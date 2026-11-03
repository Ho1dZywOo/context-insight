// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// run-first 刀I1 IT（design: docs/design/run-first-architecture/design.md §3.4，
// 成员视图转发）：真实 fixture（mini-bundle，rfmv- 前缀）+ 真实 prisma 种成员
// 会话 → 锁：①member 闸（多成员必填 / 不在 scope 拒 / run 不存在 404）；
// ②委托既有 session 处理器（workflow / member-turns / export-md 真实形状，
// 其余 query 参数透传）；③solo run 单成员缺省（免 member 直取）；
// ④framework 随 scope 成员消歧行注入（同 sid 双行转发不串行）。

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { parseAndIndex } from '@/lib/run/reader';
import { saveRun, type RunImportMeta } from '@/lib/run/run-store';
import { prisma } from '@/lib/db';
import { GET as runWorkflowGET } from '@/app/api/observe/run/[runId]/workflow/route';
import { GET as runMemberTurnsGET } from '@/app/api/observe/run/[runId]/member-turns/route';
import { GET as runExportMdGET } from '@/app/api/observe/run/[runId]/export-md/route';
import { GET as runMemberDetailGET } from '@/app/api/observe/run/[runId]/member-detail/route';
import { GET as turnDetailGET } from '@/app/api/observe/turn/[turnId]/route';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-run-member-views-'));
const ORIG_HOME = process.env.CONTEXT_INSIGHT_HOME;

const RUN_ID = 'minidemo01';
const MEMBER_A = 'rfmv-ses-mini-a';
const MEMBER_B = 'rfmv-ses-mini-b';
const MEMBER_SIDS = [MEMBER_A, MEMBER_B, 'rfmv-ses-mini-c'];
const SOLO_SID = 'rfmv-solo-ses';
const SOLO_DUAL = 'rfmv-solo-dual';
const ALL_SIDS = [...MEMBER_SIDS, SOLO_SID, SOLO_DUAL];
const MODEL = 'volc-gateway/glm-4.7';

beforeAll(async () => {
  process.env.CONTEXT_INSIGHT_HOME = tmpHome;
  const rewrite = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(/^ses_mini_/, 'rfmv-ses-mini-');
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
      ownedSessions: [],
    },
  };
  saveRun(manifest, meta);

  await prisma.session.deleteMany({ where: { taskId: { in: ALL_SIDS } } });
  await prisma.session.createMany({
    data: [
      ...MEMBER_SIDS.map(sid => ({
        taskId: sid, framework: 'opencode', label: `rfmv ${sid}`, model: MODEL,
        totalTokens: 100, startTime: new Date('2026-10-13T02:00:00Z'), endTime: new Date('2026-10-13T02:10:00Z'),
      })),
      {
        taskId: SOLO_SID, framework: 'opencode', label: 'rfmv 独立会话', model: MODEL,
        totalTokens: 150, startTime: new Date('2026-10-13T05:00:00Z'), endTime: new Date('2026-10-13T05:10:00Z'),
      },
      {
        taskId: SOLO_DUAL, framework: 'opencode', label: 'rfmv 双行原生', model: MODEL,
        totalTokens: 100, startTime: new Date('2026-10-13T06:00:00Z'), endTime: new Date('2026-10-13T06:05:00Z'),
      },
      {
        taskId: SOLO_DUAL, framework: 'opencode-proxy', label: 'rfmv 双行代理', model: MODEL,
        totalTokens: 999, startTime: new Date('2026-10-13T06:00:00Z'), endTime: new Date('2026-10-13T06:06:00Z'),
      },
    ],
  });
  const mkTurn = (sessionId: string, turnIndex: number, at: string, content: string) => ({
    sessionId, turnIndex, role: 'assistant', content,
    createdAt_ts: new Date(at), contextWindowPct: 40, model: MODEL, totalTokens: 100, latencyMs: 800,
  });
  const sidRow = async (sid: string) =>
    (await prisma.session.findFirst({ where: { taskId: sid }, select: { id: true }, orderBy: { framework: 'asc' } }))!.id;
  const soloRow = await prisma.session.findFirstOrThrow({ where: { taskId: SOLO_SID }, select: { id: true } });
  const dualNative = await prisma.session.findFirstOrThrow({
    where: { taskId: SOLO_DUAL, framework: 'opencode' }, select: { id: true },
  });
  const dualProxy = await prisma.session.findFirstOrThrow({
    where: { taskId: SOLO_DUAL, framework: 'opencode-proxy' }, select: { id: true },
  });
  const memberARow = await sidRow(MEMBER_A);
  await prisma.turn.createMany({
    data: [
      mkTurn(memberARow, 0, '2026-10-13T02:00:10Z', 'rfmv-a-0'),
      mkTurn(soloRow.id, 0, '2026-10-13T05:00:10Z', 'rfmv-solo-0'),
      mkTurn(soloRow.id, 1, '2026-10-13T05:00:40Z', 'rfmv-solo-1'),
      mkTurn(dualNative.id, 0, '2026-10-13T06:00:10Z', 'rfmv-dual-native-0'),
      mkTurn(dualProxy.id, 0, '2026-10-13T06:00:10Z', 'rfmv-dual-proxy-0'),
    ],
  });
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: { in: ALL_SIDS } } });
  if (ORIG_HOME === undefined) delete process.env.CONTEXT_INSIGHT_HOME;
  else process.env.CONTEXT_INSIGHT_HOME = ORIG_HOME;
});

