// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// run turns 收集器 wire 时长增补 IT：DB per-call durationMs 采集侧未回填
// （全 0）——cpx 捕获成员按 wire 轮间隙推导覆盖（与 session turns 处理器
// 同口径）；原生（非 claude-format）成员无 wire 保持 0；DB 已有正值优先。
// 修复前 run 级端点裸读 DB 0 值，Overview 的 Tool Calls 卡全显 0ms。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prisma } from '../setup';
import { GET as runTurnsGET } from '@/app/api/observe/run/[runId]/turns/route';

const SID_PROXY = 'ses-wire-it-proxy';
const SID_NATIVE = 'ses-wire-it-native';
const T = 1_700_000_000_000;
const ts = (offsetMs: number) => new Date(T + offsetMs).toISOString();
const w = (obj: unknown) => JSON.stringify(obj);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-run-wire-'));

beforeAll(async () => {
  // 捕获：t1/t2 同批（间隙 4000 均分）；t3 派发
  fs.writeFileSync(path.join(TMP, `cpx-${SID_PROXY}.jsonl`), [
    w({ type: 'user', timestamp: ts(0), message: { role: 'user', content: '任务' } }),
    w({
      type: 'assistant', timestamp: ts(10000), duration_ms: 5000,
      message: { role: 'assistant', content: [
        { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
        { type: 'tool_use', id: 't2', name: 'Read', input: {} },
      ] },
    }),
    w({
      type: 'user', timestamp: ts(14000),
      message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1' }, { type: 'tool_result', tool_use_id: 't2' },
      ] },
    }),
  ].join('\n') + '\n');

  await prisma.session.deleteMany({ where: { taskId: { in: [SID_PROXY, SID_NATIVE] } } });
  const proxy = await prisma.session.create({
    data: {
      taskId: SID_PROXY, framework: 'opencode-proxy', version: '1.0-opencode-proxy',
      sourcePath: path.join(TMP, `cpx-${SID_PROXY}.jsonl`),
    },
  });
  const native = await prisma.session.create({
    // opencode 原生真实源形态是 opencode.db——无 wire（框架门，含 lake 导出
    // 折叠语义一律不做增补）
    data: { taskId: SID_NATIVE, framework: 'opencode', version: '2.0.24', sourcePath: path.join(TMP, 'opencode.db') },
  });
  const mkTurn = (sessionId: string, turnIndex: number, at: string) =>
    prisma.turn.create({
      data: { sessionId, turnIndex, role: 'assistant', content: 'wire-it', createdAt_ts: new Date(at), latencyMs: 1000 },
    });
  const proxyTurn = await mkTurn(proxy.id, 0, ts(10000));
  const nativeTurn = await mkTurn(native.id, 0, ts(10000));
  await prisma.toolCall.createMany({
    data: [
      // proxy 行：t1/t2 DB 0 值（采集侧未回填）→ wire 推导；t9 DB 正值 → 优先
      { turnId: proxyTurn.id, toolCallId: 't1', toolName: 'Bash', durationMs: 0 },
      { turnId: proxyTurn.id, toolCallId: 't2', toolName: 'Read', durationMs: 0 },
      { turnId: proxyTurn.id, toolCallId: 't9', toolName: 'Edit', durationMs: 1500 },
      // 原生行：无 wire（opencode 原生/lake 导出都不做增补）→ 0 保持
      { turnId: nativeTurn.id, toolCallId: 't1', toolName: 'Bash', durationMs: 0 },
    ],
  });
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const get = (runId: string) =>
  runTurnsGET(
    new NextRequest(`http://localhost/api/observe/run/${encodeURIComponent(runId)}/turns`),
    { params: Promise.resolve({ runId }) },
  );

describe('run turns：wire 轮间隙时长增补（cpx 捕获）', () => {
  it('proxy 成员：DB 0 值被 wire 推导覆盖（同批均分 4000ms）；DB 正值优先', async () => {
    const res = await get(`solo:${SID_PROXY}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    const dur = new Map(data.items[0].toolCalls.map((tc: { toolCallId: string; durationMs: number }) => [tc.toolCallId, tc.durationMs]));
    // 同批 t1/t2 均分 [10000,14000] 间隙 → 各 2000（串行衔接）
    expect(dur.get('t1')).toBe(2000);
    expect(dur.get('t2')).toBe(2000);
    expect(dur.get('t9')).toBe(1500);
  });

  it('原生成员：无 wire 保持 DB 0（opencode 无 wire，框架门外）', async () => {
    const res = await get(`solo:${SID_NATIVE}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.items[0].toolCalls[0].durationMs).toBe(0);
  });
});
