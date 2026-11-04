// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// GET /api/observe/run/[runId]/turns/by-index?index=N —— #N 轮次直达的 run 级
// 解析：跨成员找出所有拥有第 N 轮的会话。真相源必须是服务端——客户端只
// 见已加载分页（首页 200 + 自动补齐），加载窗口外或未选中会话的轮次在客
// 户端永远解析不出（#25 误报「未找到」的根因）。items 按 run 成员序排列
// （确定性），附成员归因与轮次摘要（多会话同号轮时客户端下钻选择的行预
// 览）；客户端按「当前会话优先」排布候选。跳转只需 turnId + 归因 + 摘要。
import { NextRequest, NextResponse } from 'next/server';
import { withRouteLog } from '@/lib/api-route';
import { prisma } from '@/lib/db';
import { resolveRunScope } from '@/lib/run/observe/scope';
import { memberByRowId } from '@/lib/observe/scope';

export const GET = withRouteLog(
  'observe/run/turns/by-index',
  async (request: NextRequest, { params }: { params: Promise<{ runId: string }> }) => {
    const { runId } = await params;
    const { searchParams } = request.nextUrl;
    // 显式整数字符串校验——Number(null)=0，缺参不能被静默当作 #0
    const indexParam = searchParams.get('index');
    const index = indexParam != null && /^-?\d+$/.test(indexParam) ? Number(indexParam) : NaN;
    if (!Number.isInteger(index) || index < 0) {
      return NextResponse.json({ error: 'Missing or invalid param: index' }, { status: 400 });
    }

    const scope = await resolveRunScope(runId, prisma);
    if (!scope) {
      return NextResponse.json({ error: `Run not found: ${runId}`, reason: 'run-not-found' }, { status: 404 });
    }
    if (scope.members.length === 0) {
      return NextResponse.json({ items: [] });
    }

    const rows = await prisma.turn.findMany({
      where: {
        sessionId: { in: scope.members.map(m => m.rowId) },
        turnIndex: index,
      },
      select: { id: true, sessionId: true, turnIndex: true, contentSummary: true },
    });
    // 同会话同号多行（异常数据）取首现——轮次号本应会话内唯一
    const firstBySession = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      if (!firstBySession.has(r.sessionId)) firstBySession.set(r.sessionId, r);
    }
    const byRowId = memberByRowId(scope);
    const items = scope.members
      .flatMap(m => {
        const r = firstBySession.get(m.rowId);
        if (!r) return [];
        const member = byRowId.get(m.rowId);
        return [{
          turnId: r.id,
          memberTaskId: member?.taskId ?? m.taskId,
          memberLabel: member?.label ?? m.taskId,
          contentSummary: r.contentSummary,
        }];
      });
    return NextResponse.json({ items });
  },
);
