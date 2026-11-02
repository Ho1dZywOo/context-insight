// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software that you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

'use client';

// 数据仓源视图（design: docs/design/unified-workbench/design.md §4 刀4）。
// 旧 lake_viewer 独立页平移并入统一工作台：范式侧栏 + 筛选条 + 运行表 +
// 工作流包区块 + opgen 进度 + 标注弹窗，URL 挂在 `/?src=lake` 下（范式与
// 筛选参数原样镜像）。统一布局（目录即目录，按数据加载）：每个目录视图
// 同时呈现该目录的会话运行与 bundle 包，不按资产类型分区。全部取数走
// /api/ingest/lake action 集（paradigm-summary / lake-runs / lake-status /
// lake-notes / paradigm-target + 复用 import / bundle-list / bundle-import）。

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ParadigmSidebar, type ParadigmSummaryView } from '@/components/collection/lake/ParadigmSidebar';
import { FilterBar, EMPTY_FILTERS, type Filters } from '@/components/collection/lake/FilterBar';
import { BundleTable, type BundleItemView } from '@/components/collection/lake/BundleTable';
import { RunsTable, type RunItemView } from '@/components/collection/lake/RunsTable';
import { OpgenProgress } from '@/components/collection/lake/OpgenProgress';
import { LakeProgressView } from '@/components/collection/lake/LakeProgressView';

interface RunsResponse {
  paradigm: string;
  total: number;
  baselineSid: string | null;
  insightReachable: boolean;
  facets: { frameworks: string[]; ccVersions: string[] };
  items: RunItemView[];
}

