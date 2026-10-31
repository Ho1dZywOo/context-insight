// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 统一资产列表 IT（design: docs/design/unified-workbench/design.md §3）：
// 会话 + run 单表混排——① 导入时间倒序混排（会话 createdAt ↔ run importedAt）
// ② run 穿插下的分页切片正确性 ③ 搜索跨 kind（taskId/query/label ↔ runId/name）
// ④ kind 过滤 ⑤ Σ成员会话 tokens join ⑥ 隔离回归：run owned 会话在
// kind=all / kind=session / 搜索三条路径下都不出现在会话行（修复此前
// /api/observe/data 翻页/搜索路由未过隔离闸的缺口——仅 SSR 首屏隔离）。

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { NextRequest } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { importSession } from '../../src/lib/ingest/data-service.ts';
import { getActiveSplitMap } from '../../src/lib/active-time-map.ts';
import { parseAndIndex } from '../../src/lib/run/reader.ts';
import { saveRun, type RunImportMeta } from '../../src/lib/run/run-store.ts';

const prisma = new PrismaClient();
const dataRoute = await import('../../src/app/api/observe/data/route.ts');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-list-it-'));
const ORIG_HOME = process.env.CONTEXT_INSIGHT_HOME;
process.env.CONTEXT_INSIGHT_HOME = TMP;

const SID_A = 'cc-list-a';
const SID_B = 'cc-list-b';
const SID_C = 'cc-list-c';

function fixture(sid: string, prompt: string): string {
  const file = path.join(TMP, `${sid}.jsonl`);
  const t = (s: number) => new Date(Date.parse('2026-10-01T10:00:00.000Z') + s * 1000).toISOString();
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: prompt }, timestamp: t(0) }),
    JSON.stringify({ type: 'assistant', message: { id: `msg_${sid}`, role: 'assistant', content: [{ type: 'text', text: 'ok' }], model: 'test-model', usage: { input_tokens: 5, output_tokens: 1 } }, timestamp: t(1) }),
  ].join('\n') + '\n');
  return file;
}

function runMeta(importedAt: string, owned?: { sid: string; framework: string | null }[]): RunImportMeta {
  return {
    schema: 'insight-run-import',
    version: 1,
    data: {
      importedAt,
      sourceDir: '/bundle/x',
      manifestFile: 'workflow.json',
      exportDataComplete: true,
      sessions: { total: 0, imported: 0, existing: 0, missingFile: 0, failed: 0 },
      failures: [],
      warnings: [],
      ...(owned ? { ownedSessions: owned } : {}),
    },
  };
}

function manifestOf(file: string, sidPrefix?: string) {
  let data: unknown = JSON.parse(fs.readFileSync(path.resolve(__dirname, file), 'utf-8'));
  if (sidPrefix) {
    // 共享 test.db 前缀隔离（仓规）：mini-bundle 成员 sid 重写，避免与
    // run-import-service（bundle 导入种未前缀 ses_mini_*）跨文件串扰
    const rewrite = (v: unknown): unknown => {
      if (typeof v === 'string') return v.replace(/^ses_mini_/, `${sidPrefix}mini_`);
      if (Array.isArray(v)) return v.map(rewrite);
      if (v != null && typeof v === 'object') {
        return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, rewrite(val)]));
      }
      return v;
    };
    data = rewrite(data);
  }
  return parseAndIndex(data as Parameters<typeof parseAndIndex>[0]).manifest;
}

// 并发测试文件共享 test.db——断言域用 q='cc-list' 隔离（taskId 与 run 名
// 同前缀），排序/分页/计数不受其他文件种子污染；runs 目录按文件隔离
// （CONTEXT_INSIGHT_HOME 各自 tmp），run 断言天然确定。

async function seedSession(sid: string, prompt: string, importedAt: string) {
  await importSession(fixture(sid, prompt), sid, prisma, path.join(TMP, `${sid}.jsonl`), 'claude-jsonl');
  await prisma.session.updateMany({ where: { taskId: sid }, data: { createdAt: new Date(importedAt) } });
}

async function getItems(query: string): Promise<{ items: Array<Record<string, unknown>>; total: number; totalCount?: number }> {
  const res = await dataRoute.GET(new NextRequest(`http://localhost/api/observe/data?${query}`));
  expect(res.status).toBe(200);
  return await res.json();
}

