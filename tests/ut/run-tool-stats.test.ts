// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// run tool-stats 路由 IT（API 层验证，真 test.db）：/api/observe/run/[runId]/
// tool-stats 的工具维度聚合全链路——①per-tool 聚合（调用数 / Σ时长 / p50·p95
// 近秩分位 / 均值 / 错误与错误类型）；②计时来源三态：DB 真实值优先、
// durationMs=0 时 wire 回填（claude-format 捕获按 toolCallId 推导，opencode
// 无 wire → 如实计入 untimed 不进分位）；③Task/agent 派发窗口单独标注、
// 不进 meta.totalToolMs（与 lib/tool-timing 双计教义同源）；④tool × member
// 矩阵（格含 firstTurnId 下钻锚点，取最早轮）；⑤错误判别单一源（state ok
// 但 result 含 <tool_use_error>Cancelled 仍判 cancelled——superset 查询
// 覆盖）；⑥矩阵格逐轮聚合（三级下钻数据源：同轮多调用一行 / ts 升序 /
// wire 回填与无计时如实入行）；⑦run 不存在 404。成员 = mini-bundle 双成员
// run（唯一 sessionIds 防测试并行撞库）。

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { GET as toolStatsGET } from '@/app/api/observe/run/[runId]/tool-stats/route';
import { parseManifest } from '@/lib/run/reader';
import { saveRun } from '@/lib/run/run-store';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-run-tool-stats-'));
const ORIG_HOME = process.env.CONTEXT_INSIGHT_HOME;

// 唯一 runId/成员 sessionIds（并行测试不与其他 mini-bundle 用例撞库）
const RUN_SUFFIX = process.env.VITEST_POOL_ID ?? '0';
const RUN_ID = `ts-run-${RUN_SUFFIX}`;
const MEM_A = `ts-a-${RUN_SUFFIX}`;
const MEM_B = `ts-b-${RUN_SUFFIX}`;

const ctx: { turnIds: Record<string, string> } = { turnIds: {} };

/** mini-bundle workflow 改写 runId 与会话成员 sessionId 后存 run-store（成员
 *  资格 = 成员位引用了会话，resolveRunScope 据此合成双成员作用域） */
function miniManifestWithSuffix() {
  const raw = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, './data/run/mini-bundle/workflow.json'), 'utf-8'),
  ) as { id: string; data: { members: Array<{ sessionId?: string | null }> } };
  raw.id = RUN_ID;
  // 全部 session 成员改写为唯一 id（防并行用例的 mini-bundle 会话混入作用域；
  // MEM_C 不建会话 → 成员缺席）
  const remap = new Map([['ses_mini_a', MEM_A], ['ses_mini_b', MEM_B], ['ses_mini_c', `ts-c-${RUN_SUFFIX}`]]);
  for (const m of raw.data.members) {
    if (m.sessionId && remap.has(m.sessionId)) m.sessionId = remap.get(m.sessionId)!;
  }
  return parseManifest(raw as Parameters<typeof parseManifest>[0]);
}

