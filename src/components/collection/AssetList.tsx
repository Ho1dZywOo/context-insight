// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

'use client';

// 统一资产列表（design: docs/design/unified-workbench/design.md §3.1）。
// 会话 + run 单列表混排（iOS 分组列表形态）：行 = 框架渐变 App 图标 + 标题/
// 元信息 + 右侧微型统计列；「类型」分段控件是行过滤器（URL ?kind=，非视图
// 切换，滑动指示条纯 CSS transform）。多选跨 kind：图标位变形为对勾圆（iOS
// 编辑模式），批量操作收进底部浮动毛玻璃条（选中时滑入）；Compare 仅 2 个
// 会话行，删除按 kind 分发（run 级联 owned 会话，确认弹窗明示）。

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { BRAND_NAME, BAY_NAME, isBrandSourceType } from '@/lib/branding'
import { isProxyVersion, agentFrameworkOf } from '@/lib/shared/session-format'
import type { AssetItem, AssetKindFilter, RunAssetItem, SessionAssetItem } from '@/lib/collection/types'
import { displayModel } from '@/lib/collection/model-display'
import { useRouter } from 'next/navigation';
import { AssetIcon, type AssetIconId } from '@/components/collection/AssetIcon';
import { Button } from '@/components/ui/button';
import {
  UploadDialog,
  type UploadTarget,
} from '@/components/collection/UploadDialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { UploadIcon, LoaderIcon, CheckIcon, XIcon, TrashIcon, DownloadIcon, CheckCircleIcon, SearchIcon, ChevronLeftIcon, ChevronRightIcon, ChevronsLeftIcon, ChevronsRightIcon } from 'lucide-react';
import { toast } from 'sonner';

interface AssetListProps {
  /** SSR 首屏初始数据（此后翻页/搜索/类型过滤走客户端 /api/observe/data，无整页刷新） */
  items: AssetItem[];
  total: number;
  page: number;
  pageSize: number;
  /** 初始搜索词（直接打开 /?q= 链接时由 SSR 提供） */
  q?: string;
  /** 初始类型过滤（URL ?kind= 镜像；行过滤器，非视图切换） */
  kind?: AssetKindFilter;
  /** 未过滤的资产总数（搜索时显示 N of M） */
  totalCount?: number;
  /** run-store 扫描降级警告（坏目录占位） */
  runWarnings?: string[];
}

type UploadStatus = 'idle' | 'uploading' | 'done' | 'error';
type ExportStatus = 'idle' | 'exporting' | 'done' | 'error';

const KIND_ORDER: AssetKindFilter[] = ['all', 'session', 'run'];

const KIND_LABELS: Record<AssetKindFilter, string> = {
  all: '全部',
  session: '会话',
  run: 'Run',
};

const RUN_STATUS_DOT: Record<string, string> = {
  passed: 'bg-green-500',
  failed: 'bg-red-500',
  running: 'bg-orange-500 animate-pulse',
  pending: 'bg-gray-400',
  carried: 'bg-slate-400',
  unknown: 'bg-yellow-500',
};

const FRAMEWORK_LABELS: Record<string, string> = {
  opencode: 'OpenCode',
  'claude-code': 'Claude',
  cannbot: 'CANNBot',
  dsh: 'DSH',
  codex: 'Codex',
};

// 会话行图标 id：agent 归属归一（framework 可能带 -proxy 记录后缀）；品牌
// 容器源 → brand；未知源 → unknown
function sessionIconId(item: SessionAssetItem): AssetIconId {
  const agent = agentFrameworkOf(item.framework) ?? '';
  if (agent === 'opencode' || agent === 'claude-code' || agent === 'cannbot' || agent === 'dsh' || agent === 'codex') return agent;
  if (isBrandSourceType(item.framework)) return 'brand';
  return 'unknown';
}

