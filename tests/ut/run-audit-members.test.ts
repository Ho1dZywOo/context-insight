// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// the CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// run 级 audit 路由 IT（PR #7 审查意见回归锁）：`members` 请求参数的子集
// 约束必须在两条编排路径上一致生效——sift `--run` 原生路径（无成员过滤参
// 数，恒对账清单全体成员）仅在全集请求时启用；严格子集回落逐成员
// transcript 物化路径（子集在该路径原生生效），不再「参数过 400 校验后被
// 静默忽略、报告仍含未选成员」。mock prisma + mock sift-runner（捕获
// spawn 参数与成员归因 extras），run manifest / bundle 目录契约走真实文件。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RUN_SUFFIX = Date.now().toString(36);
const RUN_ID = `auditmb${RUN_SUFFIX}`;
const SIDS = [`aud_a_${RUN_SUFFIX}`, `aud_b_${RUN_SUFFIX}`, `aud_c_${RUN_SUFFIX}`];

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

// fake prisma：joinSessionRefs（session.findMany + turn.groupBy）与路由成员
// 会话解析（session.findFirst）按 where 过滤返回固定行；skill 声明恢复
// （skillEvent.findFirst + toolCall.findMany）给最小可恢复事件
const SESSION_ROWS = SIDS.map((taskId, i) => ({
  id: `row-${i}`, taskId, framework: 'opencode', label: null,
  startTime: new Date('2026-10-13T02:00:12Z'), endTime: new Date('2026-10-13T02:00:17Z'),
  totalTokens: 10, totalLatencyMs: 100, totalCacheReadTokens: 0, model: null,
  totalCost: null, version: null, sourcePath: null,
}));
const fakePrisma = {
  session: {
    findMany: vi.fn(async ({ where }: { where?: { taskId?: { in?: string[] } } }) => {
      const sids = where?.taskId?.in;
      return sids ? SESSION_ROWS.filter(r => sids.includes(r.taskId)) : SESSION_ROWS;
    }),
    findFirst: vi.fn(async ({ where }: { where?: { taskId?: string } }) =>
      SESSION_ROWS.find(r => r.taskId === where?.taskId) ?? null,
    ),
  },
  turn: { groupBy: vi.fn(async () => []), findMany: vi.fn(async () => []) },
  skillEvent: { findFirst: vi.fn(async () => ({ turnId: 't-x', createdAt: new Date() })) },
  toolCall: {
    findMany: vi.fn(async () => [
      {
        toolName: 'Skill',
        argsJson: JSON.stringify({ skill: 'recover-skill' }),
        resultJson: `<skill_content name="recover-skill">对账声明正文</skill_content>`,
        isSkillRelated: true,
      },
    ]),
  },
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
      if (Array.isArray(m.workflow?.members)) rewrite(m.workflow.members as Array<Record<string, unknown>>);
    }
  };
  rewrite(mini.data.members as Array<Record<string, unknown>>);
  mini.id = RUN_ID;
  mini.name = 'audit-members-it';
  return mini;
}

const manifest = parseManifest(buildManifest());

beforeEach(() => {
  captured.length = 0;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-audit-mb-'));
  // 源 bundle 在盘契约：workflow.schema.json + workflow.json + sessions/
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

describe('POST /api/observe/run/[runId]/audit —— members 子集贯穿两条编排路径', () => {
  it('未传 members（缺省全体）+ 源 bundle 在盘 → sift --run 原生路径（全集）', async () => {
    const res = await POST(makeRequest({ kind: 'skill', name: 'recover-skill' }), await routeParams());
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    const { args, extras } = captured[0];
    expect(args).toContain('--run');
    expect(args).toContain(tmpBundle);
    expect(args).not.toContain('--transcript');
    expect(extras?.expectedSlices).toBe(SIDS.length);
    expect(Object.keys(extras?._memberBySession ?? {}).sort()).toEqual([...SIDS].sort());
  });

  it('严格子集 members=[B] + 源 bundle 在盘 → 不走 --run，回落 transcript 物化且只见子集', async () => {
    const res = await POST(makeRequest({ kind: 'skill', name: 'recover-skill', members: [SIDS[1]] }), await routeParams());
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    const { args, extras } = captured[0];
    // 核心断言：sift --run 无成员过滤参数，子集必须回落，不能整 run 对账
    expect(args).not.toContain('--run');
    expect(args.filter(a => a === '--transcript')).toHaveLength(1); // 只物化成员 B
    expect(extras?.expectedSlices).toBe(1);
    const memberMap = extras?._members ?? {};
    expect(Object.values(memberMap).map(m => m.taskId)).toEqual([SIDS[1]]);
  });

  it('显式全集 members=[C,A,B]（乱序）→ 仍走 --run（全集请求保持原生路径收益）', async () => {
    const res = await POST(
      makeRequest({ kind: 'skill', name: 'recover-skill', members: [SIDS[2], SIDS[0], SIDS[1]] }),
      await routeParams(),
    );
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].args).toContain('--run');
    expect(captured[0].extras?.expectedSlices).toBe(SIDS.length);
  });

  it('子集含未知成员 → 400（校验仍前置，不进任何编排路径）', async () => {
    const res = await POST(
      makeRequest({ kind: 'skill', name: 'recover-skill', members: [SIDS[0], 'ghost-member'] }),
      await routeParams(),
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.reason).toBe('member-not-in-run');
    expect(captured).toHaveLength(0);
  });
});
