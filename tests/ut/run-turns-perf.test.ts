// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details on how to use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// run turns 性能层 IT（详情页逐 tab 提速）：
// ①轻投影：正文不进响应——contentSummary 缺失回退恒 200 字符（substr 下推
//   SQLite），空串 summary 保持空串（?? 口径），NULL 正文无回退；
// ②includeErrorDigest：服务端预算的错误摘要与客户端原文计算
//   （summarizeToolCallErrors + toolCallErrorMessage）逐值同口径——Overview
//   据此不再请求 18MB 级 includeToolDetail 原文；非错误轮零携带，
//   includeToolResult 语义保持不变；
// ③warmWireTimings：claude-format 会话启动期预热捕获推导（非 claude 跳过、
//   缺文件容忍），预热后 turns 请求路径的 durationMs 增补零冷读。

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { GET as runTurnsGET } from '@/app/api/observe/run/[runId]/turns/route';
import { collectScopeTurns } from '@/lib/observe/collectors/turns';
import { resolveRunScope } from '@/lib/run/observe/scope';
import { warmWireTimings } from '@/lib/tool-timing-warm';
import { summarizeToolCallErrors, toolCallErrorMessage, type TurnErrorDigest } from '@/lib/tool-call-errors';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-run-turns-perf-'));
const ORIG_HOME = process.env.CONTEXT_INSIGHT_HOME;
const SID = 'rtp-ses-perf';
const RUN_ID = `solo:${SID}`;

/** 5000 字符正文（无 summary）——回退恒 200 字符的载荷护栏锚点 */
const LONG_CONTENT = 'rtp-长正文'.repeat(1000);
const ctx: { sessionId: string; turnIds: Record<string, string> } = { sessionId: '', turnIds: {} };

beforeAll(async () => {
  process.env.CONTEXT_INSIGHT_HOME = tmpHome;
  await prisma.session.deleteMany({ where: { taskId: SID } });
  const s = await prisma.session.create({
    data: {
      taskId: SID,
      framework: 'opencode',
      model: 'volc-gateway/glm-4.7',
      startTime: new Date('2026-10-13T02:00:00Z'),
      endTime: new Date('2026-10-13T02:10:00Z'),
    },
  });
  ctx.sessionId = s.id;
  const mk = (turnIndex: number, at: string, data: Record<string, unknown> = {}) =>
    prisma.turn.create({ data: { sessionId: s.id, turnIndex, role: 'assistant', createdAt_ts: new Date(at), ...data } });

  // ①轻投影锚点轮
  const tLong = await mk(0, '2026-10-13T02:00:10Z', { content: LONG_CONTENT }); // 无 summary → 200 字符回退
  await mk(1, '2026-10-13T02:00:20Z', { content: 'rtp-有摘要轮正文', contentSummary: '' }); // 空串 summary → 保持空串
  await mk(2, '2026-10-13T02:00:30Z', {}); // 无 summary 无 content → null
  const tSum = await mk(3, '2026-10-13T02:00:40Z', { content: 'rtp-正文被忽略', contentSummary: 'rtp-既有摘要' });

  // ②错误摘要锚点轮（state / Exit code / cancelled / skill 失败 / 截断）
  const tState = await mk(4, '2026-10-13T02:00:50Z');
  const tExit = await mk(5, '2026-10-13T02:01:00Z');
  const tCancel = await mk(6, '2026-10-13T02:01:10Z');
  const tSkill = await mk(7, '2026-10-13T02:01:20Z');
  const tTrunc = await mk(8, '2026-10-13T02:01:30Z', { finishReason: 'length' });
  const tClean = await mk(9, '2026-10-13T02:01:40Z'); // 干净轮 → 无 digest

  await prisma.toolCall.create({ data: { turnId: tState.id, toolCallId: 'rtp-tc-state', toolName: 'Bash', state: 'error' } });
  await prisma.toolCall.create({ data: { turnId: tExit.id, toolCallId: 'rtp-tc-exit', toolName: 'Read', state: 'ok', resultJson: 'rtp-输出\nExit code 1\nrtp-尾部' } });
  await prisma.toolCall.create({ data: { turnId: tCancel.id, toolCallId: 'rtp-tc-cancel', toolName: 'Grep', state: 'ok', resultJson: '<tool_use_error>rtp-操作被 Cancelled</tool_use_error>' } });
  await prisma.toolCall.create({ data: { turnId: tSkill.id, toolCallId: 'rtp-tc-skill-ok', toolName: 'Read', state: 'ok', resultJson: 'rtp-正常结果' } });
  await prisma.skillEvent.create({ data: { turnId: tSkill.id, skillName: 'rtp-skill', eventType: 'invoke', success: false, errorMessage: 'rtp-技能失败原因' } });

  ctx.turnIds = {
    long: tLong.id, sum: tSum.id, state: tState.id, exit: tExit.id,
    cancel: tCancel.id, skill: tSkill.id, trunc: tTrunc.id, clean: tClean.id,
  };
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: SID } });
  await prisma.$disconnect();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  if (ORIG_HOME === undefined) delete process.env.CONTEXT_INSIGHT_HOME;
  else process.env.CONTEXT_INSIGHT_HOME = ORIG_HOME;
});

