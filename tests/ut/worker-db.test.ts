// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 回归锁（根治 2026-11-24 sentry run#762 类跨 worker flake）：测试库按 worker
// 分片的解析矩阵 + 物化幂等性。锁死的不变量——默认跑法下每个 worker 槽位
// 各得一份独立库文件（跨 worker 物理隔离），显式 DATABASE_URL 逃逸口原样
// 保留，.env 泄漏剥除后回落分片。解析逻辑全部纯函数化（tests/worker-db.ts），
// 这里逐分支锁死；setup.ts 只做接线（解析 → 物化 → 赋 env），任何一处退化
// （比如改回全局共写单库）都会先红在这里。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveWorkerDatabaseUrl,
  materializeWorkerShard,
  workerSlotId,
  workerShardUrl,
  workerShardFileFromUrl,
} from '../worker-db';

function tmpEnvDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-db-it-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

describe('workerSlotId：槽位取值链', () => {
  it('VITEST_WORKER_ID 优先', () => {
    expect(workerSlotId({ VITEST_WORKER_ID: '3', VITEST_POOL_ID: '9' })).toBe('3');
  });
  it('WORKER 缺席回落 VITEST_POOL_ID（同语义历名）', () => {
    expect(workerSlotId({ VITEST_POOL_ID: '9' })).toBe('9');
  });
  it('两者皆缺（非 vitest 上下文）回落单进程语义 "1"', () => {
    expect(workerSlotId({})).toBe('1');
  });
});

describe('resolveWorkerDatabaseUrl：谁说了算', () => {
  it('无当前值 → 分片库（按槽位命名）', () => {
    const envDir = tmpEnvDir({});
    expect(resolveWorkerDatabaseUrl({ currentUrl: undefined, envDir, slotId: '2' })).toEqual({
      url: 'file:./test-w2.db',
      reason: 'shard',
    });
  });

  it('显式值（shell/CI 指定特定库）→ 原样保留不介入', () => {
    const envDir = tmpEnvDir({});
    const r = resolveWorkerDatabaseUrl({
      currentUrl: 'file:/ci/special/e2e-check.db',
      envDir,
      slotId: '2',
    });
    expect(r).toEqual({ url: null, reason: 'explicit' });
  });

  it('泄漏值（与 .env 提供值一致）→ 剥除回落分片', () => {
    const envDir = tmpEnvDir({ '.env': 'DATABASE_URL="file:./dev.db"\n' });
    const r = resolveWorkerDatabaseUrl({ currentUrl: 'file:./dev.db', envDir, slotId: '4' });
    expect(r).toEqual({ url: 'file:./test-w4.db', reason: 'leak-stripped-shard' });
  });

  it('与 .env 值不同的显式值不算泄漏', () => {
    const envDir = tmpEnvDir({ '.env': 'DATABASE_URL="file:./dev.db"\n' });
    const r = resolveWorkerDatabaseUrl({ currentUrl: 'file:./other.db', envDir, slotId: '4' });
    expect(r).toEqual({ url: null, reason: 'explicit' });
  });

  it('分片 URL 随槽位隔离：两个 worker 决不相交', () => {
    const a = workerShardUrl('1');
    const b = workerShardUrl('2');
    expect(a).not.toBe(b);
    expect(workerShardFileFromUrl(a)).not.toBe(workerShardFileFromUrl(b));
  });
});

describe('materializeWorkerShard：模板复制物化', () => {
  it('模板在 → 复制出与模板逐字节一致的分片库', () => {
    const prismaDir = tmpEnvDir({ 'test.db': 'GOLDEN-IMAGE-BYTES' });
    materializeWorkerShard({ prismaDir, shardFile: 'test-w1.db' });
    expect(fs.readFileSync(path.join(prismaDir, 'test-w1.db'), 'utf8')).toBe('GOLDEN-IMAGE-BYTES');
  });

  it('幂等：分片库已存在不覆盖（worker 运行态不可重建）', () => {
    const prismaDir = tmpEnvDir({ 'test.db': 'GOLDEN-IMAGE-BYTES' });
    fs.writeFileSync(path.join(prismaDir, 'test-w1.db'), 'WORKER-RUNTIME-STATE');
    materializeWorkerShard({ prismaDir, shardFile: 'test-w1.db' });
    expect(fs.readFileSync(path.join(prismaDir, 'test-w1.db'), 'utf8')).toBe('WORKER-RUNTIME-STATE');
  });

  it('模板缺位（绕过 pretest 的 fresh clone 直跑）→ 可行动错误', () => {
    const prismaDir = tmpEnvDir({});
    expect(() => materializeWorkerShard({ prismaDir, shardFile: 'test-w1.db' })).toThrowError(
      /prisma\/test\.db 黄金模板不存在[\s\S]*npm run test/,
    );
  });

  it('非分片形态 URL 提取文件名直接抛错（显式 URL 不应走到物化）', () => {
    expect(() => workerShardFileFromUrl('file:./test.db')).toThrowError(/不应物化/);
  });
});
