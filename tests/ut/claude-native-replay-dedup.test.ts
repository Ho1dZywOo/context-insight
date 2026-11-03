// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 原生日志重放去重 IT（proxy 与原生 token 统计一致性的根源修复回归锁）：
// claude-code 的 session jsonl 是日志不是台账——resume/compact 后 verbatim 重写
// 全历史（同 message.id 同 usage 的响应整行再写一遍；真机 2 天会话 80% assistant
// 行是重放副本，主线 token 虚增 1.92×、轮次 1233 vs 734）。adapter 此前按
// 「连续性」分组，被 user 行隔开的重放副本成了新组 = 幻影轮次 + 重复计费。
// 修复：(message.id, usage) 签名全已见的组整组跳过——重放不产生轮次不重计
// token；分裂续段（同 id 新 usage）签名不全见过 → 照常入册不丢内容；
// proxy wire 每响应一行、签名唯一 → 零影响。listSessions 预览同口径去重。

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { importSession } from '../../src/lib/ingest/data-service.ts';
import { listSessions } from '../../src/lib/ingest/adapters/claude-jsonl.ts';

const prisma = new PrismaClient();
const SESSION_ID = 'claude-native-replay';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-replay-'));
const fixturePath = path.join(tmpDir, `${SESSION_ID}.jsonl`);

const T = (m: number, s = 0) => new Date(Date.UTC(2026, 9, 27, 12, m, s)).toISOString();
const asst = (id: string, text: string, usage: Record<string, number>, min: number, sec = 0, toolUse?: object) => ({
  type: 'assistant',
  timestamp: T(min, sec),
  message: {
    id,
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [
      ...(text ? [{ type: 'text', text }] : []),
      ...(toolUse ? [toolUse] : []),
    ],
    usage,
  },
});
const userText = (text: string, min: number, sec = 0) => ({
  type: 'user',
  timestamp: T(min, sec),
  message: { role: 'user', content: [{ type: 'text', text }] },
});
const userToolResult = (toolUseId: string, min: number, sec = 0) => ({
  type: 'user',
  timestamp: T(min, sec),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] },
});
const toolUseBlock = { type: 'tool_use', id: 'toolu_a1', name: 'Bash', input: { command: 'ls' } };
const usageA = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 };
const usageB = { input_tokens: 3, output_tokens: 40, cache_read_input_tokens: 150, cache_creation_input_tokens: 2 };
const usageC = { input_tokens: 4, output_tokens: 60, cache_read_input_tokens: 200, cache_creation_input_tokens: 8 };
const usageD = { input_tokens: 5, output_tokens: 70, cache_read_input_tokens: 300, cache_creation_input_tokens: 9 };

const lines: object[] = [
  userText('任务一', 0),
  asst('msg_a', 'A 的回答', usageA, 1, 0, toolUseBlock),
  userToolResult('toolu_a1', 2),
  asst('msg_b', 'B 的回答', usageB, 3),
  userText('任务二', 4),
  asst('msg_c', 'C 的回答', usageC, 5),
  // ── resume/compact 全历史重放：verbatim 副本（同 id 同 usage 同内容），
  //    与原响应之间隔 user 行、重放内部沿用原会话的 tool_result 断组——
  //    修复前会被切成新组（幻影轮次 + 重复计费）──
  userText('（resume 后继续）', 6),
  asst('msg_a', 'A 的回答', usageA, 1, 0, toolUseBlock),
  userToolResult('toolu_a1', 2),
  asst('msg_b', 'B 的回答', usageB, 3),
  userText('任务三', 7),
  asst('msg_d', 'D 的回答', usageD, 8),
  // ── 分裂续段保护：同 id 不同 usage（流式分段被 atis-latch 夹断）——
  //    签名不全见过 → 两组都入册，不丢内容（回归锁：去重不得误伤）──
  asst('msg_e', 'E 的前半段', { input_tokens: 50, output_tokens: 0 }, 9),
  { type: 'atis-latch', timestamp: T(9, 30) },
  asst('msg_e', 'E 的回答', { input_tokens: 50, output_tokens: 30 }, 9, 45),
];

