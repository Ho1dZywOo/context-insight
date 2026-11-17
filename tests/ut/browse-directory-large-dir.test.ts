// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// browse-directory 大目录全量语义 IT：无界目录（如 /tmp 顶层 12 万+ 条目）
// 的浏览必须全量返回（浏览是找东西，不裁剪数据），性能靠 IO 纪律根治——
// withFileTypes 单次 readdir 分组、分批并发 stat、bundle manifest 探测设
// 目录数上限（超限跳过探测：isBundleDir 恒 false，浏览照常可导航；普通
// 工作目录真值探测不变）。
import { describe, it, expect, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { POST } from '@/app/api/ingest/browse-directory/route';

const PROBE_DIR_LIMIT = 2000;

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-browse-large-'));
afterAll(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

function req(dirPath: string): NextRequest {
  return new NextRequest('http://localhost/api/ingest/browse-directory', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dirPath }),
  });
}

function createDir(name: string, fileCount: number, opts: {
  dirs?: number; importable?: number;
} = {}): string {
  const dir = path.join(fixtureRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < fileCount; i++) {
    fs.writeFileSync(path.join(dir, `plain-${i}.log`), 'x');
  }
  for (let i = 0; i < (opts.dirs ?? 0); i++) {
    fs.mkdirSync(path.join(dir, `dir-${i}`), { recursive: true });
  }
  for (let i = 0; i < (opts.importable ?? 0); i++) {
    // rollout- 前缀精确嗅探 → codex 捕获件
    fs.writeFileSync(path.join(dir, `rollout-2026-11-16T00-${String(i).padStart(2, '0')}-00-00000000-0000-0000-0000-0000000000${i}.jsonl`), '{"type":"session_meta"}\n');
  }
  return dir;
}

describe('POST /api/ingest/browse-directory — 大目录全量返回', () => {
  it('大目录（6000+ 条目）全量返回：目录、普通文件、可导入文件一条不裁', async () => {
    const dir = createDir('huge', 5200, { dirs: 800, importable: 20 });
    const res = await POST(req(dir));
    expect(res.status).toBe(200);
    const data = await res.json();
    // 全量语义：无任何省略字段，entries = 目录 + 文件总和
    expect(data.entries).toHaveLength(6020);
    expect(data.totalEntries).toBeUndefined();
    expect(data.truncated).toBeUndefined();
    const dirs = data.entries.filter((e: { isDir: boolean }) => e.isDir);
    const importable = data.entries.filter((e: { isImportableFile: boolean }) => e.isImportableFile);
    expect(dirs).toHaveLength(800);
    expect(importable).toHaveLength(20);
    expect(importable.every((e: { importableType: string | null }) => e.importableType === 'codex-jsonl')).toBe(true);
    // 普通文件在场（此前裁剪版会砍掉它们）
    const names = new Set(data.entries.map((e: { name: string }) => e.name));
    expect(names.has('plain-0.log')).toBe(true);
    expect(names.has('plain-5199.log')).toBe(true);
  });

  it('目录数超探测上限：isBundleDir 全 false（跳过 manifest 探测），目录照常全量可导航', async () => {
    const dir = createDir('probe-skip', 3, { dirs: PROBE_DIR_LIMIT + 5 });
    const res = await POST(req(dir));
    expect(res.status).toBe(200);
    const data = await res.json();
    const dirs = data.entries.filter((e: { isDir: boolean }) => e.isDir);
    expect(dirs).toHaveLength(PROBE_DIR_LIMIT + 5);
    expect(dirs.every((e: { isBundleDir: boolean }) => e.isBundleDir === false)).toBe(true);
  });

  it('目录数在上限内：bundle 真值探测保留（高亮与点击直达不受大目录纪律影响）', async () => {
    const dir = createDir('bundle-marker', 1, { dirs: 2 });
    fs.writeFileSync(path.join(dir, 'dir-0', 'workflow.json'), '{}\n');
    const res = await POST(req(dir));
    const data = await res.json();
    const marked = data.entries.filter((e: { isBundleDir: boolean }) => e.isBundleDir);
    expect(marked.map((e: { name: string }) => e.name)).toEqual(['dir-0']);
  });

  it('文件条目携带真实 size/mtime；目录 mtime 恒 0（组内名字序由消费方单点排）', async () => {
    const dir = createDir('file-meta', 2, { importable: 1 });
    const before = Date.now();
    const res = await POST(req(dir));
    const data = await res.json();
    const file = data.entries.find((e: { name: string }) => e.name === 'plain-0.log');
    expect(file.size).toBe(1);
    expect(file.mtime).toBeGreaterThan(0);
    expect(file.mtime).toBeLessThanOrEqual(Date.now() + 1000);
    expect(before).toBeGreaterThan(0);
  });
});
