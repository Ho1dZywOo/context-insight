// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. Do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 单轮耗时（turnMs）投影 IT：Turns 行展示从「模型耗时」改「单轮耗时」的
// 服务端口径——两投影面（run turns collector 与 member-turns 的 session
// 处理器）同源同值：
// ① claude 格式会话（claude-code-proxy wire 捕获 / opencode-proxy 捕获 /
//   claude-code 原生）：工具执行在生成之后 → turnMs = latency + 最慢并行
//   工具（有效时长与 toolCalls 投影同源：DB 正值优先、wire 兜底）；
// ② opencode 原生：消息时长已覆盖 part 执行 → turnMs = latency（不双计）；
// ③ 生成时长缺失但工具有时长 → 回落工具时长（有信号好过零）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prisma } from '../setup';
import { GET as runTurnsGET } from '@/app/api/observe/run/[runId]/turns/route';
import { GET as memberTurnsGET } from '@/app/api/observe/run/[runId]/member-turns/route';

const SID_CC_PROXY = 'ses-wall-cc-proxy';
const SID_OC_PROXY = 'ses-wall-oc-proxy';
const SID_OC_NATIVE = 'ses-wall-oc-native';
const SID_CC_NATIVE = 'ses-wall-cc-native';
const SID_CC_CCDB = 'ses-wall-cc-ccdb';
const T = 1_700_000_000_000;
const ts = (offsetMs: number) => new Date(T + offsetMs).toISOString();
const w = (obj: unknown) => JSON.stringify(obj);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-run-wall-'));

// claude 格式 wire 捕获：assistant 行 duration_ms=10000（生成跨度），t1/t2
// 同批工具（下一请求 +4000 → 轮间隙均分各 2000）
function wireCapture(sid: string): string {
  return path.join(TMP, `cpx-${sid}.jsonl`);
}

beforeAll(async () => {
  for (const sid of [SID_CC_PROXY, SID_OC_PROXY]) {
    fs.writeFileSync(wireCapture(sid), [
      w({ type: 'user', timestamp: ts(0), message: { role: 'user', content: '任务' } }),
      w({
        type: 'assistant', timestamp: ts(10000), duration_ms: 10000,
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
  }

  // 模型 B 捕获（cc-db-turn 原生导出）：assistant 行 ts = 请求发出、
  // duration_ms = 请求→响应，工具结果载体行同戳——wire 窗口 =
  // [ts+dur, 下一请求行 ts]（lake bundle .native 全员此形态）
  const ccdbCapture = path.join(TMP, `cc-${SID_CC_CCDB}.jsonl`);
  fs.writeFileSync(ccdbCapture, [
    w({
      type: 'assistant', timestamp: ts(0), duration_ms: 5000,
      message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'b1', name: 'Read', input: {} },
        { type: 'tool_use', id: 'b2', name: 'Bash', input: {} },
      ] },
    }),
    w({
      type: 'user', timestamp: ts(0),
      message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'b1' }, { type: 'tool_result', tool_use_id: 'b2' },
      ] },
    }),
    w({
      type: 'assistant', timestamp: ts(14000), duration_ms: 1000,
      message: { role: 'assistant', content: [{ type: 'text', text: '收尾' }] },
    }),
  ].join('\n') + '\n');

  await prisma.session.deleteMany({ where: { taskId: { in: [SID_CC_PROXY, SID_OC_PROXY, SID_OC_NATIVE, SID_CC_NATIVE, SID_CC_CCDB] } } });
  const ccProxy = await prisma.session.create({
    data: { taskId: SID_CC_PROXY, framework: 'claude-code-proxy', version: '1.0-claude-code-proxy', sourcePath: wireCapture(SID_CC_PROXY) },
  });
  const ocProxy = await prisma.session.create({
    data: { taskId: SID_OC_PROXY, framework: 'opencode-proxy', version: '1.0-opencode-proxy', sourcePath: wireCapture(SID_OC_PROXY) },
  });
  const ocNative = await prisma.session.create({
    data: { taskId: SID_OC_NATIVE, framework: 'opencode', version: '2.0.24', sourcePath: path.join(TMP, 'nope.jsonl') },
  });
  const ccNative = await prisma.session.create({
    data: { taskId: SID_CC_NATIVE, framework: 'claude-code', version: '2.0.0', sourcePath: path.join(TMP, 'nope2.jsonl') },
  });
  const ccdb = await prisma.session.create({
    data: { taskId: SID_CC_CCDB, framework: 'claude-code', version: null, sourcePath: ccdbCapture },
  });
  const mkTurn = (sessionId: string, latencyMs: number) =>
    prisma.turn.create({
      data: { sessionId, turnIndex: 0, role: 'assistant', content: 'wall-it', createdAt_ts: new Date(ts(10000)), latencyMs },
    });
  const ccProxyTurn = await mkTurn(ccProxy.id, 10000);
  const ocProxyTurn = await mkTurn(ocProxy.id, 1000);
  const ocNativeTurn = await mkTurn(ocNative.id, 800);
  const ccNativeTurn = await mkTurn(ccNative.id, 0);
  const ccdbTurn = await mkTurn(ccdb.id, 5000);
  await prisma.toolCall.createMany({
    data: [
      // claude-code-proxy：t1/t2 DB 0 → wire 均分 2000；t9 DB 正值 1500 优先
      { turnId: ccProxyTurn.id, toolCallId: 't1', toolName: 'Bash', durationMs: 0 },
      { turnId: ccProxyTurn.id, toolCallId: 't2', toolName: 'Read', durationMs: 0 },
      { turnId: ccProxyTurn.id, toolCallId: 't9', toolName: 'Edit', durationMs: 1500 },
      // opencode-proxy（claude 格式 wire 捕获）：同 Wire 增补参与相加
      { turnId: ocProxyTurn.id, toolCallId: 't1', toolName: 'Bash', durationMs: 0 },
      { turnId: ocProxyTurn.id, toolCallId: 't2', toolName: 'Read', durationMs: 0 },
      // opencode 原生：时长在消息时长之内 → 不相加（不双计）
      { turnId: ocNativeTurn.id, toolCallId: 't1', toolName: 'Bash', durationMs: 600 },
      // claude-code 原生：生成缺失（0）→ 回落工具时长
      { turnId: ccNativeTurn.id, toolCallId: 't1', toolName: 'Bash', durationMs: 600 },
      // cc-db-turn 原生导出：DB 0 → wire 模型 B 窗口（各 4500）参与相加
      { turnId: ccdbTurn.id, toolCallId: 'b1', toolName: 'Read', durationMs: 0 },
      { turnId: ccdbTurn.id, toolCallId: 'b2', toolName: 'Bash', durationMs: 0 },
    ],
  });
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const runTurns = (runId: string) =>
  runTurnsGET(
    new NextRequest(`http://localhost/api/observe/run/${encodeURIComponent(runId)}/turns`),
    { params: Promise.resolve({ runId }) },
  );

