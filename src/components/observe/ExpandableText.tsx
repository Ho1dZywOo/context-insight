"use client"
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 长内容夹断展示：详情页的可读性来自「一条页面滚动条」——嵌套滚动容器
// （每块内容各自 max-h + overflow-auto）会制造滚动条森林。统一改为
// 「max-height 夹断 + 底部 mask 渐隐 + 展开钮」：折叠态只露一屏内容、
// 底缘渐隐提示还有下文；展开后全文随页面流式布局，页面滚动统管一切。
// mask 渐隐跨任意背景生效（不透明渐变覆盖层会与卡片底色错位）。
// 内容是否超限双通道判定：真实测量（scrollHeight，浏览器）+ 字符量
// 启发（纯文本子节点，测试环境 happy-dom 不布局也能判）。
import { useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { cn } from "@/lib/utils"

export function ExpandableText({ children, clampPx = 260, className }: {
  children?: ReactNode
  clampPx?: number
  className?: string
}) {
  const [expanded, setExpanded] = useState(false)
  const [measuredOverflow, setMeasuredOverflow] = useState(false)
  const innerRef = useRef<HTMLDivElement>(null)

  // 纯文本长内容走字符量启发（渲染期推导，测试环境无布局也能判）
  const heuristicOverflow = typeof children === "string" && children.length > 700
  // 结构化内容（markdown/列表）只能实测：rAF 内 setState 避免级联渲染
  useLayoutEffect(() => {
    if (expanded) return
    const el = innerRef.current
    if (!el) return
    const id = requestAnimationFrame(() => setMeasuredOverflow(el.scrollHeight > clampPx + 4))
    return () => cancelAnimationFrame(id)
  }, [children, clampPx, expanded])

  const overflows = heuristicOverflow || measuredOverflow
  // 夹断常驻（防溢出内容撑开布局），渐隐只在真超限时出现——短内容若也
  // 渐隐，一行文字会被无端糊掉底缘（用户现场反馈）
  const clamped = !expanded
  const faded = !expanded && overflows

  return (
    <div style={expanded ? { contentVisibility: "auto", containIntrinsicSize: `auto ${clampPx}px` } : undefined}>
      <div
        ref={innerRef}
        className={cn(
          clamped && "overflow-hidden",
          faded && "[mask-image:linear-gradient(to_bottom,black_calc(100%-22px),transparent)]",
          className,
        )}
        style={clamped ? { maxHeight: clampPx } : undefined}
      >
        {children}
      </div>
      {overflows && (
        <div className="flex justify-center py-1">
          <span
            role="button"
            tabIndex={0}
            onClick={() => setExpanded(!expanded)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setExpanded(!expanded) }}
            className="inline-flex items-center gap-1 rounded-full border border-border/70 px-2.5 py-0.5 text-xs text-muted-foreground hover:border-foreground/25 hover:text-foreground cursor-pointer select-none transition-colors"
          >
            {expanded ? "收起 ▴" : "⋯ 展开全文 ▾"}
          </span>
        </div>
      )}
    </div>
  )
}
