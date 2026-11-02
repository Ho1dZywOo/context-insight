// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// GET /api/observe/run/[runId]/turns/search —— run 跨成员全域关键词搜索
// （content / summary / 工具 args / result / error 五路匹配共用
// observe/collectors/search 单点；结果附 member 归因，契约镜像 session
// turns/search 端点；design: docs/design/run-observe-parity/design.md §4）。
// 搜索不受 member 过滤约束（跨成员定位是本端点的核心价值）。
// 取数两级瘦身（PR #7 审查意见）：①显式轻投影只取匹配所需列（不带顶层
// select 时 Prisma 物化 Turn 全部标量列，含 contentJson / inputMessagesJson
// 这类 35MB 级全文字段）；②关键词可安全下推时把候选过滤推到 SQL（见
// canPushDownKeyword 注释），只对命中集跑 matchTurnSearch。

import { NextRequest, NextResponse } from 'next/server';
import { withRouteLog } from '@/lib/api-route';
import { prisma } from '@/lib/db';
import { resolveRunScope } from '@/lib/run/observe/scope';
import { memberByRowId } from '@/lib/observe/scope';
import { matchTurnSearch } from '@/lib/observe/collectors/search';

/** 关键词可否安全下推到 SQL：matchTurnSearch 是 Unicode 不区分大小写的子串
 * 匹配，而 SQLite LIKE 只对 ASCII 不区分大小写（西里尔/希腊等带大小写的非
 * ASCII 文字按字节比较）——含此类字符时下推会丢命中，须退回轻投影全量扫
 * 描保语义。% / _ 通配符只会让 LIKE 超匹配（超集无害，matchTurnSearch 仍
 * 精确复滤）；大小写不敏感文字（ASCII / CJK 等）下推集与内存匹配集等价。 */
function canPushDownKeyword(trimmed: string): boolean {
  for (const ch of trimmed) {
    if (ch.charCodeAt(0) < 128) continue;
    if (ch.toLowerCase() !== ch.toUpperCase()) return false;
  }
  return true;
}

export const GET = withRouteLog(
  'observe/run/turns/search',
  async (request: NextRequest, { params }: { params: Promise<{ runId: string }> }) => {
    const { runId } = await params;
    const { searchParams } = request.nextUrl;
    const keyword = searchParams.get('keyword');
    // 命中上限（可选，Turns 搜索驻留面板传 50）：total 恒为全量命中数，
    // 截断由面板明示「已显示前 N」——不静默截
    const limitRaw = Number(searchParams.get('limit'));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 200) : null;

    if (!keyword || keyword.trim().length === 0) {
      return NextResponse.json({ error: 'Missing required param: keyword' }, { status: 400 });
    }

    const scope = await resolveRunScope(runId, prisma);
    if (!scope) {
      return NextResponse.json({ error: `Run not found: ${runId}`, reason: 'run-not-found' }, { status: 404 });
    }
    if (scope.members.length === 0) {
      return NextResponse.json({ items: [], total: 0 });
    }

    // 五路候选下推（可安全时）：OR 覆盖 content / contentSummary / 工具
    // args / result / error——与 matchTurnSearch 的五路一一对应，DB 命中集
    // ⊇ 内存精确命中集，total 恒等于全量命中数（全量计数语义不变）。
    const trimmed = keyword.trim();
    const keywordFilter = canPushDownKeyword(trimmed)
      ? {
          OR: [
            { content: { contains: trimmed } },
            { contentSummary: { contains: trimmed } },
            {
              toolCalls: {
                some: {
                  OR: [
                    { argsJson: { contains: trimmed } },
                    { resultJson: { contains: trimmed } },
                    { errorMessage: { contains: trimmed } },
                  ],
                },
              },
            },
          ],
        }
      : undefined;

    const rows = await prisma.turn.findMany({
      where: {
        sessionId: { in: scope.members.map(m => m.rowId) },
        ...(keywordFilter ?? {}),
      },
      orderBy: [{ turnIndex: 'asc' }],
      // 显式轻投影（性能层，同 collectors/turns.ts 范式）：TurnSearchRow 契约
      // 之外的标量列（contentJson / inputMessagesJson / 各 token 计数…）不物化
      select: {
        id: true,
        sessionId: true,
        turnIndex: true,
        role: true,
        content: true,
        contentSummary: true,
        agentName: true,
        isSubagent: true,
        subagentName: true,
        subagentSessionId: true,
        reasoningTokens: true,
        createdAt_ts: true,
        createdAt: true,
        toolCalls: {
          select: { toolCallId: true, toolName: true, dispatchBridgeId: true, argsJson: true, resultJson: true, errorMessage: true },
        },
      },
    });

    const byRowId = memberByRowId(scope);
    let items = matchTurnSearch(rows, keyword, {
      memberOf: sessionId => {
        const member = byRowId.get(sessionId);
        return member ? { taskId: member.taskId, label: member.label } : null;
      },
    });
    const total = items.length;
    if (limit != null) items = items.slice(0, limit);

    return NextResponse.json({ items, total });
  },
);
