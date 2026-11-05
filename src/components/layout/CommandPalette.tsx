// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 命令面板（⌘K / Ctrl+K）：全站资产直达——会话/Run 混排即时搜索，↑↓ 导航、
// ↵ 打开、Esc 关闭。复用列表取数管线（/api/observe/data，q 同语义），零新
// 后端；图标与资产表同一 AssetIcon/modelIconId 单点。触发位在工具栏（伪装
// 搜索框形态），闭合态零成本。

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { SearchIcon, LoaderIcon, CornerDownLeftIcon } from 'lucide-react'
import { AssetIcon, modelIconId } from '@/components/collection/AssetIcon'
import type { AssetItem } from '@/lib/collection/types'
import { cn } from '@/lib/utils'
import { HEADER_PILL } from '@/components/layout/header-actions'

export function CommandPalette() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<AssetItem[]>([])
  const [loading, setLoading] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const seq = useRef(0)

  // 呼出：清场（事件处重置，effect 内不做同步 setState）
  const openPalette = useCallback(() => {
    setOpen(true)
    setQuery('')
    setActiveIndex(0)
  }, [])

  // ⌘K / Ctrl+K 全局开关（输入态也生效——任意处呼出是命令面板的本职）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        if (!open) openPalette()
        else setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, openPalette])

  // 开面板：聚焦输入（rAF 避开同帧渲染竞态）
  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  // 防抖取数：空查询 = 资产首页（天然「最近」）；seq 竞态闸与列表同款
  useEffect(() => {
    if (!open) return
    const t = setTimeout(async () => {
      const s = ++seq.current
      setLoading(true)
      try {
        const params = new URLSearchParams({ page: '1', pageSize: '8' })
        if (query.trim()) params.set('q', query.trim())
        const res = await fetch(`/api/observe/data?${params}`)
        const data = await res.json()
        if (s !== seq.current || !res.ok) return
        setResults((data.items ?? []) as AssetItem[])
        setActiveIndex(0)
      } catch {
        if (s === seq.current) setResults([])
      } finally {
        if (s === seq.current) setLoading(false)
      }
    }, 200)
    return () => clearTimeout(t)
  }, [open, query])

  const go = useCallback((item: AssetItem) => {
    setOpen(false)
    router.push(item.kind === 'run'
      ? `/run/${encodeURIComponent(item.runId)}`
      : `/run/solo:${encodeURIComponent(item.taskId)}`)
  }, [router])

  // 闭合态：工具栏触发位（伪装搜索框——Linear/GitHub 式 quiet affordance）
  if (!open) {
    return (
      <button
        type="button"
        onClick={openPalette}
        className={`${HEADER_PILL} w-44 justify-start gap-2 border border-foreground/[0.08] bg-muted/30 text-muted-foreground hover:bg-muted/50`}
      >
        <SearchIcon className="size-4 text-muted-foreground/70" />
        <span className="text-xs">Search</span>
        <kbd className="ml-auto rounded-md border border-border/60 bg-background/60 px-1.5 py-px text-[10px] font-medium text-muted-foreground/70">⌘K</kbd>
      </button>
    )
  }

  return (
    <div className="fixed inset-0 z-50 animate-in fade-in duration-150" role="dialog" aria-label="命令面板">
      <button type="button" aria-label="关闭" className="absolute inset-0 cursor-default bg-black/40 backdrop-blur-[2px]" onClick={() => setOpen(false)} />
      <div className="absolute left-1/2 top-[12vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 animate-in fade-in zoom-in-95 slide-in-from-top-1 duration-150 overflow-hidden rounded-2xl border border-border/60 bg-card/90 shadow-[0_4px_16px_rgba(0,0,0,0.12),0_32px_64px_-16px_rgba(0,0,0,0.4)] backdrop-blur-2xl backdrop-saturate-150">
        {/* 输入行 */}
        <div className="flex h-12 items-center gap-2.5 border-b border-border/50 px-4">
          <SearchIcon className="size-4 shrink-0 text-muted-foreground/70" />
          <input
            data-command-input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex(i => Math.min(i + 1, results.length - 1)) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex(i => Math.max(i - 1, 0)) }
              else if (e.key === 'Enter') { e.preventDefault(); if (results[activeIndex]) go(results[activeIndex]) }
              else if (e.key === 'Escape') { e.preventDefault(); setOpen(false) }
            }}
            placeholder="搜索会话 / Run / 关键字…"
            className="h-full w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/50"
          />
          {loading && <LoaderIcon className="size-4 shrink-0 animate-spin text-muted-foreground/60" />}
          <kbd className="shrink-0 rounded-md border border-border/60 bg-muted/50 px-1.5 py-px text-[10px] font-medium text-muted-foreground/60">esc</kbd>
        </div>
        {/* 结果列表：图标/跳转语义与资产表完全同源 */}
        <div className="max-h-80 overflow-y-auto p-2">
          {results.length === 0 && !loading && (
            <p className="py-10 text-center text-xs text-muted-foreground/60">无匹配资产</p>
          )}
          {results.map((item, i) => (
            <button
              type="button"
              key={item.key}
              data-command-item={item.kind}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => go(item)}
              className={cn(
                'flex h-11 w-full items-center gap-3 rounded-lg px-2.5 text-left transition-colors duration-100',
                i === activeIndex ? 'bg-foreground/[0.06]' : 'hover:bg-foreground/[0.04]',
              )}
            >
              <AssetIcon id={item.kind === 'run' ? 'run' : modelIconId(item.model)} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-foreground">
                  {item.kind === 'run' ? (item.name ?? item.runId) : (item.query ?? item.taskId)}
                </span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {item.kind === 'run' ? item.runId : `${item.model ?? item.framework ?? '—'} · ${item.taskId}`}
                </span>
              </span>
              <span className="shrink-0 rounded-full bg-foreground/[0.04] px-1.5 py-px text-[10px] text-muted-foreground">{item.kind === 'run' ? 'Run' : 'Session'}</span>
              {i === activeIndex && <CornerDownLeftIcon className="size-3.5 shrink-0 text-muted-foreground/50" />}
            </button>
          ))}
        </div>
        {/* 快捷键脚注 */}
        <div className="flex items-center gap-4 border-t border-border/50 px-4 py-2 text-[10px] text-muted-foreground/60">
          <span>↑↓ 导航</span>
          <span>↵ 打开</span>
          <span>esc 关闭</span>
        </div>
      </div>
    </div>
  )
}