const memberTurns = (runId: string, member: string) =>
  memberTurnsGET(
    new NextRequest(`http://localhost/api/observe/run/${encodeURIComponent(runId)}/member-turns?member=${encodeURIComponent(member)}`),
    { params: Promise.resolve({ runId }) },
  );

describe('run turns / member-turns：单轮耗时（turnMs）投影', () => {
  it('claude 格式 wire 捕获：turnMs = 生成 + 最慢并行工具（有效时长 DB 正值优先、wire 兜底同源）', async () => {
    const res = await runTurns(`solo:${SID_CC_PROXY}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    const item = data.items[0];
    // 有效时长 [2000, 2000, 1500] → max 2000；10000 + 2000
    expect(item.latencyMs).toBe(10000);
    expect(item.turnMs).toBe(12000);
    // toolCalls 投影同源同值（用户可见的分解与单轮一致）
    expect(item.toolCalls.map((tc: { toolCallId: string; durationMs: number }) => [tc.toolCallId, tc.durationMs])).toEqual(
      expect.arrayContaining([['t1', 2000], ['t2', 2000], ['t9', 1500]]),
    );
  });

  it('opencode-proxy 捕获（claude 格式）：同为 wire 相加口径', async () => {
    const res = await runTurns(`solo:${SID_OC_PROXY}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.items[0].turnMs).toBe(3000); // 1000 + max(2000, 2000)
  });

  it('opencode 原生：消息时长已含工具执行 → turnMs = latency（不双计）', async () => {
    const res = await runTurns(`solo:${SID_OC_NATIVE}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.items[0].latencyMs).toBe(800);
    expect(data.items[0].turnMs).toBe(800);
  });

  it('生成时长缺失（0）：回落工具时长（有信号好过零）', async () => {
    const res = await runTurns(`solo:${SID_CC_NATIVE}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.items[0].latencyMs).toBe(0);
    expect(data.items[0].turnMs).toBe(600);
  });

  it('cc-db-turn 原生导出（模型 B：载体行同戳）：wire 窗口参与相加', async () => {
    const res = await runTurns(`solo:${SID_CC_CCDB}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    const item = data.items[0];
    // 模型 B 窗口 [0+5000, 14000] 均分 → b1/b2 各 4500 → max 4500
    expect(item.latencyMs).toBe(5000);
    expect(item.turnMs).toBe(9500);
    const dur = new Map(item.toolCalls.map((tc: { toolCallId: string; durationMs: number }) => [tc.toolCallId, tc.durationMs]));
    expect(dur.get('b1')).toBe(4500);
    expect(dur.get('b2')).toBe(4500);
  });

  it('member-turns（session 处理器面）：与 run turns 同口径', async () => {
    const res = await memberTurns(`solo:${SID_CC_PROXY}`, SID_CC_PROXY);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.items[0].turnMs).toBe(12000);
    const resNative = await memberTurns(`solo:${SID_OC_NATIVE}`, SID_OC_NATIVE);
    expect(resNative.status).toBe(200);
    const dataNative = await resNative.json();
    expect(dataNative.items[0].turnMs).toBe(800);
  });
});