// 期望 token 口径（buildAssistantInteraction：total = max(maxRaw, in+cr+cw) + out）：
// A 135、B 195、C 272、D 384（重放副本不重计）、E 分裂续段并轮 80（E1 前半段
// 同 id 不同 usage → 两组都入册，turn-split 归并连续 assistant = 一轮，内容保全）
const EXPECTED_TURN_TOKENS = 135 + 195 + 272 + 384 + 80;
const EXPECTED_ASSISTANT_TURNS = 5;

let sessionId: string | null = null;

describe('E2E: claude-code 原生日志重放去重（proxy/原生 token 统计一致性）', () => {
  beforeAll(async () => {
    fs.writeFileSync(fixturePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    await prisma.$connect();
    await prisma.session.deleteMany({ where: { taskId: SESSION_ID, framework: 'claude-code' } });
    const res = await importSession(fixturePath, SESSION_ID, prisma, fixturePath, 'claude-jsonl');
    expect(res.imported).toBe(true);
    const s = await prisma.session.findFirst({
      where: { taskId: SESSION_ID, framework: 'claude-code' },
      select: { id: true, totalTokens: true },
    });
    sessionId = s?.id ?? null;
  });

  afterAll(async () => {
    try {
      await prisma.session.deleteMany({ where: { taskId: SESSION_ID, framework: 'claude-code' } });
    } catch { /* ignore */ }
    await prisma.$disconnect();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('重放副本不产生幻影轮次：assistant 轮 = 唯一响应（A/B/C/D/E，重放 A/B 不成轮）', async () => {
    const n = await prisma.turn.count({ where: { sessionId: sessionId!, role: 'assistant' } });
    expect(n).toBe(EXPECTED_ASSISTANT_TURNS);
  });

  it('重放副本不重复计费：Σ turn tokens = 唯一响应口径（重放 A/B 不重计）', async () => {
    const rows = await prisma.turn.findMany({
      where: { sessionId: sessionId!, role: 'assistant' },
      select: { totalTokens: true, contentSummary: true },
    });
    expect(rows.reduce((s, r) => s + r.totalTokens, 0)).toBe(EXPECTED_TURN_TOKENS);
    // 同一响应内容只出现在一个轮次里（重放副本没有成为第二行）；分裂续段的
    // 两段内容都保全（E 的前半段 + E 的回答——去重不得误伤同 id 新 usage）
    expect(rows.filter(r => (r.contentSummary ?? '').includes('A 的回答')).length).toBe(1);
    expect(rows.filter(r => (r.contentSummary ?? '').includes('B 的回答')).length).toBe(1);
    expect(rows.some(r => (r.contentSummary ?? '').includes('E 的前半段'))).toBe(true);
    expect(rows.some(r => (r.contentSummary ?? '').includes('E 的回答'))).toBe(true);
  });

  it('会话级 totalTokens 汇聚一致（治理/上仓 roll-up 的口径源）', async () => {
    const s = await prisma.session.findFirst({
      where: { taskId: SESSION_ID, framework: 'claude-code' },
      select: { totalTokens: true },
    });
    expect(s?.totalTokens).toBe(EXPECTED_TURN_TOKENS);
  });

  it('listSessions 预览同口径去重（导入前预览 ≠ 导入后实际）', () => {
    const items = listSessions(tmpDir);
    const item = items.find(i => i.id === SESSION_ID);
    expect(item).toBeTruthy();
    // 预览口径（in+out+cr+cw 逐行求和）：A 135、B 195、C 272、D 384、E1 50、
    // E2 80 = 1116——重放的 A/B 副本各 +135/+195 已被签名去重。与导入后 Σ 的
    // 50 差额 = E 分裂续段两行在预览口径各计一次（既有差异，导入后并轮取末
    // usage——非重放问题，不在本修复范围）
    expect(item?.totalTokens).toBe(EXPECTED_TURN_TOKENS + 50);
  });
});