function getTurns(query = '') {
  return runTurnsGET(
    new NextRequest(`http://localhost/api/observe/run/${RUN_ID}/turns${query}`),
    { params: Promise.resolve({ runId: RUN_ID }) },
  );
}

describe('run turns 性能层（详情页逐 tab 提速）', () => {
  it('轻投影：正文不进响应——缺失回退 200 字符，空串/既有摘要口径不变', async () => {
    const res = await getTurns('?page=1&pageSize=50');
    expect(res.status).toBe(200);
    const data = await res.json();
    const byId = new Map(data.items.map((i: { turnId: string }) => [i.turnId, i]));
    // 无 summary：恒 200 字符头（5 字/字组 × 40 = 200）
    expect((byId.get(ctx.turnIds.long) as { contentSummary: string }).contentSummary).toBe(LONG_CONTENT.substring(0, 200));
    expect((byId.get(ctx.turnIds.long) as { contentSummary: string }).contentSummary.length).toBe(200);
    // 空串 summary：?? 不捕获 falsy，保持空串（不触发回退）
    expect((byId.get(data.items.find((i: { turnIndex: number }) => i.turnIndex === 1).turnId) as { contentSummary: string }).contentSummary).toBe('');
    // 无 summary 无 content：null
    expect((byId.get(data.items.find((i: { turnIndex: number }) => i.turnIndex === 2).turnId) as { contentSummary: string }).contentSummary).toBeNull();
    // 既有摘要：原样（不被回退覆盖）
    expect((byId.get(ctx.turnIds.sum) as { contentSummary: string }).contentSummary).toBe('rtp-既有摘要');
    // 轻投影恒不携带 resultJson（includeToolResult 未请求）
    for (const item of data.items) {
      for (const tc of item.toolCalls ?? []) {
        expect(tc.resultJson).toBeUndefined();
      }
    }
  });

  it('includeErrorDigest：服务端摘要与客户端原文计算逐值同口径，非错误轮零携带', async () => {
    const scope = (await resolveRunScope(RUN_ID, prisma))!;
    // 原文基准（客户端旧路径的输入形状）：从 DB 直取含 resultJson 的完整工具调用
    const rawRows = await prisma.turn.findMany({
      where: { sessionId: ctx.sessionId },
      include: {
        toolCalls: { select: { toolCallId: true, toolName: true, state: true, errorType: true, resultJson: true } },
        skillEvents: { select: { skillName: true, eventType: true, success: true, errorMessage: true } },
      },
      orderBy: [{ turnIndex: 'asc' }],
    });
    const rawDigestOf = (turnId: string) => {
      const t = rawRows.find(r => r.id === turnId)!;
      const summary = summarizeToolCallErrors(t.toolCalls, t.skillEvents, t.finishReason);
      return {
        ...summary,
        messages: t.toolCalls.map(tc => ({ toolName: tc.toolName, message: toolCallErrorMessage(tc) })).filter(m => m.message !== ''),
        skillMessages: t.skillEvents.filter(se => !se.success && se.errorMessage).map(se => ({ skillName: se.skillName, message: se.errorMessage!.substring(0, 60) })),
      };
    };

    const result = await collectScopeTurns(prisma, scope, { page: 1, pageSize: 50, includeErrorDigest: true });
    const byId = new Map(result.items.map(i => [i.turnId, i]));

    // parity：错误轮 digest 与原文基准逐值相等（计数/明细/消息/技能消息）
    for (const key of ['state', 'exit', 'cancel', 'skill', 'trunc'] as const) {
      const item = byId.get(ctx.turnIds[key]) as { errorDigest?: TurnErrorDigest };
      expect(item.errorDigest, `digest 在场：${key}`).toBeDefined();
      expect(item.errorDigest).toEqual(rawDigestOf(ctx.turnIds[key]));
    }
    // 具体信号抽查：state 错误 / Exit code 消息 / cancelled / 技能失败 / 截断
    expect(byId.get(ctx.turnIds.state)!.errorDigest!.failed).toBe(1);
    expect(byId.get(ctx.turnIds.exit)!.errorDigest!.messages).toEqual([{ toolName: 'Read', message: 'exit 1' }]);
    expect(byId.get(ctx.turnIds.cancel)!.errorDigest!.cancelled).toBe(1);
    expect(byId.get(ctx.turnIds.cancel)!.errorDigest!.messages[0].message).toContain('rtp-操作被 Cancelled');
    expect(byId.get(ctx.turnIds.skill)!.errorDigest!.skillFail).toBe(1);
    expect(byId.get(ctx.turnIds.skill)!.errorDigest!.skillMessages).toEqual([{ skillName: 'rtp-skill', message: 'rtp-技能失败原因' }]);
    expect(byId.get(ctx.turnIds.trunc)!.errorDigest!.truncated).toBe(1);
    // 干净轮：无 digest（响应零冗余）
    expect((byId.get(ctx.turnIds.clean) as { errorDigest?: TurnErrorDigest }).errorDigest).toBeUndefined();
    // 路由参数透传（API 层契约）
    const res = await getTurns('?page=1&pageSize=50&includeErrorDigest=true');
    const data = await res.json();
    const routeItem = data.items.find((i: { turnId: string }) => i.turnId === ctx.turnIds.exit);
    expect(routeItem.errorDigest.failed).toBe(1);
    expect(routeItem.errorDigest.messages).toEqual([{ toolName: 'Read', message: 'exit 1' }]);
  });

  it('includeToolResult 语义保持：显式请求仍携带原文', async () => {
    const res = await getTurns('?page=1&pageSize=50&includeToolDetail=true');
    const data = await res.json();
    const exitTurn = data.items.find((i: { turnId: string }) => i.turnId === ctx.turnIds.exit);
    expect(exitTurn.toolCalls[0].resultJson).toContain('Exit code 1');
  });

  it('warmWireTimings：claude-format 预热捕获推导，非 claude 跳过，缺文件容忍；预热后请求路径零冷读', async () => {
    // wire 捕获：assistant tool_use → user tool_result，间隙 3000ms
    const capturePath = path.join(tmpHome, 'rtp-warm.jsonl');
    fs.writeFileSync(capturePath, [
      JSON.stringify({ type: 'assistant', timestamp: '2026-10-13T02:05:00.000Z', duration_ms: 120, message: { content: [{ type: 'tool_use', id: 'rtp-warmu-1', name: 'Bash' }] } }),
      JSON.stringify({ type: 'user', timestamp: '2026-10-13T02:05:03.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'rtp-warmu-1' }] } }),
      '',
    ].join('\n'));
    const warmSid = 'rtp-ses-warm';
    const missingSid = 'rtp-ses-warm-missing';
    const nativeSid = 'rtp-ses-warm-native';
    await prisma.session.deleteMany({ where: { taskId: { in: [warmSid, missingSid, nativeSid] } } });
    const mkSession = (taskId: string, framework: string, sourcePath: string | null) =>
      prisma.session.create({ data: { taskId, framework, sourcePath, startTime: new Date('2026-10-13T02:00:00Z') } });
    const warmSession = await mkSession(warmSid, 'claude-code', capturePath);
    await mkSession(missingSid, 'claude-code', path.join(tmpHome, 'rtp-不存在.jsonl'));
    await mkSession(nativeSid, 'opencode', capturePath); // 非 claude-format：跳过
    const warmTurn = await prisma.turn.create({
      data: { sessionId: warmSession.id, turnIndex: 0, role: 'assistant', createdAt_ts: new Date('2026-10-13T02:05:00Z') },
    });
    await prisma.toolCall.create({
      data: { turnId: warmTurn.id, toolCallId: 'rtp-warmu-1', toolName: 'Bash', state: 'ok' }, // durationMs=0 → 走 wire 增补
    });

    try {
      const summary = await warmWireTimings(prisma);
      expect(summary.candidates).toBeGreaterThanOrEqual(3);
      expect(summary.warmed).toBeGreaterThanOrEqual(2); // warm + missing（缺文件容忍，不抛）
      expect(summary.skipped).toBeGreaterThanOrEqual(1); // opencode 跳过

      // 预热后请求路径：durationMs 增补来自缓存的 wire 区间（零冷读）
      const scope = (await resolveRunScope(`solo:${warmSid}`, prisma))!;
      const result = await collectScopeTurns(prisma, scope, { page: 1, pageSize: 10 });
      expect(result.items[0].toolCalls[0].durationMs).toBe(3000);
    } finally {
      await prisma.session.deleteMany({ where: { taskId: { in: [warmSid, missingSid, nativeSid] } } });
    }
  });
});
