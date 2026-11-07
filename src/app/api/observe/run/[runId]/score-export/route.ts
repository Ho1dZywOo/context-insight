// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// the CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Score 评测数据导出端点（issue #116：数据用于自循环演进 RSI）：run 全员评
// 分卡 + 维度定义快照 + 便利聚合成单一 JSON（insight-score-export@1）。
// GET 幂等只读（读最新缓存卡，无则现算确定性层——要新卡先 POST scorecard
// 重算）。页面按钮与程序化拉取（curl）同款载荷——一份数据两个入口。run 级
// 聚合端点（非成员视图转发），scope 解析复用 run 域单点。

import { NextRequest, NextResponse } from 'next/server';
import { withRouteLog } from '@/lib/api-route';
import { prisma } from '@/lib/db';
import { resolveRunScope } from '@/lib/run/observe/scope';
import { readRun } from '@/lib/run/run-store';
import { isSoloRunId } from '@/lib/run/identity';
import { buildScoreExport } from '@/lib/scoring';

export const GET = withRouteLog<{ params: Promise<{ runId: string }> }>('observe/run/score-export', async (
  _request: NextRequest,
  ctx: { params: Promise<{ runId: string }> },
) => {
  const { runId } = await ctx.params;
  const scope = await resolveRunScope(runId, prisma);
  if (!scope) {
    return NextResponse.json({ error: `Run not found: ${runId}`, reason: 'run-not-found' }, { status: 404 });
  }

  // run 身份：solo 合成作用域无 run-store 记录（kind=solo，名取成员 taskId）
  const solo = isSoloRunId(runId);
  const stored = solo ? null : readRun(runId);
  const file = await buildScoreExport(
    { runId, name: stored?.manifest.name ?? null, kind: solo ? 'solo' : stored?.manifest.kind ?? 'run' },
    scope.members.map(m => ({ taskId: m.taskId, framework: m.framework, label: m.label })),
    prisma,
  );

  // 文件名：solo 保持会话口径，bundle 用 run 身份（文件系统安全字符收敛）
  const nameBase = solo ? scope.members[0]?.taskId ?? runId : stored?.manifest.name ?? runId;
  const safeBase = String(nameBase).replace(/[\\/:*?"<>|\s]+/g, '_');
  const filename = `${solo ? 'session' : 'run'}_${safeBase}_score.json`;
  return new NextResponse(JSON.stringify(file, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
    },
  });
});
