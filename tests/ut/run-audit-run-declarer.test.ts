// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// run 级 audit 路由 IT（PR #7 审查意见回归锁）：run 域声明源成员的会话解析
// 独立于 members 子集过滤。「声明源」（恢复编排规程用）与「涉事成员」（对账
// 子集）是独立角色——声明源不在子集时不得因子集过滤误报 404「无已导入会话」，
// 应单独解析其会话（仅用于声明恢复，不加入对账集：transcript 物化仍只见子
// 集）。mock prisma + mock sift-runner（捕获 spawn 参数与成员归因 extras），
// run manifest / bundle 目录契约走真实文件；S1 型声明（skillEvent 无 invoke
// → turn0 ≥500 字注入）走最短恢复链。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RUN_SUFFIX = Date.now().toString(36);
const RUN_ID = `auditrc${RUN_SUFFIX}`;
const SIDS = [`aud_x_${RUN_SUFFIX}`, `aud_y_${RUN_SUFFIX}`, `aud_z_${RUN_SUFFIX}`];

interface CapturedCall {
  args: string[];
  extras?: { expectedSlices?: number; _members?: Record<string, { taskId: string }>; _memberBySession?: Record<string, { taskId: string }> };
  cleanup?: () => void;
}
const captured: CapturedCall[] = [];

vi.mock('@/lib/sift-runner', () => ({
  makeStreamingAuditResponse: vi.fn((args: string[], _outputDir: string, cleanup?: () => void, extras?: CapturedCall['extras']) => {
    captured.push({ args, extras, cleanup });
    return new Response('');
  }),
}));

// fake prisma：joinSessionRefs（session.findMany + turn.groupBy）与路由会话解析
// （session.findFirst）按 where 过滤返回固定行；run 域 S1 型声明恢复走
// turn.findFirst（≥500 字 turn0），只有声明源 B 的会话（row-1）可恢复
const SESSION_ROWS = SIDS.map((taskId, i) => ({
  id: `row-${i}`, taskId, framework: 'opencode', label: null,
  startTime: new Date('2026-10-13T02:00:12Z'), endTime: new Date('2026-10-13T02:00:17Z'),
  totalTokens: 10, totalLatencyMs: 100, totalCacheReadTokens: 0, model: null,
  totalCost: null, version: null, sourcePath: null,
}));
const TURN0_BODY = `run 级编排规程声明体（S1 注入）：${'规程条目；'.repeat(120)}`;
const sessionFindFirst = vi.fn(async ({ where }: { where?: { taskId?: string } }) =>
  SESSION_ROWS.find(r => r.taskId === where?.taskId) ?? null,
);
const turnFindFirst = vi.fn(async ({ where }: { where?: { sessionId?: string } }) =>
  where?.sessionId === 'row-1' ? { id: 't0-declarer', content: TURN0_BODY } : null,
);
const fakePrisma = {
  session: {
    findMany: vi.fn(async ({ where }: { where?: { taskId?: { in?: string[] } } }) => {
      const sids = where?.taskId?.in;
      return sids ? SESSION_ROWS.filter(r => sids.includes(r.taskId)) : SESSION_ROWS;
    }),
    findFirst: sessionFindFirst,
  },
  turn: { groupBy: vi.fn(async () => []), findMany: vi.fn(async () => []), findFirst: turnFindFirst },
  skillEvent: { findFirst: vi.fn(async () => null) },
  toolCall: { findMany: vi.fn(async () => []) },
  interactionBridge: { findMany: vi.fn(async () => []) },
};
vi.mock('@/lib/db', () => ({ prisma: fakePrisma }));

const { POST } = await import('@/app/api/observe/run/[runId]/audit/route');
const { saveRun } = await import('@/lib/run/run-store');
const { parseManifest } = await import('@/lib/run/reader');

let tmpHome: string;
let tmpBundle: string;

/** 克隆 mini bundle manifest：三个带 sessionId 的成员指到本文件唯一会话。 */
function buildManifest(): unknown {
  const mini = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, './data/run/mini-bundle/workflow.json'), 'utf-8'),
  );
  let i = 0;
  const rewrite = (members: Array<Record<string, unknown>>): void => {
    for (const m of members) {
      if (typeof m.sessionId === 'string' && m.sessionId.startsWith('ses_mini_') && i < SIDS.length) {
        m.sessionId = SIDS[i++];
      }
      const wf = m.workflow as Record<string, unknown> | undefined;
      if (Array.isArray(wf?.members)) rewrite(wf.members as Array<Record<string, unknown>>);
    }
  };
  rewrite(mini.data.members as Array<Record<string, unknown>>);
  mini.id = RUN_ID;
  mini.name = 'audit-run-declarer-it';
  return mini;
}