beforeAll(async () => {
  process.env.CONTEXT_INSIGHT_HOME = tmpHome;
  saveRun(miniManifestWithSuffix(), null, path.join(tmpHome, 'runs'));
  await prisma.session.deleteMany({ where: { taskId: { in: [MEM_A, MEM_B] } } });

  // wire 捕获（成员 B = claude-format）：assistant tool_use → user tool_result
  // 间隙 2500ms——成员 B 的 durationMs=0 调用按 toolCallId 回填
  const capture = path.join(tmpHome, `ts-wire-${RUN_SUFFIX}.jsonl`);
  fs.writeFileSync(capture, [
    JSON.stringify({ type: 'assistant', timestamp: '2026-10-13T02:10:00.000Z', duration_ms: 100, message: { content: [{ type: 'tool_use', id: 'ts-wireu-1', name: 'Grep' }] } }),
    JSON.stringify({ type: 'user', timestamp: '2026-10-13T02:10:02.500Z', message: { content: [{ type: 'tool_result', tool_use_id: 'ts-wireu-1' }] } }),
    '',
  ].join('\n'));

  const sa = await prisma.session.create({
    data: { taskId: MEM_A, framework: 'opencode', startTime: new Date('2026-10-13T02:00:00Z'), endTime: new Date('2026-10-13T02:09:00Z') },
  });
  const sb = await prisma.session.create({
    data: { taskId: MEM_B, framework: 'claude-code', sourcePath: capture, startTime: new Date('2026-10-13T02:10:00Z'), endTime: new Date('2026-10-13T02:19:00Z') },
  });

  const mkTurn = (sessionId: string, turnIndex: number, at: string) =>
    prisma.turn.create({ data: { sessionId, turnIndex, role: 'assistant', createdAt_ts: new Date(at) } });
  const ta1 = await mkTurn(sa.id, 0, '2026-10-13T02:00:10Z');
  const ta2 = await mkTurn(sa.id, 1, '2026-10-13T02:01:10Z');
  const ta3 = await mkTurn(sa.id, 2, '2026-10-13T02:02:10Z');
  const tb1 = await mkTurn(sb.id, 0, '2026-10-13T02:10:00Z');
  const tb2 = await mkTurn(sb.id, 1, '2026-10-13T02:11:00Z');
  ctx.turnIds = { ta1: ta1.id, ta2: ta2.id, ta3: ta3.id, tb1: tb1.id, tb2: tb2.id };

  const mkCall = (
    turnId: string,
    data: Omit<Prisma.ToolCallUncheckedCreateInput, 'turnId' | 'state'> & { state?: string },
  ) => prisma.toolCall.create({ data: { state: 'ok', ...data, turnId } });

  // 成员 A（opencode 无 wire）：
  // Bash ×3（1000/3000/5000，末次 error）· Read ×1 无计时 · Edit ×1 state ok
  // 但 result 含 <tool_use_error>Cancelled（错误判别单一源的 cancelled 路）
  // · WebSearch ×2 同轮（ta1）——矩阵格逐轮聚合「同轮多调用一行」断言用
  await mkCall(ta1.id, { toolCallId: 'ts-tc-bash-1', toolName: 'Bash', durationMs: 1000 });
  await mkCall(ta2.id, { toolCallId: 'ts-tc-bash-2', toolName: 'Bash', durationMs: 3000 });
  await mkCall(ta3.id, { toolCallId: 'ts-tc-bash-3', toolName: 'Bash', durationMs: 5000, state: 'error', errorType: 'exit-1' });
  await mkCall(ta2.id, { toolCallId: 'ts-tc-read-1', toolName: 'Read', durationMs: 0 });
  await mkCall(ta3.id, { toolCallId: 'ts-tc-edit-1', toolName: 'Edit', durationMs: 500, resultJson: '<tool_use_error>用户操作被 Cancelled</tool_use_error>' });
  await mkCall(ta1.id, { toolCallId: 'ts-tc-ws-1', toolName: 'WebSearch', durationMs: 600 });
  await mkCall(ta1.id, { toolCallId: 'ts-tc-ws-2', toolName: 'WebSearch', durationMs: 400 });

  // 成员 B（claude-format + wire）：
  // Grep wire 回填 2500（durationMs=0）· Grep 真实 1500 · Task 派发 3500
  // · skill 元调用 40（提示词注入类，isSkillRelated 透传断言用）
  await mkCall(tb1.id, { toolCallId: 'ts-wireu-1', toolName: 'Grep', durationMs: 0 });
  await mkCall(tb2.id, { toolCallId: 'ts-tc-grep-2', toolName: 'Grep', durationMs: 1500 });
  await mkCall(tb2.id, { toolCallId: 'ts-tc-task-1', toolName: 'Task', durationMs: 3500 });
  await mkCall(tb1.id, {
    toolCallId: 'ts-tc-skill-1', toolName: 'skill', durationMs: 40, isSkillRelated: true,
    argsJson: '{"name":"demo-skill","summary":"Loaded skill: demo-skill"}',
  });
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: { in: [MEM_A, MEM_B] } } });
  await prisma.$disconnect();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  if (ORIG_HOME === undefined) delete process.env.CONTEXT_INSIGHT_HOME;
  else process.env.CONTEXT_INSIGHT_HOME = ORIG_HOME;
});

