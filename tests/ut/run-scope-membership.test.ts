// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// run 观测作用域成员资格 IT：成员位引用了会话（sessionId 落库）即入作用域，
// 图注解只是归因元数据（structure），不是入场券。锁三件事：
// ①无图注解成员的会话照常进观测面（executions / run 详情名册 / 列表会话
//   成员数）——修复前 graphMembers-only 解析让它整体失明；
// ②道名/归因标签用成员短名（nodeId·g·a 撞名消歧；无图成员剥「：第 N 代」
//   装饰取基名），泳道 root 道以会话命名而非全叫 root；
// ③无 sessionId 的成员位（process/缺导出）不产生幻影成员。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prisma } from '../setup';
import { parseAndIndex } from '@/lib/run/reader';
import { saveRun, listRuns, type RunImportMeta } from '@/lib/run/run-store';
import { GET as executionsGET } from '@/app/api/observe/run/[runId]/executions/route';
import { GET as runDetailGET } from '@/app/api/observe/run/[runId]/route';

const RUN_ID = 'scopemember01';
const SID_G1 = 'ses-sm-g1';
const SID_G2 = 'ses-sm-g2';
const SID_NG = 'ses-sm-ng1';
const ALL_SIDS = [SID_G1, SID_G2, SID_NG];

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-run-scope-'));
const ORIG_HOME = process.env.CONTEXT_INSIGHT_HOME;

const req = (pathname: string) => new NextRequest(`http://localhost${pathname}`);
const ctx = (runId: string) => ({ params: Promise.resolve({ runId }) });

