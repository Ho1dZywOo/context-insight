// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// turn-digest IT（run 成员视图轻摘要）：真实 prisma 种会话/轮次/skill 事件 →
// 锁：①响应形状——轮次只有 turnId/turnIndex/isSubagent 三字段（无 content/
// token 等重字段，聚合消费面不需要 member-turns 全量轮次）；②skill 事件
// (name,eventType) 聚合计数（重复事件合并、无名事件跳过、首见序）；③
// turnIndex 升序；④共享契约 buildMainAgentTurnMap 主 agent 轮优先 + 无主轮
// index 回退、expandSkillEvents 展开保序保量（喂 deriveAuditableTargets 的
// 原始形状，skillEventCount 语义不变）；⑤solo run 免 member 直取；⑥run
// 不存在 404。

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { GET as runTurnDigestGET } from '@/app/api/observe/run/[runId]/turn-digest/route';
import { buildMainAgentTurnMap, expandSkillEvents, type TurnDigest } from '@/lib/shared/turn-digest';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-turn-digest-'));
const ORIG_HOME = process.env.CONTEXT_INSIGHT_HOME;
const SID = 'tdg-ses-solo';
const EMPTY_SID = 'tdg-ses-empty';
const ALL_SIDS = [SID, EMPTY_SID];
const MODEL = 'volc-gateway/glm-4.7';

beforeAll(async () => {
  process.env.CONTEXT_INSIGHT_HOME = tmpHome;
  await prisma.session.deleteMany({ where: { taskId: { in: ALL_SIDS } } });
  await prisma.session.createMany({
    data: [
      {
        taskId: SID, framework: 'opencode', label: 'tdg 轻摘要会话', model: MODEL,
        totalTokens: 100, startTime: new Date('2026-10-20T02:00:00Z'), endTime: new Date('2026-10-20T02:10:00Z'),
      },
      {
        taskId: EMPTY_SID, framework: 'opencode', label: 'tdg 空会话', model: MODEL,
        totalTokens: 0, startTime: new Date('2026-10-20T03:00:00Z'), endTime: new Date('2026-10-20T03:01:00Z'),
      },
    ],
  });
  const row = await prisma.session.findFirstOrThrow({ where: { taskId: SID }, select: { id: true } });
  const mk = (turnIndex: number, isSubagent: boolean, content: string) => ({
    sessionId: row.id, turnIndex, isSubagent, role: 'assistant', content,
    createdAt_ts: new Date('2026-10-20T02:00:10Z'), contextWindowPct: 40, model: MODEL, totalTokens: 100, latencyMs: 800,
  });
  // turnIndex 2 主/sub 双轮——锁 buildMainAgentTurnMap 主轮优先
  await prisma.turn.createMany({
    data: [mk(0, false, 'tdg-main-0'), mk(1, true, 'tdg-sub-1'), mk(2, false, 'tdg-main-2'), mk(2, true, 'tdg-sub-2')],
  });
  const turns = await prisma.turn.findMany({ where: { sessionId: row.id }, select: { id: true, content: true } });
  const idOf = (c: string) => turns.find(t => t.content === c)!.id;
  await prisma.skillEvent.createMany({
    data: [
      { turnId: idOf('tdg-main-0'), skillName: 'skill-a', eventType: 'invoke' },
      { turnId: idOf('tdg-sub-1'), skillName: 'skill-a', eventType: 'use' },
      { turnId: idOf('tdg-main-2'), skillName: 'skill-a', eventType: 'invoke' },
      { turnId: idOf('tdg-sub-1'), skillName: 'agent-b', eventType: 'dispatch' },
      { turnId: idOf('tdg-sub-2'), skillName: 'agent-b', eventType: 'dispatch' },
      { turnId: idOf('tdg-sub-2'), skillName: 'agent-b', eventType: 'dispatch' },
      { turnId: idOf('tdg-sub-2'), skillName: '', eventType: 'invoke' },
    ],
  });
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: { in: ALL_SIDS } } });
  if (ORIG_HOME === undefined) delete process.env.CONTEXT_INSIGHT_HOME;
  else process.env.CONTEXT_INSIGHT_HOME = ORIG_HOME;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const call = (
  runId: string,
  query = '',
) => runTurnDigestGET(
  new NextRequest(`http://localhost/api/observe/run/${runId}/turn-digest${query}`),
  { params: Promise.resolve({ runId }) },
);

