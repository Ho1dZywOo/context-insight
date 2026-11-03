// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// run 合并 Context/Perf IT（ContextTracker run 泛化）：
// 真实 fixture（mini-bundle，rop- 前缀）+ 真实 prisma 种跨成员上下文轮次 / 执行切片 →
// 锁：①context 全量瘦轮次投影（member 归因 + root/subagent + 每 agent 窗口上限、
// subagent 模型归一、无重负载字段）；
// ②executions 镜像 session 端点形状（items/root/subagents + 技能挂接 + member 闸）；
// ③turns light 投影新增 cache/context 字段 + 子代理模型归一 + 单成员大页放行
// （跨成员混排恒 500 上限）。

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { parseAndIndex } from '@/lib/run/reader';
import { saveRun, type RunImportMeta } from '@/lib/run/run-store';
import { prisma } from '@/lib/db';
import { GET as runContextGET } from '@/app/api/observe/run/[runId]/context/route';
import { GET as runExecutionsGET } from '@/app/api/observe/run/[runId]/executions/route';
import { GET as runTurnsGET } from '@/app/api/observe/run/[runId]/turns/route';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-run-observe-context-'));
const ORIG_HOME = process.env.CONTEXT_INSIGHT_HOME;

const RUN_ID = 'minidemo01';
const MEMBER_SIDS = ['ropc-ses-mini-a', 'ropc-ses-mini-b', 'ropc-ses-mini-c'];
const MEMBER_A = 'ropc-ses-mini-a';
const MODEL = 'volc-gateway/glm-4.7';

beforeAll(async () => {
  process.env.CONTEXT_INSIGHT_HOME = tmpHome;
  const rewrite = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(/^ses_mini_/, 'ropc-ses-mini-');
    if (Array.isArray(v)) return v.map(rewrite);
    if (v != null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, rewrite(val)]));
    }
    return v;
  };
  const manifest = parseAndIndex(
    rewrite(JSON.parse(fs.readFileSync(path.resolve(__dirname, './data/run/mini-bundle/workflow.json'), 'utf-8'))) as Parameters<typeof parseAndIndex>[0],
  ).manifest;
  const meta: RunImportMeta = {
    schema: 'insight-run-import',
    version: 1,
    data: {
      importedAt: '2026-10-15T10:00:00+08:00',
      sourceDir: '/bundle/mini',
      manifestFile: 'workflow.json',
      exportDataComplete: true,
      sessions: { total: 3, imported: 3, existing: 0, missingFile: 0, failed: 0 },
      failures: [],
      warnings: [],
      ownedSessions: MEMBER_SIDS.map(sid => ({ sid, framework: 'opencode' })),
    },
  };
  saveRun(manifest, meta);

  await prisma.session.deleteMany({ where: { taskId: { in: MEMBER_SIDS } } });
  await prisma.session.createMany({
    data: MEMBER_SIDS.map((sid, i) => ({
      taskId: sid,
      framework: 'opencode',
      model: MODEL,
      totalTokens: 100 * (i + 1),
      startTime: new Date('2026-10-13T02:00:00Z'),
      endTime: new Date('2026-10-13T02:10:00Z'),
    })),
  });
  const ids = await Promise.all(
    MEMBER_SIDS.map(sid => prisma.session.findFirst({ where: { taskId: sid }, select: { id: true } })),
  );
  const [sa, sb, sc] = ids.map(r => r!.id);

  // 上下文水位（root 轮）：a 峰值 55 / b 峰值 80 / c 峰值 ~95（+ 450 点触发降采样）
  const mkCtx = (sessionId: string, turnIndex: number, pct: number, at: string) =>
    ({ sessionId, turnIndex, role: 'assistant', content: `rop-turn-${turnIndex}`, createdAt_ts: new Date(at), contextWindowPct: pct, cacheReadTokens: 10, cacheWriteTokens: 5 });
  await prisma.turn.create({ data: { ...mkCtx(sa, 0, 10, '2026-10-13T02:00:10Z'), model: MODEL, totalTokens: 100, latencyMs: 800 } });
  await prisma.turn.create({ data: { ...mkCtx(sa, 1, 55, '2026-10-13T02:00:40Z'), model: MODEL, totalTokens: 120, latencyMs: 900 } });
  await prisma.turn.create({ data: { ...mkCtx(sb, 0, 30, '2026-10-13T02:00:20Z'), model: MODEL } });
  await prisma.turn.create({ data: { ...mkCtx(sb, 1, 80, '2026-10-13T02:00:50Z'), model: MODEL } });
  await prisma.turn.createMany({
    data: Array.from({ length: 450 }, (_, k) => mkCtx(sc, k, Math.round((k / 449) * 95 * 10) / 10, new Date(Date.parse('2026-10-13T02:00:30Z') + k * 1000).toISOString())),
  });

  // 子代理泳道：null-model 轮 + 后继带 model 轮（首见 assistant 定型 → 归一到 sub 模型）
  await prisma.turn.create({
    data: { sessionId: sa, turnIndex: 2, role: 'assistant', content: 'rop-sub-null-model', createdAt_ts: new Date('2026-10-13T02:00:45Z'), isSubagent: true, subagentSessionId: 'rop-sub-1', subagentName: 'rop-研究员' },
  });
  await prisma.turn.create({
    data: { sessionId: sa, turnIndex: 3, role: 'assistant', content: 'rop-sub-with-model', createdAt_ts: new Date('2026-10-13T02:00:46Z'), isSubagent: true, subagentSessionId: 'rop-sub-1', subagentName: 'rop-研究员', model: 'glm-4.7-sub' },
  });

  // 执行切片（成员 a）：root + subagent + 技能挂接
  const rootExec = await prisma.execution.create({
    data: { sessionId: sa, agentName: 'rop-alpha-agent', tokens: 500, inputTokens: 300, outputTokens: 200, latencyMs: 1200, toolCallCount: 3, llmCallCount: 2, model: MODEL },
  });
  await prisma.execution.create({
    data: { sessionId: sa, agentName: 'rop-研究员', agentSessionId: 'rop-sub-1', isSubagent: true, subagentType: 'research', subagentName: 'rop-研究员', rootExecutionId: rootExec.id, parentExecutionId: rootExec.id, depth: 1, tokens: 150, latencyMs: 600, toolCallCount: 1, skillInvokeCount: 2, model: 'glm-4.7-sub' },
  });
  await prisma.executionSkill.create({ data: { executionId: rootExec.id, skillName: 'rop-skill-x', skillVersion: 3, isPrimary: true } });

  // 子代理类型桥锚（identity join 同源）：rop-sub-1 → research
  await prisma.interactionBridge.create({
    data: { sessionId: sa, dispatchExecutionId: rootExec.id, subagentSessionId: 'rop-sub-1', subagentType: 'research', dispatchContent: '调研一下' },
  });
});