beforeAll(async () => {
  process.env.CONTEXT_INSIGHT_HOME = tmpHome;
  // 成员四形态：图+sid（×2，同节点跨尝试 → 撞名消歧出 ·g0·1/·g0·2）、
  // 无图+sid（修复对象）、图+无 sid（不得产生幻影成员）
  const manifest = parseAndIndex({
    schema: 'workflow-bundle',
    version: 1,
    id: RUN_ID,
    kind: 'workflow',
    name: 'scope-member-it',
    startedAt: null,
    finishedAt: null,
    data: {
      exportDataComplete: true,
      relations: [],
      members: [
        {
          id: 'S_G1', kind: 'session', name: 'detect-npu-arch：第 0 代第 1 次执行',
          sessionId: SID_G1, location: `sessions/${SID_G1}.native`,
          annotation: { graph: { role: 'execute', nodeId: 'detect-npu-arch', generation: 0, attempt: 1, attemptResult: 'succeeded' } },
        },
        {
          id: 'S_G2', kind: 'session', name: 'detect-npu-arch：第 0 代第 2 次执行',
          sessionId: SID_G2, location: `sessions/${SID_G2}.native`,
          annotation: { graph: { role: 'execute', nodeId: 'detect-npu-arch', generation: 0, attempt: 2, attemptResult: 'succeeded' } },
        },
        {
          id: 'S_NG', kind: 'session', name: 'setup-ops-test-kit：第 0 代第 1 次执行',
          sessionId: SID_NG, location: `sessions/${SID_NG}.native`,
        },
        {
          id: 'P_NOSID', kind: 'process', name: 'init：第 0 代第 1 次执行',
          annotation: { graph: { role: 'execute', nodeId: 'init', generation: 0, attempt: 1, attemptResult: 'succeeded' } },
        },
      ],
    },
  }).manifest;
  const meta: RunImportMeta = {
    schema: 'insight-run-import',
    version: 1,
    data: {
      importedAt: '2026-10-20T10:00:00+08:00',
      sourceDir: '/bundle/scope-member',
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
  const rows: Record<string, string> = {};
  for (const taskId of ALL_SIDS) {
    const s = await prisma.session.create({
      data: { taskId, framework: 'opencode', startTime: new Date('2026-10-20T02:00:00Z'), endTime: new Date('2026-10-20T02:10:00Z') },
    });
    rows[taskId] = s.id;
  }
  // 每成员一个 root execution；g1/ng1 各带 subagent（验证跨成员 Σ 与归因）
  const mkExec = (sessionId: string, agentSessionId: string, isSubagent: boolean, at: string) =>
    prisma.execution.create({
      data: {
        sessionId, agentName: isSubagent ? 'helper' : 'main', agentSessionId, isSubagent,
        createdAt: new Date(at), tokens: 100, latencyMs: 5_000, toolCallCount: 1, llmCallCount: 2,
      },
    });
  await mkExec(rows[SID_G1], SID_G1, false, '2026-10-20T02:00:00Z');
  await mkExec(rows[SID_G1], 'sm-sub-1', true, '2026-10-20T02:01:00Z');
  await mkExec(rows[SID_G1], 'sm-sub-2', true, '2026-10-20T02:02:00Z');
  await mkExec(rows[SID_G2], SID_G2, false, '2026-10-20T02:03:00Z');
  await mkExec(rows[SID_NG], SID_NG, false, '2026-10-20T02:04:00Z');
  await mkExec(rows[SID_NG], 'sm-sub-3', true, '2026-10-20T02:05:00Z');
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: { in: ALL_SIDS } } });
  if (ORIG_HOME === undefined) delete process.env.CONTEXT_INSIGHT_HOME;
  else process.env.CONTEXT_INSIGHT_HOME = ORIG_HOME;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('run 观测作用域成员资格（sessionId 入场，图注解只是归因）', () => {
  it('executions：无图成员的 root/subagent 照常入面，道名用会话短名', async () => {
    const res = await executionsGET(req(`/api/observe/run/${RUN_ID}/executions`), ctx(RUN_ID));
    expect(res.status).toBe(200);
    const data = await res.json();
    const roots = data.items.filter((a: { isSubagent: boolean }) => !a.isSubagent);
    const subs = data.items.filter((a: { isSubagent: boolean }) => a.isSubagent);
    // 三个成员会话的 root 全部在场（无图成员 SID_NG 不再失明）；幻影成员不存在
    expect(roots.map((a: { member: { taskId: string } }) => a.member.taskId).sort()).toEqual([SID_G1, SID_G2, SID_NG]);
    expect(subs).toHaveLength(3);
    expect(data.subagentCount).toBe(3);
    // 道名/归因标签：同节点跨尝试撞名 → ·g0·1 / ·g0·2；无图成员剥装饰取基名
    const labelBySid = new Map(roots.map((a: { member: { taskId: string; label: string } }) => [a.member.taskId, a.member.label]));
    expect(labelBySid.get(SID_G1)).toBe('detect-npu-arch·g0·1');
    expect(labelBySid.get(SID_G2)).toBe('detect-npu-arch·g0·2');
    expect(labelBySid.get(SID_NG)).toBe('setup-ops-test-kit');
    // 无 sid 成员位（init process）不得出现
    const allTaskIds = new Set(data.items.map((a: { member: { taskId: string } | null }) => a.member?.taskId).filter(Boolean));
    expect([...allTaskIds].sort()).toEqual([...ALL_SIDS].sort());
  });

  it('run 详情名册 + memberStats：三成员全量（无图成员计入 Σ）', async () => {
    const res = await runDetailGET(req(`/api/observe/run/${RUN_ID}`), ctx(RUN_ID));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.members.map((m: { taskId: string }) => m.taskId).sort()).toEqual([...ALL_SIDS].sort());
    expect(data.memberStats.joinedCount).toBe(3);
  });

  it('列表 sessionMemberCount：引用会话的成员位计数（图注解可选）', () => {
    const { runs } = listRuns();
    const item = runs.find(r => r.runId === RUN_ID);
    expect(item).toBeTruthy();
    expect(item!.sessionMemberCount).toBe(3);
  });
});
