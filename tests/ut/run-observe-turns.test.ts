// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// run 合并轮次/桥/搜索 IT（design: docs/design/run-observe-parity/design.md §3.2/§4）：
// 真实 fixture（mini-bundle，rop- 前缀）+ 真实 prisma 种跨成员交错轮次 →
// 锁：①turns 全局事件时间混排 + member 归因（子代理轮归成员会话）；
// ②member 过滤 / offset 分页 / 非法参数闸；③bridges 批量收齐 + 归因；
// ④跨成员全域搜索（工具 args 命中 + 正文命中，附 member）。

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { parseAndIndex } from '@/lib/run/reader';
import { saveRun, type RunImportMeta } from '@/lib/run/run-store';
import { prisma } from '@/lib/db';
import { GET as runTurnsGET } from '@/app/api/observe/run/[runId]/turns/route';
import { GET as runBridgesGET } from '@/app/api/observe/run/[runId]/bridges/route';
import { GET as runSearchGET } from '@/app/api/observe/run/[runId]/turns/search/route';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-run-observe-turns-'));
const ORIG_HOME = process.env.CONTEXT_INSIGHT_HOME;

const RUN_ID = 'minidemo01';
const MEMBER_SIDS = ['rop-ses-mini-a', 'rop-ses-mini-b', 'rop-ses-mini-c'];

const ctx: { summaries: string[] } = { summaries: [] };