describe('run 成员视图 turn-digest（聚合消费面轻摘要）', () => {
  it('solo run 免 member：轮次三字段形状 + turnIndex 升序（无重字段）', async () => {
    const res = await call(`solo:${SID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as TurnDigest;
    expect(body.turns).toHaveLength(4);
    expect(body.turns.map(t => t.turnIndex)).toEqual([0, 1, 2, 2]);
    // 轻摘要形状锁：每轮只有 turnId/turnIndex/isSubagent（无 content/token/latency 等重字段）
    for (const t of body.turns) {
      expect(Object.keys(t).sort()).toEqual(['isSubagent', 'turnId', 'turnIndex']);
      expect(typeof t.turnId).toBe('string');
    }
    const db = await prisma.turn.findMany({ where: { sessionId: (await prisma.session.findFirstOrThrow({ where: { taskId: SID } })).id }, orderBy: { turnIndex: 'asc' } });
    expect(body.turns.map(t => t.turnId)).toEqual(db.map(t => t.id));
  });

  it('skill 事件聚合计数：重复合并、无名跳过、首见序', async () => {
    const res = await call(`solo:${SID}`);
    const body = (await res.json()) as TurnDigest;
    expect(body.skillEvents).toEqual([
      { skillName: 'skill-a', eventType: 'invoke', count: 2 },
      { skillName: 'skill-a', eventType: 'use', count: 1 },
      { skillName: 'agent-b', eventType: 'dispatch', count: 3 },
    ]);
  });

  it('空会话：turns/skillEvents 均空数组（不 500）', async () => {
    const res = await call(`solo:${EMPTY_SID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as TurnDigest;
    expect(body.turns).toEqual([]);
    expect(body.skillEvents).toEqual([]);
  });

  it('run 不存在：404 run-not-found', async () => {
    const res = await call('solo:tdg-no-such-session');
    expect(res.status).toBe(404);
    expect((await res.json()).reason).toBe('run-not-found');
  });

  it('共享契约：buildMainAgentTurnMap 主 agent 轮优先 + 无主轮 index 回退', async () => {
    const res = await call(`solo:${SID}`);
    const body = (await res.json()) as TurnDigest;
    const main0 = body.turns.find(t => t.turnIndex === 0 && !t.isSubagent)!.turnId;
    const sub1 = body.turns.find(t => t.turnIndex === 1)!.turnId;
    const main2 = body.turns.find(t => t.turnIndex === 2 && !t.isSubagent)!.turnId;
    const map = buildMainAgentTurnMap(body.turns);
    expect(map.get(0)).toBe(main0);
    expect(map.get(1)).toBe(sub1); // 无主轮的 index 回退 subagent 轮
    expect(map.get(2)).toBe(main2); // 同 index 主轮优先，不被 subagent 遮蔽
    expect(map.size).toBe(3);
  });

  it('共享契约：expandSkillEvents 展开保量（skillEventCount 语义不变）', () => {
    const events = expandSkillEvents([
      { skillName: 'skill-a', eventType: 'invoke', count: 2 },
      { skillName: 'agent-b', eventType: 'dispatch', count: 3 },
    ]);
    expect(events).toHaveLength(5);
    expect(events.filter(e => e.skillName === 'skill-a')).toEqual([
      { skillName: 'skill-a', eventType: 'invoke' },
      { skillName: 'skill-a', eventType: 'invoke' },
    ]);
  });
});
