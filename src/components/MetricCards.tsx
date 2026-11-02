// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import Link from 'next/link';
import { cn } from '@/lib/utils';

interface MetricCardsProps {
  totalSessions: number;
  /** 已导入 run 数（统一工作台首卡并列展示；0/未传 = 纯会话形态） */
  runCount?: number;
  /** join 到库的 run 成员会话数——Tokens/Cost/AvgDuration 为系统总口径
   *  （独立会话 + run 成员），副行说明成员规模 */
  runMemberSessions?: number;
  totalTokens: number;
  totalCost: number;
  /** Σ全量时长（独立会话 + run 成员）——总量口径，均值无信息量（用户决策） */
  totalDurationMs: number;
  totalErrors?: number;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function formatLatency(ms: number): string {
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}min`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${ms}ms`;
}

export function MetricCards({ totalSessions, runCount, runMemberSessions, totalTokens, totalCost, totalDurationMs, totalErrors }: MetricCardsProps) {
  return (
    <div className={cn("grid gap-4", totalErrors !== undefined ? "grid-cols-5" : "grid-cols-4")}>
      <Card size="sm">
        <CardHeader>
          <CardTitle>Sessions</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-bold">{totalSessions}</p>
          {runCount != null && runCount > 0 && (
            <p className="text-xs text-muted-foreground mt-0.5">
              + {runCount} <Link href="/?kind=run" className="hover:underline">Runs</Link>
              {runMemberSessions != null && runMemberSessions > 0 && ` · ${runMemberSessions} member sessions`}
            </p>
          )}
        </CardContent>
      </Card>
      <Card size="sm">
        <CardHeader>
          <CardTitle>Total Tokens</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-bold">{formatTokens(totalTokens)}</p>
        </CardContent>
      </Card>
      <Card size="sm">
        <CardHeader>
          <CardTitle>Total Cost</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-bold">{formatCost(totalCost)}</p>
        </CardContent>
      </Card>
      <Card size="sm">
        <CardHeader>
          <CardTitle>Total Duration</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-bold">{formatLatency(totalDurationMs)}</p>
        </CardContent>
      </Card>
      {totalErrors !== undefined && (
        <Card size="sm" className={totalErrors > 0 ? "border-red-200 dark:border-red-500/30" : ""}>
          <CardHeader>
            <CardTitle className={totalErrors > 0 ? "text-red-600 dark:text-red-400" : ""}>Errors</CardTitle>
          </CardHeader>
          <CardContent>
            <p className={`text-2xl font-bold ${totalErrors > 0 ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}`}>
              {totalErrors}
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
