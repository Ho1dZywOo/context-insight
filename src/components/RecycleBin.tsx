// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

'use client'

// 回收站面板（底部折叠面板位，接替 Recent Imports）：insight 库删除的资产
// 先落快照于此——「恢复」回流为独立会话（原 run 目录已删，不复活 run），
// 「彻底删除/清空」不可逆。破坏性操作走两步确认（行内按钮变形，iOS 式轻
// 确认，无弹窗打断）；恢复成功后 router.refresh() 让主列表同步浮现。

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronDownIcon, RotateCcwIcon, Trash2Icon, LoaderIcon } from 'lucide-react'
import { AssetIcon, modelIconId } from '@/components/collection/AssetIcon'
import { Button } from '@/components/ui/button'
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
  const router = useRouter()
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

  const post = useCallback(async (body: Record<string, unknown>): Promise<boolean> => {
    try {
      const res = await fetch('/api/recycle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      return res.ok
    } catch {
      return false
    }
  }, [])

  const handleRestore = useCallback(async (name: string) => {
    setBusy(name)
    try {
      if (await post({ action: 'restore', name })) {
        setEntries(prev => (prev ?? []).filter(e => e.name !== name))
        router.refresh()
      }
    } finally {
      setBusy(null)
    }
  }, [post, router])

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
    <section data-recycle-panel className="shrink-0 border-t border-border/40 bg-card/40">
      {/* 面板头（与 Recent Imports 同一 chrome）：折叠开关 + 小字距标题 +
          计数角标 + 清空（两步确认） */}
      <div className="flex h-9 items-center gap-1 px-2">
        <button
          type="button"
          onClick={() => setCollapsed(v => !v)}
          aria-expanded={!collapsed}
          className="flex h-9 min-w-0 flex-1 items-center gap-2 px-2 text-left"
        >
          <ChevronDownIcon className={cn('size-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-200', collapsed && '-rotate-90')} />
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Recycle Bin</span>
          {entries !== null && (
            <span className="rounded-full bg-foreground/[0.06] px-1.5 py-px text-[10px] font-medium tabular-nums text-muted-foreground">{count}</span>
          )}
        </button>
        {hasEntries && (
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              'h-6 shrink-0 rounded-md px-2 text-[11px]',
              arm === '__empty__'
                ? 'bg-destructive/10 text-destructive'
                : 'text-muted-foreground hover:bg-destructive/10 hover:text-destructive',
            )}
            disabled={busy === '__empty__'}
            onClick={handleEmpty}
          >
            {busy === '__empty__' ? '清空中…' : arm === '__empty__' ? '确认清空' : '清空'}
          </Button>
        )}
      </div>
      {/* 折叠体：grid-rows 0fr→1fr 过渡（纯 CSS 无 JS 测高） */}
      <div className={cn('grid transition-[grid-template-rows] duration-200 ease-out', collapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]')}>
        <div className="overflow-hidden">
          <div className="max-h-44 overflow-y-auto border-t border-border/40">
            {entries === null && (
              <div className="space-y-2 p-3">
                <div className="h-9 animate-pulse rounded-lg bg-muted/30" />
                <div className="h-9 animate-pulse rounded-lg bg-muted/20" />
              </div>
            )}
            {entries !== null && !hasEntries && (
              <p className="px-4 py-6 text-center text-xs text-muted-foreground/60">回收站为空 —— 从 insight 删除的资产会先落入这里，可随时恢复</p>
            )}
            {entries?.map(e => (
              <div
                key={e.name}
                data-recycle-row
                data-recycle-name={e.name}
                className="group flex items-center gap-3 px-3 py-2.5 transition-colors duration-150 hover:bg-accent/40"
              >
                <AssetIcon id={modelIconId(e.model)} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-foreground">{e.query ?? e.taskId}</p>
                  <p className="truncate text-xs text-muted-foreground" title={`${e.taskId}${e.framework ? ` · ${e.framework}` : ''}`}>
                    {e.taskId}{e.framework ? ` · ${e.framework}` : ''} · {formatSize(e.size)} · 删除于 {formatDeletedAt(e.deletedAt)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    data-recycle-restore
                    className="h-6 rounded-md bg-emerald-500/[0.08] px-2 text-[11px] text-emerald-700 hover:bg-emerald-500/[0.14] hover:text-emerald-700 dark:text-emerald-300 dark:hover:text-emerald-300"
                    disabled={busy === e.name}
                    onClick={() => handleRestore(e.name)}
                  >
                    {busy === e.name ? <LoaderIcon className="size-3 animate-spin" /> : <RotateCcwIcon className="size-3" />}
                    恢复
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    data-recycle-purge
                    className={cn(
                      'h-6 rounded-md px-2 text-[11px]',
                      arm === e.name
                        ? 'bg-destructive/10 text-destructive'
                        : 'text-muted-foreground/70 hover:bg-destructive/10 hover:text-destructive',
                    )}
                    disabled={busy === e.name}
                    onClick={() => handlePurge(e.name)}
                    title="彻底删除（不可恢复）"
                  >
                    <Trash2Icon className="size-3" />
                    {arm === e.name ? '确认删除' : '彻底删除'}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
