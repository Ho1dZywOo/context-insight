// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Skills 页派发维度 collector IT（Skills 页变革）：真实 fixture（mini-bundle，
// sid 重写 rsd- 前缀）+ 真实 prisma 种成员会话，锁 dispatches 双源投影——
// ①claude 真值（eventType=dispatch 的 SkillEvent，Turn.subagentSessionId 为
// 子代理会话去重键）；②run 成员首 turn 推导（无 dispatch 事件的框架；图结构
// nodeId[·验收] 为基名，verify 角色保真；无 turn 成员跳过）；③真值覆盖的
// 子代理会话不重复推导；④dispatch 不混进技能事件；⑤turnId/turnCreatedAt
// 投影（跳转闭环）；⑥solo 作用域不推导（单会话不是派发种群）。

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { parseAndIndex } from '@/lib/run/reader';
import { saveRun, type RunImportMeta } from '@/lib/run/run-store';
import { prisma } from '@/lib/db';
import { GET } from '@/app/api/observe/run/[runId]/skills/route';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-run-skills-dispatch-'));
const ORIG_HOME = process.env.CONTEXT_INSIGHT_HOME;

// 文件级前缀（rsd- = run-skills-dispatch）：共享 test.db 下与 rop-/cl- 前缀互不串扰
const RUN_ID = 'minidemo01';
const MEMBER_SIDS = ['rsd-ses-mini-a', 'rsd-ses-mini-b', 'rsd-ses-mini-c'];
const SOLO_SID = 'rsd-solo-ses';

beforeAll(async () => {
  process.env.CONTEXT_INSIGHT_HOME = tmpHome;
  const rewrite = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(/^ses_mini_/, 'rsd-ses-mini-');
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

  await prisma.session.deleteMany({ where: { taskId: { in: [...MEMBER_SIDS, SOLO_SID, 'rsd-ext-subagent'] } } });
  await prisma.session.createMany({
    data: [
      // 图结构：a=build·执行(g0)、b=build·验收(g0)、c=build·执行(g1)
      // totalTokens：派发 token 回填的成员 rowId 路径夹具
      { taskId: MEMBER_SIDS[0]!, framework: 'opencode', totalTokens: 1000 },
      { taskId: MEMBER_SIDS[1]!, framework: 'opencode', totalTokens: 2000 },
      { taskId: MEMBER_SIDS[2]!, framework: 'opencode', totalTokens: 4000 },
      // solo 负向：claude 格式单会话（dispatch 事件有、成员推导必须无）
      { taskId: SOLO_SID, framework: 'claude-code', totalTokens: 8000 },
      // 事件路径的外部子代理会话（不在作用域成员表内，token 按 taskId 兜底解析）
      { taskId: 'rsd-ext-subagent', framework: 'claude-code', totalTokens: 5000 },
    ],
  });
  const [a, b, c, solo] = await Promise.all(
    [...MEMBER_SIDS, SOLO_SID].map(async sid =>
      (await prisma.session.findFirstOrThrow({ where: { taskId: sid }, select: { id: true } })).id,
    ),
  );

  // turns：a 两轮（t0 早 / t1 派发动作所在轮）、b 一轮（验收角色首 turn）、
  // c 一轮、solo 一轮（subagentSessionId 指向外部子代理）
  const turnRows = await Promise.all([
    prisma.turn.create({ data: { sessionId: a, turnIndex: 0, role: 'assistant', createdAt_ts: new Date('2026-10-13T02:00:10Z'), createdAt: new Date('2026-10-13T02:00:10Z') } }),
    prisma.turn.create({ data: { sessionId: a, turnIndex: 1, role: 'assistant', subagentSessionId: MEMBER_SIDS[2], createdAt_ts: new Date('2026-10-13T02:01:00Z'), createdAt: new Date('2026-10-13T02:01:00Z') } }),
    prisma.turn.create({ data: { sessionId: b, turnIndex: 0, role: 'assistant', createdAt_ts: new Date('2026-10-13T02:00:30Z'), createdAt: new Date('2026-10-13T02:00:30Z') } }),
    prisma.turn.create({ data: { sessionId: c, turnIndex: 0, role: 'assistant', createdAt_ts: new Date('2026-10-13T03:00:00Z'), createdAt: new Date('2026-10-13T03:00:00Z') } }),
    prisma.turn.create({ data: { sessionId: solo, turnIndex: 0, role: 'assistant', subagentSessionId: 'rsd-ext-subagent', createdAt_ts: new Date('2026-10-13T04:00:00Z'), createdAt: new Date('2026-10-13T04:00:00Z') } }),
  ]);
  const [, aT1] = turnRows;
  const cT0 = turnRows[3]!;
  const soloT = turnRows[4]!;

  await prisma.sessionSkill.create({ data: { sessionId: a, skillName: 'rsd-skill-x', skillVersion: 1, invocationCount: 1 } });
  // 幽灵行夹具：dispatch-only 名字也有 SessionSkill 聚合行（摄取口径故意计
  // dispatch）——技能维必须剔除，派发维承载
  await prisma.sessionSkill.createMany({
    data: [
      { sessionId: a, skillName: 'rsd-cl-agent', invocationCount: 1 },
      { sessionId: solo, skillName: 'rsd-solo-agent', invocationCount: 1 },
    ],
  });
  // a.t1：一次技能调用 + 一次派发（claude 真值，子代理=c）；c.t0：一次无
  // subagentSessionId 标记的派发（token 无从解析 → null，不伪造 0）
  await prisma.skillEvent.createMany({
    data: [
      { turnId: aT1.id, skillName: 'rsd-skill-x', eventType: 'invoke', success: true, durationMs: 5, createdAt: new Date('2026-10-13T02:01:00Z') },
      { turnId: aT1.id, skillName: 'rsd-cl-agent', eventType: 'dispatch', success: true, durationMs: 0, createdAt: new Date('2026-10-13T02:01:00Z') },
      { turnId: cT0.id, skillName: 'rsd-orphan-agent', eventType: 'dispatch', success: true, durationMs: 0, createdAt: new Date('2026-10-13T03:00:00Z') },
      { turnId: soloT.id, skillName: 'rsd-solo-agent', eventType: 'dispatch', success: true, durationMs: 0, createdAt: new Date('2026-10-13T04:00:00Z') },
    ],
  });
});

