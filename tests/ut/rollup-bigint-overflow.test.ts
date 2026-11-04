// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details.
// You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// roll-up 列 BigInt 升型 IT（Int32 溢出崩溃的根源修复回归锁）：
// Session/Execution/InteractionBridge 的 token 与时延 roll-up 列域无界——
// 真实场景实测 Execution.tokens 1.26B、长活会话 execution 墙钟跨度 3.8B ms
// （44 天）、外部报告 Session.totalTokens 2.23B，全部撞破 Int(32 位) 的
// 2.147B 上限：SQLite 64 位照存不报错，Prisma 读取层转换即抛
// 「Inconsistent column data: Value ... does not fit in an INT column」，
// 触到该行的任何查询（session.findFirst / execution.findMany）整条 500。
// 修复三面：schema roll-up 列升 BigInt（migration 表重建，存量零改写）；
// bigint→number 的 JSON 序列化垫片（src/lib/bigint-json.ts，杜绝 API 路由
// stringify(bigint) 的运行时 TypeError——tsc 对此零感知）；单轮/单调用粒度
// 列（Turn/ToolCall）物理有界保持 Int（本夹具同时锁住该边界：单轮远小于
// 2^31，Σ 才超——证明升型范围切在聚合层而非一刀切）。

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { importSession } from '../../src/lib/ingest/data-service.ts';

const prisma = new PrismaClient();
const SESSION_ID = 'claude-native-bigint-overflow';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollup-bigint-'));
const fixturePath = path.join(tmpDir, `${SESSION_ID}.jsonl`);

// 夹具口径：30 轮 × 每轮 80M tokens（in 5M + out 3M + cacheRead 70M +
// cacheWrite 2M）——单轮 80M 远在 Int32 内（Turn 保持 Int 的边界依据），
// Σ 2.4B 撞破 2.147B；时间戳铺满 30 天（execution 墙钟跨度实测 29 天+1h
// ≈ 2.51B ms，同样 > 2^31，复刻真实 44 天长活会话病灶）。
const TURNS = 30;
const PER_TURN_TOKENS = 80_000_000;
const EXPECTED_TOTAL_TOKENS = TURNS * PER_TURN_TOKENS; // 2,400,000,000
const DAY_MS = 86_400_000;

const day = (n: number, h = 0) => new Date(Date.UTC(2026, 9, 1 + n, h)).toISOString();
const usage = {
  input_tokens: 5_000_000,
  output_tokens: 3_000_000,
  cache_read_input_tokens: 70_000_000,
  cache_creation_input_tokens: 2_000_000,
};

const lines: object[] = [];
for (let i = 0; i < TURNS; i++) {
  lines.push({
    type: 'user',
    timestamp: day(i),
    message: { role: 'user', content: [{ type: 'text', text: `任务 ${i}` }] },
  });
  lines.push({
    type: 'assistant',
    timestamp: day(i, 1),
    message: {
      id: `msg_bigint_${i}`,
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [{ type: 'text', text: `第 ${i} 轮回答` }],
      usage,
    },
  });
}
// 收尾 user 行（会话尾部常态：末轮后仍有用户输入、无响应收尾）
lines.push({
  type: 'user',
  timestamp: day(30),
  message: { role: 'user', content: [{ type: 'text', text: '（会话继续）' }] },
});

let sessionId: string | null = null;

describe('E2E: roll-up 列 BigInt 升型（Int32 溢出读崩溃的回归锁）', () => {
  beforeAll(async () => {
    fs.writeFileSync(fixturePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    await prisma.$connect();
    await prisma.session.deleteMany({ where: { taskId: SESSION_ID, framework: 'claude-code' } });
    const res = await importSession(fixturePath, SESSION_ID, prisma, fixturePath, 'claude-jsonl');
    expect(res.imported).toBe(true);
  });

  afterAll(async () => {
    try {
      await prisma.session.deleteMany({ where: { taskId: SESSION_ID, framework: 'claude-code' } });
    } catch { /* ignore */ }
    await prisma.$disconnect();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('session.findFirst 直读 2.4B 总量行不再抛 Inconsistent column data（用户报障现场）', async () => {
    const s = await prisma.session.findFirst({
      where: { taskId: SESSION_ID, framework: 'claude-code' },
    });
    expect(s).not.toBeNull();
    sessionId = s!.id;
    // 读出即为 bigint（列已 BigInt）；值无损
    expect(typeof s!.totalTokens).toBe('bigint');
    expect(Number(s!.totalTokens)).toBe(EXPECTED_TOTAL_TOKENS);
  });

  it('execution.findMany 直读超 Int32 墙钟跨度不再抛（日志 500 现场：latencyMs 3.8B）', async () => {
    const execs = await prisma.execution.findMany({ where: { sessionId: sessionId! } });
    expect(execs.length).toBeGreaterThan(0);
    const root = execs.find(e => !e.isSubagent);
    expect(root).toBeDefined();
    expect(typeof root!.latencyMs).toBe('bigint');
    // 夹具时间轴 2026-10-01T00:00 → 2026-10-30T01:00：墙钟跨度 = 29 天+1h
    // （回归目标：> 2^31 即可，跨度的精确口径属 execution-split 语义测试）
    const spanMs = Number(root!.latencyMs);
    expect(spanMs).toBeGreaterThan(2_147_483_647);
    expect(spanMs).toBeGreaterThanOrEqual(29 * DAY_MS);
    expect(spanMs).toBeLessThanOrEqual(31 * DAY_MS);
  });

  it('JSON.stringify 直接序列化 roll-up 字段可行（bigint-json 垫片回归锁：API 路由不再运行时 500）', async () => {
    const s = await prisma.session.findFirst({
      where: { id: sessionId! },
      select: { totalTokens: true, totalLatencyMs: true, totalInputTokens: true },
    });
    // 无垫片时这里直接抛 TypeError: Do not know how to serialize a BigInt
    const json = JSON.stringify(s);
    const parsed = JSON.parse(json);
    expect(parsed.totalTokens).toBe(EXPECTED_TOTAL_TOKENS);
    expect(parsed.totalInputTokens).toBe(TURNS * 5_000_000);
  });

  it('单轮粒度列保持 Int（升型切在聚合层：单轮 80M 在 Int32 内即正常读出为 number）', async () => {
    const t = await prisma.turn.findFirst({
      where: { sessionId: sessionId!, role: 'assistant' },
      select: { totalTokens: true },
    });
    expect(typeof t!.totalTokens).toBe('number');
    expect(t!.totalTokens).toBe(PER_TURN_TOKENS);
  });
});
