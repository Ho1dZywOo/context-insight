// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// the CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// buildScoreExport 并发限流回归锁（review fix）：首次导出大 run 时全员成员缓存
// 未命中，会触发 N 次完整评分现算（重 Prisma 读 + store 落盘）；GET 名义「幂等
// 只读」不应一次性打满事件循环 / SQLite 单写者。以 getDerivedScorecard 为观测缝，
// 断言全员现算并发被有界（≤ SCORE_EXPORT_CONCURRENCY）且结果按成员顺序回填。
// 修复前（Promise.all 全员并发）maxActive === N 必红。

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'score-export-conc-'));
process.env.SCORING_DATA_DIR = path.join(TMP, 'scorecards');
process.env.SCORING_PROFILE_DIR = path.join(TMP, 'profiles');
process.env.SCORING_USER_DEF_DIR = path.join(TMP, 'user-defs');

const mocks = vi.hoisted(() => {
  const state = { active: 0, maxActive: 0 };
  return {
    getDerivedScorecard: vi.fn(async (taskId: string) => {
      state.active += 1;
      state.maxActive = Math.max(state.maxActive, state.active);
      await new Promise<void>(r => setTimeout(r, 15));
      state.active -= 1;
      return {
        sessionId: `sid-${taskId}`,
        card: {
          framework: { totalScore: 0.5, coverage: 1, veto: { triggered: false } },
          status: 'completed',
          dimensions: [],
        },
      };
    }),
    maxActive: () => state.maxActive,
    reset: () => { state.active = 0; state.maxActive = 0; },
  };
});

vi.mock('@/lib/scoring/core/scorecard-read', () => ({
  getDerivedScorecard: mocks.getDerivedScorecard,
}));

import { buildScoreExport } from '@/lib/scoring';
import { SCORE_EXPORT_CONCURRENCY } from '@/lib/scoring/core/score-export';
import type { PrismaClient } from '@prisma/client';

describe('buildScoreExport 并发限流', () => {
  beforeEach(() => mocks.reset());

  afterAll(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it('全员现算并发有界（≤ 阈值）且仍并行（非串行退化），结果按成员顺序回填', async () => {
    const N = 16;
    const members = Array.from({ length: N }, (_, i) => ({
      taskId: `ses_conc_${i}`,
      framework: 'opencode',
    }));
    const file = await buildScoreExport(
      { runId: 'conc-run', name: null, kind: 'workflow' },
      members,
      {} as PrismaClient,
    );

    // 并发有界：修复前 Promise.all 会一次性打满 N 路（maxActive === N）
    expect(mocks.maxActive()).toBeLessThanOrEqual(SCORE_EXPORT_CONCURRENCY);
    // 确认确实并行（有界而非退化为串行 1）
    expect(mocks.maxActive()).toBeGreaterThan(1);
    // 顺序回填：成员顺序与输入一致，卡全在场
    expect(file.members.map(m => m.taskId)).toEqual(members.map(m => m.taskId));
    expect(file.members.every(m => m.scorecard != null)).toBe(true);
  });
});