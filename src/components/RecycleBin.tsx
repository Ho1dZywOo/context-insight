// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

'use client'

// 回收站（侧栏 section 形态，VS Code Explorer 同款位）：insight 库删除的资
// 产先落快照于此——「恢复」回流为独立会话（原 run 目录已删，不复活 run），
// 「彻底删除/清空」不可逆。破坏性操作走两步确认（行内按钮变形，3.5s 自动
// 解除，轻确认无弹窗）；恢复成功后整页 reload 让主列表同步浮现（主列表
// items 是客户端 state——分页/搜索局部更新——router.refresh() 只换 props
// 不重置 state，回流行不会出现；与删除流程同口径）。

import { useCallback, useEffect, useState } from 'react'
import { ChevronDownIcon, RotateCcwIcon, TrashIcon, LoaderIcon } from 'lucide-react'
import { toast } from 'sonner'
import { AssetIcon, modelIconId } from '@/components/collection/AssetIcon'
import { cn } from '@/lib/utils'

interface RecycleEntry {
  name: string
  taskId: string
  framework: string | null
  query: string | null
  model: string | null
  size: number
  deletedAt: string
}

function formatSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

function formatDeletedAt(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(ms)) return ''
  const min = Math.floor(ms / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}

export function RecycleBin() {
  const [entries, setEntries] = useState<RecycleEntry[] | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  // 两步确认：arm 存放已武装的条目名（清空用 '__empty__' 哨兵）；3.5s 自动解除
  const [arm, setArm] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/recycle')
      .then(r => (r.ok ? r.json() : null))
      .then(d => setEntries(d?.entries ?? []))
      .catch(() => setEntries([]))
  }, [])

  const disarmLater = useCallback((name: string) => {
    setTimeout(() => setArm(prev => (prev === name ? null : prev)), 3500)
  }, [])

  // 返回响应体而非布尔：restore 需要区分 imported:true/false（服务端 200 但
  // imported:false = 未回流也未删快照），只凭 res.ok 会把失败当成功移除条目。
  const post = useCallback(async (body: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
    try {
      const res = await fetch('/api/recycle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) return null
      return await res.json()
    } catch {
      return null
    }
  }, [])

  const handleRestore = useCallback(async (name: string) => {
    setBusy(name)
    try {
      const data = await post({ action: 'restore', name })
      if (data?.imported === true) {
        setEntries(prev => (prev ?? []).filter(e => e.name !== name))
        // 整页 reload（非 router.refresh）：主列表 items 是客户端 state，
        // refresh 只换 props 不重置 state，回流行不会浮现——徽章与列表会
        // 自相矛盾（badge 4 / list 3）；删除流程同款出口，三处 UI 一致
        window.location.reload()
      } else if (data) {
        // imported:false（空会话 0 轮 / 同 taskId 已存在走 merge/dedup）：快照
        // 未回流也未删除——保留条目并如实提示，不静默抹掉列表条目
        toast.error(data.query ? '恢复失败：会话已存在' : '恢复失败：空会话无法恢复')
      }
    } finally {
      setBusy(null)
    }
  }, [post])

  const handlePurge = useCallback(async (name: string) => {
    if (arm !== name) {
      setArm(name)
      disarmLater(name)
      return
    }
    setArm(null)
    setBusy(name)
    try {
      if (await post({ action: 'purge', name })) {
        setEntries(prev => (prev ?? []).filter(e => e.name !== name))
      }
    } finally {
      setBusy(null)
    }
  }, [arm, disarmLater, post])

  const handleEmpty = useCallback(async () => {
    if (arm !== '__empty__') {
      setArm('__empty__')
      disarmLater('__empty__')
      return
    }
    setArm(null)
    setBusy('__empty__')
    try {
      if (await post({ action: 'empty' })) setEntries([])
    } finally {
      setBusy(null)
    }
  }, [arm, disarmLater, post])

  const count = entries?.length ?? 0
  const hasEntries = count > 0

  return (
    <section data-recycle-panel className="mt-1">
      {/* section 头：折叠开关 + 小字距标题 + 计数角标 + 清空（两步确认） */}
      <div className="flex h-8 items-center gap-1 px-1.5">
        <button
          type="button"
          onClick={() => setCollapsed(v => !v)}
          aria-expanded={!collapsed}
          className="flex h-8 min-w-0 flex-1 items-center gap-1.5 px-1.5 text-left"
        >
          <ChevronDownIcon className={cn('size-3 shrink-0 text-muted-foreground/60 transition-transform duration-200', collapsed && '-rotate-90')} />
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">Recycle Bin</span>
          {hasEntries && (
            <span className="rounded-full bg-foreground/[0.06] px-1.5 py-px text-[10px] font-medium tabular-nums text-muted-foreground">{count}</span>
          )}
        </button>
        {hasEntries && (
          <button
            type="button"
            data-recycle-empty
            onClick={handleEmpty}
            disabled={busy === '__empty__'}
            title="清空回收站（不可恢复）"
            className={cn(
              'flex h-6 shrink-0 items-center rounded-md px-1.5 text-[10px] transition-colors duration-150',
              arm === '__empty__'
                ? 'bg-destructive/10 font-medium text-destructive'
                : 'text-muted-foreground/60 hover:bg-destructive/10 hover:text-destructive',
            )}
          >
            {busy === '__empty__' ? <LoaderIcon className="size-3 animate-spin" /> : arm === '__empty__' ? '确认' : <TrashIcon className="size-3" />}
          </button>
        )}
      </div>
      {/* 折叠体：grid-rows 0fr→1fr 过渡（纯 CSS 无 JS 测高） */}
      <div className={cn('grid transition-[grid-template-rows] duration-200 ease-out', collapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]')}>
        <div className="overflow-hidden">
          {entries === null && (
            <div className="space-y-1.5 px-3 pb-2">
              <div className="h-7 animate-pulse rounded-md bg-muted/30" />
              <div className="h-7 animate-pulse rounded-md bg-muted/20" />
            </div>
          )}
          {entries !== null && !hasEntries && (
            <p className="px-3 pb-2 text-[11px] leading-5 text-muted-foreground/50">删除的资产会先落入这里，可随时恢复</p>
          )}
          {entries?.map(e => (
            <div
              key={e.name}
              data-recycle-row
              data-recycle-name={e.name}
              className={cn(
                'group flex items-center gap-2 rounded-lg py-1.5 pl-4 pr-1.5 transition-colors duration-150',
                arm === e.name ? 'bg-destructive/[0.06]' : 'hover:bg-foreground/[0.04]',
              )}
            >
              <AssetIcon id={modelIconId(e.model)} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-foreground" title={e.taskId}>{e.query ?? e.taskId}</p>
                <p className="truncate text-[10px] text-muted-foreground/70">
                  {formatSize(e.size)} · 删除于 {formatDeletedAt(e.deletedAt)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity duration-150 group-hover:opacity-100">
                <button
                  type="button"
                  data-recycle-restore
                  onClick={() => handleRestore(e.name)}
                  disabled={busy === e.name}
                  title="恢复到 insight 库"
                  className="flex h-6 items-center rounded-md px-1.5 text-[10px] text-emerald-700 transition-colors duration-150 hover:bg-emerald-500/10 dark:text-emerald-300"
                >
                  {busy === e.name ? <LoaderIcon className="size-3 animate-spin" /> : <RotateCcwIcon className="size-3" />}
                </button>
                <button
                  type="button"
                  data-recycle-purge
                  onClick={() => handlePurge(e.name)}
                  disabled={busy === e.name}
                  title="彻底删除（不可恢复）"
                  className={cn(
                    'flex h-6 items-center rounded-md px-1.5 text-[10px] transition-colors duration-150',
                    arm === e.name
                      ? 'bg-destructive/10 font-medium text-destructive'
                      : 'text-muted-foreground/60 hover:bg-destructive/10 hover:text-destructive',
                  )}
                >
                  {arm === e.name ? '确认' : <TrashIcon className="size-3" />}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
