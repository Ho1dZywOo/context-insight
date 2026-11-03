// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 泳道车道表 run 级端点 IT（master 947f4b2 session-lanes-route 平移到
// run-first 形态）：车道是 run 级概念——bundle 成员共享范式目录，solo run
// 即单成员，端点不做成员转发（collector 直连）。三级解析。① 湖范式命中
// （声明即信任，source=paradigm）② 范式缺失/未配置（本地会话未上湖）→
// 桥派发描述内容签名推断（source=inferred，本地 op-fusion 会话的核心场景）
// ③ 内容不过阈 → 空表回落贪心（source=null）。solo run 免 member 直取；
// 同 sid 双记录由 scope 原生优先消歧；bundle run 全成员桥池化推断（单成员
// 各命中单车道是词频巧合，池化后双车道才是结构证据）。

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prisma } from '../setup';
import { parseAndIndex } from '@/lib/run/reader';
import { saveRun, type RunImportMeta } from '@/lib/run/run-store';

const lakeSessions = [
  { sid: 'ses-lane-it-known', paradigm: 'op-fusion' },
  { sid: 'ses-lane-it-unknown', paradigm: 'op-split' },
];
vi.mock('@/lib/collection/lake-view/runs', () => ({
  getLakeListing: async () => ({ sessions: lakeSessions, paradigms: [], baselineByParadigm: new Map(), head: null }),
}));

import { GET as runLanesGET } from '@/app/api/observe/run/[runId]/lanes/route';

const KNOWN = 'ses-lane-it-known';
const NOLAKE = 'ses-lane-it-nolake';
const WEAK = 'ses-lane-it-weak';
const DUAL = 'ses-lane-it-dual';
const POOL_A = 'rfmv-ses-mini-a';
const POOL_B = 'rfmv-ses-mini-b';
const POOL_C = 'rfmv-ses-mini-c';
const ALL = [KNOWN, NOLAKE, WEAK, DUAL, POOL_A, POOL_B, POOL_C];
const OP_FUSION_DISPATCHES = [
  'P1 需求分析', 'R 门控：P1 审核',
  '④ 模板计算流：base', '④ 模板计算流：group',
  'R 门控：④ base 审核', '④.5 存活节点：group', '⑤ VF 融合：base',
];

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-run-lanes-'));
const ORIG_HOME = process.env.CONTEXT_INSIGHT_HOME;
const BUNDLE_RUN_ID = 'minidemo01';

