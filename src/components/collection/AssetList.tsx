// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

'use client';

// 统一资产列表（design: docs/design/unified-workbench/design.md §3.1）。
// 会话 + run 单列表混排（分组列表形态）：行 = 模型徽标 App 图标（会话跟
// 模型走、瓦色全站统一翡翠绿；run 靛紫；右上角常显小勾选角标：未选空心 /
// 选中实心对勾）+ 标题/元信息 + 右侧定宽微型
// 统计列；「类型」分段控件是行过滤器（URL ?kind=，非视图切换，滑动指示条
// 纯 CSS transform）。多选批量操作收进底部浮动毛玻璃条（选中时滑入）；
// Compare 仅 2 个会话行，删除按 kind 分发（run 级联 owned 会话，确认弹窗
// 明示）。

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { BAY_NAME } from '@/lib/branding'
import { frameworkDisplayName, isProxyVersion } from '@/lib/shared/session-format'
import type { AssetItem, AssetKindFilter, RunAssetItem, SessionAssetItem } from '@/lib/collection/types'
import { displayModel } from '@/lib/collection/model-display'
import { useRouter } from 'next/navigation';
import { AssetIcon, modelIconId, type AssetIconId } from '@/components/collection/AssetIcon';
import { Button } from '@/components/ui/button';
import {
  UploadDialog,
  type UploadTarget,
} from '@/components/collection/UploadDialog';
import { toast } from 'sonner';
import { notifyError } from '@/components/NoticeHud';
import { notifyAssetsChanged, onAssetsChanged } from '@/lib/assets-events';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { UploadIcon, LoaderIcon, CheckIcon, XIcon, TrashIcon, SearchIcon, ChevronLeftIcon, ChevronRightIcon, ChevronsLeftIcon, ChevronsRightIcon } from 'lucide-react';

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

const KIND_ORDER: AssetKindFilter[] = ['all', 'session', 'run'];

const KIND_LABELS: Record<AssetKindFilter, string> = {
  all: 'All',
  session: 'Sessions',
  run: 'Runs',
};

// 会话行图标 id：跟模型走（modelIconId 在 AssetIcon 单点解析），与导入来
// 源解耦
function sessionIconId(item: SessionAssetItem): AssetIconId {
  return modelIconId(item.model);
}

