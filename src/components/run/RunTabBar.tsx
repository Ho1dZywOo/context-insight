"use client"
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OR ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Run 详情页导航（凹槽分段控件）：
// ①凹槽轨道（rounded-full 浅灰轨道）内横排药丸，居中收束（w-fit：宽屏
//   居中成"主控台"，窄屏自动占满整行、溢出走滚动 + mask 边缘渐隐提示）；
// ②活跃指示器 = 浮起卡舌（bg-card + 发丝环 + 分层投影，与 Audit 域导航、
//   成员轨道同一语法），纯 transform/width 过渡（弹簧曲线）滑向活跃项——
//   定位经 useLayoutEffect 量测、直接写 style，零重渲染、不闪初始态；
// ③活跃 tab 自动滚入视野（手动 scrollLeft 计算，不影响页面滚动）；
// ④图标彩色常驻：非活跃压暗（opacity-55），激活时点亮——卡舌滑入 +
//   色彩点亮的双重激活反馈；
// ⑤面板淡入切换由页面侧容器类承担（display 翻转即重放 CSS 动画）。
// 契约保持：tab 按钮为普通 button（无 ARIA tab 角色——工作台既有约定，
// IT 锁定）；wire/replay 高级门逻辑原样迁移（?a / NEXT_PUBLIC_SHOW_...）。
import { useCallback, useEffect, useLayoutEffect, useRef } from "react"
import type { ComponentType, ReactNode } from "react"
import {
  LayoutDashboardIcon, GitBranchIcon, MessageSquareIcon, BarChart3Icon,
  ShieldCheckIcon, GaugeIcon, SparklesIcon, FileSearchIcon, FileTextIcon, PlayIcon, AwardIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import type { RunTabKey } from "@/app/run/[runId]/run-view"

/** tab 渲染表（icon 组件 + 色调分离：图标彩色常驻，非活跃压暗） */
export interface RunTabDef {
  key: RunTabKey
  label: string
  icon: ComponentType<{ className?: string }>
  /** 图标色调（非活跃压暗至 opacity-55，激活点亮全彩） */
  tone: string
}

export const RUN_TABS: readonly RunTabDef[] = [
  { key: "overview", label: "Overview", icon: LayoutDashboardIcon, tone: "text-blue-500" },
  { key: "graph", label: "Graph", icon: GitBranchIcon, tone: "text-emerald-500" },
  { key: "turns", label: "Turns", icon: MessageSquareIcon, tone: "text-violet-500" },
  { key: "context", label: "Context", icon: BarChart3Icon, tone: "text-pink-500" },
  { key: "audit", label: "Audit", icon: ShieldCheckIcon, tone: "text-emerald-500" },
  { key: "perf", label: "Perf", icon: GaugeIcon, tone: "text-amber-500" },
  { key: "skills", label: "Skills", icon: SparklesIcon, tone: "text-orange-500" },
  { key: "files", label: "Files", icon: FileSearchIcon, tone: "text-teal-500" },
  { key: "wire", label: "Wire 轮次", icon: FileTextIcon, tone: "text-sky-500" },
  { key: "replay", label: "Replay", icon: PlayIcon, tone: "text-pink-500" },
  { key: "score", label: "Score", icon: AwardIcon, tone: "text-violet-500" },
]

/** 默认隐藏的 tab（wire/replay 属调试/重放视图）：URL 带 ?a 或
 *  NEXT_PUBLIC_SHOW_ADVANCED_TABS 时展示（session 页同款门） */
export const HIDDEN_RUN_TABS_DEFAULT: readonly RunTabKey[] = ["wire", "replay"]
export const RUN_TABS_DEFAULT_VISIBLE: readonly RunTabDef[] = RUN_TABS.filter(t => !HIDDEN_RUN_TABS_DEFAULT.includes(t.key))

/** 活跃指示器过渡曲线：快出缓收，无回弹过冲 */
const INDICATOR_TRANSITION = "transition-[transform,width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]"

export function RunTabBar({ tabs, active, onSelect, className }: {
  tabs: readonly RunTabDef[]
  active: RunTabKey
  onSelect: (key: RunTabKey) => void
  className?: string
}): ReactNode {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const indicatorRef = useRef<HTMLDivElement | null>(null)
  const buttonsRef = useRef(new Map<string, HTMLButtonElement>())

  // 量测 + 定位（指示器/可达性滚动/边缘渐隐全部直接写 style——测量类
  // 效果零重渲染，也不触发 setState-in-effect 级联）
  const reposition = useCallback(() => {
    const scroller = scrollerRef.current
    const btn = buttonsRef.current.get(active)
    const ind = indicatorRef.current
    if (scroller && btn && ind) {
      ind.style.width = `${btn.offsetWidth}px`
      ind.style.transform = `translateX(${btn.offsetLeft}px)`
      // 活跃 tab 可达性：溢出时滚入视野（手动 scrollLeft 数学；block 维度
      // 不碰——页面各 tab 自滚动，scrollIntoView 可能惊动外层）
      const sl = scroller.scrollLeft
      const l = btn.offsetLeft
      const r = l + btn.offsetWidth
      if (l < sl + 8) scroller.scrollTo?.({ left: Math.max(0, l - 8), behavior: "smooth" })
      else if (r > sl + scroller.clientWidth - 8) scroller.scrollTo?.({ left: r - scroller.clientWidth + 8, behavior: "smooth" })
    }
    // 可滚动方向的边缘渐隐：按 scrollLeft 现算 mask（对凹槽轨道的半透明
    // 底色也成立——渐变 fade div 会在轨道上留下实体色断层）
    if (scroller) {
      const left = scroller.scrollLeft > 4
      const right = scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 4
      const mask = left || right
        ? `linear-gradient(to right, ${left ? "transparent" : "#000"} 0, #000 24px, #000 calc(100% - 24px), ${right ? "transparent" : "#000"} 100%)`
        : "none"
      scroller.style.webkitMaskImage = mask
      scroller.style.maskImage = mask
    }
  }, [active])

  useLayoutEffect(reposition, [reposition, tabs])

  // 滚动 / 尺寸变化 → 重定位（rAF 节流，被动监听）
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    let raf = 0
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(reposition) }
    scroller.addEventListener("scroll", onScroll, { passive: true })
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(onScroll) : null
    ro?.observe(scroller)
    return () => {
      scroller.removeEventListener("scroll", onScroll)
      ro?.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [reposition])

  return (
    <div className={cn("relative", className)} data-run-tabbar>
      {/* 凹槽轨道 = 滚动容器本体：w-fit 宽屏居中收束（主控台位）、窄屏
          自动占满整行走横滚；mask 边缘渐隐挂在轨道上（半透明底色也成立） */}
      <div
        ref={scrollerRef}
        className="relative mx-auto flex w-fit max-w-full items-center gap-0.5 overflow-x-auto overscroll-x-contain rounded-full bg-foreground/[0.04] p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden dark:bg-foreground/[0.07]"
      >
        {/* 活跃指示器（浮起卡舌）：随活跃药丸滑动（transform/width 过渡，圆角不变形） */}
        <div
          ref={indicatorRef}
          aria-hidden
          className={cn(
            "absolute inset-y-1 left-0 w-0 rounded-full bg-card ring-1 ring-foreground/[0.06] shadow-[0_1px_2px_rgba(0,0,0,0.06),0_6px_16px_-8px_rgba(0,0,0,0.22)]",
            INDICATOR_TRANSITION,
          )}
        />
        {tabs.map(tab => {
          const isActive = tab.key === active
          const Icon = tab.icon
          return (
            <button
              key={tab.key}
              type="button"
              ref={el => { if (el) buttonsRef.current.set(tab.key, el); else buttonsRef.current.delete(tab.key) }}
              onClick={() => { if (tab.key !== active) onSelect(tab.key) }}
              className={cn(
                "relative z-10 flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition-colors duration-200",
                isActive ? "text-foreground" : "text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground",
              )}
            >
              <Icon className={cn("size-3.5 shrink-0 transition-opacity duration-200", tab.tone, isActive ? "opacity-100" : "opacity-55")} />
              <span className="whitespace-nowrap">{tab.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
