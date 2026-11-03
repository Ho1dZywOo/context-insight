// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. Do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// wire 捕获 tool_result 历史重放 IT（全管线：jsonl → adapter → turn-split → DB）：
// cpx 逐请求落盘 messages 历史——同一 tool_use_id 的结果行随每个后续请求重复
// 携带，last-wins 会把 completedAt 滑到最后一次重放的请求时刻（真机现场：
// 42ms 的 Bash 被记成 50653.9s，Turns tab 工具耗时全席失真）。修复后首现
// 胜出：completedAt 锚定首条载体行，durationMs 回到真实窗口。
import { describe, it, expect, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prisma } from '../setup';
import { POST } from '@/app/api/ingest/import-file/route';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-replay-it-'));
const SID = 'wire-replay-it-sid';
// 夹具即数据源（首现载体 42ms → 纯重放 14h → 重放+新提示 15h）
const FIXTURE = path.resolve(__dirname, 'data/claude-sessions/proxy-wire-tool-replay.jsonl');
const CAPTURE_FILE = path.join(TMP, `cpx-${SID}.jsonl`);
fs.copyFileSync(FIXTURE, CAPTURE_FILE);

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/ingest/import-file', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterAll(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  await prisma.session.deleteMany({ where: { taskId: SID } });
  await prisma.$disconnect();
});

describe('wire 捕获 tool_result 历史重放（import-file → DB 全管线）', () => {
  it('completedAt 首现胜出，durationMs 回到 42ms 真实窗口', async () => {
    const res = await POST(req({ source: 'claude-jsonl', sessionId: SID, filePath: CAPTURE_FILE }));
    expect(res.status).toBe(200);

    const s = await prisma.session.findFirst({ where: { taskId: SID } });
    expect(s?.framework).toBe('claude-code-proxy');
    const turns = await prisma.turn.findMany({ where: { sessionId: s!.id }, orderBy: { turnIndex: 'asc' } });
    // 重放行不产生额外轮次
    expect(turns.filter(t => t.role === 'user').length).toBe(2);
    expect(turns.filter(t => t.role === 'assistant').length).toBe(2);

    const toolTurn = turns.find(t => t.role === 'assistant');
    const tcs = await prisma.toolCall.findMany({ where: { turnId: toolTurn!.id } });
    expect(tcs.length).toBe(1);
    const tc = tcs[0]!;
    // 首条载体行时刻（42ms 窗口），不是 14h/15h 后的重放时刻
    expect(tc.startedAt?.toISOString()).toBe('2026-10-27T13:14:48.004Z');
    expect(tc.completedAt?.toISOString()).toBe('2026-10-27T13:14:48.046Z');
    expect(tc.durationMs).toBe(42);
  });
});