// framework 显示名走 session-format 词表单点（品牌 sourceType / agent 归属 /
// 未知回落三态同源），本文件不再持词表副本
function sessionFrameworkLabel(item: SessionAssetItem): string | null {
  return frameworkDisplayName(item.framework);
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

// 行右侧微型统计列（tokens / cost / active·wall）：值 + 小标签，列内右对齐、
// 列宽固定——跨行纵向对齐不随数字长短漂移
function Stat({ label, value, title, error, width }: { label: string; value: string; title?: string; error?: boolean; width: string }) {
  return (
    <div className={`flex flex-col items-center gap-0.5 ${width}`} title={title}>
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
  const searchRef = useRef<HTMLInputElement>(null)

  // 「/」直达搜索框（工作台快捷键习惯）：非输入态按下即聚焦；纯原生监听，卸载即除
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable)) return
      e.preventDefault()
      searchRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  async function fetchAssets(nextPage: number, nextQ: string, nextKind: AssetKindFilter): Promise<number> {
    const seq = ++reqSeq.current
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: String(nextPage), pageSize: String(pageSize) })
      if (nextQ) params.set('q', nextQ)
      if (nextKind !== 'all') params.set('kind', nextKind)
      const res = await fetch(`/api/observe/data?${params}`)
      const data = await res.json()
      if (seq !== reqSeq.current || !res.ok) return 0
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
      return (data.items ?? []).length
    } catch {
      /* 网络错误：保留当前数据 */
      return 0
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

  // 删除乐观移除（Gmail 范式）：确认即隐藏行、后台结算、结果 sonner toast +
  // 限时撤销（真实数据恢复，经 POST /api/recycle restore——删除级联内部本来
  // 就会先归档快照到回收站）。hiddenKeys = 用户已确认删除的行，fetchAssets
  // 结算前把行从渲染滤掉、结算后由服务端真值自然接管；失败/撤销按 key 回滚
  // 显示。跨组件同步走 assets-changed 事件（本列表结算后广播，回收站面板
  // 侧听并重取；面板恢复同理反向广播），不再整页 location.reload
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(new Set())
  const toastSeq = useRef(0)
  // 409 双行消歧（同 taskId 双记录并存）：删除路由要求显式 confirmAll 才放
  // 行全删，此前前端从未接线——歧义删除一直静默失败。这里弹二次确认
  const [ambiguity, setAmbiguity] = useState<{ taskId: string; rowCount: number; key: string } | null>(null)

  const [uploadStatus, setUploadStatus] = useState<Record<string, UploadStatus>>({})
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null)
  // 上传弹窗（统一组件，刀3 合一）：kind + target 一体；结果经回调回填行内状态
  const [uploadRequest, setUploadRequest] = useState<{ key: string; kind: 'session' | 'run'; target: UploadTarget } | null>(null)
  const [uploadOpen, setUploadOpen] = useState(false)

  const confirmDeleteItem = confirmDeleteKey != null ? items.find(i => i.key === confirmDeleteKey) : undefined
  // 乐观隐藏后的可见行：删除中行离场即时可见；选择/Compare 全部基于可见行
  const visibleItems = items.filter(i => !hiddenKeys.has(i.key))
  const selectedItems = visibleItems.filter(i => selectedKeys.has(i.key))
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

  // —— 删除交互基建（乐观移除 + sonner 相位 + 撤销） ——

  function hideKeys(keys: string[]) {
    if (keys.length === 0) return
    setHiddenKeys(prev => {
      const next = new Set(prev)
      for (const k of keys) next.add(k)
      return next
    })
  }

  function unhideKeys(keys: string[]) {
    if (keys.length === 0) return
    setHiddenKeys(prev => {
      const next = new Set(prev)
      for (const k of keys) next.delete(k)
      return next
    })
  }

  function beginDeletionToast(message: string): string {
    const tid = `del-${++toastSeq.current}`
    toast.loading(message, { id: tid })
    return tid
  }

  // 结算成功：带回收站条目名则提供限时撤销（action 按钮），并广播资产变更
  //（本列表侧听重取 + 回收站面板重取）；无条目名（归档 best-effort 失败或
  // run 目录删除不可逆）只报结果
  function settleDeletion(tid: string, message: string, undo?: { names: string[]; keys: string[] }) {
    if (undo && undo.names.length > 0) {
      const { names, keys } = undo
      toast.success(message, {
        id: tid,
        duration: 6_000,
        action: { label: '撤销', onClick: () => { void handleUndo(names, keys, tid) } },
      })
    } else {
      toast.success(message, { id: tid, duration: 3_000 })
    }
    notifyAssetsChanged()
  }

  function failDeletion(tid: string, keys: string[], message: string) {
    unhideKeys(keys)
    // 收掉 loading toast，改走持久报错卡：失败原因必须经「知道了」确认，
    // 不再 6s 超时蒸发
    toast.dismiss(tid)
    notifyError('删除失败', message)
    // 失败也广播：部分成功时列表/面板靠重取对齐服务端真值
    notifyAssetsChanged()
  }

  // 删除结算（事件回调）：局部刷新列表（/api/observe/data）+ router.refresh()
  // 软刷指标卡；删除致当前页清空时回退上一页
  async function syncAfterDeletion() {
    const remaining = await fetchAssets(page, q, kindRef.current)
    if (remaining === 0 && page > 1) await fetchAssets(page - 1, q, kindRef.current)
    router.refresh()
  }

  // 资产变更软同步：本列表或回收站面板任一侧结算后广播事件、各持有方重取
  //（订阅随 page/q 变化重建，闭包持有最新分页/搜索态）
  useEffect(() => {
    return onAssetsChanged(() => { void syncAfterDeletion() })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, q])

  // 撤销 = 真实数据恢复：逐条 POST /api/recycle restore（快照在删除级联内
  // best-effort 归档过），成功后回滚隐藏 + 广播重取；注意 restore 契约是
  // 200 + imported 布尔（空会话 0 轮 / 同 taskId 已存在都不回流）——只有
  // imported:true 才算恢复，res.ok 不等于恢复成功。全部失败提示走回收站
  // 面板手动恢复（快照仍保留在那里）
  async function handleUndo(names: string[], keys: string[], tid: string) {
    toast.loading('恢复中…', { id: tid })
    let restored = 0
    for (const name of names) {
      try {
        const res = await fetch('/api/recycle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'restore', name }),
        })
        const data = res.ok ? await res.json().catch(() => null) : null
        if (data?.imported === true) restored++
      } catch {}
    }
    if (restored > 0) {
      unhideKeys(keys)
      toast.success(`已恢复 ${restored} 项`, { id: tid, duration: 3_000 })
      notifyAssetsChanged()
    } else {
      // 撤销失败：收掉 loading，走持久报错卡（须确认）——快照仍在回收站，
      // 用户还有面板手动恢复这条后路，提示不能自动消失
      toast.dismiss(tid)
      notifyError('恢复失败', '快照仍在回收站，可到面板手动恢复')
    }
  }

  async function handleDeleteAll() {
    const keys = visibleItems.map(i => i.key)
    hideKeys(keys)
    const tid = beginDeletionToast('正在清空全部资产…')
    const recycle: string[] = []
    let failed = false
    try {
      // 全资产删除：run 先行（级联删除其导入的成员会话），再清剩余独立会话。
      // run 列表会随删除收缩——循环取第一页直到取空，避免翻页错位
      for (;;) {
        const listRes = await fetch('/api/observe/data?kind=run&pageSize=100&page=1')
        if (!listRes.ok) break
        const data = await listRes.json()
        const runs = (data.items ?? []) as Array<{ runId: string }>
        if (runs.length === 0) break
        for (const run of runs) {
          try {
            const res = await fetch(`/api/observe/run/${encodeURIComponent(run.runId)}`, { method: 'DELETE' })
            const rd = res.ok ? await res.json().catch(() => ({})) : {}
            if (!res.ok) failed = true
            if (Array.isArray(rd.recycle)) recycle.push(...rd.recycle)
          } catch { failed = true }
        }
      }
      const res = await fetch('/api/ingest/delete-session', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deleteAll: true }),
      })
      const data = res.ok ? await res.json().catch(() => ({})) : {}
      if (!res.ok) failed = true
      if (Array.isArray(data.recycle)) recycle.push(...data.recycle)
    } catch { failed = true }
    if (failed) {
      failDeletion(tid, keys, '清空未完全成功，列表已还原（已成功项随刷新对齐）')
    } else {
      settleDeletion(
        tid,
        recycle.length > 0 ? `已清空全部资产（${recycle.length} 个会话已入回收站）` : '已清空全部资产',
        recycle.length > 0 ? { names: recycle, keys } : undefined,
      )
    }
  }

  async function handleDeleteSelected() {
    // 按 kind 分发：会话批量 delete-session；run 逐个走 observe/run 级联删除
    const keys = selectedItems.map(i => i.key)
    hideKeys(keys)
    const tid = beginDeletionToast(`正在删除 ${keys.length} 项…`)
    const recycle: string[] = []
    let failed = false
    if (selectedSessions.length > 0) {
      try {
        const res = await fetch('/api/ingest/delete-session', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessions: selectedSessions.map(i => {
            // framework 仅非空时携带：空值行传占位符会过滤成查无此行（404）
            const entry: Record<string, unknown> = { taskId: i.taskId }
            if (i.framework) entry.framework = i.framework
            return entry
          }) }),
        })
        const data = res.ok ? await res.json().catch(() => ({})) : {}
        if (!res.ok) failed = true
        if (Array.isArray(data.recycle)) recycle.push(...data.recycle)
      } catch { failed = true }
    }
    for (const run of selectedRuns) {
      try {
        const res = await fetch(`/api/observe/run/${encodeURIComponent(run.runId)}`, { method: 'DELETE' })
        const data = res.ok ? await res.json().catch(() => ({})) : {}
        if (!res.ok) failed = true
        if (Array.isArray(data.recycle)) recycle.push(...data.recycle)
      } catch { failed = true }
    }
    if (failed) {
      failDeletion(tid, keys, '部分删除失败，列表已还原（已成功项随刷新对齐）')
    } else {
      settleDeletion(
        tid,
        recycle.length > 0 ? `已删除 ${keys.length} 项（${recycle.length} 个会话已入回收站）` : `已删除 ${keys.length} 项`,
        recycle.length > 0 ? { names: recycle, keys } : undefined,
      )
    }
  }

  async function handleDeleteOne(item: AssetItem) {
    hideKeys([item.key])
    const tid = beginDeletionToast('正在删除…')
    try {
      if (item.kind === 'session') {
        // framework 仅非空时携带：空值行传占位符会过滤成查无此行（404 静默
        // 失败）；不带 framework 的歧义由路由 409 守卫接手（handleDeleteAmbiguous）
        const body: Record<string, unknown> = { taskId: item.taskId }
        if (item.framework) body.framework = item.framework
        const res = await fetch('/api/ingest/delete-session', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (res.status === 409) {
          const data = await res.json().catch(() => ({}))
          unhideKeys([item.key])
          toast.dismiss(tid)
          setAmbiguity({
            taskId: item.taskId,
            rowCount: Number(data.rowCount ?? 0) || 2,
            key: item.key,
          })
          return
        }
        const data = res.ok ? await res.json().catch(() => ({})) : {}
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
        const names: string[] = Array.isArray(data.recycle) ? data.recycle : []
        settleDeletion(tid, names.length > 0 ? '已删除会话' : '已删除会话（回收站归档失败，不可撤销）',
          names.length > 0 ? { names, keys: [item.key] } : undefined)
      } else {
        const res = await fetch(`/api/observe/run/${encodeURIComponent(item.runId)}`, { method: 'DELETE' })
        const data = res.ok ? await res.json().catch(() => ({})) : {}
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
        const recycled = Array.isArray(data.recycle) ? data.recycle.length : 0
        // run 目录本身删除后不可撤销（只能从原始 bundle 重导），但级联清掉
        // 的成员会话已入回收站——提示可去恢复，不提供行级撤销
        settleDeletion(tid, recycled > 0 ? `已删除 run（${recycled} 个成员会话已入回收站）` : '已删除 run')
      }
    } catch {
      failDeletion(tid, [item.key], '删除失败，行已还原')
    }
  }

  // 409 歧义确认后的全删：路由契约要求显式 confirmAll: true 才放行
  async function handleDeleteAmbiguous() {
    const amb = ambiguity
    setAmbiguity(null)
    if (!amb) return
    hideKeys([amb.key])
    const tid = beginDeletionToast('正在删除…')
    try {
      const res = await fetch('/api/ingest/delete-session', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: amb.taskId, confirmAll: true }),
      })
      const data = res.ok ? await res.json().catch(() => ({})) : {}
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      const names: string[] = Array.isArray(data.recycle) ? data.recycle : []
      settleDeletion(tid, `已删除 ${data.deleted ?? amb.rowCount} 行`,
        names.length > 0 ? { names, keys: [amb.key] } : undefined)
    } catch {
      failDeletion(tid, [amb.key], '删除失败，行已还原')
    }
  }

  const emptyText = kind === 'run'
    ? '暂无导入的 Run。导入包含 workflow.json 与 sessions/ 的 Bundle 目录后在此查看。'
    : kind === 'session'
      ? 'No sessions found. Import a session to get started.'
      : 'No sessions found. Import a session or bundle to get started.'
  const titleText = kind === 'run' ? `Runs (${total})` : kind === 'session' ? `Sessions (${total})` : `Assets (${total})`
  const kindIndex = KIND_ORDER.indexOf(kind)

  // 选择位：行图标 + 常显微型勾选点（图标右上角）——静息 9px 空心点
  // （轻量到几乎无感），选中放大为 14px 实心对勾（150ms 过渡）；点击图标/
  // 角标即勾选
  const renderSelectSlot = (selected: boolean, iconId: AssetIconId, label: string, onToggle: () => void) => (
    <button
      type="button"
      data-asset-check
      role="checkbox"
      aria-checked={selected}
      aria-label={`选择 ${label}`}
      title={selected ? '取消选择' : '选择'}
      onClick={onToggle}
      className="relative size-10 shrink-0 cursor-pointer rounded-[14px] outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      <AssetIcon id={iconId} />
      <span
        aria-hidden
        data-check-badge
        className={`absolute -right-px -top-px flex items-center justify-center rounded-full border transition-all duration-150 ${
          selected
            ? 'size-3.5 border-primary bg-primary text-primary-foreground shadow-[0_1px_3px_rgba(0,0,0,0.2)]'
            : 'size-[9px] border-muted-foreground/30 bg-card shadow-[0_0_0_1.5px_var(--background)]'
        }`}
      >
        {selected && <CheckIcon className="size-2" strokeWidth={4} />}
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
          <Stat width="w-16" label="Tokens" value={item.memberStats != null ? formatTokens(item.memberStats.totalTokens) : '—'} title="Σ成员会话指标" />
          <Stat width="w-14" label="Cost" value={item.memberStats != null ? formatCost(item.memberStats.totalCost) : '—'} title="Σ成员会话成本" />
          <Stat
            width="w-28"
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
          <Stat width="w-16" label="Tokens" value={formatTokens(item.totalTokens)} />
          <Stat width="w-14" label="Cost" value={formatCost(item.totalCost)} />
          <Stat
            width="w-28"
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
          {/* 搜索场（圆角搜索框形态）：Enter 立即，输入防抖自动；进行中右缘转圈 */}
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
            <input
              data-asset-search
              ref={searchRef}
              placeholder="Search keyword or session ID"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitSearch() }}
              className="h-8 w-64 rounded-full border border-foreground/[0.09] bg-muted/40 pl-8.5 pr-8 text-xs text-foreground outline-none transition-colors duration-200 placeholder:text-muted-foreground/60 focus:border-primary/40 focus:bg-background/60 focus:ring-2 focus:ring-primary/15"
            />
            {!loading && !q && (
              <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md border border-border/60 bg-muted/60 px-1.5 py-px text-[10px] font-medium text-muted-foreground/70">/</kbd>
            )}
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
          {/* 类型行过滤（design 决策 D1：过滤器，非视图切换）：分段控件（等宽
              三分 + 滑动指示条，transform 过渡，纯 CSS） */}
          <div role="group" aria-label="类型过滤" className="relative flex h-8 shrink-0 items-center rounded-full border border-foreground/[0.09] bg-muted/40 p-1" data-kind-seg={kind}>
            <span
              aria-hidden
              className="absolute inset-y-1 left-1 w-14 rounded-full bg-card shadow-[0_1px_3px_rgba(0,0,0,0.1)] ring-1 ring-foreground/[0.06] transition-transform duration-200 ease-out"
              style={{ transform: `translateX(${kindIndex * 100}%)` }}
            />
            {KIND_ORDER.map(k => (
              <button
                key={k}
                type="button"
                onClick={() => switchKind(k)}
                className={`relative z-10 flex h-6 w-14 shrink-0 cursor-pointer items-center justify-center rounded-full whitespace-nowrap text-xs font-medium transition-colors duration-200 ${kind === k ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {KIND_LABELS[k]}
              </button>
            ))}
          </div>
          {total > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="rounded-full border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive gap-1"
              onClick={() => setDeleteMode('all')}
            >
              <TrashIcon className="size-3.5" />
              Delete All Assets
            </Button>
          )}
        </div>
      </div>

      <Dialog open={deleteMode !== null} onOpenChange={(open) => { if (!open) setDeleteMode(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {deleteMode === 'all' ? 'Delete All Assets' : `Delete ${selectedKeys.size} 项`}
            </DialogTitle>
            <DialogDescription className="text-base">
              {deleteMode === 'all'
                ? `将删除全部资产：每个 run（含其导入的成员会话）与所有独立会话的分析数据。原始文件不受影响，可随时重新导入。`
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
      <Dialog open={ambiguity !== null} onOpenChange={(open) => { if (!open) setAmbiguity(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>同 ID 存在多条记录</DialogTitle>
            <DialogDescription className="text-base">
              {`taskId "${ambiguity?.taskId}" 有 ${ambiguity?.rowCount ?? 2} 条会话记录（双记录并存），确认删除将同时移除全部记录。删除前逐条归档回收站，可撤销恢复。`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAmbiguity(null)}>取消</Button>
            <Button variant="destructive" onClick={handleDeleteAmbiguous}>全部删除</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <div className="animate-in fade-in slide-in-from-bottom-2 duration-300 overflow-hidden rounded-2xl border border-border/50 bg-card/50 shadow-[0_1px_2px_rgba(0,0,0,0.03),0_16px_40px_-24px_rgba(0,0,0,0.22)]">
        <div className="divide-y divide-border/50">
          {visibleItems.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-14 text-center">
              <SearchIcon className="size-5 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">{emptyText}</p>
            </div>
          )}
          {visibleItems.map((item) => (
            item.kind === 'run' ? renderRunRow(item) : renderSessionRow(item)
          ))}
        </div>
      </div>

      {/* 选择模式操作条（sticky 悬于列表可见区底部，选中时滑入）：批量动作
          从工具栏常驻改到此处——未选中时界面零按钮噪声；sticky 而非 fixed，
          工作台 chrome（底部面板/状态栏）下不越界 */}
      {selectedKeys.size > 0 && (
        <div
          data-selection-bar
          className="sticky bottom-4 z-30 mx-auto flex w-fit animate-in fade-in slide-in-from-bottom-4 duration-200 items-center gap-1.5 rounded-full border border-border/70 bg-card/80 py-1.5 pl-4 pr-2 shadow-[0_2px_8px_rgba(0,0,0,0.08),0_24px_48px_-16px_rgba(0,0,0,0.32)] backdrop-blur-2xl backdrop-saturate-150"
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
          勾选行图标角标可多选：2 个会话可对比，任意行可批量删除 <ChevronRightIcon className="inline size-3 align-[-2px]" />
        </p>
      )}
    </div>
  );
}
