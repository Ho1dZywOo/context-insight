// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 工具输出截断提示（单一视觉源，两个尺度）：
//   OutputTruncationChip —— 调用级：工具行上的行内标记，悬停看这一次被截的规模；
//   OutputTruncationNote —— 事件级：Skills 逐次调用行下方的说明行，直接写出
//     这一次读取的输出被截、agent 未看到全文。
// 文案一律带「工具输出」四字：与模型输出截断（红）一眼可分。只陈述事实（谁截
// 的、截了多少、agent 没看到全文），不给处置建议。色调取琥珀（与错误红、模型
// 输出截断红区分：截断是数据完整性信号，不是失败）。动效只走 CSS：入场淡入 +
// 轻微回弹缩放（GPU 合成，无布局），并在系统开启「减弱动态效果」时退化为静态出现。

import { ScissorsIcon } from "lucide-react"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { describeToolOutputTruncation, type ToolOutputTruncation } from "@/lib/tool-output-truncation"

const TONE = "bg-amber-500/10 text-amber-700 ring-1 ring-inset ring-amber-500/25 dark:bg-amber-500/15 dark:text-amber-400 dark:ring-amber-400/25"
const ENTER = "motion-safe:animate-in fade-in zoom-in-90 duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] fill-mode-backwards"

/** 这一次调用的事实句：被截的规模 + agent 未看到全文 */
function truncationFact(t: ToolOutputTruncation): string {
  return `${describeToolOutputTruncation(t)}，agent 未看到全文。`
}

interface ChipProps {
  truncation: ToolOutputTruncation
}

export function OutputTruncationChip({ truncation }: ChipProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            data-slot="output-truncation-chip"
            className={cn("inline-flex shrink-0 cursor-default items-center gap-1 rounded-full px-1.5 text-[11px] font-medium leading-[18px]", TONE, ENTER)}
          />
        }
      >
        <ScissorsIcon className="size-3 shrink-0" aria-hidden="true" />
        工具输出截断
      </TooltipTrigger>
      <TooltipContent side="top">{truncationFact(truncation)}</TooltipContent>
    </Tooltip>
  )
}

interface NoteProps {
  truncation: ToolOutputTruncation
  className?: string
}

export function OutputTruncationNote({ truncation, className }: NoteProps) {
  return (
    <p
      data-slot="output-truncation-note"
      className={cn("flex items-start gap-1 text-[11px] leading-5 text-amber-700 dark:text-amber-400", ENTER, className)}
    >
      <ScissorsIcon className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
      <span>{truncationFact(truncation)}</span>
    </p>
  )
}

/** 结果正文里的截断痕迹（横幅 / 中缝丢弃标记）：琥珀底色衬出，与正文区分 */
export function OutputSeam({ children }: { children: React.ReactNode }) {
  return (
    <span
      data-slot="output-seam"
      className="rounded-sm bg-amber-500/15 text-amber-700 outline-1 -outline-offset-1 outline-amber-500/20 dark:bg-amber-500/20 dark:text-amber-400"
    >
      {children}
    </span>
  )
}
