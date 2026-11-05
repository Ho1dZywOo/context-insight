// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

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

// 总览条（widget 带）：5 张碎卡合一块毛玻璃横幅——去盒噪一行读完，
// 大号 tabular 数字 + 小字距标签；Errors 非零时整格红调。取值元素保持
// p.text-2xl ×5（顺序 Sessions/Tokens/Cost/Duration/Errors——IT 契约）
function Metric({ label, value, error, children }: { label: string; value: string; error?: boolean; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 px-5 py-4">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
      <p className={cn('text-2xl font-bold tabular-nums tracking-tight', error ? 'text-red-600 dark:text-red-400' : 'text-foreground')}>{value}</p>
      {children}
    </div>
  );
}

export function MetricCards({ totalSessions, runCount, runMemberSessions, totalTokens, totalCost, totalDurationMs, totalErrors }: MetricCardsProps) {
  return (
    <section
      data-metric-strip
      className="animate-in fade-in slide-in-from-bottom-2 duration-300 rounded-2xl border border-border/70 bg-card/60 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_16px_40px_-24px_rgba(0,0,0,0.28)] backdrop-blur-2xl backdrop-saturate-150"
    >
      <div className={cn('grid grid-cols-2 sm:grid-cols-3', totalErrors !== undefined ? 'lg:grid-cols-5' : 'lg:grid-cols-4', 'lg:divide-x lg:divide-border/50')}>
        <Metric label="Sessions" value={String(totalSessions)}>
          {runCount != null && runCount > 0 && (
            <p className="text-xs text-muted-foreground">
              + {runCount} <Link href="/?kind=run" className="hover:underline">Runs</Link>
              {runMemberSessions != null && runMemberSessions > 0 && ` · ${runMemberSessions} member sessions`}
            </p>
          )}
        </Metric>
        <Metric label="Total Tokens" value={formatTokens(totalTokens)} />
        <Metric label="Total Cost" value={formatCost(totalCost)} />
        <Metric label="Total Duration" value={formatLatency(totalDurationMs)} />
        {totalErrors !== undefined && (
          <Metric label="Errors" value={String(totalErrors)} error={totalErrors > 0} />
        )}
      </div>
    </section>
  );
}
