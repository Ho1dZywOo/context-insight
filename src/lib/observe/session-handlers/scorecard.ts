// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// the CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 评分卡 v2（六维）：文件存储（缓存定位——事实源是 turns 数据，随时可删可
// 重算）。GET 读最新一张，没有则现算确定性层（首次打开零等待）；POST 强制
// 重算。aborted（截断）卡不写盘，直接返回并说明原因。派生读取逻辑住
// scorecard-read（score 导出共用同一单一源），本层只是 HTTP 薄壳。

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { runScorecard, loadRegistry } from '@/lib/scoring';
import { deriveForUi, getDerivedScorecard } from '@/lib/scoring/core/scorecard-read';
import { withRouteLog } from '@/lib/api-route';

export const GET = withRouteLog('observe/session/scorecard', async (request: NextRequest) => {
  const { searchParams } = new URL(request.url);
  const taskId = searchParams.get('taskId');
  const framework = searchParams.get('framework');
  if (!taskId) {
    return NextResponse.json({ error: 'Missing taskId' }, { status: 400 });
  }

  const got = await getDerivedScorecard(taskId, { framework, prisma });
  if (!got) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  return NextResponse.json(got.card);
});

// 强制重算确定性层（旧卡自动归档 archive/，历史保留）
export const POST = withRouteLog('observe/session/scorecard', async (request: NextRequest) => {
  const body = await request.json() as { taskId?: string; framework?: string };
  if (!body.taskId) {
    return NextResponse.json({ error: 'Missing taskId' }, { status: 400 });
  }
  const card = await runScorecard(body.taskId, prisma, body.framework ? { framework: body.framework } : {});
  if (!card) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  const registry = await loadRegistry();
  return NextResponse.json(await deriveForUi(card, registry));
});
