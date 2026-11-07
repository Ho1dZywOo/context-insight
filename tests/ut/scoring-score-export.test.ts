// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// the CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Score 评测数据导出 IT（issue #116：数据用于自循环演进 RSI）：域服务
// buildScoreExport（三层结构：分数层/匹配关系层/溯源层 + 缺卡容错）与
// solo run 端点 GET 全链路（scope 解析 → 组装 → attachment）。独立 sid
// （ses_scoreexp_*）+ tmp SCORING_* 目录隔离（不读不写真实用户目录）。

import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';
import { buildScoreExport, SCORE_EXPORT_SCHEMA, SCORECARD_SCHEMA, SCORER_VERSION } from '@/lib/scoring';
import { VERSION as INSIGHT_VERSION } from '@/lib/version';
import { GET as scoreExportGET } from '@/app/api/observe/run/[runId]/score-export/route';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'score-export-it-'));
process.env.SCORING_DATA_DIR = path.join(TMP, 'scorecards');
process.env.SCORING_BASELINE_DIR = path.join(TMP, 'baselines');
process.env.SCORING_PROFILE_DIR = path.join(TMP, 'profiles');
process.env.SCORING_USER_DEF_DIR = path.join(TMP, 'user-defs');

const prisma = new PrismaClient();

async function seedSession(sid: string, calls: Array<{ args: string; state?: string; error?: string }>) {
  const s = await prisma.session.create({ data: { taskId: sid, framework: 'opencode' } });
  if (calls.length === 0) return s;
  const t = await prisma.turn.create({
    data: { sessionId: s.id, turnIndex: 0, role: 'assistant', totalTokens: 100 },
  });
  await prisma.toolCall.createMany({
    data: calls.map((c, i) => ({
      turnId: t.id,
      toolCallId: `${sid}-c${i}`,
      toolName: 'Bash',
      argsJson: c.args,
      state: c.state ?? 'ok',
      errorMessage: c.error ?? null,
    })),
  });
  return s;
}

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('Score 评测数据导出（issue #116，RSI 演进语料）', () => {
  it('buildScoreExport：三层结构齐备（信封/维度定义快照/全员评分卡/便利聚合），缺卡成员带 error 不炸整包', async () => {
    const a = await seedSession('ses_scoreexp_a', [
      { args: '{"cmd":"ls"}' },
      { args: '{"cmd":"pwd"}' },
      { args: '{"cmd":"date"}' },
    ]);
    try {
      const file = await buildScoreExport(
        { runId: 'scoreexp-run', name: '导出测试', kind: 'workflow' },
        [
          { taskId: 'ses_scoreexp_a', framework: 'opencode', label: 'build' },
          { taskId: 'ses_scoreexp_ghost', framework: 'opencode' },
        ],
        prisma,
      );

      // 溯源层：信封 + 版本单一源（insight/scorer/评分卡 schema）
      expect(file.schema).toBe(SCORE_EXPORT_SCHEMA);
      expect(file.schema).toBe('insight-score-export@1');
      expect(file.version).toBe(1);
      expect(new Date(file.generatedAt).toString()).not.toBe('Invalid Date');
      expect(file.source.insightVersion).toBe(INSIGHT_VERSION);
      expect(file.source.scorerVersion).toBe(SCORER_VERSION);
      expect(file.source.scorecardSchema).toBe(SCORECARD_SCHEMA);

      // 匹配关系·静态半边：内置六维定义快照在场（维度↔子项↔聚合策略，可整体序列化）
      const dimIds = file.dimensions.map(d => d.id);
      for (const id of ['D1', 'D2', 'D3', 'D4', 'D5', 'D6']) expect(dimIds).toContain(id);
      expect(file.dimensions.every(d => d.items.length > 0)).toBe(true);
      expect(file.dimensions.every(d => typeof d.aggregation?.kind === 'string')).toBe(true);
      expect(JSON.parse(JSON.stringify(file.dimensions))).toEqual(file.dimensions);

      // 分数层：成员卡原样内嵌（UI 同款派生形态），run 身份齐全
      expect(file.run).toEqual({ runId: 'scoreexp-run', name: '导出测试', kind: 'workflow', memberCount: 2 });
      const [ma, mg] = file.members;
      expect(ma.taskId).toBe('ses_scoreexp_a');
      expect(ma.label).toBe('build');
      expect(ma.sessionId).toBeTruthy();
      expect(ma.scorecard!.schemaVersion).toBe(SCORECARD_SCHEMA);
      expect(ma.scorecard!.dimensions.length).toBeGreaterThan(0);
      // 证据↔轮次匹配关系：每条证据可回溯（turnIndex 缺省 null 或数字）
      const evidences = ma.scorecard!.dimensions.flatMap(d => d.items.flatMap(i => i.evidence ?? []));
      expect(evidences.every(e => e.turnIndex === null || typeof e.turnIndex === 'number')).toBe(true);

      // 缺卡成员：诚实导出（error 说明原因，不炸整包）
      expect(mg.scorecard).toBeNull();
      expect(mg.error).toBeTruthy();

      // 便利聚合：与 members 自洽（总分/覆盖度直取卡内 framework；维度均值可从卡复算）
      expect(file.summary.memberTotals).toHaveLength(2);
      const mt = file.summary.memberTotals.find(t => t.taskId === 'ses_scoreexp_a')!;
      expect(mt.totalScore).toBe(ma.scorecard!.framework.totalScore);
      expect(mt.coverage).toBe(ma.scorecard!.framework.coverage);
      const ghost = file.summary.memberTotals.find(t => t.taskId === 'ses_scoreexp_ghost')!;
      expect(ghost.totalScore).toBeNull();
      expect(ghost.status).toBe('missing');
      expect(file.summary.dimensionMeans.length).toBeGreaterThan(0);
      for (const dm of file.summary.dimensionMeans) {
        const scores = ma.scorecard!.dimensions
          .filter(d => d.dimensionId === dm.dimensionId && d.status === 'scored' && typeof d.score === 'number')
          .map(d => d.score as number);
        expect(dm.scoredMembers).toBe(scores.length);
        expect(dm.mean).toBeCloseTo(scores.reduce((x, y) => x + y, 0) / scores.length, 10);
      }
    } finally {
      await prisma.session.delete({ where: { id: a.id } }).catch(() => {});
    }
  });

  it('solo run 端点：GET → 200 + JSON attachment + 单成员全员包', async () => {
    const b = await seedSession('ses_scoreexp_b', [
      { args: '{"cmd":"git status"}' },
      { args: '{"cmd":"make test"}' },
    ]);
    try {
      const res = await scoreExportGET(
        new NextRequest('http://localhost/api/observe/run/solo:ses_scoreexp_b/score-export'),
        { params: Promise.resolve({ runId: 'solo:ses_scoreexp_b' }) },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(res.headers.get('content-disposition')).toContain('session_ses_scoreexp_b_score.json');
      const file = await res.json();
      expect(file.schema).toBe('insight-score-export@1');
      expect(file.run.kind).toBe('solo');
      expect(file.run.memberCount).toBe(1);
      expect(file.members).toHaveLength(1);
      expect(file.members[0].taskId).toBe('ses_scoreexp_b');
      expect(file.members[0].scorecard).not.toBeNull();
    } finally {
      await prisma.session.delete({ where: { id: b.id } }).catch(() => {});
    }
  });

  it('run 不存在：404（run-not-found）', async () => {
    const res = await scoreExportGET(
      new NextRequest('http://localhost/api/observe/run/no-such-run/score-export'),
      { params: Promise.resolve({ runId: 'no-such-run' }) },
    );
    expect(res.status).toBe(404);
    expect((await res.json()).reason).toBe('run-not-found');
  });
});
