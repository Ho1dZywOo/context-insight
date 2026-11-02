// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// /api/ingest/lake 的 lake-notes 动作 e2e（单源架构统一切入点）：本地 bare 湖 +
// 真测试库评分卡 → POST {action:'lake-notes'}（读，上报前「先弹确认」取快照）与
// {action:'lake-notes', kind:'scorecard'}（覆盖写评分卡快照）→ 读回类型化记录；
// 未知 sid 404 / 缺 sid 400 / 非法 recording 400。负向验证：旧实现无 lake-notes
// 分支，落到末尾 Unknown action 返回 400。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { makeBareLake } from '../ut/lake_viewer/helpers/makeLake';
import type { Scorecard } from '../../src/lib/scoring';
import { seedLakeConfig } from '../helpers/lake-env';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lake-ingest-notes-'));
const BARE = path.join(TMP, 'lake.git');
seedLakeConfig(TMP, { address: BARE });
process.env.LAKE_VIEWER_CACHE_DIR = path.join(TMP, 'cache');
process.env.SCORING_DATA_DIR = path.join(TMP, 'scorecards');

const prisma = new PrismaClient();
const SID = 'ele-notes0001';

beforeAll(async () => {
  makeBareLake(BARE, [
    {
      time: '2026-09-01T10:00:00+08:00',
      message: '提交人: zhang3 内容描述: 评分卡上报冒烟 日志路径: /tmp/s.jsonl.gz 备注: 空跑验证 框架: claude-code 时间: 2026-09-01 09:55',
      sessions: [{ sid: SID, paradigm: 'elementwise', framework: 'claude-code', ccVersion: '1.2.3' }],
    },
  ]);

  await prisma.session.deleteMany({ where: { taskId: SID } });
  const row = await prisma.session.create({
    data: {
      taskId: SID,
      framework: 'claude-code',
      version: '1.2.3',
      startTime: new Date('2026-09-01T09:55:00+08:00'),
      endTime: new Date('2026-09-01T10:25:00+08:00'),
      totalTokens: 60_000,
    },
    select: { id: true },
  });
  const card: Scorecard = {
    schemaVersion: 'workflow-scorecard@2',
    sessionId: row.id,
    taskType: 'operator',
    computedAt: '2026-09-16T09:00:00+08:00',
    status: 'completed',
    framework: { totalScore: 87, veto: null, coverage: 1, weightsUsed: {} },
    dimensions: [
      { dimensionId: 'correctness', name: '正确性', english: 'correctness', role: 'weighted', status: 'scored', score: 0.9, items: [] },
      { dimensionId: 'efficiency', name: '效率', english: 'efficiency', role: 'weighted', status: 'scored', score: 0.84, items: [] },
      { dimensionId: 'completeness', name: '完整性', english: 'completeness', role: 'weighted', status: 'scored', score: 0.87, items: [] },
      { dimensionId: 'robustness', name: '健壮性', english: 'robustness', role: 'weighted', status: 'scored', score: 0.8, items: [] },
      { dimensionId: 'readability', name: '可读性', english: 'readability', role: 'weighted', status: 'scored', score: 0.92, items: [] },
      { dimensionId: 'maintainability', name: '可维护性', english: 'maintainability', role: 'weighted', status: 'scored', score: 0.89, items: [] },
    ],
    judgeCost: null,
  };
  const { scorecardStore } = await import('../../src/lib/scoring');
  await scorecardStore().put(card);
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: SID } });
  await prisma.$disconnect();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

const post = (body: Record<string, unknown>) => new NextRequest('http://localhost/api/ingest/lake', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'lake-notes', ...body }),
});

interface ApiRecord { ts: string; type: string; totalScore?: number | null }

describe('ingest/lake lake-notes 动作（本地 bare 湖 + 真测试库评分卡）', () => {
  it('读（无 kind）→ 空仓返回空记录列表（上报前「先弹确认」取数）', async () => {
    const { POST } = await import('../../src/app/api/ingest/lake/route');
    const res = await POST(post({ sid: SID }));
    expect(res.status).toBe(200);
    const { records } = await res.json() as { records: ApiRecord[] };
    expect(Array.isArray(records)).toBe(true);
    expect(records).toHaveLength(0);
  });

  it('scorecard 覆盖写 → 快照入湖并可读回（总分 87）', async () => {
    const { POST } = await import('../../src/app/api/ingest/lake/route');
    const w = await POST(post({ sid: SID, kind: 'scorecard' }));
    expect(w.status).toBe(200);
    const wdata = await w.json() as { records: ApiRecord[] };
    const cards = wdata.records.filter(r => r.type === 'scorecard');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.totalScore).toBe(87);

    const r = await POST(post({ sid: SID }));
    expect(r.status).toBe(200);
    const { records } = await r.json() as { records: ApiRecord[] };
    expect(records.filter(x => x.type === 'scorecard')).toHaveLength(1);
  });

  it('未知 sid 404 / 缺 sid 400 / 非法 recording 400', async () => {
    const { POST } = await import('../../src/app/api/ingest/lake/route');
    expect((await POST(post({ sid: 'no-such-sid' }))).status).toBe(404);
    expect((await POST(post({}))).status).toBe(400);
    expect((await POST(post({ sid: SID, recording: 'weird' }))).status).toBe(400);
  });
});