beforeAll(async () => {
  process.env.CONTEXT_INSIGHT_HOME = tmpHome;
  const rewrite = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(/^ses_mini_/, 'rop-ses-mini-');
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
  const rows = await prisma.session.createMany({
    data: MEMBER_SIDS.map((sid, i) => ({
      taskId: sid,
      framework: 'opencode',
      model: 'volc-gateway/glm-4.7',
      totalTokens: 100 * (i + 1),
      startTime: new Date('2026-10-13T02:00:00Z'),
      endTime: new Date('2026-10-13T02:10:00Z'),
    })),
  });
  expect(rows.count).toBe(3);
  const [sa, sb, sc] = await Promise.all(
    MEMBER_SIDS.map(sid => prisma.session.findFirst({ where: { taskId: sid }, select: { id: true } })),
  );

  // 跨成员交错事件时间：a0 < b0 < c0 < a1 < sub(挂在 a) < b1
  const mk = (sessionId: string, turnIndex: number, at: string, content: string, extra: Record<string, unknown> = {}) =>
    prisma.turn.create({ data: { sessionId, turnIndex, role: 'assistant', content, createdAt_ts: new Date(at), ...extra } });
  const a0 = await mk(sa!.id, 0, '2026-10-13T02:00:10Z', 'rop-alpha 用户开始任务', { role: 'user' });
  const b0 = await mk(sb!.id, 0, '2026-10-13T02:00:20Z', 'rop-bravo 回应');
  await mk(sc!.id, 0, '2026-10-13T02:00:30Z', 'rop-charlie 开始');
  const a1 = await mk(sa!.id, 1, '2026-10-13T02:00:40Z', 'rop-alpha 调工具', { inputMessagesCount: 12 });
  await mk(sa!.id, 2, '2026-10-13T02:00:45Z', 'rop-subagent 泳道轮', { isSubagent: true, subagentSessionId: 'rop-sub-1', subagentName: 'rop-研究员' });
  await mk(sb!.id, 1, '2026-10-13T02:00:50Z', 'rop-bravo 完成');
  ctx.summaries = [a0.content!, b0.content!, 'rop-charlie 开始', a1.content!, 'rop-subagent 泳道轮', 'rop-bravo 完成'];

  await prisma.toolCall.create({
    data: { turnId: a1.id, toolCallId: 'rop-tc-read', toolName: 'Read', state: 'ok', argsJson: '{"file_path": "/repo/rop-needle.md"}' },
  });
  await prisma.interactionBridge.create({
    data: {
      sessionId: sa!.id,
      dispatchExecutionId: 'rop-exec-1',
      dispatchTurnId: a0.id,
      subagentSessionId: 'rop-sub-1',
      subagentName: 'rop-研究员',
      status: 'dispatched',
    },
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

function getTurns(runId: string, query = '') {
  return runTurnsGET(
    new NextRequest(`http://localhost/api/observe/run/${runId}/turns${query}`),
    { params: Promise.resolve({ runId }) },
  );
}

describe('run 合并轮次观测（run-observe-parity 刀B）', () => {
  it('turns：全成员事件时间混排 + member 归因（子代理轮归成员会话）+ light 工具投影', async () => {
    const res = await getTurns(RUN_ID);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.total).toBe(6);
    // 交错序：a0 → b0 → c0 → a1 → sub → b1（contentSummary 兜底 content 前 200 字）
    expect(data.items.map((i: { contentSummary: string | null }) => i.contentSummary)).toEqual(ctx.summaries);
    // 归因：首条归 a；子代理轮（第 5 条）同样归成员 a 的会话
    expect(data.items[0].member).toMatchObject({ taskId: 'rop-ses-mini-a' });
    expect(data.items[4]).toMatchObject({ isSubagent: true, subagentSessionId: 'rop-sub-1' });
    expect(data.items[4].member).toMatchObject({ taskId: 'rop-ses-mini-a' });
    // light 工具投影：a1 的 Read 工具调用
    const a1 = data.items[3];
    expect(a1.toolCalls).toEqual([{ toolCallId: 'rop-tc-read', toolName: 'Read', state: 'ok', durationMs: 0 }]);
    // 轻投影含输入消息条数（节点 Δ 输入卡的历史边界）
    expect(a1.inputMessagesCount).toBe(12);
  });

  it('member 过滤：单成员作用域 + 非法成员 400', async () => {
    const res = await getTurns(RUN_ID, `?member=${MEMBER_SIDS[1]}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.total).toBe(2);
    expect(data.items.every((i: { member: { taskId: string } }) => i.member.taskId === MEMBER_SIDS[1])).toBe(true);

    const bad = await getTurns(RUN_ID, '?member=rop-not-a-member');
    expect(bad.status).toBe(400);
    const body = await bad.json();
    expect(body.reason).toBe('member-not-in-run');
  });

  it('offset 分页：pageSize=2 第 2 页取混排第 3-4 条', async () => {
    const res = await getTurns(RUN_ID, '?page=2&pageSize=2');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ page: 2, pageSize: 2, total: 6 });
    expect(data.items.map((i: { contentSummary: string | null }) => i.contentSummary)).toEqual(ctx.summaries.slice(2, 4));
  });

  it('run 不存在 → 404', async () => {
    const res = await getTurns('rop-no-such-run');
    expect(res.status).toBe(404);
  });

  it('bridges：成员会话派发桥批量收齐 + member 归因', async () => {
    const res = await runBridgesGET(
      new NextRequest(`http://localhost/api/observe/run/${RUN_ID}/bridges`),
      { params: Promise.resolve({ runId: RUN_ID }) },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.total).toBe(1);
    expect(data.items[0]).toMatchObject({
      subagentSessionId: 'rop-sub-1',
      subagentName: 'rop-研究员',
      status: 'dispatched',
    });
    expect(data.items[0].member).toMatchObject({ taskId: 'rop-ses-mini-a' });
  });

  it('跨成员搜索：工具 args 命中与正文命中均附 member 归因', async () => {
    const byKeyword = async (keyword: string) => {
      const res = await runSearchGET(
        new NextRequest(`http://localhost/api/observe/run/${RUN_ID}/turns/search?keyword=${encodeURIComponent(keyword)}`),
        { params: Promise.resolve({ runId: RUN_ID }) },
      );
      expect(res.status).toBe(200);
      return res.json();
    };

    const toolHit = await byKeyword('rop-needle');
    expect(toolHit.total).toBe(1);
    expect(toolHit.items[0]).toMatchObject({ matchField: 'toolArgs', toolName: 'Read' });
    expect(toolHit.items[0].member).toMatchObject({ taskId: 'rop-ses-mini-a' });

    const contentHit = await byKeyword('rop-bravo');
    expect(contentHit.total).toBe(2);
    expect(contentHit.items.every((i: { member: { taskId: string } }) => i.member.taskId === MEMBER_SIDS[1])).toBe(true);
  });
});
