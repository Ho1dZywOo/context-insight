// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// the CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Score 评测数据导出（issue #116：数据用于自循环演进 RSI）：单一 JSON 文件，
// 三层可回溯——
// ① 分数层：每成员完整评分卡（workflow-scorecard@2 原样内嵌不重造——分
//   数/判定/原始值/证据 turnIndex 都在卡里）；
// ② 匹配关系层：维度定义快照（维度↔子项↔权重↔聚合策略，含 profile 覆
//   盖与 D7 用户维——导出即当时生效口径，RSI 侧无需读码即可解释分数）；
// ③ 溯源层：insight/scorer 版本、profile、时刻、run·成员身份（跨 run
//   对比的口径可比性）。
// 消费入口两份一源：页面按钮与 API GET 同款载荷（RSI 管线 curl 直拉）。
// GET 语义 = 读最新缓存卡（无则现算确定性层）——幂等只读；要新卡先 POST
// scorecard 重算。summary 是派生便利聚合（无权重统计），不是 run 级融合
// 评分（融合仍是后续版本议题）。缺卡成员带 error 照实导出，不炸整包。

import type { PrismaClient } from '@prisma/client';
import { VERSION as INSIGHT_VERSION } from '@/lib/version';
import type { DimensionDefinition } from './schema';
import type { Scorecard } from './types';
import { SCORECARD_SCHEMA } from './types';
import { SCORER_VERSION } from './runner';
import { loadRegistry } from '../registry';
import { getDerivedScorecard } from './scorecard-read';
import { mapBounded } from '@/lib/shared/map-bounded';

export const SCORE_EXPORT_SCHEMA = 'insight-score-export@1' as const;

/** 导出全员取卡并发上限：缓存未命中成员会触发完整现算（重 Prisma 读 + 落盘），
 *  无界并发会在首次导出大 run 时打满事件循环 / SQLite 单写者争抢；有界限流
 *  与湖侧清单（SCORE_FETCH_LIMIT=8）同口径，GET 幂等只读不再被 N 次并发写拖垮。 */
export const SCORE_EXPORT_CONCURRENCY = 8;

export interface ScoreExportSource {
  insightVersion: string;
  scorerVersion: string;
  scorecardSchema: string;
  /** 生效评分口径快照（null = 默认口径） */
  profile: { id: string; name: string } | null;
}

export interface ScoreExportRunMeta {
  runId: string;
  name: string | null;
  /** 'solo' 或 manifest kind（如 'workflow'） */
  kind: string;
  memberCount: number;
}

export interface ScoreExportMember {
  taskId: string;
  framework: string;
  label: string | null;
  sessionId: string | null;
  /** null = 会话缺失/算卡失败（error 说明原因）——诚实导出，整包不炸 */
  scorecard: Scorecard | null;
  error?: string;
}

export interface ScoreExportFile {
  schema: typeof SCORE_EXPORT_SCHEMA;
  version: 1;
  generatedAt: string;
  source: ScoreExportSource;
  run: ScoreExportRunMeta;
  /** 匹配关系·静态半边：生效口径的维度定义快照（定义是数据，可整体序列化） */
  dimensions: DimensionDefinition[];
  /** 分数层·动态半边：每成员完整评分卡（UI 同款派生形态） */
  members: ScoreExportMember[];
  /** 便利聚合（派生只读，无权重统计——不是融合评分） */
  summary: {
    memberTotals: Array<{
      taskId: string;
      totalScore: number | null;
      coverage: number | null;
      vetoTriggered: boolean;
      status: string;
    }>;
    dimensionMeans: Array<{ dimensionId: string; name: string; scoredMembers: number; mean: number }>;
  };
}

export interface ScoreExportMemberInput {
  taskId: string;
  framework: string;
  label?: string | null;
}

/** run 全员评分导出组装（域服务）：成员并行取派生卡（registry 单次加载全
 * 员复用），缺卡成员带 error 不炸整包；聚合层从成员卡现算（单一源，不引
 * 入第二套分数口径）。 */
export async function buildScoreExport(
  run: Omit<ScoreExportRunMeta, 'memberCount'>,
  members: ScoreExportMemberInput[],
  prisma: PrismaClient,
): Promise<ScoreExportFile> {
  const registry = await loadRegistry();
  const entries: ScoreExportMember[] = await mapBounded(members, SCORE_EXPORT_CONCURRENCY, async m => {
    const base = { taskId: m.taskId, framework: m.framework, label: m.label ?? null };
    try {
      const got = await getDerivedScorecard(m.taskId, { framework: m.framework, prisma, registry });
      if (!got) return { ...base, sessionId: null, scorecard: null, error: 'session-not-found' };
      return { ...base, sessionId: got.sessionId, scorecard: got.card };
    } catch (e) {
      return { ...base, sessionId: null, scorecard: null, error: e instanceof Error ? e.message : 'scorecard-failed' };
    }
  });

  const memberTotals = entries.map(m => ({
    taskId: m.taskId,
    totalScore: m.scorecard?.framework.totalScore ?? null,
    coverage: m.scorecard?.framework.coverage ?? null,
    vetoTriggered: m.scorecard?.framework.veto?.triggered ?? false,
    status: m.scorecard?.status ?? 'missing',
  }));

  // 维度均值：只聚合已评出分数的成员维度（NA/否决维不入均值——口径与卡内一致）
  const dimAgg = new Map<string, { name: string; scores: number[] }>();
  for (const m of entries) {
    for (const d of m.scorecard?.dimensions ?? []) {
      if (d.status !== 'scored' || typeof d.score !== 'number') continue;
      const agg = dimAgg.get(d.dimensionId) ?? { name: d.name, scores: [] };
      agg.scores.push(d.score);
      dimAgg.set(d.dimensionId, agg);
    }
  }
  const dimensionMeans = [...dimAgg.entries()].map(([dimensionId, agg]) => ({
    dimensionId,
    name: agg.name,
    scoredMembers: agg.scores.length,
    mean: agg.scores.reduce((a, b) => a + b, 0) / agg.scores.length,
  }));

  return {
    schema: SCORE_EXPORT_SCHEMA,
    version: 1,
    generatedAt: new Date().toISOString(),
    source: {
      insightVersion: INSIGHT_VERSION,
      scorerVersion: SCORER_VERSION,
      scorecardSchema: SCORECARD_SCHEMA,
      profile: registry.profile,
    },
    run: { ...run, memberCount: members.length },
    dimensions: registry.defs,
    members: entries,
    summary: { memberTotals, dimensionMeans },
  };
}
