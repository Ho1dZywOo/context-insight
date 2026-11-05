// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 统一工作台首页（design: docs/design/unified-workbench/design.md §3）。
// 会话 + run 单表混排（list-service 单点，隔离闸内聚）；单一「导入」入口
// （ImportDialog 统一向导：选择即类型——本地双绿直导 / 数据仓目录注册表）。

import { Suspense } from 'react';
import Link from 'next/link';
import { MetricCards } from '@/components/MetricCards';
import { AssetList } from '@/components/collection/AssetList';
import { ImportDialog } from '@/components/collection/ImportDialog';
import { LakeSourceView } from '@/components/collection/LakeSourceView';
import { AppHeader } from '@/components/layout/AppHeader';
import { AppShell } from '@/components/layout/AppShell';
import { CommandPalette } from '@/components/layout/CommandPalette';
import { HEADER_PILL_TINTED } from '@/components/layout/header-actions';
import { BAY_VIEWER_NAME, BRAND_NAME } from '@/lib/branding';
import { VERSION_DISPLAY } from '@/lib/version';
import { prisma } from '@/lib/db';
import { queryAssetList, assetSummary } from '@/lib/collection/list-service';
import { pageSessionErrorTotal } from '@/lib/collection/session-asset';
import type { AssetKindFilter } from '@/lib/collection/types';
import { ArrowLeftIcon, EyeIcon, SettingsIcon } from 'lucide-react';

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; pageSize?: string; isSubagent?: string; user?: string; q?: string; kind?: string; src?: string }>;
}) {
  const params = await searchParams;
  // 数据源切换（design §5）：本地洞察库（缺省）↔ 数据仓（?src=lake）——同一
  // 工作台内的两个数据源视图，URL 镜像
  const isLakeSource = params.src === 'lake';

  if (isLakeSource) {
    return (
      <AppShell
        active="lake"
        toolbar={
          <AppHeader
            title="数据仓"
            actions={
              <>
                <CommandPalette />
                <ImportDialog />
                <Link href="/" className={HEADER_PILL_TINTED}>
                  <ArrowLeftIcon className="size-4 text-muted-foreground" />
                  本地洞察库
                </Link>
                <a href="/settings" className={`${HEADER_PILL_TINTED} lg:hidden`}>
                  <SettingsIcon className="size-4 text-muted-foreground" />
                  Settings
                </a>
              </>
            }
          />
        }
        statusBar={
          <footer className="flex h-7 shrink-0 items-center justify-between gap-4 border-t border-border/40 bg-card/30 px-4 text-[11px] text-muted-foreground">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex items-center gap-1.5 whitespace-nowrap">
                <span className="size-1.5 rounded-full bg-emerald-500" />
                数据仓 · Lake
              </span>
              <span className="hidden text-muted-foreground/60 sm:inline">{BAY_VIEWER_NAME}</span>
            </div>
            <span className="whitespace-nowrap text-muted-foreground/60">{VERSION_DISPLAY}</span>
          </footer>
        }
      >
        <div className="mx-auto w-full max-w-7xl px-6 py-8">
          <Suspense fallback={<div className="flex h-[60vh] items-center justify-center text-sm text-muted-foreground">加载中…</div>}>
            <LakeSourceView />
          </Suspense>
        </div>
      </AppShell>
    );
  }

  const page = Math.max(1, Number(params.page ?? 1));
  const pageSize = Math.max(1, Math.min(100, Number(params.pageSize ?? 20)));
  // 会话搜索（keyword / sessionID）：taskId / query / label 任一子串命中；
  // run 侧按 runId / name 子串命中（list-service 内分发）
  const q = params.q?.trim() ?? '';
  const kindParam = params.kind;
  const kind: AssetKindFilter = kindParam === 'session' || kindParam === 'run' ? kindParam : 'all';

  const [result, summary] = await Promise.all([
    queryAssetList(prisma, { q, kind, page, pageSize, user: params.user, isSubagent: params.isSubagent }),
    assetSummary(prisma),
  ]);
  // Errors 指标卡：当前页资产的工具调用/技能失败计数（页级口径；run 行按其
  // join 成员行计入——与 Σ指标同为「成员会话也是会话」的系统总口径）
  const pageSessionRowIds = result.items
    .filter((i): i is Extract<typeof i, { kind: 'session' }> => i.kind === 'session')
    .map(i => i.sessionId);
  const pageRunMemberRowIds = result.items
    .filter((i): i is Extract<typeof i, { kind: 'run' }> => i.kind === 'run')
    .flatMap(i => i.memberStats?.memberRowIds ?? []);
  const totalErrors = await pageSessionErrorTotal(prisma, [...pageSessionRowIds, ...pageRunMemberRowIds]);

  return (
    <AppShell
      active="assets"
      assetBadge={summary.sessionCount + summary.runCount}
      toolbar={
        <AppHeader
          title="资产库"
          actions={
            <>
              <CommandPalette />
              <ImportDialog />
              <Link href="/?src=lake" className={`${HEADER_PILL_TINTED} lg:hidden`}>
                <EyeIcon className="size-4 text-muted-foreground" />
                {BAY_VIEWER_NAME}
              </Link>
              <a href="/settings" className={`${HEADER_PILL_TINTED} lg:hidden`}>
                <SettingsIcon className="size-4 text-muted-foreground" />
                Settings
              </a>
            </>
          }
        />
      }
      statusBar={
        <footer className="flex h-7 shrink-0 items-center justify-between gap-4 border-t border-border/40 bg-card/30 px-4 text-[11px] text-muted-foreground">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex items-center gap-1.5 whitespace-nowrap">
              <span className="size-1.5 rounded-full bg-emerald-500" />
              资产库 · Local
            </span>
            <span className="hidden text-muted-foreground/60 sm:inline">{BRAND_NAME}</span>
          </div>
          <span className="whitespace-nowrap text-muted-foreground/60">{VERSION_DISPLAY}</span>
        </footer>
      }
    >
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-8">
        <MetricCards
          totalSessions={summary.sessionCount}
          runCount={summary.runCount}
          totalTokens={summary.totalTokens}
          totalCost={summary.totalCost}
          totalDurationMs={summary.totalDurationMs}
          totalErrors={totalErrors}
        />
        <AssetList
          items={result.items}
          total={result.total}
          page={page}
          pageSize={pageSize}
          q={q}
          kind={kind}
          totalCount={result.totalCount ?? summary.sessionCount + summary.runCount}
          runWarnings={result.runWarnings}
        />
      </main>
    </AppShell>
  );
}
