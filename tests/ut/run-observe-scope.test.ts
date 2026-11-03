// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// run 观测作用域 IT（design: docs/design/run-observe-parity/design.md §3.1）：
// 真实 fixture（mini-bundle，sid 重写 rop- 前缀）+ 真实 prisma 种成员会话 →
// 锁三件事：①resolveRunScope 成员身份/结构归因（graph 注解 → nodeKey 与
// view-model 同构）；②LRU 缓存命中（同 runId 二次解析零重查）；③run 不存在
// → null。另锁 GET /api/observe/run/[runId] 的 memberStats/totalErrors 聚合
// （两段式活跃拆分 + 页级错误计数，与统一列表/首页 Errors 同口径）。

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { parseAndIndex } from '@/lib/run/reader';
import { saveRun, type RunImportMeta } from '@/lib/run/run-store';
import { resolveRunScope } from '@/lib/run/observe/scope';
import { prisma } from '@/lib/db';
import { GET as runDetailGET } from '@/app/api/observe/run/[runId]/route';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-run-observe-scope-'));
const ORIG_HOME = process.env.CONTEXT_INSIGHT_HOME;

// 文件级前缀（rop- = run-observe-parity）：共享 test.db 下与 uw-/cl- 前缀互不串扰
const RUN_ID = 'minidemo01';
const MEMBER_SIDS = ['rop-ses-mini-a', 'rop-ses-mini-b', 'rop-ses-mini-c'];

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

  // 成员会话入库：a/b 同模型不同 provider（锁 models 归一合并），c 异模型
  await prisma.session.deleteMany({ where: { taskId: { in: MEMBER_SIDS } } });
  await prisma.session.createMany({
    data: [
      { taskId: MEMBER_SIDS[0]!, framework: 'opencode', model: 'volc-gateway/glm-4.7', totalTokens: 1500, totalCost: 0.15, startTime: new Date('2026-10-13T02:00:12Z'), endTime: new Date('2026-10-13T02:05:12Z') },
      { taskId: MEMBER_SIDS[1]!, framework: 'opencode', model: 'deepseek/glm-4.7', totalTokens: 800, totalCost: 0.05, startTime: new Date('2026-10-13T02:06:00Z'), endTime: new Date('2026-10-13T02:07:00Z') },
      { taskId: MEMBER_SIDS[2]!, framework: 'opencode', model: 'deepseek/glm-5.3', totalTokens: 100, totalCost: 0.01, startTime: new Date('2026-10-13T03:00:00Z'), endTime: new Date('2026-10-13T03:01:00Z') },
    ],
  });
  // turn 计数与错误：a 两轮（其一挂失败 tool call）、c 一轮（b 零轮——
  // joinedCount 含 b 但 turns 贡献 0，锁「计数≠有轮」）
  const a = await prisma.session.findFirst({ where: { taskId: MEMBER_SIDS[0] }, select: { id: true } });
  const c = await prisma.session.findFirst({ where: { taskId: MEMBER_SIDS[2] }, select: { id: true } });
  await prisma.turn.createMany({
    data: [
      { sessionId: a!.id, turnIndex: 0, role: 'assistant' },
      { sessionId: a!.id, turnIndex: 1, role: 'assistant' },
      { sessionId: c!.id, turnIndex: 0, role: 'assistant' },
    ],
  });
  const t0 = await prisma.turn.findFirst({ where: { sessionId: a!.id, turnIndex: 0 }, select: { id: true } });
  await prisma.toolCall.create({ data: { turnId: t0!.id, toolCallId: 'rop-tc-1', toolName: 'Bash', state: 'error' } });
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

describe('run 观测作用域（run-observe-parity 刀A）', () => {
  it('resolveRunScope：成员身份 + 结构归因（nodeKey 与 view-model 同构）+ LRU 命中', async () => {
    const scope = await resolveRunScope(RUN_ID, prisma);
    expect(scope).not.toBeNull();
    expect(scope!.kind).toBe('run');
    expect(scope!.runId).toBe(RUN_ID);
    expect(scope!.members.map(m => m.taskId).sort()).toEqual([...MEMBER_SIDS].sort());

    const a = scope!.members.find(m => m.taskId === MEMBER_SIDS[0])!;
    expect(a.framework).toBe('opencode');
    expect(a.rowId).toBeTruthy();
    // 结构归因：build g0 执行成员（graph 注解 → nodeKey 同构 view-model）
    expect(a.structure).toMatchObject({ nodeId: 'build', generation: 0, role: 'execute' });
    expect(a.structure!.nodeKey).toBe('n-build-g0');
    expect(typeof a.structure!.attempt).toBe('number');

    // LRU 命中：同 runId 二次解析返回同一对象（join 不重跑）
    const again = await resolveRunScope(RUN_ID, prisma);
    expect(again).toBe(scope);
  });

  it('run 不存在 → null', async () => {
    expect(await resolveRunScope('rop-no-such-run', prisma)).toBeNull();
  });

  it('GET /api/observe/run/[runId]：memberStats 聚合（Σtokens/cost/turns、models 去 provider 合并）+ totalErrors', async () => {
    const res = await runDetailGET(
      new NextRequest(`http://localhost/api/observe/run/${RUN_ID}`),
      { params: Promise.resolve({ runId: RUN_ID }) },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.memberStats).toMatchObject({
      joinedCount: 3,
      totalTokens: 2_400,
      totalTurns: 3,
    });
    expect(data.memberStats.totalCost).toBeCloseTo(0.21, 10);
    // 模型分布：a/b 同模型不同 provider → 归一合并；c 单独
    expect(data.memberStats.models).toEqual([
      { model: 'glm-4.7', count: 2 },
      { model: 'glm-5.3', count: 1 },
    ]);
    expect(data.memberStats.memberRowIds).toHaveLength(3);
    // 页级错误计数：a 的一条失败 tool call（state=error）
    expect(data.totalErrors).toBe(1);
  });
});