beforeAll(async () => {
  process.env.CONTEXT_INSIGHT_HOME = tmpHome;
  // bundle run：mini-bundle 清单（3 成员）落 run-store（HOME 隔离）；清单内
  // sid 前缀改写避免与其它用例的库内 taskId 冲突（run-member-views 同款）
  const rewriteSid = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(/^ses_mini_/, 'rfmv-ses-mini-');
    if (Array.isArray(v)) return v.map(rewriteSid);
    if (v != null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, rewriteSid(val)]));
    }
    return v;
  };
  const manifest = parseAndIndex(
    rewriteSid(JSON.parse(fs.readFileSync(path.resolve(__dirname, './data/run/mini-bundle/workflow.json'), 'utf-8'))) as Parameters<typeof parseAndIndex>[0],
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

  await prisma.session.deleteMany({ where: { taskId: { in: ALL } } });
  const ids: Record<string, string> = {};
  for (const taskId of [KNOWN, NOLAKE, WEAK]) {
    const s = await prisma.session.create({ data: { taskId, framework: 'opencode' } });
    ids[taskId] = s.id;
  }
  // 本地（未上湖）会话的桥：op-fusion 形态派发描述（7 条有效，5 命中，率 0.71）
  await prisma.interactionBridge.createMany({
    data: OP_FUSION_DISPATCHES.map(dispatchContent => ({
      sessionId: ids[NOLAKE], dispatchExecutionId: 'exec-lane-it', dispatchContent, status: 'completed',
    })),
  });
  // 弱内容会话：10 条里 1 条含 base（率 0.1、单车道）→ 不过阈回落空表
  await prisma.interactionBridge.createMany({
    data: Array.from({ length: 10 }, (_, i) => ({
      sessionId: ids[WEAK], dispatchExecutionId: 'exec-lane-it',
      dispatchContent: i === 0 ? '④ 模板计算流：base' : `杂项说明 ${i}`, status: 'completed',
    })),
  });
  // 同 sid 双记录：桥只在原生行——scope 原生优先，推断读原生行的桥
  const dualNative = await prisma.session.create({ data: { taskId: DUAL, framework: 'opencode' } });
  await prisma.session.create({ data: { taskId: DUAL, framework: 'opencode-proxy' } });
  await prisma.interactionBridge.createMany({
    data: OP_FUSION_DISPATCHES.map(dispatchContent => ({
      sessionId: dualNative.id, dispatchExecutionId: 'exec-lane-it', dispatchContent, status: 'completed',
    })),
  });
  // bundle 成员桥：A 全 base、B 全 group——单成员各命中单车道（distinct=1，
  // 词频巧合不过阈），池化后双车道过阈（run 级推断的结构证据）
  const poolSessions = await Promise.all(
    [POOL_A, POOL_B, POOL_C].map(taskId => prisma.session.create({ data: { taskId, framework: 'opencode' } })),
  );
  const [poolA, poolB] = poolSessions;
  await prisma.interactionBridge.createMany({
    data: [
      ...Array.from({ length: 4 }, () => ({
        sessionId: poolA.id, dispatchExecutionId: 'exec-lane-it', dispatchContent: '④ 模板计算流：base', status: 'completed',
      })),
      ...Array.from({ length: 4 }, () => ({
        sessionId: poolB.id, dispatchExecutionId: 'exec-lane-it', dispatchContent: '④.5 存活节点：group', status: 'completed',
      })),
    ],
  });
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: { in: ALL } } });
  if (ORIG_HOME === undefined) delete process.env.CONTEXT_INSIGHT_HOME;
  else process.env.CONTEXT_INSIGHT_HOME = ORIG_HOME;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const call = (runId: string, query = '') =>
  runLanesGET(
    new NextRequest(`http://localhost/api/observe/run/${runId}/lanes${query}`),
    { params: Promise.resolve({ runId }) },
  );

describe('泳道车道表 run 成员端点（三级解析）', () => {
  it('① 湖范式 × 配置声明：source=paradigm，声明即信任', async () => {
    const res = await call(`solo:${KNOWN}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ paradigm: 'op-fusion', lanes: ['base', 'group', 'empty'], source: 'paradigm' });
  });

  it('② 本地会话（未上湖）→ 桥派发描述推断：source=inferred', async () => {
    const res = await call(`solo:${NOLAKE}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe('inferred');
    expect(body.paradigm).toBe('op-fusion');
    expect(body.lanes.length).toBeGreaterThan(0);
  });

  it('③ 弱内容不过阈 → 空表回落贪心：source=null', async () => {
    const res = await call(`solo:${WEAK}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ paradigm: null, lanes: [], source: null });
  });

  it('同 sid 双记录：scope 原生优先行驱动推断（framework 消歧不串行）', async () => {
    const res = await call(`solo:${DUAL}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe('inferred');
    expect(body.paradigm).toBe('op-fusion');
  });

  it('bundle run：全成员桥池化推断——单成员单车道是词频巧合，池化双车道过阈', async () => {
    // A 全 base（distinct=1）/ B 全 group（distinct=1）各自不过阈；run 级
    // 池化后双车道命中（率 1.0）——车道是 run 级结构，成员切片看不到全貌
    const res = await call(BUNDLE_RUN_ID);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe('inferred');
    expect(body.paradigm).toBe('op-fusion');
    expect(body.lanes).toEqual(['base', 'group', 'empty']);
  });
});
