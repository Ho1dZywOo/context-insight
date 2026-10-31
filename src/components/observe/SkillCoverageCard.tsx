"use client"
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { Card, CardContent } from "@/components/ui/card"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useMemo } from "react"
import type { ReactNode } from "react"
import {
  LayoutGridIcon,
  CheckCircle2Icon,
  ArrowDownCircleIcon,
  SparklesIcon,
  CircleDashedIcon,
  HelpCircleIcon,
  Loader2Icon,
  AlertCircleIcon,
} from "lucide-react"
import { useSkillCoverage } from "@/components/observe/use-skill-coverage"
import type { CoverageItem, CoverageStats } from "@/lib/skill-coverage"
import type { ViewUrlFor } from "@/lib/observe/member-url"

interface SkillCoverageCardProps {
  taskId: string
  framework?: string
  urlFor?: ViewUrlFor
  /** 头部右侧插槽（run 页传成员选择器；session 语义缺省不渲染） */
  toolbar?: ReactNode
  /** 口径拆分：all=技能+子代理混排（导出查看器旧观）；skills=仅技能；agents=仅派发子代理 */
  scope?: "all" | "skills" | "agents"
  /** 根卡类（run 页同排双列传 h-full 与时间线等高对齐） */
  className?: string
}

const STATUS_META = {
  invoked: {
    icon: CheckCircle2Icon,
    label: "已调用",
    ring: "#10b981",
    chip: "border-emerald-400/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  loaded: {
    icon: ArrowDownCircleIcon,
    label: "仅加载",
    ring: "#3b82f6",
    chip: "border-blue-400/50 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  },
  dispatched: {
    icon: SparklesIcon,
    label: "子代理",
    ring: "#8b5cf6",
    chip: "border-purple-400/50 bg-purple-500/10 text-purple-700 dark:text-purple-300",
  },
  unused: {
    icon: CircleDashedIcon,
    label: "未使用",
    ring: "#94a3b8",
    chip: "border-slate-300/60 bg-slate-500/5 text-slate-500 dark:text-slate-400",
  },
  extra: {
    icon: HelpCircleIcon,
    label: "全集外",
    ring: "#f97316",
    chip: "border-orange-400/50 bg-orange-500/10 text-orange-700 dark:text-orange-300",
  },
} as const

function coverageRing(stats: CoverageStats) {
  const size = 104
  const stroke = 10
  const r = (size - stroke) / 2
  const c = size / 2
  const circ = 2 * Math.PI * r
  // 环分母 = 四态条目之和（dispatched 含全集外动态子代理）。availableTotal
  // 只含全集内 skill，动态子代理数超过全集时用它当分母会溢出整圈。
  const total = stats.total
  const segments = total > 0
    ? [
        { n: stats.unused, color: "#e2e8f0" },
        { n: stats.invoked, color: STATUS_META.invoked.ring },
        { n: stats.loaded, color: STATUS_META.loaded.ring },
        { n: stats.dispatched, color: STATUS_META.dispatched.ring },
      ].filter(s => s.n > 0)
    : []
  let offset = 0
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
      <circle cx={c} cy={c} r={r} fill="none" stroke="#e2e8f0" strokeWidth={stroke} className="dark:opacity-25" />
      {segments.map((seg, i) => {
        if (seg.n <= 0) return null
        const len = (seg.n / total) * circ
        const el = (
          <circle
            key={i}
            cx={c}
            cy={c}
            r={r}
            fill="none"
            stroke={seg.color}
            strokeWidth={stroke}
            strokeDasharray={`${Math.max(len - 2, 0.1)} ${circ}`}
            strokeDashoffset={-offset}
            strokeLinecap="round"
            transform={`rotate(-90 ${c} ${c})`}
          />
        )
        offset += len
        return el
      })}
      <text x={c} y={c - 3} textAnchor="middle" className="fill-foreground text-[17px] font-semibold tabular-nums">
        {stats.unused}
      </text>
      <text x={c} y={c + 14} textAnchor="middle" className="fill-muted-foreground text-[10px]">
        / {total} 未使用
      </text>
    </svg>
  )
}