function getStats(runId: string) {
  return toolStatsGET(
    new NextRequest(`http://localhost/api/observe/run/${runId}/tool-stats`),
    { params: Promise.resolve({ runId }) },
  );
}

/** 夹具轮时刻（epoch ms）——逐轮行 ts 断言用 */
const T = (s: string) => new Date(`2026-10-13T${s}Z`).getTime();

describe('run tool-stats（工具维度耗时统计，API 层）', () => {
  it('per-tool 聚合：Σ/分位/均值/错误类型 + 排行序（totalMs 降序）', async () => {
    const res = await getStats(RUN_ID);
    expect(res.status).toBe(200);
    const body = await res.json();
    const names = (body.tools as Array<{ toolName: string }>).map(t => t.toolName);
    // Bash 9000 > Grep 4000 > Task 3500（派发）> WebSearch 1000 > Edit 500 > skill 40（元调用）> Read 0（无计时）
    expect(names).toEqual(['Bash', 'Grep', 'Task', 'WebSearch', 'Edit', 'skill', 'Read']);

    const bash = body.tools.find((t: { toolName: string }) => t.toolName === 'Bash');
    expect(bash.calls).toBe(3);
    expect(bash.errors).toBe(1);
    expect(bash.totalMs).toBe(9000);
    expect(bash.timedCalls).toBe(3);
    expect(bash.untimedCalls).toBe(0);
    expect(bash.minMs).toBe(1000);
    expect(bash.p50Ms).toBe(3000);
    expect(bash.p95Ms).toBe(5000);
    expect(bash.maxMs).toBe(5000);
    expect(bash.avgMs).toBe(3000);
    expect(bash.errorTypes).toEqual([{ type: 'exit-1', count: 1 }]);
    expect(bash.isDispatch).toBe(false);
  });

  it('计时三态：wire 回填（claude-format 捕获）/ 无计时不进分位 / DB 原值优先', async () => {
    const body = await (await getStats(RUN_ID)).json();
    const grep = body.tools.find((t: { toolName: string }) => t.toolName === 'Grep');
    expect(grep.calls).toBe(2);
    expect(grep.wireDerived).toBe(1);          // ts-wireu-1：durationMs=0 → wire 2500
    expect(grep.totalMs).toBe(4000);           // 2500 + 1500
    expect(grep.untimedCalls).toBe(0);
    expect(grep.p50Ms).toBe(1500);             // [1500, 2500] 近秩 p50 = 1500

    const read = body.tools.find((t: { toolName: string }) => t.toolName === 'Read');
    expect(read.timedCalls).toBe(0);
    expect(read.untimedCalls).toBe(1);         // opencode 无 wire → 如实无计时
    expect(read.p50Ms).toBe(0);
    expect(read.totalMs).toBe(0);

    expect(body.meta.wireDerivedCalls).toBe(1);
    expect(body.meta.untimedCalls).toBe(1);
    expect(body.meta.timedCalls).toBe(10);
    expect(body.meta.totalCalls).toBe(11);
    // Σ 工具执行 = Bash 9000 + Grep 4000 + WebSearch 1000 + Edit 500 + skill 40（Task 派发另计）
    expect(body.meta.totalToolMs).toBe(14540);
    expect(body.meta.dispatchMs).toBe(3500);
  });

  it('派发窗口：Task 单独标注不进 Σ 工具执行（双计教义同源）', async () => {
    const body = await (await getStats(RUN_ID)).json();
    const task = body.tools.find((t: { toolName: string }) => t.toolName === 'Task');
    expect(task.isDispatch).toBe(true);
    expect(task.totalMs).toBe(3500);
    // Edit 的 cancelled：state ok 但 result 含 <tool_use_error>Cancelled——
    // 错误判别单一源（superset 查询覆盖 result 标记）
    const edit = body.tools.find((t: { toolName: string }) => t.toolName === 'Edit');
    expect(edit.errors).toBe(1);
    expect(edit.errorTypes).toEqual([{ type: 'cancelled', count: 1 }]);
  });

  it('tool × member 矩阵：格聚合 + firstTurnId 取最早轮；成员轴双成员', async () => {
    const body = await (await getStats(RUN_ID)).json();
    expect(body.members.sort()).toEqual([MEM_A, MEM_B].sort());

    const bashA = body.matrix.Bash[MEM_A];
    expect(bashA).toBeDefined();
    expect(bashA.calls).toBe(3);
    expect(bashA.totalMs).toBe(9000);
    expect(bashA.errors).toBe(1);
    expect(bashA.firstTurnId).toBe(ctx.turnIds.ta1);

    const grepB = body.matrix.Grep[MEM_B];
    expect(grepB.calls).toBe(2);
    expect(grepB.totalMs).toBe(4000);
    expect(grepB.firstTurnId).toBe(ctx.turnIds.tb1);   // 两格中最早轮

    // Bash 只在成员 A：B 列无格
    expect(body.matrix.Bash[MEM_B]).toBeUndefined();
  });

  it('矩阵格逐轮聚合（三级下钻数据源）：同轮多调用一行 / ts 升序 / wire 回填与无计时如实入行', async () => {
    const body = await (await getStats(RUN_ID)).json();

    // WebSearch ×2 同轮（ta1）聚合一行：calls 2、Σ 1000——跳转目标 = 轮
    const ws = body.matrix.WebSearch[MEM_A];
    expect(ws.turns).toEqual([
      { turnId: ctx.turnIds.ta1, turnIndex: 0, calls: 2, totalMs: 1000, errors: 0, ts: T('02:00:10') },
    ]);

    // Bash 三轮三行（ts 升序定序；错误入行；#N 序号 = 会话内 turnIndex）
    const bashA = body.matrix.Bash[MEM_A];
    expect(bashA.turns).toEqual([
      { turnId: ctx.turnIds.ta1, turnIndex: 0, calls: 1, totalMs: 1000, errors: 0, ts: T('02:00:10') },
      { turnId: ctx.turnIds.ta2, turnIndex: 1, calls: 1, totalMs: 3000, errors: 0, ts: T('02:01:10') },
      { turnId: ctx.turnIds.ta3, turnIndex: 2, calls: 1, totalMs: 5000, errors: 1, ts: T('02:02:10') },
    ]);
    // firstTurnId 与逐轮首行同源（最早轮）
    expect(bashA.firstTurnId).toBe(bashA.turns[0].turnId);

    // Grep wire 回填入行（tb1 2500 是 toolUseId 间隙推导值）
    expect(body.matrix.Grep[MEM_B].turns).toEqual([
      { turnId: ctx.turnIds.tb1, turnIndex: 0, calls: 1, totalMs: 2500, errors: 0, ts: T('02:10:00') },
      { turnId: ctx.turnIds.tb2, turnIndex: 1, calls: 1, totalMs: 1500, errors: 0, ts: T('02:11:00') },
    ]);

    // 无计时调用如实入行（totalMs 0——轮跳转目标仍有效，轴不撒谎）
    expect(body.matrix.Read[MEM_A].turns).toEqual([
      { turnId: ctx.turnIds.ta2, turnIndex: 1, calls: 1, totalMs: 0, errors: 0, ts: T('02:01:10') },
    ]);
  });

  it('skill 族元调用：isSkillRelated 透传采集侧单一源（提示词注入类——计时如实、不派发）', async () => {
    const body = await (await getStats(RUN_ID)).json();
    const skill = body.tools.find((t: { toolName: string }) => t.toolName === 'skill');
    expect(skill.isSkillRelated).toBe(true);
    expect(skill.isDispatch).toBe(false);
    expect(skill.calls).toBe(1);
    expect(skill.totalMs).toBe(40);       // DB 原值优先照常（非派发 → 进 Σ）
    expect(skill.errors).toBe(0);
    // 普通工具不带标（flag 只标元调用族）
    const bash = body.tools.find((t: { toolName: string }) => t.toolName === 'Bash');
    expect(bash.isSkillRelated).toBe(false);
  });

  it('run 不存在 → 404', async () => {
    const res = await getStats('ts-run-不存在');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.reason).toBe('run-not-found');
  });
});