afterAll(async () => {
  for (const sid of [SID_A, SID_B, SID_C, 'cl-mini_a', 'cl-mini_c']) {
    try { await prisma.session.deleteMany({ where: { taskId: sid } }); } catch { /* ignore */ }
  }
  await prisma.$disconnect();
  fs.rmSync(TMP, { recursive: true, force: true });
  if (ORIG_HOME === undefined) delete process.env.CONTEXT_INSIGHT_HOME;
  else process.env.CONTEXT_INSIGHT_HOME = ORIG_HOME;
});

describe('统一资产列表：单表混排', () => {
  // 时间线（倒序）：C(10-14) > B(10-12) > run R1(10-11) > A(10-10)
  // pageSize=2 → page1=[C,B]，page2=[R1,A]（run 穿插页边界）
  beforeAll(async () => {
    await seedSession(SID_A, '会话A:矩阵乘优化', '2026-10-10T00:00:00.000Z');
    await seedSession(SID_B, '会话B:算子验证', '2026-10-12T00:00:00.000Z');
    await seedSession(SID_C, '会话C:错误修复', '2026-10-14T00:00:00.000Z');
    const manifest = manifestOf('./data/run/mini-bundle/workflow.json', 'cl-');
    manifest.id = 'cc-list-run-01';
    manifest.name = 'cc-list 混排 run';
    saveRun(manifest, runMeta('2026-10-11T00:00:00.000Z'));
  });

  it('导入时间倒序混排：run 行按 importedAt 穿插在会话行之间', async () => {
    const data = await getItems('q=cc-list&pageSize=10');
    const order = data.items.map(i => (i.kind === 'run' ? `run:${i.runId}` : i.taskId));
    expect(order).toEqual([SID_C, SID_B, 'run:cc-list-run-01', SID_A]);
    // run 行形状：kind 判别 + 名称 + 导入时间
    const run = data.items.find(i => i.kind === 'run')!;
    expect(run.name).toBe('cc-list 混排 run');
    expect(run.importedAt).toBe('2026-10-11T00:00:00.000Z');
    // 会话行补 kind 字段（判别联合）
    expect(data.items.find(i => i.taskId === SID_C)!.kind).toBe('session');
    // total = 会话 3 + run 1（q 隔离域内）
    expect(data.total).toBe(4);
  });

  it('run 穿插下的分页切片：page2 首行 = run（页边界正确性）', async () => {
    const page1 = await getItems('q=cc-list&pageSize=2&page=1');
    expect(page1.items.map(i => (i.kind === 'run' ? 'run' : i.taskId))).toEqual([SID_C, SID_B]);
    const page2 = await getItems('q=cc-list&pageSize=2&page=2');
    const page2Ids = page2.items.map(i => (i.kind === 'run' ? `run:${i.runId}` : i.taskId));
    expect(page2Ids).toEqual(['run:cc-list-run-01', SID_A]);
    expect(page2.total).toBe(4);
  });

  it('搜索跨 kind：q 命中 run 名 → 只返回 run 行；q 命中会话 query → 只返回会话行', async () => {
    const byRun = await getItems('q=cc-list 混排 run');
    expect(byRun.items).toHaveLength(1);
    expect(byRun.items[0].kind).toBe('run');

    const bySession = await getItems('q=矩阵乘');
    expect(bySession.items.map(i => i.taskId)).toEqual([SID_A]);
  });

  it('kind 过滤：kind=session 纯会话；kind=run 纯 run', async () => {
    const sessionsOnly = await getItems('kind=session&q=cc-list');
    expect(sessionsOnly.items.every(i => i.kind === 'session')).toBe(true);
    expect(sessionsOnly.items.map(i => i.taskId).sort()).toEqual([SID_A, SID_B, SID_C].sort());

    const runsOnly = await getItems('kind=run');
    expect(runsOnly.items.every(i => i.kind === 'run')).toBe(true);
    expect(runsOnly.items.map(i => i.runId)).toEqual(['cc-list-run-01']);
  });

  it('Σ成员会话指标：run 行 memberStats = join 聚合（tokens/cost/active/models/起止兜底）', async () => {
    await seedSession('cl-mini_a', 'mini 成员A', '2026-10-05T00:00:00.000Z');
    await seedSession('cl-mini_c', 'mini 成员C', '2026-10-06T00:00:00.000Z');
    // 模型分布展示口径：不同 provider 前缀的同名模型应归一合并计数
    await prisma.session.updateMany({ where: { taskId: 'cl-mini_a' }, data: { model: 'volc-gateway/deepseek-v4-pro' } });
    await prisma.session.updateMany({ where: { taskId: 'cl-mini_c' }, data: { model: 'deepseek/deepseek-v4-pro' } });
    const rows = await prisma.session.findMany({
      where: { taskId: { in: ['cl-mini_a', 'cl-mini_c'] } },
      select: { id: true, taskId: true, totalTokens: true, totalCost: true, model: true, startTime: true, endTime: true, version: true },
    });
    const expectSum = rows.reduce((s, r) => s + r.totalTokens, 0);
    const expectCost = rows.reduce((s, r) => s + r.totalCost, 0);
    // 期望活跃 Σ 直接从同款拆分实现推导（锁「聚合 = Active 列同口径 Σ」）
    const activeMap = await getActiveSplitMap(rows);
    const actives = rows.map(r => activeMap.get(r.id)?.activeMs ?? null);
    const expectActive = actives.every(a => a == null)
      ? null
      : actives.reduce<number>((s, a) => s + (a ?? 0), 0);

    const data = await getItems('kind=run');
    const run = data.items.find(i => i.runId === 'cc-list-run-01')!;
    const stats = run.memberStats as {
      joinedCount: number; totalTokens: number; totalCost: number; totalActiveMs: number | null;
      models: Array<{ model: string; count: number }>;
      earliestStart: string | null; latestEnd: string | null;
    };
    expect(stats.totalTokens).toBe(expectSum);
    expect(stats.totalCost).toBeCloseTo(expectCost, 6);
    expect(stats.joinedCount).toBe(rows.length);
    expect(stats.totalActiveMs).toBe(expectActive);
    // 模型分布：去 provider 前缀归一后，volc-gateway/ 与 deepseek/ 同名模型合并计数
    expect(stats.models).toEqual([{ model: 'deepseek-v4-pro', count: rows.length }]);
    // 起止兜底：成员会话最早开始 / 最晚结束（fixture 首条 user turn 时刻）
    expect(stats.earliestStart).toBe('2026-10-01T10:00:00.000Z');
    expect(stats.latestEnd).toBe('2026-10-01T10:00:01.000Z');
  });
});