afterAll(async () => {
  for (const sid of MEMBER_SIDS) {
    try { await prisma.session.deleteMany({ where: { taskId: sid } }); } catch { /* ignore */ }
  }
  await prisma.$disconnect();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  if (ORIG_HOME === undefined) delete process.env.CONTEXT_INSIGHT_HOME;
  else process.env.CONTEXT_INSIGHT_HOME = ORIG_HOME;
});

function get(runId: string, seg: string, query = '') {
  const handler = seg === 'context' ? runContextGET : seg === 'executions' ? runExecutionsGET : runTurnsGET;
  return handler(
    new NextRequest(`http://localhost/api/observe/run/${runId}/${seg}${query}`),
    { params: Promise.resolve({ runId }) },
  );
}

describe('run 合并 Context/Perf 观测（ContextTracker run 泛化）', () => {
  it('context：全量瘦轮次投影（member 归因 + root/subagent）+ 每 agent 窗口上限（subagent 模型归一）', async () => {
    const res = await get(RUN_ID, 'context');
    expect(res.status).toBe(200);
    const data = await res.json();
    // 全量轮次：a（2 root + 2 sub）+ b（2 root）+ c（450 root）
    expect(data.total).toBe(456);
    expect(data.turns).toHaveLength(456);
    // member 归因：root 轮带成员短名（与泳道 root 道 / executions 同源）
    const a0 = data.turns.find((t: { member: { taskId: string } | null; isSubagent: boolean; turnIndex: number }) => t.member?.taskId === MEMBER_A && !t.isSubagent && t.turnIndex === 0);
    expect(a0).toBeTruthy();
    expect(a0.member).toEqual({ taskId: MEMBER_A, label: 'build·g0' });
    expect(a0.role).toBe('assistant');
    expect(a0.contextWindowPct).toBe(10);
    expect(a0.cacheReadTokens).toBe(10);
    expect(a0.cacheWriteTokens).toBe(5);
    // contentSummary 回退（content 前 200 字）——压缩检测/命令轮识别依赖
    expect(a0.contentSummary).toBe('rop-turn-0');
    // 子代理轮在场（sid 池化分组材料 + member 归因）；类型回填 = 桥锚同源
    //（泳道图例键 `subagentType ?? agentName` 的前半），root 轮恒 null
    const sub = data.turns.find((t: { subagentSessionId: string | null }) => t.subagentSessionId === 'rop-sub-1');
    expect(sub).toBeTruthy();
    expect(sub.member.taskId).toBe(MEMBER_A);
    expect(sub.subagentType).toBe('research');
    expect(a0.subagentType).toBeNull();
    // agentLimits：root 每成员一条（成员序），模型 → 窗口上限同源
    const roots = data.agentLimits.filter((l: { kind: string }) => l.kind === 'root');
    expect(roots.map((l: { key: string }) => l.key)).toEqual(MEMBER_SIDS.map(sid => `root:${sid}`));
    for (const r of roots) {
      expect(r.model).toBe(MODEL);
      expect(r.contextLimit).toBeGreaterThan(0);
    }
    // subagent 上限：首见非空轮模型归一（glm-4.7-sub，非会话模型）
    const subLimit = data.agentLimits.find((l: { key: string }) => l.key === 'rop-sub-1');
    expect(subLimit.kind).toBe('subagent');
    expect(subLimit.model).toBe('glm-4.7-sub');
    expect(subLimit.contextLimit).toBeGreaterThan(0);
    // 瘦投影护栏：无重负载字段（toolCalls/skillEvents 不透出）
    expect(a0.toolCalls).toBeUndefined();
    expect(a0.skillEvents).toBeUndefined();
  });

  it('executions：镜像 session 端点形状（items/root/subagents + 技能挂接）+ member 过滤与非法闸', async () => {
    const all = await get(RUN_ID, 'executions');
    expect(all.status).toBe(200);
    const allData = await all.json();
    expect(allData.totalExecutions).toBe(2);
    expect(allData.root).toHaveLength(1);
    expect(allData.subagents).toHaveLength(1);
    expect(allData.items.find((e: { isSubagent: boolean }) => !e.isSubagent).skills).toEqual([
      { skillName: 'rop-skill-x', skillVersion: 3, isPrimary: true },
    ]);

    const one = await get(RUN_ID, 'executions', `?member=${MEMBER_A}`);
    expect(one.status).toBe(200);
    const oneData = await one.json();
    expect(oneData.totalExecutions).toBe(2);
    expect(oneData.subagentCount).toBe(1);
    expect(oneData.subagents[0].model).toBe('glm-4.7-sub');
    // 成员归因（刀F）：items 带 member；label = 图结构短名（刀G：nodeId +
    // 角色消歧，不用 prompt 开头的 session.label；session 端点镜像不含此字段）；
    // isProxy = 该成员会话行判定（run 级混布可见，泳道身份/活跃展开按成员走）
    for (const e of oneData.items) {
      expect(e.member).toEqual({ taskId: MEMBER_A, label: "build·g0", isProxy: false });
    }

    const bad = await get(RUN_ID, 'executions', '?member=rop-not-in-run');
    expect(bad.status).toBe(400);
    const badBody = await bad.json();
    expect(badBody.reason).toBe('member-not-in-run');

    const missing = await get('rop-no-such-run', 'executions');
    expect(missing.status).toBe(404);
  });

  it('turns：light 投影带 cache/context 字段 + 子代理模型归一 + 页容量上限 20000（刀F 统一）', async () => {
    const res = await get(RUN_ID, 'turns');
    expect(res.status).toBe(200);
    const data = await res.json();
    // 缺省 200；显式大页放行到 20000（light 投影，Perf 全景等整段消费方）；
    // 超限钳到 20000
    expect(data.pageSize).toBe(200);
    const mergedBig = await get(RUN_ID, 'turns', '?pageSize=20000');
    expect((await mergedBig.json()).pageSize).toBe(20000);
    const clamped = await get(RUN_ID, 'turns', '?pageSize=999999');
    expect((await clamped.json()).pageSize).toBe(20000);
    // a 的 root 轮：cache/context 新字段透出
    const a0 = data.items.find((i: { member: { taskId: string }; turnIndex: number }) => i.member?.taskId === MEMBER_A && i.turnIndex === 0);
    expect(a0).toBeTruthy();
    expect(a0.contextWindowPct).toBe(10);
    expect(a0.cacheReadTokens).toBe(10);
    expect(a0.cacheWriteTokens).toBe(5);
    // 子代理 null-model 轮：归一到该 subagent 首个 assistant model
    const subNull = data.items.find((i: { contentSummary: string | null }) => i.contentSummary === 'rop-sub-null-model');
    expect(subNull.model).toBe('glm-4.7-sub');

    // 单成员大页放行：a 全量（root 2 + sub 2）
    const big = await get(RUN_ID, 'turns', `?member=${MEMBER_A}&pageSize=20000`);
    expect(big.status).toBe(200);
    const bigData = await big.json();
    expect(bigData.pageSize).toBe(20000);
    expect(bigData.total).toBe(4);
  });
});
