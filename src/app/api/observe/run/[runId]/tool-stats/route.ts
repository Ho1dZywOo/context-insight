// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// GET /api/observe/run/[runId]/tool-stats —— run 工具维度耗时统计（Perf
// 「成员 × 工具」双维度的工具侧）：per-tool 聚合（调用数 / Σ时长 / p50·p95
// 分位 / 错误率与错误类型）+ tool × member 矩阵（格含 firstTurnId 下钻锚点
// ）。逐调用耗时 = DB durationMs > 0 ? 原值 : wire 回填（cpx 捕获），
// 无计时调用如实计数不进分位；Task/agent 派发窗口单独标注不进 Σ 工具
// 执行时长。消费方：PerfPanorama 工具耗时卡 + 离线导出静态档案。

import { NextRequest, NextResponse } from 'next/server';
import { withRouteLog } from '@/lib/api-route';
import { prisma } from '@/lib/db';
import { resolveRunScope } from '@/lib/run/observe/scope';
import { collectScopeToolStats } from '@/lib/observe/collectors/tool-stats';

export const GET = withRouteLog(
  'observe/run/tool-stats',
  async (_request: NextRequest, { params }: { params: Promise<{ runId: string }> }) => {
    const { runId } = await params;
    const scope = await resolveRunScope(runId, prisma);
    if (!scope) {
      return NextResponse.json({ error: `Run not found: ${runId}`, reason: 'run-not-found' }, { status: 404 });
    }
    return NextResponse.json(await collectScopeToolStats(prisma, scope));
  },
);