describe('统一资产列表：run 会话隔离回归（缺口修复）', () => {
  beforeAll(async () => {
    // R2 收编 SID_B（ownedSessions 精确到 (taskId, framework) 对）
    const b = await prisma.session.findFirst({ where: { taskId: SID_B }, select: { framework: true } });
    saveRun(manifestOf('./data/run/graph-bend-braid-manifest.json'), runMeta('2026-10-15T00:00:00.000Z', [{ sid: SID_B, framework: b?.framework ?? null }]));
  });

  it('kind=all：owned 会话不进会话行，run 行在列；q 隔离域计数不含 owned', async () => {
    const data = await getItems('q=cc-list&pageSize=10');
    expect(data.items.find(i => i.taskId === SID_B)).toBeUndefined();
    // 独立会话 A/C（B 被收编）+ run01 → 3
    expect(data.total).toBe(3);
    // 两个 run 都在（runs 目录按文件隔离，列表确定）
    const runsOnly = await getItems('kind=run');
    expect(runsOnly.items.map(i => i.runId)).toEqual(['WA0B1C2D3E4F5002', 'cc-list-run-01']);
  });

  it('kind=session：owned 会话同样排除（计数聚合一致）', async () => {
    const data = await getItems('kind=session&q=cc-list');
    expect(data.items.find(i => i.taskId === SID_B)).toBeUndefined();
    expect(data.items.map(i => i.taskId).sort()).toEqual([SID_A, SID_C].sort());
    expect(data.total).toBe(2);
  });

  it('搜索路径：q 精确命中 owned 会话 taskId → 不出现（此前翻页/搜索路由漏隔离）', async () => {
    const data = await getItems(`q=${SID_B}`);
    expect(data.items.find(i => i.taskId === SID_B)).toBeUndefined();
    expect(data.total).toBe(0);
  });
});
