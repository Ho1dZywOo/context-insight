"use client"
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 会话时间线（Turn 播放器的胶片轨）：每轮一根圆顶柱，柱高 ∝ token（sqrt
// 标度让小轮也可见）、颜色 = 角色/归属；高危轮覆盖角色色（窗口>80% 红、
// 时延>15s 琥珀）。位置感只靠当前柱高亮：选中柱全亮、其余压暗，悬停时
// 临时提亮——不设独立播放头，柱即指示。柱宽有上限：少轮会话整组收窄
// 居中（行 maxWidth = 柱数 × 单柱宽，纯数学不依赖量测，SSR 即正确），不再
// 横向拉伸成宽胖块；多轮时上限大于容器自然满宽。
// 大会话（数千 turn）逐柱渲染会横向溢出——按容器实测宽度聚桶：超容量时
// 每 k 轮合并一根柱（高度 = 桶内最大 token、颜色 = 桶内最危险态、点击跳
// 桶首轮），高亮落在选中 turn 所属桶柱上。
import { memo, useLayoutEffect, useMemo, useRef, useState } from "react"
import { cn } from "@/lib/utils"

export interface FilmstripTurn {
  turnId: string
  turnIndex: number
  role: string
  isSubagent: boolean
  totalTokens: number
  latencyMs: number
  contextWindowPct?: number | null
}

function barColor(t: FilmstripTurn): string {
  if ((t.contextWindowPct ?? 0) > 80) return "bg-red-500"
  if (t.latencyMs > 15000) return "bg-amber-500"
  if (t.isSubagent) return "bg-orange-400"
  if (t.role === "user") return "bg-blue-400"
  if (t.role === "system") return "bg-slate-400"
  return "bg-emerald-500"
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

const BAR_MIN_PX = 2
const BAR_GAP_PX = 1
const BAR_MAX_PX = 14

// 逐柱 memo：props 全为原始值 + 稳定 ref 回调。切换 turn 只有新旧两根
// 柱的 selected 变化——数千 turn 的大会话走查保持 O(1) 重渲。onSelect 经
// ref 传递：父级回调身份变化不击穿柱级 memo。
const FilmstripBar = memo(function FilmstripBar({ turnId, turnIndex, heightPct, colorClass, selected, title, onSelectRef }: {
  turnId: string
  turnIndex: number
  heightPct: number
  colorClass: string
  selected: boolean
  title: string
  onSelectRef: { current: (turnId: string) => void }
}) {
  return (
    <span
      role="option"
      aria-selected={selected}
      data-testid={`filmstrip-turn-${turnIndex}`}
      title={title}
      className={cn(
        "flex-1 min-w-[1px] rounded-t-[3px] cursor-pointer transition-opacity duration-150",
        colorClass,
        selected ? "opacity-100" : "opacity-35 hover:opacity-80",
      )}
      style={{ height: `${heightPct}%` }}
      onClick={() => onSelectRef.current(turnId)}
    />
  )
})

export const TurnFilmstrip = memo(function TurnFilmstrip({ turns, selectedTurnId, onSelect }: {
  turns: FilmstripTurn[]
  selectedTurnId: string
  onSelect: (turnId: string) => void
}) {
  const n = turns.length
  const selIdx = turns.findIndex(t => t.turnId === selectedTurnId)
  // ref 承接回调：对象身份恒定，柱级 memo 不被父级新闭包击穿
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect

  // 容器实测宽度 → 柱容量；未测得（SSR/测试环境）用保守缺省，观察者即校准
  const wrapRef = useRef<HTMLDivElement>(null)
  const [capacity, setCapacity] = useState(240)
  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const update = () => {
      const w = el.clientWidth
      if (w > 0) setCapacity(Math.max(8, Math.floor((w + BAR_GAP_PX) / (BAR_MIN_PX + BAR_GAP_PX))))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 超容量聚桶：每 bucketSize 轮一根柱；桶内峰值定高、最危险态定色
  const bucketSize = n > capacity ? Math.ceil(n / capacity) : 1
  const bars = useMemo(() => {
    const maxTokens = Math.max(...turns.map(t => t.totalTokens), 1)
    const out: Array<{ turnId: string; turnIndex: number; heightPct: number; colorClass: string; title: string }> = []
    for (let i = 0; i < n; i += bucketSize) {
      const grp = turns.slice(i, i + bucketSize)
      const peak = grp.reduce((m, t) => (t.totalTokens > m.totalTokens ? t : m), grp[0])
      const heightPct = 15 + Math.sqrt(peak.totalTokens / maxTokens) * 85
      let colorClass: string
      let title: string
      if (bucketSize === 1) {
        colorClass = barColor(peak)
        title = `#${peak.turnIndex} ${peak.role}${peak.isSubagent ? " · subagent" : ""} · ${peak.totalTokens} tokens · ${fmtMs(peak.latencyMs)}${(peak.contextWindowPct ?? 0) > 80 ? " · ⚠ 窗口>80%" : ""}`
      } else {
        const danger = grp.some(t => (t.contextWindowPct ?? 0) > 80)
          ? "bg-red-500"
          : grp.some(t => t.latencyMs > 15000) ? "bg-amber-500" : barColor(peak)
        colorClass = danger
        const first = grp[0], last = grp[grp.length - 1]
        title = `#${first.turnIndex}–#${last.turnIndex} · ${grp.length} turns 合并 · peak #${peak.turnIndex} ${peak.totalTokens} tokens · max ${fmtMs(Math.max(...grp.map(t => t.latencyMs)))}${grp.some(t => (t.contextWindowPct ?? 0) > 80) ? " · ⚠ 窗口>80%" : ""}`
      }
      out.push({ turnId: grp[0].turnId, turnIndex: grp[0].turnIndex, heightPct, colorClass, title })
    }
    return out
  }, [turns, bucketSize, n])

  // 行宽上限 = 柱数 × 单柱宽（含间隙）：少轮收窄居中，多轮自然满宽
  const rowMaxPx = bars.length * (BAR_MAX_PX + BAR_GAP_PX) - BAR_GAP_PX

  return (
    <div className="px-2" ref={wrapRef}>
      <div
        className="mx-auto flex h-9 w-full items-end gap-px overflow-hidden"
        style={{ maxWidth: `${rowMaxPx}px` }}
      >
        {bars.map((b, i) => (
          <FilmstripBar
            key={b.turnId}
            turnId={b.turnId}
            turnIndex={b.turnIndex}
            heightPct={b.heightPct}
            colorClass={b.colorClass}
            selected={selIdx >= i * bucketSize && selIdx < (i + 1) * bucketSize}
            title={b.title}
            onSelectRef={onSelectRef}
          />
        ))}
      </div>
    </div>
  )
})