function lakeAction(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  return fetch('/api/ingest/lake', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}

// 浏览器时区偏移（±HH:MM）：日期筛选边界按用户本地时区解释，服务端不再
// 自行解读无时区日期（UTC 服务器上 +08 用户的「当天」会平移 8 小时）
function browserTzOffset(): string {
  const minutes = new Date().getTimezoneOffset();
  const sign = minutes <= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

function filtersToBody(paradigm: string, f: Filters): Record<string, unknown> {
  return {
    paradigm,
    ...(f.framework ? { framework: f.framework } : {}),
    ...(f.ccVersion ? { ccVersion: f.ccVersion } : {}),
    ...(f.opGen ? { opGen: f.opGen } : {}),
    ...(f.scored ? { scored: f.scored === 'true' } : {}),
    ...(f.imported ? { imported: f.imported === 'true' } : {}),
    ...(f.q.trim() ? { q: f.q.trim() } : {}),
    ...(f.from ? { from: f.from } : {}),
    ...(f.to ? { to: f.to } : {}),
    ...((f.from || f.to) ? { tz: browserTzOffset() } : {}),
  };
}

export function LakeSourceView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const filters = useMemo<Filters>(() => ({
    framework: searchParams.get('framework') ?? '',
    ccVersion: searchParams.get('ccVersion') ?? '',
    opGen: (searchParams.get('opGen') as Filters['opGen']) ?? '',
    scored: (searchParams.get('scored') as Filters['scored']) ?? '',
    imported: (searchParams.get('imported') as Filters['imported']) ?? '',
    q: searchParams.get('q') ?? '',
    from: searchParams.get('from') ?? '',
    to: searchParams.get('to') ?? '',
  }), [searchParams]);

  const [paradigms, setParadigms] = useState<ParadigmSummaryView[] | null>(null);
  const selected = searchParams.get('paradigm') ?? paradigms?.[0]?.name ?? null;

  const [result, setResult] = useState<{ query: string; data: RunsResponse | null; error: string | null } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  // bundle 清单（全仓锚定扫描，条目自带所在目录；键 = 选中范式——切换/刷新
  // 期间旧数据自然失配，客户端按目录过滤呈现）
  const [bundles, setBundles] = useState<{ paradigm: string; data: BundleItemView[] | null; error: string | null } | null>(null);

  const query = selected ? JSON.stringify(filtersToBody(selected, filters)) : '';
  const runs = result?.query === query ? result.data : null;
  const error = result?.query === query ? result.error : null;

  useEffect(() => {
    let cancelled = false;
    void lakeAction({ action: 'paradigm-summary' }).then(r => r.json()).then((d: { items?: ParadigmSummaryView[] }) => {
      if (!cancelled) setParadigms(d.items ?? []);
    }).catch(() => {
      if (!cancelled) setParadigms([]);
    });
    return () => { cancelled = true; };
  }, []);

  // bundle 清单：随范式选择/刷新拉取（一次拉全量，客户端按目录过滤）
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    const paradigm = selected;
    void (async () => {
      try {
        const res = await lakeAction({ action: 'bundle-list' });
        const data = await res.json() as { items?: BundleItemView[]; error?: string };
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        if (!cancelled) setBundles({ paradigm, data: data.items ?? [], error: null });
      } catch (e) {
        if (!cancelled) setBundles({ paradigm, data: null, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => { cancelled = true; };
  }, [selected, refreshKey]);

  useEffect(() => {
    if (!query) return;
    let cancelled = false;
    const body = filtersToBody(selected!, filters);
    void (async () => {
      try {
        const res = await lakeAction({ action: 'lake-runs', ...body });
        const data = await res.json() as RunsResponse & { error?: string };
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        if (!cancelled) setResult({ query, data, error: null });
      } catch (e) {
        if (!cancelled) setResult({ query, data: null, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => { cancelled = true; };
  }, [query, refreshKey, selected, filters]);

  // 该目录的 bundle（条目 paradigm = 所在顶层目录，位置即身份）
  const dirBundles = selected != null && bundles?.paradigm === selected
    ? (bundles.data ?? []).filter(b => b.paradigm === selected)
    : [];
  const bundlesLoading = selected != null && bundles?.paradigm !== selected;

  const importRun = async (sid: string, recording: 'capture' | 'native'): Promise<{ error: string | null; insightUrl?: string | null }> => {
    try {
      const res = await lakeAction({ action: 'import', sid, recording });
      const data = await res.json().catch(() => ({})) as { result?: { imported?: boolean; query?: string | null; reason?: 'imported' | 'imported-empty' | 'already-exists' | 'no-interactions'; framework?: string | null; version?: string | null }; insightUrl?: string; error?: string };
      if (!res.ok) return { error: data.error ?? `HTTP ${res.status}` };
      // 未真正写库（no-interactions：空/不可读捕获）不跳转——权威深链指向不存在
      // 的行会 404；already-exists（imported:false 但 query 有值）深链仍指向既有行，
      // 照常跳转
      if (data.result?.reason === 'no-interactions') return { error: 'No parseable records (empty or unrecognized file)' };
      setRefreshKey(k => k + 1);
      // 跳转只认响应回传的权威深链（framework = 刚落库行的记录类）
      return { error: null, insightUrl: data.insightUrl ?? null };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  };

  const updateUrl = (patch: Partial<Filters> & { paradigm?: string }) => {
    const p = new URLSearchParams(searchParams);
    const next = { ...filters, ...patch };
    for (const key of Object.keys(EMPTY_FILTERS) as Array<keyof Filters>) {
      const v = next[key];
      if (v) p.set(key, v); else p.delete(key);
    }
    if (patch.paradigm) p.set('paradigm', patch.paradigm);
    p.set('src', 'lake');
    router.replace(`/?${p.toString()}`, { scroll: false });
  };

  const loadingView = !error && !runs && !!selected;

  return (
    <div className="flex h-[calc(100dvh-11rem)] min-h-[520px] min-w-0 flex-col overflow-hidden rounded-xl border bg-white shadow-sm">
      <div className="flex min-h-0 flex-1">
        <ParadigmSidebar
          paradigms={paradigms ?? []}
          selected={selected}
          onSelect={name => updateUrl({ paradigm: name })}
        />
        <main className="flex min-w-0 flex-1 flex-col">
          {selected ? (
            <>
              <FilterBar filters={filters} facets={runs?.facets ?? { frameworks: [], ccVersions: [] }} onChange={f => updateUrl(f)} />
              {runs && runs.items.length > 0 && (
                <div className="px-4 pt-3">
                  <OpgenProgress paradigm={selected} items={runs.items} />
                </div>
              )}
              <div className="mt-2 flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-1.5 text-xs text-neutral-500">
                <span>
                  {selected}
                  {runs?.baselineSid && <span className="ml-2 text-emerald-600" title={`基准 ${runs.baselineSid}`}>◆ baseline</span>}
                </span>
                <span>
                  {loadingView ? '加载中…' : runs ? `共 ${runs.total} 条运行${runs.total > runs.items.length ? `（显示前 ${runs.items.length} 条）` : ''}` : ''}
                </span>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {error && <p className="p-4 text-sm text-red-600">{error}</p>}
                {!error && runs && runs.items.length === 0 && dirBundles.length === 0 && (
                  <p className="p-8 text-center text-sm text-neutral-400">该目录暂无会话与 Run 包</p>
                )}
                {!error && runs && runs.items.length > 0 && (
                  <RunsTable items={runs.items} onImport={importRun} />
                )}
                {dirBundles.length > 0 && (
                  <div className="border-t border-neutral-200">
                    <div className="flex items-center justify-between border-b border-neutral-100 bg-white px-4 py-1.5 text-xs text-neutral-500">
                      <span>工作流包（Run bundle）</span>
                      <span>共 {dirBundles.length} 个</span>
                    </div>
                    <BundleTable items={dirBundles} onImported={() => setRefreshKey(k => k + 1)} />
                  </div>
                )}
                {bundlesLoading && dirBundles.length === 0 && (
                  <p className="p-2 text-center text-xs text-neutral-400">bundle 清单加载中…</p>
                )}
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center">
              {paradigms == null
                ? <LakeProgressView />
                : paradigms.length === 0
                  ? <p className="text-sm text-neutral-400">数据仓为空或不可达</p>
                  : <p className="text-sm text-neutral-400">选择左侧目录开始</p>}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
