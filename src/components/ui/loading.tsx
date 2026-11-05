// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { Loader2Icon } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * 加载态原语（全站统一契约，承总览 pending 脉冲的呼吸语言）。
 *
 * 任何异步取数界面在「数据在途」窗口必须呈现可见加载动效，禁止渲染半空
 * 内容等数据到位后突兀弹出。分两型按场景选用：
 * - BreathCards：有卡片形态的容器（轮次列表、目录侧栏、表格区）——呼吸
 *   占位卡错峰浮现（入场 stagger + 呼吸相位差波动）
 * - LoadState：面板/区块级取数（tab 内容、视图主体）——居中呼吸卡 + 文案
 *
 * 全部带 role="status"（屏幕阅读器播报加载中）；动效纯 CSS（opacity/
 * transform 呼吸，不触发布局），数据落位后由消费方的 animate-in fade-in
 * 平滑接管。reduced-motion 下降速不减义。
 */

export function Spinner({ className }: { className?: string }) {
  return <Loader2Icon aria-hidden className={cn("size-4 animate-spin text-muted-foreground/70", className)} />
}

/** 呼吸占位卡：错峰浮现入场（fill-mode-backwards 保住延迟期初始透明）+ 呼吸相位差 */
export function BreathCards({ count = 4, compact = false, className, cardClassName }: {
  count?: number
  compact?: boolean
  className?: string
  cardClassName?: string
}) {
  return (
    <div role="status" aria-live="polite" className={cn("space-y-2", className)}>
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className={cn("animate-in fade-in slide-in-from-bottom-1 duration-500 fill-mode-backwards", cardClassName)}
          style={{ animationDelay: `${i * 70}ms` }}
        >
          <div
            className={cn("load-breathe rounded-xl border border-border/40 bg-card/60 px-3", compact ? "py-2" : "py-2.5")}
            style={{ animationDelay: `${(i % 3) * 320}ms` }}
          >
            <div className="flex items-center gap-2.5">
              <div className="size-4.5 shrink-0 rounded-md bg-foreground/[0.07]" />
              <div className={cn("h-2.5 rounded-full bg-foreground/[0.07]", i % 3 === 0 ? "w-3/5" : i % 3 === 1 ? "w-4/5" : "w-2/5")} />
              {compact && <div className="ml-auto h-2.5 w-8 shrink-0 rounded-full bg-foreground/[0.07]" />}
            </div>
            {!compact && (
              <div className="mt-2 flex items-center gap-2.5">
                <div className="h-2.5 w-1/3 rounded-full bg-foreground/[0.07]" />
                <div className="h-2.5 w-10 rounded-full bg-foreground/[0.07]" />
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

export function LoadState({ label, className }: { label?: string; className?: string }) {
  return (
    <div role="status" aria-live="polite" className={cn("flex flex-col items-center justify-center gap-4 px-6 py-14", className)}>
      <div className="w-52 max-w-full animate-in fade-in slide-in-from-bottom-1 duration-500">
        <div className="load-breathe rounded-xl border border-border/40 bg-card/60 px-4 py-3">
          <div className="h-2.5 w-3/5 rounded-full bg-foreground/[0.07]" />
          <div className="mt-2 h-2.5 w-4/5 rounded-full bg-foreground/[0.07]" />
        </div>
      </div>
      {label && <p className="text-xs text-muted-foreground">{label}</p>}
    </div>
  )
}