function sessionFrameworkLabel(item: SessionAssetItem): string | null {
  const agent = agentFrameworkOf(item.framework) ?? '';
  if (agent === 'opencode' || agent === 'claude-code' || agent === 'cannbot' || agent === 'dsh' || agent === 'codex') {
    return FRAMEWORK_LABELS[agent] ?? agent;
  }
  return isBrandSourceType(item.framework) ? BRAND_NAME : null;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

function formatDuration(ms: number | null): string {
  if (ms == null || ms <= 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)}min`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hour = String(d.getHours()).padStart(2, '0');
  const minute = String(d.getMinutes()).padStart(2, '0');
  return `${month}/${day} ${hour}:${minute}`;
}

// run 行起止（Start→End 与 wall 时长共用）：manifest 端点优先，缺失用
// 成员会话聚合兜底（与 run 域 attemptRangeOf 的兜底语义一致——bundle manifest
// 常缺时间戳，成员会话行起止是更可靠的事实源）
function runStartEnd(item: RunAssetItem): { start: string | null; end: string | null } {
  return {
    start: item.startedAt ?? item.memberStats?.earliestStart ?? null,
    end: item.finishedAt ?? item.memberStats?.latestEnd ?? null,
  };
}

function runWallMs(item: RunAssetItem): number | null {
  const { start: startIso, end: endIso } = runStartEnd(item);
  if (!startIso) return null;
  const start = Date.parse(startIso);
  const end = endIso ? Date.parse(endIso) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

// 数字页码窗口：1 … c-1 c c+1 … last（当前页恒在，两端恒在，中间留 1 页上下文）
function pageWindow(current: number, totalPages: number): Array<number | '…'> {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1)
  const out: Array<number | '…'> = [1]
  const from = Math.max(2, current - 1)
  const to = Math.min(totalPages - 1, current + 1)
  if (from > 2) out.push('…')
  for (let p = from; p <= to; p++) out.push(p)
  if (to < totalPages - 1) out.push('…')
  out.push(totalPages)
  return out
}

// 行右侧微型统计列（tokens / cost / active·wall）：值 + 小标签，右对齐
function Stat({ label, value, title, error }: { label: string; value: string; title?: string; error?: boolean }) {
  return (
    <div className="flex flex-col items-end gap-0.5" title={title}>
      <span
        data-stat={label}
        className={`text-xs font-medium tabular-nums ${error ? 'text-red-600 dark:text-red-400' : 'text-foreground/90'}`}
      >
        {value}
      </span>
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60">{label}</span>
    </div>
  );
}

export function AssetList({
  items: initialItems,
  total: initialTotal,
  page: initialPage,
  pageSize,
  q: initialQ = '',
  kind: initialKind = 'all',
  totalCount: initialTotalCount,
  runWarnings: initialRunWarnings = [],
}: AssetListProps) {
  const router = useRouter()
  // 客户端自取数：翻页/搜索/类型过滤 GET /api/observe/data 局部更新（无整页
  // 刷新），SSR 初始值供首屏；URL 经 history.replaceState 同步（可分享、不触发导航）
  const [items, setItems] = useState(initialItems)
  const [total, setTotal] = useState(initialTotal)
  const [allCount, setAllCount] = useState(initialTotalCount ?? initialTotal)
  const [page, setPage] = useState(initialPage)
  const [q, setQ] = useState(initialQ)
  const [kind, setKind] = useState<AssetKindFilter>(initialKind)
  const [searchInput, setSearchInput] = useState(initialQ)
  const [loading, setLoading] = useState(false)
  const [runWarnings, setRunWarnings] = useState(initialRunWarnings)
  const reqSeq = useRef(0)
  // 防抖闭包需要「当前 kind」——state 在 effect 闭包里会过期，走 ref
  const kindRef = useRef<AssetKindFilter>(initialKind)

  async function fetchAssets(nextPage: number, nextQ: string, nextKind: AssetKindFilter) {
    const seq = ++reqSeq.current
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: String(nextPage), pageSize: String(pageSize) })
      if (nextQ) params.set('q', nextQ)
      if (nextKind !== 'all') params.set('kind', nextKind)
      const res = await fetch(`/api/observe/data?${params}`)
      const data = await res.json()
      if (seq !== reqSeq.current || !res.ok) return
      setItems(data.items ?? [])
      setTotal(data.total ?? 0)
      if (data.totalCount != null) setAllCount(data.totalCount)
      else setAllCount(data.total ?? 0)
      setPage(nextPage)
      setQ(nextQ)
      setRunWarnings([])
      const url = new URL(window.location.href)
      if (nextQ) url.searchParams.set('q', nextQ)
      else url.searchParams.delete('q')
      if (nextKind !== 'all') url.searchParams.set('kind', nextKind)
      else url.searchParams.delete('kind')
      if (nextPage > 1) url.searchParams.set('page', String(nextPage))
      else url.searchParams.delete('page')
      window.history.replaceState(null, '', url.toString())
    } catch {
      /* 网络错误：保留当前数据 */
    } finally {
      if (seq === reqSeq.current) setLoading(false)
    }
  }

  // 输入防抖自动搜索（400ms 无操作触发；回车立即）
  useEffect(() => {
    const v = searchInput.trim()
    if (v === q) return
    const t = setTimeout(() => { fetchAssets(1, v, kindRef.current) }, 400)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput])

  function submitSearch() {
    fetchAssets(1, searchInput.trim(), kindRef.current)
  }

  function switchKind(nextKind: AssetKindFilter) {
    if (nextKind === kindRef.current) return
    kindRef.current = nextKind
    setKind(nextKind)
    fetchAssets(1, q, nextKind)
  }

  const totalPages = Math.ceil(total / pageSize);
  const hasNext = page < totalPages;
  const hasPrev = page > 1;
  const [deleteMode, setDeleteMode] = useState<'all' | 'selected' | null>(null)
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())

  const [uploadStatus, setUploadStatus] = useState<Record<string, UploadStatus>>({})
  const [exportStatus, setExportStatus] = useState<Record<string, ExportStatus>>({})
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null)
  // 上传弹窗（统一组件，刀3 合一）：kind + target 一体；结果经回调回填行内状态
  const [uploadRequest, setUploadRequest] = useState<{ key: string; kind: 'session' | 'run'; target: UploadTarget } | null>(null)
  const [uploadOpen, setUploadOpen] = useState(false)

  const confirmDeleteItem = confirmDeleteKey != null ? items.find(i => i.key === confirmDeleteKey) : undefined
  const selectedItems = items.filter(i => selectedKeys.has(i.key))
  const selectedSessions = selectedItems.filter((i): i is SessionAssetItem => i.kind === 'session')
  const selectedRuns = selectedItems.filter((i): i is RunAssetItem => i.kind === 'run')
  const compareReady = selectedSessions.length === 2 && selectedRuns.length === 0

  // 行内上传统一入口（刀3）：会话行与 run 行同一弹窗，kind + target 随行携带；
  // key 供回调免查定位行内状态
  function openUpload(item: SessionAssetItem | RunAssetItem) {
    if (item.kind === 'run') {
      setUploadRequest({ key: item.key, kind: 'run', target: { runId: item.runId, runName: item.name } })
    } else {
      setUploadRequest({
        key: item.key,
        kind: 'session',
        target: {
          taskId: item.taskId,
          query: item.query,
          framework: item.framework,
          model: item.model,
          startTime: item.startTime,
          endTime: item.endTime,
          sourcePath: item.sourcePath,
          user: item.user,
        },
      })
    }
    setUploadOpen(true)
  }

  function handleToggle(key: string) {
    setSelectedKeys(prev => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  async function handleDeleteAll() {
    try {
      const res = await fetch('/api/ingest/delete-session', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deleteAll: true }),
      })
      if (res.ok) window.location.reload()
    } catch {}
  }

  async function handleDeleteSelected() {
    // 按 kind 分发：会话批量 delete-session；run 逐个走 observe/run 级联删除
    if (selectedSessions.length > 0) {
      const entries = selectedSessions.map(i => ({ taskId: i.taskId, framework: i.framework ?? 'unknown' }))
      try {
        await fetch('/api/ingest/delete-session', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessions: entries }),
        })
      } catch {}
    }
    for (const run of selectedRuns) {
      try {
        await fetch(`/api/observe/run/${encodeURIComponent(run.runId)}`, { method: 'DELETE' })
      } catch {}
    }
    window.location.reload()
  }

  async function handleDeleteOne(item: AssetItem) {
    if (item.kind === 'session') {
      try {
        const res = await fetch('/api/ingest/delete-session', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId: item.taskId, framework: item.framework ?? 'unknown' }),
        })
        if (res.ok) window.location.reload()
      } catch {}
      return
    }
    try {
      const res = await fetch(`/api/observe/run/${encodeURIComponent(item.runId)}`, { method: 'DELETE' })
      if (res.ok) window.location.reload()
    } catch {}
  }

  async function handleExport(item: SessionAssetItem) {
    const key = item.key
    setExportStatus(prev => ({ ...prev, [key]: 'exporting' }))
    try {
      const res = await fetch('/api/ingest/export-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // framework：同 sid 双行（方案一）消歧——不带会导出另一行
        body: JSON.stringify({ taskId: item.taskId, framework: item.framework ?? undefined }),
      })
      if (!res.ok) {
        const err = await res.json()
        setExportStatus(prev => ({ ...prev, [key]: 'error' }))
        toast.error('Export failed', { description: err.error ?? 'Unknown error' })
        return
      }
      const blob = await res.blob()
      const defaultName = `context_session_${item.taskId}.db`
      const picker = (window as Window & { showSaveFilePicker?: (options: { suggestedName?: string; types?: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<{ name: string; createWritable: () => Promise<{ write: (data: Blob) => Promise<void>; close: () => Promise<void> }> }> }).showSaveFilePicker
      if (typeof picker === 'function') {
        try {
          const handle = await picker({
            suggestedName: defaultName,
            types: [{ description: 'SQLite Database', accept: { 'application/x-sqlite3': ['.db'] } }],
          })
          const writable = await handle.createWritable()
          await writable.write(blob)
          await writable.close()
          setExportStatus(prev => ({ ...prev, [key]: 'done' }))
          toast.success('Database exported', {
            description: `Saved to ${handle.name}.`,
            icon: <CheckCircleIcon className="size-4" />,
            duration: 5000,
          })
          return
        } catch (e: unknown) {
          if (e instanceof DOMException && e.name === 'AbortError') {
            setExportStatus(prev => ({ ...prev, [key]: 'idle' }))
            return
          }
        }
      }
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = defaultName
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 10000)
      setExportStatus(prev => ({ ...prev, [key]: 'done' }))
      toast.success('Database exported', {
        description: `${defaultName} has been downloaded.`,
        icon: <CheckCircleIcon className="size-4" />,
        duration: 5000,
      })
    } catch {
      setExportStatus(prev => ({ ...prev, [key]: 'error' }))
      toast.error('Export failed', { description: 'Network error' })
    }
  }

  const emptyText = kind === 'run'
    ? '暂无导入的 Run。导入包含 workflow.json 与 sessions/ 的 Bundle 目录后在此查看。'
    : kind === 'session'
      ? 'No sessions found. Import a session to get started.'
      : 'No sessions found. Import a session or bundle to get started.'
  const titleText = kind === 'run' ? `Runs (${total})` : kind === 'session' ? `Sessions (${total})` : `资产 (${total})`
  const kindIndex = KIND_ORDER.indexOf(kind)

  // 选择位（图标 ↔ 对勾变形）：行图标是类型的一眼识别位，选择时同一位置变
  // 圆形对勾——iOS 编辑模式语义；点击即勾选（大命中区）。普通函数而非嵌套
  // 组件——组件身份每次渲染都会变（重挂载毁掉变形过渡），函数直出 JSX 元素
  // 类型稳定
  const renderSelectSlot = (selected: boolean, iconId: AssetIconId, label: string, onToggle: () => void) => (
    <button
      type="button"
      data-asset-check
      role="checkbox"
      aria-checked={selected}
      aria-label={`选择 ${label}`}
      onClick={onToggle}
      className="relative size-10 shrink-0 cursor-pointer rounded-[14px] outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      <span
        aria-hidden
        className={`absolute inset-0 flex items-center justify-center transition-all duration-200 ${selected ? 'scale-75 opacity-0' : 'scale-100 opacity-100'}`}
      >
        <AssetIcon id={iconId} />
      </span>
      <span
        aria-hidden
        className={`absolute inset-0 flex items-center justify-center rounded-full bg-primary text-primary-foreground shadow-[0_2px_8px_-2px_rgba(0,0,0,0.3)] transition-all duration-200 ${selected ? 'scale-100 opacity-100' : 'scale-50 opacity-0'}`}
      >
        <CheckIcon className="size-4" strokeWidth={3} />
      </span>
    </button>
  );

  const renderRunRow = (item: RunAssetItem) => {
    const selected = selectedKeys.has(item.key)
    const uStatus = uploadStatus[item.key] ?? 'idle'
    const wall = runWallMs(item)
    const { start, end } = runStartEnd(item)
    const models = item.memberStats?.models ?? []
    const modelMain = models.length > 0
      ? (
        <span title={models.map(m => `${m.model} ×${m.count}`).join('\n')}>
          {models[0]!.model}
          {models.length > 1 && <span className="text-muted-foreground"> +{models.length - 1}</span>}
        </span>
      )
      : <span>—</span>
    const statusDot = RUN_STATUS_DOT[item.status] ?? 'bg-gray-400'
    return (
      <div
        key={item.key}
        data-asset-row
        data-asset-key={item.key}
        className={`group flex items-center gap-3 px-3 py-2.5 transition-colors duration-150 ${selected ? 'bg-primary/[0.06]' : 'hover:bg-accent/40'}`}
      >
        {renderSelectSlot(selected, 'run', item.name ?? item.runId, () => handleToggle(item.key))}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Link
              href={`/run/${encodeURIComponent(item.runId)}`}
              className="truncate text-sm font-medium text-foreground transition-colors hover:text-primary hover:underline"
            >
              {item.name ?? item.runId}
            </Link>
            <span data-run-status={item.status} className="inline-flex shrink-0 items-center gap-1 rounded-full bg-foreground/[0.04] px-1.5 py-px text-[10px] text-muted-foreground">
              <span className={`size-1.5 rounded-full ${statusDot}`} />
              {item.status}
            </span>
            {!item.exportDataComplete && (
              <span className="shrink-0 text-[10px] text-yellow-600 dark:text-yellow-400" title="导出数据不完整（exportDataComplete=false）">数据不完整</span>
            )}
          </div>
          <p
            className="mt-0.5 truncate text-xs text-muted-foreground"
            title={`${item.runId} · ${item.nodeCount} 节点 · ${item.memberCount} 成员 · ${item.sessionMemberCount} 会话成员`}
          >
            {modelMain} · {formatTime(start)} → {formatTime(end)} · {item.runId} · {item.nodeCount} 节点 · {item.sessionMemberCount} 会话
          </p>
        </div>
        <div className="hidden shrink-0 items-center gap-6 md:flex">
          <Stat label="Tokens" value={item.memberStats != null ? formatTokens(item.memberStats.totalTokens) : '—'} title="Σ成员会话指标" />
          <Stat label="Cost" value={item.memberStats != null ? formatCost(item.memberStats.totalCost) : '—'} title="Σ成员会话成本" />
          <Stat
            label="Active / Wall"
            value={`${formatDuration(item.memberStats?.totalActiveMs ?? null)}${wall != null && item.memberStats?.totalActiveMs != null ? ` / ${formatDuration(wall)}` : ''}`}
            title="Σ成员会话活跃 / Run 跨度墙钟"
          />
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground/70 opacity-0 transition-opacity hover:text-red-600 focus-visible:opacity-100 group-hover:opacity-100"
            onClick={() => setConfirmDeleteKey(item.key)}
            title="Delete run"
          >
            <TrashIcon className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground/70 opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
            onClick={() => openUpload(item)}
            disabled={uStatus === 'uploading'}
            title={`上传 Bundle 到 ${BAY_NAME}`}
            aria-label={`上传 run ${item.runId} 到数据仓`}
          >
            {uStatus === 'idle' && <UploadIcon className="size-3.5" />}
            {uStatus === 'uploading' && <LoaderIcon className="size-3.5 animate-spin" />}
            {uStatus === 'done' && <CheckIcon className="size-3.5 text-green-600" />}
            {uStatus === 'error' && <XIcon className="size-3.5 text-red-500" />}
          </Button>
        </div>
      </div>
    );
  };

  const renderSessionRow = (item: SessionAssetItem) => {
    const selected = selectedKeys.has(item.key)
    const uStatus = uploadStatus[item.key] ?? 'idle'
    const eStatus = exportStatus[item.key] ?? 'idle'
    const fwLabel = sessionFrameworkLabel(item)
    const isProxy = isProxyVersion(item.version)
    return (
      <div
        key={item.key}
        data-asset-row
        data-asset-key={item.key}
        className={`group flex items-center gap-3 px-3 py-2.5 transition-colors duration-150 ${selected ? 'bg-primary/[0.06]' : 'hover:bg-accent/40'}`}
      >
        {renderSelectSlot(selected, sessionIconId(item), item.query ?? item.taskId, () => handleToggle(item.key))}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Link
              href={`/run/solo:${encodeURIComponent(item.taskId)}`}
              className="truncate text-sm font-medium text-foreground transition-colors hover:text-primary hover:underline"
            >
              {item.query ?? item.taskId}
            </Link>
            {isProxy && (
              <span className="shrink-0 rounded-full bg-yellow-500/15 px-1.5 py-px text-[10px] font-medium text-yellow-700 dark:bg-yellow-500/20 dark:text-yellow-400">proxy</span>
            )}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground" title={item.taskId}>
            {fwLabel && <>{fwLabel} · </>}
            <span title={item.model ?? undefined}>{displayModel(item.model) ?? '—'}</span>
            {' · '}
            {formatTime(item.startTime)} → {formatTime(item.endTime)}
            {' · 导入 '}
            {formatTime(item.importedAt)}
          </p>
        </div>
        <div className="hidden shrink-0 items-center gap-6 md:flex">
          <Stat label="Tokens" value={formatTokens(item.totalTokens)} />
          <Stat label="Cost" value={formatCost(item.totalCost)} />
          <Stat
            label="Active / Wall"
            value={`${formatDuration(item.activeMs ?? null)}${item.wallMs != null && item.activeMs != null ? ` / ${formatDuration(item.wallMs)}` : ''}`}
            title="活跃 / 墙钟（斜杠后为墙钟）：间隔 >5min 的空档计非活跃，API 调用进行中计活跃"
          />
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground/70 opacity-0 transition-opacity hover:text-red-600 focus-visible:opacity-100 group-hover:opacity-100"
            onClick={() => setConfirmDeleteKey(item.key)}
            title="Delete session"
          >
            <TrashIcon className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground/70 opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
            onClick={() => handleExport(item)}
            disabled={eStatus === 'exporting'}
            title="Export DB"
          >
            {eStatus === 'idle' && <DownloadIcon className="size-3.5" />}
            {eStatus === 'exporting' && <LoaderIcon className="size-3.5 animate-spin" />}
            {eStatus === 'done' && <CheckCircleIcon className="size-3.5 text-green-600" />}
            {eStatus === 'error' && <XIcon className="size-3.5 text-red-500" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground/70 opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
            onClick={() => openUpload(item)}
            disabled={uStatus === 'uploading'}
            title={`Upload to ${BAY_NAME}`}
          >
            {uStatus === 'idle' && <UploadIcon className="size-3.5" />}
            {uStatus === 'uploading' && <LoaderIcon className="size-3.5 animate-spin" />}
            {uStatus === 'done' && <CheckIcon className="size-3.5 text-green-600" />}
            {uStatus === 'error' && <XIcon className="size-3.5 text-red-500" />}
          </Button>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-3">
      {runWarnings.map(w => (
        <p key={w} className="text-xs text-yellow-600 dark:text-yellow-400">⚠ {w}</p>
      ))}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="text-lg font-semibold tracking-tight">
            {titleText}
            {q && allCount !== total && (
              <span className="text-sm font-normal text-muted-foreground ml-1">of {allCount}</span>
            )}
          </h2>
          {/* 搜索场（iOS 搜索框形态）：Enter 立即，输入防抖自动；进行中右缘转圈 */}
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
            <input
              data-asset-search
              placeholder="Search keyword or session ID"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitSearch() }}
              className="h-8 w-64 rounded-full border border-foreground/[0.09] bg-muted/40 pl-8.5 pr-8 text-xs text-foreground outline-none transition-colors duration-200 placeholder:text-muted-foreground/60 focus:border-primary/40 focus:bg-background/60 focus:ring-2 focus:ring-primary/15"
            />
            {loading && <LoaderIcon className="absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />}
            {!loading && q && (
              <button
                type="button"
                className="absolute right-2 top-1/2 flex size-4 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full text-muted-foreground/60 transition-colors hover:bg-foreground/[0.08] hover:text-foreground"
                onClick={() => { setSearchInput(''); fetchAssets(1, '', kindRef.current) }}
                title="Clear"
              >
                <XIcon className="size-3" />
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* 类型行过滤（design 决策 D1：过滤器，非视图切换）：iOS 分段控件，
              等宽三分 + 滑动指示条（transform 过渡，纯 CSS） */}
          <div role="group" aria-label="类型过滤" className="relative flex h-8 items-center rounded-full border border-foreground/[0.09] bg-muted/40 p-1" data-kind-seg={kind}>
            <span
              aria-hidden
              className="absolute inset-y-1 left-1 w-[calc((100%-0.5rem)/3)] rounded-full bg-card shadow-[0_1px_3px_rgba(0,0,0,0.1)] ring-1 ring-foreground/[0.06] transition-transform duration-200 ease-out"
              style={{ transform: `translateX(${kindIndex * 100}%)` }}
            />
            {KIND_ORDER.map(k => (
              <button
                key={k}
                type="button"
                onClick={() => switchKind(k)}
                className={`relative z-10 flex-1 cursor-pointer rounded-full px-3 py-1 text-xs font-medium transition-colors duration-200 ${kind === k ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {KIND_LABELS[k]}
              </button>
            ))}
          </div>
          {total > 0 && kind !== 'run' && (
            <Button
              variant="outline"
              size="sm"
              className="rounded-full border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive gap-1"
              onClick={() => setDeleteMode('all')}
            >
              <TrashIcon className="size-3.5" />
              Delete All Sessions
            </Button>
          )}
        </div>
      </div>

      <Dialog open={deleteMode !== null} onOpenChange={(open) => { if (!open) setDeleteMode(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {deleteMode === 'all' ? 'Delete All Sessions' : `Delete ${selectedKeys.size} 项`}
            </DialogTitle>
            <DialogDescription className="text-base">
              {deleteMode === 'all'
                ? `将从 Insight 数据库中移除全部会话的分析数据（run 不受影响）。原始会话文件不受影响，可随时重新导入。`
                : selectedRuns.length > 0
                  ? `将删除选中的 ${selectedSessions.length} 个会话与 ${selectedRuns.length} 个 run。删除 run 会同时删除由它导入的成员会话（导入前已存在的会话不受影响）。`
                  : `将从 Insight 数据库中移除选中的 ${selectedSessions.length} 个 session 的分析数据。原始会话文件不受影响，可随时重新导入。`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteMode(null)}>取消</Button>
            <Button variant="destructive" onClick={() => {
              const mode = deleteMode
              setDeleteMode(null)
              if (mode === 'all') handleDeleteAll()
              else if (mode === 'selected') handleDeleteSelected()
            }}>确认删除</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={confirmDeleteKey !== null} onOpenChange={(open) => { if (!open) setConfirmDeleteKey(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirmDeleteItem?.kind === 'run' ? 'Delete Run' : 'Delete Session'}</DialogTitle>
            <DialogDescription className="text-base">
              {confirmDeleteItem?.kind === 'run'
                ? `将删除该 run（${confirmDeleteItem.name ?? confirmDeleteItem.runId}）及其目录数据，并级联删除由它导入的成员会话（导入前已存在的会话不受影响）。`
                : '将从 Insight 数据库中移除该 session 的分析数据。原始会话文件不受影响，可随时重新导入。'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDeleteKey(null)}>取消</Button>
            <Button variant="destructive" onClick={() => {
              const item = confirmDeleteItem
              setConfirmDeleteKey(null)
              if (item) handleDeleteOne(item)
            }}>确认删除</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <UploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        kind={uploadRequest?.kind ?? 'session'}
        target={uploadRequest?.target ?? null}
        onUploadStart={() => {
          if (uploadRequest) setUploadStatus(prev => ({ ...prev, [uploadRequest.key]: 'uploading' }))
        }}
        onResult={({ ok }) => {
          if (uploadRequest) setUploadStatus(prev => ({ ...prev, [uploadRequest.key]: ok ? 'done' : 'error' }))
        }}
      />
      <div className="animate-in fade-in slide-in-from-bottom-2 duration-300 overflow-hidden rounded-2xl border border-border/70 bg-card/70 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_16px_40px_-24px_rgba(0,0,0,0.28)] backdrop-blur-2xl backdrop-saturate-150">
        <div className="divide-y divide-border/50">
          {items.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-14 text-center">
              <SearchIcon className="size-5 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">{emptyText}</p>
            </div>
          )}
          {items.map((item) => (
            item.kind === 'run' ? renderRunRow(item) : renderSessionRow(item)
          ))}
        </div>
      </div>

      {/* 选择模式浮动操作条（底部居中毛玻璃胶囊，选中时滑入）：批量动作
          从工具栏常驻改到此处——未选中时界面零按钮噪声 */}
      {selectedKeys.size > 0 && (
        <div
          data-selection-bar
          className="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 animate-in fade-in slide-in-from-bottom-4 duration-200 items-center gap-1.5 rounded-full border border-border/70 bg-card/80 py-1.5 pl-4 pr-2 shadow-[0_2px_8px_rgba(0,0,0,0.08),0_24px_48px_-16px_rgba(0,0,0,0.32)] backdrop-blur-2xl backdrop-saturate-150"
        >
          <span className="text-xs text-muted-foreground">
            已选 {selectedKeys.size} 项{compareReady ? ' — 可对比' : ''}
          </span>
          {compareReady && (
            <Button
              variant="default"
              size="sm"
              className="rounded-full"
              onClick={() => {
                router.push(`/compare?sessions=${encodeURIComponent(selectedSessions[0].taskId)},${encodeURIComponent(selectedSessions[1].taskId)}`)
              }}
            >
              对比
            </Button>
          )}
          <Button
            variant="destructive"
            size="sm"
            className="rounded-full"
            onClick={() => setDeleteMode('selected')}
          >
            删除
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 rounded-full text-muted-foreground"
            onClick={() => setSelectedKeys(new Set())}
            title="取消选择"
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      )}

      {(totalPages > 1 || total > 0) && (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
          <p className="text-xs text-muted-foreground">
            {q ? `${total} of ${allCount}` : `${total}`} 项
            {totalPages > 1 && ` · 第 ${page} / ${totalPages} 页`}
            {loading && <LoaderIcon className="inline size-3 ml-1.5 animate-spin align-[-2px]" />}
          </p>
          {totalPages > 1 && (
            <div className="flex items-center gap-0.5 rounded-full border border-foreground/[0.08] bg-card/70 p-1 shadow-[0_1px_2px_rgba(0,0,0,0.06)]">
              <Button variant="ghost" size="icon" className="size-7 rounded-full" disabled={!hasPrev || loading} onClick={() => fetchAssets(1, q, kindRef.current)} title="第一页">
                <ChevronsLeftIcon className="size-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="size-7 rounded-full" disabled={!hasPrev || loading} onClick={() => fetchAssets(page - 1, q, kindRef.current)} title="上一页">
                <ChevronLeftIcon className="size-3.5" />
              </Button>
              {pageWindow(page, totalPages).map((p, i) =>
                p === '…' ? (
                  <span key={`ellipsis-${i}`} className="px-1 text-xs text-muted-foreground select-none">…</span>
                ) : (
                  <Button
                    key={p}
                    variant={p === page ? 'secondary' : 'ghost'}
                    size="icon"
                    className={`size-7 rounded-full text-xs tabular-nums ${p === page ? 'font-semibold' : ''}`}
                    disabled={loading}
                    onClick={() => { if (p !== page) fetchAssets(p, q, kindRef.current) }}
                  >
                    {p}
                  </Button>
                )
              )}
              <Button variant="ghost" size="icon" className="size-7 rounded-full" disabled={!hasNext || loading} onClick={() => fetchAssets(page + 1, q, kindRef.current)} title="下一页">
                <ChevronRightIcon className="size-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="size-7 rounded-full" disabled={!hasNext || loading} onClick={() => fetchAssets(totalPages, q, kindRef.current)} title="最后一页">
                <ChevronsRightIcon className="size-3.5" />
              </Button>
            </div>
          )}
        </div>
      )}
      {/* 未选中时的引导（对比规则提示）：低调一行，选中后由浮动条接管 */}
      {selectedKeys.size === 0 && (
        <p className="text-center text-[11px] text-muted-foreground/60">
          点击行图标可多选：2 个会话可对比，任意行可批量删除 <ChevronRightIcon className="inline size-3 align-[-2px]" />
        </p>
      )}
    </div>
  );
}