function chipTooltipBody(item: CoverageItem): string {
  const parts: string[] = [STATUS_META[item.status].label]
  if (item.invokeCount > 0) parts.push(`调用 ${item.invokeCount} 次`)
  if (item.loadCount > 0) parts.push(`加载 ${item.loadCount} 次`)
  if (item.dispatchCount > 0) parts.push(`派发 ${item.dispatchCount} 次`)
  if (item.description) parts.push(`\n${item.description}`)
  if (item.origin) parts.push(`\n来源: ${item.origin}`)
  return parts.join(" · ")
}

export function SkillCoverageCard({ taskId, framework, urlFor, toolbar, scope = "all", className }: SkillCoverageCardProps) {
  const { data, loading, error } = useSkillCoverage(taskId, framework, urlFor)

  // 口径拆分投影：skills 维剔除子代理（dispatched），agents 维只留子代理，
  // all 保持混排（导出查看器旧观）。环与图例的计数随拆分重算——同源同口径
  const scoped = useMemo(() => {
    if (!data) return null
    // 载荷可能缺省 items/stats（旧 mock / 异形响应）——防御缺省，不在这里炸
    const all = data.items ?? []
    const base = data.stats ?? { availableTotal: 0, invoked: 0, loaded: 0, dispatched: 0, unused: 0, extra: 0, total: 0 }
    if (scope === "all") return { items: all, stats: base }
    const items = all.filter(i => (scope === "agents") === (i.status === "dispatched"))
    const count = (s: CoverageItem["status"]) => items.filter(i => i.status === s).length
    const invoked = count("invoked")
    const loaded = count("loaded")
    const dispatched = count("dispatched")
    const unused = count("unused")
    const extra = count("extra")
    return {
      items,
      stats: { ...base, invoked, loaded, dispatched, unused, extra, total: invoked + loaded + dispatched + unused },
    }
  }, [data, scope])

  if (loading) {
    return (
      <Card size="sm" className={className}>
        <CardContent className="flex flex-1 items-center gap-2 py-3 text-xs text-muted-foreground">
          <Loader2Icon className="size-3.5 animate-spin" />
          正在统计 Skill 覆盖度…
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card size="sm" className={className}>
        <CardContent className="flex flex-1 items-center gap-2 py-3 text-xs text-destructive">
          <AlertCircleIcon className="size-3.5" />
          覆盖度获取失败：{error}
        </CardContent>
      </Card>
    )
  }

  if (!data) return null

  // 数据源降级（如 opencode 原生会话系统提示不落盘）：明示原因而非静默消失
  if (!data.hasAvailableList) {
    if (!data.degradedReason) return null
    return (
      <Card size="sm" className={className}>
        <CardContent className="flex flex-1 items-center gap-2 py-3 text-xs text-muted-foreground">
          <LayoutGridIcon className="size-3.5 shrink-0" />
          <span>覆盖度不可用：{data.degradedReason}</span>
          {toolbar}
        </CardContent>
      </Card>
    )
  }

  if (!scoped || scoped.items.length === 0) {
    // 拆分口径下空集保持布局稳定（同排双列不留空位）；all 维持旧观不渲染
    if (scope === "all") return null
    return (
      <Card size="sm" className={className}>
        <CardContent className="flex flex-1 items-center gap-2 py-3 text-xs text-muted-foreground">
          <LayoutGridIcon className="size-3.5 shrink-0" />
          <span>{scope === "skills" ? "该会话无 skill 声明与使用记录" : "该会话无派发事件记录"}</span>
          {toolbar}
        </CardContent>
      </Card>
    )
  }
  const { items, stats } = scoped

  const dispatchCalls = items.reduce((s, i) => s + i.dispatchCount, 0)

  return (
    <Card size="sm" className={className}>
      <CardContent className="flex flex-1 flex-col justify-center gap-3 py-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold">
            <LayoutGridIcon className="size-3.5" />
            {scope === "agents" ? "Agent 覆盖度" : "Skill 覆盖度"}
          </span>
          <span className="text-xs text-muted-foreground">
            {scope === "agents"
              ? "按成员会话派发事件清点子代理（agent 不在 skills 注入段，无声明全集可对照）"
              : scope === "skills"
                ? `会话注入的 ${stats.availableTotal} 个可用 skills 中哪些始终未使用（灰）—— 已使用的按 调用 / 仅加载 区分`
                : `会话注入的 ${stats.availableTotal} 个可用 skills 中哪些始终未使用（灰）—— 已使用的按 调用 / 仅加载 / 子代理派发 区分`}
          </span>
          {toolbar}
        </div>

        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="flex items-center gap-3 shrink-0">
            {scope === "agents" ? (
              // 无声明全集可对照——环退化为单值读数（子代理计数），不伪造分母
              <div className="flex size-[104px] flex-col items-center justify-center rounded-full border-[10px] border-[#8b5cf6]/25">
                <span className="text-[17px] font-semibold tabular-nums">{stats.dispatched}</span>
                <span className="text-[10px] text-muted-foreground">子代理</span>
              </div>
            ) : (
              coverageRing(stats)
            )}
            <div className="flex flex-col gap-1 text-[11px]">
              {scope === "agents" ? (
                <>
                  <span className="inline-flex items-center gap-1.5 tabular-nums">
                    <span className="size-2 rounded-full shrink-0" style={{ background: STATUS_META.dispatched.ring }} />
                    <span className="text-muted-foreground">已派发</span>
                    <span className="font-semibold">{stats.dispatched}</span>
                  </span>
                  <span className="inline-flex items-center gap-1.5 pl-3.5 tabular-nums">
                    <span className="text-muted-foreground">累计派发</span>
                    <span>{dispatchCalls} 次</span>
                  </span>
                </>
              ) : (
                (["unused", "invoked", "loaded", "dispatched", "extra"] as const)
                  .filter(k => (k === "extra" ? stats.extra > 0 : stats[k] > 0 || k === "unused"))
                  .map(k => {
                    const meta = STATUS_META[k]
                    return (
                      <span key={k} className={cn("inline-flex items-center gap-1.5 tabular-nums", k === "unused" && "font-semibold")}>
                        <span className="size-2 rounded-full shrink-0" style={{ background: meta.ring }} />
                        <span className="text-muted-foreground">{meta.label}</span>
                        <span className={cn(k === "unused" && "text-foreground")}>{stats[k]}</span>
                      </span>
                    )
                  })
              )}
            </div>
          </div>

          <div className="flex flex-wrap gap-1.5 content-center flex-1 min-w-[18rem] lg:border-l lg:border-border/60 lg:pl-4">
            {items.map(item => {
              const meta = STATUS_META[item.status]
              const Icon = meta.icon
              return (
                <Tooltip key={`${item.status}-${item.name}`}>
                  <TooltipTrigger
                    render={
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-medium max-w-[18rem] cursor-default",
                          meta.chip,
                          item.status === "unused" && "opacity-65"
                        )}
                      >
                        <Icon className="size-3 shrink-0" />
                        <span className="truncate">{item.name}</span>
                        {(() => {
                          // 次数 = 调用+加载+派发（子代理多次派发同样体现 ×N）
                          const n = item.invokeCount + item.loadCount + item.dispatchCount
                          return n > 1 ? (
                            <span className="tabular-nums opacity-70">×{n}</span>
                          ) : null
                        })()}
                      </span>
                    }
                    delay={0}
                    closeDelay={0}
                  />
                  <TooltipContent side="top" className="max-w-[24rem] whitespace-pre-wrap">
                    <span className="font-semibold">{item.name}</span>
                    {"\n"}
                    {chipTooltipBody(item)}
                  </TooltipContent>
                </Tooltip>
              )
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