const call = (
  handler: (request: NextRequest, ctx: { params: Promise<{ runId: string }> }) => Promise<Response>,
  runId: string,
  query = '',
) => handler(new NextRequest(`http://localhost/api/observe/run/${runId}/x${query}`), { params: Promise.resolve({ runId }) });

describe('run-first 刀I1：成员视图转发（session 独有能力的 run 对偶）', () => {
  it('member 闸：多成员 run 必填 member；不在 scope 拒；run 不存在 404', async () => {
    const noMember = await call(runWorkflowGET, RUN_ID);
    expect(noMember.status).toBe(400);
    expect((await noMember.json()).reason).toBe('member-required');

    const badMember = await call(runWorkflowGET, RUN_ID, `?member=rfmv-not-a-member`);
    expect(badMember.status).toBe(400);
    expect((await badMember.json()).reason).toBe('member-not-in-scope');

    const missing = await call(runWorkflowGET, 'rfmv-no-such-run', `?member=${MEMBER_A}`);
    expect(missing.status).toBe(404);
    expect((await missing.json()).reason).toBe('run-not-found');
  });

  it('委托真实处理器：workflow（成员 a）返回工作流树；member 闸后的 query 透传', async () => {
    const res = await call(runWorkflowGET, RUN_ID, `?member=${MEMBER_A}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBeTruthy();
  });

  it('member-turns：单成员 run 缺省免 member + query 透传（includeToolDetail）', async () => {
    const res = await call(runMemberTurnsGET, `solo:${SOLO_SID}`, '?includeToolDetail=true&includeContent=true');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(2);
    expect(body.items.map((t: { content: string }) => t.content)).toEqual(['rfmv-solo-0', 'rfmv-solo-1']);
  });

  it('framework 随 scope 成员消歧行注入：同 sid 双行不串行（原生优先）', async () => {
    const res = await call(runMemberTurnsGET, `solo:${SOLO_DUAL}`, '?includeContent=true');
    expect(res.status).toBe(200);
    const body = await res.json();
    // 原生优先行（opencode）的轮次——不是 proxy 行
    expect(body.items).toHaveLength(1);
    expect(body.items[0].content).toBe('rfmv-dual-native-0');
  });

  it('export-md：solo run 导出 Markdown 正文', async () => {
    const res = await call(runExportMdGET, `solo:${SOLO_SID}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('rfmv-solo-0');
  });
});

describe('run-first 刀J1：member-detail 转发 + 顶级 turn 详情', () => {
  it('member-detail：solo run 返回 session 详情投影（taskId/label 逐字段一致）', async () => {
    const res = await call(runMemberDetailGET, `solo:${SOLO_SID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.taskId).toBe(SOLO_SID);
    expect(body.label).toBe('rfmv 独立会话');
  });

  it('member-detail：framework 随 scope 成员消歧行注入（同 sid 双行原生优先）', async () => {
    const res = await call(runMemberDetailGET, `solo:${SOLO_DUAL}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.taskId).toBe(SOLO_DUAL);
    expect(body.label).toBe('rfmv 双行原生');
    expect(body.framework).toBe('opencode');
  });

  it('member-detail：多成员 run 走 member 闸（member-required）', async () => {
    const res = await call(runMemberDetailGET, RUN_ID);
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe('member-required');
  });

  it('顶级 /api/observe/turn/[turnId]：全局 turnId 直取详情（含 content + 成员 taskId 归属）', async () => {
    const row = await prisma.turn.findFirstOrThrow({
      where: { content: 'rfmv-solo-0' },
      select: { id: true, sessionId: true },
    });
    const sess = await prisma.session.findUniqueOrThrow({ where: { id: row.sessionId }, select: { taskId: true } });
    const res = await turnDetailGET(
      new NextRequest(`http://localhost/api/observe/turn/${row.id}?includeContent=true`),
      { params: Promise.resolve({ turnId: row.id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.turnId).toBe(row.id);
    expect(body.content).toBe('rfmv-solo-0');
    // taskId = 会话行 taskId（run Turns 节点归属解析的单一机制）
    expect(body.taskId).toBe(sess.taskId);
  });
});
