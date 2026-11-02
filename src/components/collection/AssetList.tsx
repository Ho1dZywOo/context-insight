// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

'use client';

// 统一资产表（design: docs/design/unified-workbench/design.md §3.1）。
// 会话 + run 单表混排：Run 行按列语义映射（标题→run name、Tokens→Σ成员、
// Active/Wall→墙钟），类型徽标区分；「类型」筛选是行过滤器（URL ?kind=），
// 不是视图切换。多选跨 kind：Compare 仅 2 个会话行，删除按 kind 分发
// （run 删除级联 owned 会话，确认弹窗明示）。

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { BRAND_NAME, BAY_NAME, isBrandSourceType } from '@/lib/branding'
import { isProxyVersion, agentFrameworkOf } from '@/lib/shared/session-format'
import { sessionHref } from '@/lib/shared/session-link'
import type { AssetItem, AssetKindFilter, RunAssetItem, SessionAssetItem } from '@/lib/collection/types'
import { displayModel } from '@/lib/collection/model-display'
import { useRouter } from 'next/navigation';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { UploadDialog, type UploadTarget } from '@/components/collection/UploadDialog';
import { Input } from '@/components/ui/input';
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

const RUN_STATUS_VARIANT: Record<string, 'green' | 'red' | 'orange' | 'gray' | 'slate' | 'yellow'> = {
  passed: 'green',
  failed: 'red',
  running: 'orange',
  pending: 'gray',
  carried: 'slate',
  unknown: 'yellow',
};

const KIND_LABELS: Record<AssetKindFilter, string> = {
  all: '全部',
  session: '会话',
  run: 'Run',
};

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