afterAll(async () => {
  for (const sid of [...MEMBER_SIDS, SOLO_SID, 'rsd-ext-subagent']) {
    try { await prisma.session.deleteMany({ where: { taskId: sid } }); } catch { /* ignore */ }
  }
  await prisma.$disconnect();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  if (ORIG_HOME === undefined) delete process.env.CONTEXT_INSIGHT_HOME;
  else process.env.CONTEXT_INSIGHT_HOME = ORIG_HOME;
});

describe('Skills 页派发维度：dispatches 双源投影（run 作用域）', () => {
  it('真值优先 + 成员首 turn 推导 + 覆盖去重 + dispatch 不混技能事件 + turnId/时间投影', async () => {
    const res = await GET(
      new NextRequest(`http://localhost/api/observe/run/${RUN_ID}/skills`),
      { params: Promise.resolve({ runId: RUN_ID }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    // 技能维剔除 dispatch-only 幽灵行（rsd-cl-agent 是子代理名，聚合行不进技能列表）
    expect(body.skills.map((s: { skillName: string }) => s.skillName)).toEqual(['rsd-skill-x']);

    // 技能事件：dispatch 被过滤（只剩 invoke），turnId/turnCreatedAt 投影在位
    expect(body.events).toHaveLength(1);
    expect(body.events[0].eventType).toBe('invoke');
    expect(body.events[0].skillName).toBe('rsd-skill-x');
    expect(typeof body.events[0].turnId).toBe('string');
    expect(body.events[0].turnCreatedAt).toBe('2026-10-13T02:01:00.000Z');

    // 派发：a（首 turn 推导）→ b（验收角色推导）→ claude 真值 → 无 sid 孤儿，按时刻升序
    expect(body.dispatches).toHaveLength(4);
    expect(body.dispatches.map((d: { name: string }) => d.name)).toEqual([
      'build',
      'build·验收',
      'rsd-cl-agent',
      'rsd-orphan-agent',
    ]);

    // 推导路径 a：图结构基名（nodeId=build、execute），成员首 turn，verify=false
    // token 回填 = 子代理成员会话 totalTokens（rowId 路径）
    const derivedA = body.dispatches[0];
    expect(derivedA.source).toBe('member');
    expect(derivedA.verify).toBe(false);
    expect(derivedA.member.taskId).toBe(MEMBER_SIDS[0]);
    expect(derivedA.at).toBe('2026-10-13T02:00:10.000Z');
    expect(derivedA.tokens).toBe(1000);

    // 推导路径 b：verify 角色保真（nodeId=build + ·验收）
    const derivedB = body.dispatches[1];
    expect(derivedB.source).toBe('member');
    expect(derivedB.verify).toBe(true);
    expect(derivedB.member.taskId).toBe(MEMBER_SIDS[1]);
    expect(derivedB.at).toBe('2026-10-13T02:00:30.000Z');
    expect(derivedB.tokens).toBe(2000);

    // 真值路径：派发动作所在父成员归因、turnId=动作轮；token = 作用域内
    // 子代理会话（subagentSessionId=c → rowId 路径）
    const eventD = body.dispatches[2];
    expect(eventD.source).toBe('event');
    expect(eventD.name).toBe('rsd-cl-agent');
    expect(eventD.member.taskId).toBe(MEMBER_SIDS[0]);
    expect(eventD.at).toBe('2026-10-13T02:01:00.000Z');
    expect(eventD.tokens).toBe(4000);

    // 孤儿派发：无 subagentSessionId 标记 → token 无从解析，保持 null（不伪造 0）
    const orphanD = body.dispatches[3];
    expect(orphanD.source).toBe('event');
    expect(orphanD.name).toBe('rsd-orphan-agent');
    expect(orphanD.tokens).toBeNull();

    // c 被 subagentSessionId 真值覆盖：零重复推导（孤儿事件的成员归因不算推导）
    expect(body.dispatches.filter((d: { source: string; member: { taskId: string } | null }) => d.source === 'member' && d.member?.taskId === MEMBER_SIDS[2])).toHaveLength(0);
  });
});

describe('Skills 页派发维度：solo 作用域不推导', () => {
  it('单会话不是派发种群——只有 dispatch 真值事件，无成员首 turn 推导', async () => {
    const res = await GET(
      new NextRequest(`http://localhost/api/observe/run/solo:${SOLO_SID}/skills`),
      { params: Promise.resolve({ runId: `solo:${SOLO_SID}` }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.events).toHaveLength(0);
    // 幽灵行剔除同样生效：rsd-solo-agent（dispatch-only）不进技能列表
    expect(body.skills).toHaveLength(0);
    expect(body.dispatches).toHaveLength(1);
    expect(body.dispatches[0].source).toBe('event');
    expect(body.dispatches[0].name).toBe('rsd-solo-agent');
    expect(body.dispatches[0].member.taskId).toBe(SOLO_SID);
    // 外部子代理会话已入库但不在作用域成员表内：token 按 taskId 兜底解析
    expect(body.dispatches[0].tokens).toBe(5000);
  });
});