const manifest = parseManifest(buildManifest());

beforeEach(() => {
  captured.length = 0;
  sessionFindFirst.mockClear();
  turnFindFirst.mockClear();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-audit-rc-'));
  tmpBundle = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-audit-bundle-'));
  fs.writeFileSync(path.join(tmpBundle, 'workflow.schema.json'), '{}');
  fs.writeFileSync(path.join(tmpBundle, 'workflow.json'), JSON.stringify(buildManifest()));
  fs.mkdirSync(path.join(tmpBundle, 'sessions'), { recursive: true });
  process.env.CONTEXT_INSIGHT_HOME = tmpHome;
  saveRun(
    manifest,
    {
      schema: 'insight-run-import',
      version: 1,
      data: {
        importedAt: '2026-11-02T10:00:00+08:00',
        sourceDir: tmpBundle,
        manifestFile: 'workflow.json',
        exportDataComplete: true,
        sessions: { total: 3, imported: 3, existing: 0, missingFile: 0, failed: 0 },
        failures: [],
        warnings: [],
        ownedSessions: [],
      },
    },
    path.join(tmpHome, 'runs'),
  );
});

afterEach(() => {
  for (const c of captured) c.cleanup?.();
  delete process.env.CONTEXT_INSIGHT_HOME;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpBundle, { recursive: true, force: true });
});

function makeRequest(body: unknown): Request {
  return new Request(`http://localhost/api/observe/run/${RUN_ID}/audit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const routeParams = async (): Promise<never> =>
  ({ params: Promise.resolve({ runId: RUN_ID }) }) as never;

describe('POST /api/observe/run/[runId]/audit —— run 域声明源会话解析独立于 members 子集', () => {
  it('声明源不在子集（members=[A]、name=B，B 在 run 内有会话）→ 不误报 404；对账集只见子集、声明从 B 的会话恢复', async () => {
    const res = await POST(
      makeRequest({ kind: 'run', name: SIDS[1], members: [SIDS[0]] }),
      await routeParams(),
    );
    // 旧实现：sessions map 只含子集 → sessions.get(B)=undefined → 404「声明源成员无已导入会话」
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    const { args, extras } = captured[0];
    // 对账集 = 子集 A（声明源 B 只用于恢复规程，不被纳入对账）
    expect(args).not.toContain('--run');
    expect(args.filter(a => a === '--transcript')).toHaveLength(1);
    expect(extras?.expectedSlices).toBe(1);
    expect(Object.values(extras?._members ?? {}).map(m => m.taskId)).toEqual([SIDS[0]]);
    // 声明恢复解析的是声明源 B 的会话（row-1），不是子集内 A 的
    expect(turnFindFirst.mock.calls.some(c => c[0]?.where?.sessionId === 'row-1')).toBe(true);
    // 会话解析：子集解析 A（1 次）+ 声明源单独解析 B（1 次，不在子集不重复查）
    expect(sessionFindFirst.mock.calls.map(c => c[0]?.where?.taskId)).toEqual([SIDS[0], SIDS[1]]);
  });

  it('声明源在子集内（members=[A,B]、name=B）→ 复用子集会话解析，无额外查询', async () => {
    const res = await POST(
      makeRequest({ kind: 'run', name: SIDS[1], members: [SIDS[0], SIDS[1]] }),
      await routeParams(),
    );
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].args.filter(a => a === '--transcript')).toHaveLength(2);
    expect(captured[0].extras?.expectedSlices).toBe(2);
    const taskIds = sessionFindFirst.mock.calls.map(c => c[0]?.where?.taskId).sort();
    expect(taskIds).toEqual([...SIDS.slice(0, 2)].sort());
  });

  it('声明源不在本 run → 400 前置校验仍生效（修复不放松校验）', async () => {
    const res = await POST(
      makeRequest({ kind: 'run', name: 'ghost-declarer', members: [SIDS[0]] }),
      await routeParams(),
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.reason).toBe('bad-request');
    expect(captured).toHaveLength(0);
  });
});