// run 行起止（Start→End 列与 wall 时长共用）：manifest 端点优先，缺失用
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

  // 输入防抖自动搜索（400ms 无操作触发；回车/按钮立即）
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
  const [uploadError, setUploadError] = useState<string | null>(null)
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
      const entries = selectedSessions.map(i => ({ taskId: i.taskId, framework: i.framework ?? undefined }))
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
          body: JSON.stringify({ taskId: item.taskId, framework: item.framework ?? undefined }),
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

  return (
    <div className="space-y-3">
      {runWarnings.map(w => (
        <p key={w} className="text-xs text-yellow-600 dark:text-yellow-400">⚠ {w}</p>
      ))}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="text-lg font-semibold">
            {titleText}
            {q && allCount !== total && (
              <span className="text-sm font-normal text-muted-foreground ml-1">of {allCount}</span>
            )}
          </h2>
          <div className="flex items-center gap-1.5">
            <Input
              placeholder="Search keyword or session ID"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitSearch() }}
              className="w-52 sm:w-64"
            />
            <Button
              variant="outline"
              size="icon"
              className="size-8 shrink-0"
              onClick={submitSearch}
              disabled={loading}
              title="Search"
            >
              {loading ? <LoaderIcon className="size-3.5 animate-spin" /> : <SearchIcon className="size-3.5" />}
            </Button>
            {q && (
              <Button
                variant="ghost"
                size="icon"
                className="size-8 shrink-0 text-muted-foreground"
                onClick={() => { setSearchInput(''); fetchAssets(1, '', kindRef.current) }}
                title="Clear"
              >
                <XIcon className="size-3.5" />
              </Button>
            )}
          </div>
          {/* 类型行过滤（design 决策 D1：过滤器，非视图切换——与搜索同层级） */}
          <div className="flex items-center rounded-md border p-0.5 gap-0.5" role="group" aria-label="类型过滤">
            {(Object.keys(KIND_LABELS) as AssetKindFilter[]).map(k => (
              <button
                key={k}
                type="button"
                onClick={() => switchKind(k)}
                className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                  kind === k
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent/40'
                }`}
              >
                {KIND_LABELS[k]}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {selectedKeys.size === 0 && "Select 2 sessions to compare, or any rows to delete"}
            {selectedKeys.size === 1 && "1 selected"}
            {selectedKeys.size === 2 && (compareReady ? "2 selected — Compare ready" : "2 selected")}
            {selectedKeys.size > 2 && `${selectedKeys.size} selected`}
          </span>
          {compareReady && (
            <Button
              variant="default"
              size="sm"
              className="bg-blue-600 hover:bg-blue-700 text-white"
              onClick={() => {
                router.push(`/compare?sessions=${encodeURIComponent(selectedSessions[0].taskId)},${encodeURIComponent(selectedSessions[1].taskId)}`)
              }}
            >
              Compare Selected
            </Button>
          )}
          {selectedKeys.size >= 1 && (
            <Button
              variant="destructive"
              size="sm"
              className="gap-1"
              onClick={() => setDeleteMode('selected')}
            >
              <TrashIcon className="size-3.5" />
              Delete Selected ({selectedKeys.size})
            </Button>
          )}
          {total > 0 && kind !== 'run' && (
            <Button
              variant="outline"
              size="sm"
              className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive gap-1"
              onClick={() => setDeleteMode('all')}
            >
              <TrashIcon className="size-3.5" />
              Delete All Sessions
            </Button>
          )}
        </div>
      </div>

      {uploadError && (
        <span className="text-xs text-red-500">{uploadError}</span>
      )}

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
          setUploadError(null)
        }}
        onResult={({ ok, message }) => {
          if (uploadRequest) setUploadStatus(prev => ({ ...prev, [uploadRequest.key]: ok ? 'done' : 'error' }))
          if (!ok && message) setUploadError(message)
        }}
      />
      <div className="border rounded-lg">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-xs w-10 text-center"></TableHead>
              <TableHead className="text-xs">Query</TableHead>
              <TableHead className="text-xs">Type</TableHead>
              <TableHead className="text-xs whitespace-nowrap">Start → End</TableHead>
              <TableHead className="text-xs whitespace-nowrap">Import Time</TableHead>
              <TableHead className="text-xs">Model</TableHead>
              <TableHead className="text-xs text-right whitespace-nowrap">Tokens</TableHead>
              <TableHead className="text-xs text-right whitespace-nowrap">Cost</TableHead>
              <TableHead className="text-xs text-right whitespace-nowrap" title="活跃 / 墙钟（斜杠后为墙钟）：间隔 >5min 的空档计非活跃，API 调用进行中计活跃">Active / Wall</TableHead>
              <TableHead className="text-xs w-8"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 && (
              <TableRow>
                <TableCell colSpan={10} className="text-center text-muted-foreground py-8">
                  {emptyText}
                </TableCell>
              </TableRow>
            )}
            {items.map((item) => {
              const uStatus = uploadStatus[item.key] ?? 'idle'
              const eStatus = exportStatus[item.key] ?? 'idle'
              if (item.kind === 'run') {
                const wall = runWallMs(item)
                return (
                  <TableRow key={item.key} className={selectedKeys.has(item.key) ? 'bg-blue-500/10' : ''}>
                    <TableCell className="w-8 px-2 text-center">
                      <Checkbox
                        checked={selectedKeys.has(item.key)}
                        onCheckedChange={() => handleToggle(item.key)}
                      />
                    </TableCell>
                    <TableCell className="max-w-[300px] truncate text-xs">
                      <Link
                        href={`/run/${encodeURIComponent(item.runId)}`}
                        className="text-primary hover:underline"
                      >
                        {item.name ?? item.runId}
                      </Link>
                      <div className="text-[11px] text-muted-foreground truncate" title={`${item.runId} · ${item.nodeCount} 节点 · ${item.memberCount} 成员 · ${item.sessionMemberCount} 会话成员`}>
                        {item.runId} · {item.nodeCount} 节点 · {item.sessionMemberCount} 会话
                        {!item.exportDataComplete && (
                          <span className="ml-1 text-yellow-600 dark:text-yellow-400" title="导出数据不完整（exportDataComplete=false）">· 数据不完整</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs">
                      <span className="inline-flex items-center gap-1">
                        <Badge variant="purple">Run</Badge>
                        <Badge variant={RUN_STATUS_VARIANT[item.status] ?? 'gray'}>{item.status}</Badge>
                      </span>
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap">
                      {formatTime(runStartEnd(item).start)} → {formatTime(runStartEnd(item).end)}
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap">{formatTime(item.importedAt)}</TableCell>
                    <TableCell className="text-xs">
                      {item.memberStats && item.memberStats.models.length > 0 ? (
                        <span
                          className="block truncate max-w-[110px]"
                          title={item.memberStats.models.map(m => `${m.model} ×${m.count}`).join('\n')}
                        >
                          {item.memberStats.models[0]!.model}
                          {item.memberStats.models.length > 1 && (
                            <span className="text-muted-foreground"> +{item.memberStats.models.length - 1}</span>
                          )}
                        </span>
                      ) : '—'}
                    </TableCell>
                    <TableCell className="text-xs tabular-nums text-right" title="Σ成员会话指标">
                      {item.memberStats != null ? formatTokens(item.memberStats.totalTokens) : '—'}
                    </TableCell>
                    <TableCell className="text-xs tabular-nums text-right" title="Σ成员会话成本">
                      {item.memberStats != null ? formatCost(item.memberStats.totalCost) : '—'}
                    </TableCell>
                    <TableCell className="text-xs tabular-nums text-right whitespace-nowrap" title="Σ成员会话活跃 / Run 跨度墙钟">
                      {formatDuration(item.memberStats?.totalActiveMs ?? null)}
                      {wall != null && item.memberStats?.totalActiveMs != null && (
                        <span className="text-muted-foreground"> / {formatDuration(wall)}</span>
                      )}
                    </TableCell>
                    <TableCell className="px-2">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-6 text-muted-foreground hover:text-red-600"
                          onClick={() => setConfirmDeleteKey(item.key)}
                          title="Delete run"
                        >
                          <TrashIcon className="size-3.5" />
                        </Button>
                        <Button
                          variant="outline"
                          size="icon"
                          className="size-6"
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
                    </TableCell>
                  </TableRow>
                )
              }
              return (
                <TableRow key={item.key} className={selectedKeys.has(item.key) ? 'bg-blue-500/10' : ''}>
                  <TableCell className="w-8 px-2 text-center">
                    <Checkbox
                      checked={selectedKeys.has(item.key)}
                      onCheckedChange={() => handleToggle(item.key)}
                    />
                  </TableCell>
                  <TableCell className="max-w-[300px] truncate text-xs">
                    <Link
                      href={sessionHref(item.taskId, item.framework)}
                      className="text-primary hover:underline"
                    >
                      {item.query ?? item.taskId}
                    </Link>
                  </TableCell>
                  <TableCell className="text-xs">
                    {/* 方案一（同 sid 双会话）：framework 可能带 -proxy 记录后缀，
                        图标按 agent 归属归一呈现，proxy 与否走 version 徽标 */}
                    {(() => {
                      const agent = agentFrameworkOf(item.framework) ?? '';
                      return agent === 'opencode' || agent === 'claude-code' || agent === 'cannbot' || agent === 'dsh' || agent === 'codex' ? (
                        <span className="inline-flex items-center gap-1">
                          {agent === 'opencode'
                            ? <Badge variant="blue">OpenCode</Badge>
                            : agent === 'cannbot'
                              ? <Badge variant="green">CANNBot</Badge>
                              : agent === 'dsh'
                                ? <Badge variant="purple">DSH</Badge>
                              : agent === 'codex'
                                ? <Badge variant="slate">Codex</Badge>
                                : <Badge variant="orange">Claude</Badge>}
                          {isProxyVersion(item.version) && (
                            <Badge variant="yellow">proxy</Badge>
                          )}
                        </span>
                      ) : isBrandSourceType(item.framework) ? (
                        <Badge variant="purple">{BRAND_NAME}</Badge>
                      ) : '—';
                    })()}
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap">
                    {formatTime(item.startTime)} → {formatTime(item.endTime)}
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap">{formatTime(item.importedAt)}</TableCell>
                  <TableCell className="text-xs"><span className="block truncate max-w-[110px]" title={item.model ?? undefined}>{displayModel(item.model) ?? '—'}</span></TableCell>
                  <TableCell className="text-xs tabular-nums text-right">{formatTokens(item.totalTokens)}</TableCell>
                  <TableCell className="text-xs tabular-nums text-right">{formatCost(item.totalCost)}</TableCell>
                  <TableCell className="text-xs tabular-nums text-right whitespace-nowrap">
                    {formatDuration(item.activeMs ?? null)}
                    {item.wallMs != null && item.activeMs != null && (
                      <span className="text-muted-foreground"> / {formatDuration(item.wallMs)}</span>
                    )}
                  </TableCell>
                  <TableCell className="px-2">
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6 text-muted-foreground hover:text-red-600"
                        onClick={() => setConfirmDeleteKey(item.key)}
                        title="Delete session"
                      >
                        <TrashIcon className="size-3.5" />
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        className="size-6"
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
                        variant="outline"
                        size="icon"
                        className="size-6"
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
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      {(totalPages > 1 || total > 0) && (
        <div className="flex items-center justify-between gap-3 mt-4 flex-wrap">
          <p className="text-xs text-muted-foreground">
            {q ? `${total} of ${allCount}` : `${total}`} 项
            {totalPages > 1 && ` · 第 ${page} / ${totalPages} 页`}
            {loading && <LoaderIcon className="inline size-3 ml-1.5 animate-spin align-[-2px]" />}
          </p>
          {totalPages > 1 && (
            <div className="flex items-center gap-1">
              <Button variant="outline" size="icon" className="size-7" disabled={!hasPrev || loading} onClick={() => fetchAssets(1, q, kindRef.current)} title="第一页">
                <ChevronsLeftIcon className="size-3.5" />
              </Button>
              <Button variant="outline" size="icon" className="size-7" disabled={!hasPrev || loading} onClick={() => fetchAssets(page - 1, q, kindRef.current)} title="上一页">
                <ChevronLeftIcon className="size-3.5" />
              </Button>
              {pageWindow(page, totalPages).map((p, i) =>
                p === '…' ? (
                  <span key={`ellipsis-${i}`} className="px-1 text-xs text-muted-foreground select-none">…</span>
                ) : (
                  <Button
                    key={p}
                    variant={p === page ? 'default' : 'outline'}
                    size="icon"
                    className={`size-7 text-xs tabular-nums ${p === page ? 'font-semibold' : ''}`}
                    disabled={loading}
                    onClick={() => { if (p !== page) fetchAssets(p, q, kindRef.current) }}
                  >
                    {p}
                  </Button>
                )
              )}
              <Button variant="outline" size="icon" className="size-7" disabled={!hasNext || loading} onClick={() => fetchAssets(page + 1, q, kindRef.current)} title="下一页">
                <ChevronRightIcon className="size-3.5" />
              </Button>
              <Button variant="outline" size="icon" className="size-7" disabled={!hasNext || loading} onClick={() => fetchAssets(totalPages, q, kindRef.current)} title="最后一页">
                <ChevronsRightIcon className="size-3.5" />
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
