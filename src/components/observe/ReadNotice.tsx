// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 读取事实提示（单一视觉源）：行内标记（FactChip）+ 说明行（FactNote）两个基元，
// 按色调承载两类事实，判定与文案一律来自 lib（展示层不持词表副本）：
//   琥珀 amber   —— 工具输出截断：运行环境砍了输出，agent 未看到全文。
//   中性 neutral —— 部分读取：命令自带行范围（sed -n / head / offset+limit），
//                  agent 有意只读了一段。输出没有丢，不是数据完整性问题，所以
//                  不用琥珀、更不用红。
// SkillReadChip / SkillReadNote 两个展示面共用：Skills 逐次调用行（一个技能事件）
// 是标记 + 说明行，悬停给输出规模；turn 详情 Tool Calls 的工具行（一次工具调用）
// 只有标记，悬停直接给结论——能定行号写 agent 实际读到的行，否则写输出规模。
// 截断类文案一律带「工具输出」四字：与模型输出截断（红）一眼可分。只陈述事实
// （谁截的、截了多少、读到了哪），不给处置建议。动效只走 CSS：入场淡入 + 轻微
// 回弹缩放（GPU 合成，无布局），系统开启「减弱动态效果」时退化为静态出现。

import type { ReactNode } from "react"
import { Rows3Icon, ScissorsIcon } from "lucide-react"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import {
  toolOutputTruncationFact,
  type ToolOutputTruncation,
} from "@/lib/tool-output-truncation"
import type { SkillReadMark as SkillReadMarkKind } from "@/lib/skill-content"

export type FactTone = "amber" | "neutral"

const TONE_CHIP: Record<FactTone, string> = {
  amber: "bg-amber-500/10 text-amber-700 ring-1 ring-inset ring-amber-500/25 dark:bg-amber-500/15 dark:text-amber-400 dark:ring-amber-400/25",
  neutral: "bg-foreground/[0.05] text-muted-foreground ring-1 ring-inset ring-foreground/15 dark:bg-foreground/[0.08] dark:ring-foreground/20",
}
const TONE_NOTE: Record<FactTone, string> = {
  amber: "text-amber-700 dark:text-amber-400",
  neutral: "text-muted-foreground",
}
const ENTER = "motion-safe:animate-in fade-in zoom-in-90 duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] fill-mode-backwards"

interface ChipProps {
  tone: FactTone
  icon: ReactNode
  /** 悬停补充事实（可与行内文案不同尺度，如工具输出的截断规模） */
  tooltip: string
  children: ReactNode
}

/** 行内事实标记 */
export function FactChip({ tone, icon, tooltip, children }: ChipProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            data-slot="fact-chip"
            data-tone={tone}
            className={cn("inline-flex shrink-0 cursor-default items-center gap-1 rounded-full px-1.5 text-[11px] font-medium leading-[18px]", TONE_CHIP[tone], ENTER)}
          />
        }
      >
        {icon}
        {children}
      </TooltipTrigger>
      <TooltipContent side="top">{tooltip}</TooltipContent>
    </Tooltip>
  )
}

interface NoteProps {
  tone: FactTone
  icon: ReactNode
  className?: string
  children: ReactNode
}

/** 事实说明行（标记下方，直接写出这一次发生了什么） */
export function FactNote({ tone, icon, className, children }: NoteProps) {
  return (
    <p
      data-slot="fact-note"
      data-tone={tone}
      className={cn("flex items-start gap-1 text-[11px] leading-5", TONE_NOTE[tone], ENTER, className)}
    >
      {icon}
      <span>{children}</span>
    </p>
  )
}

/** 读取标记（行内）与说明行（行下方）：外观单点。结论（标不标、标什么、写什么）
 *  由 skillReadMarkOf 给出，这里只负责呈现。 */
interface SkillReadMarkProps {
  mark: SkillReadMarkKind
  /** 该次调用的截断事实（mark = truncated 时在） */
  truncation?: ToolOutputTruncation | null
}

/** 标记的悬停文案：旁边有说明行（alongsideNote）时结论已在行下方，悬停给互补的
 *  输出规模；单独摆放（工具行）时悬停是结论唯一的落点。 */
export function SkillReadChip({ mark, truncation, alongsideNote = false }: SkillReadMarkProps & { alongsideNote?: boolean }) {
  if (mark.kind === "truncated") {
    const scale = truncation ? toolOutputTruncationFact(truncation) : null
    return (
      <FactChip
        tone="amber"
        icon={<ScissorsIcon className="size-3 shrink-0" aria-hidden="true" />}
        tooltip={alongsideNote && scale ? scale : mark.fact}
      >
        工具输出截断
      </FactChip>
    )
  }
  return (
    <FactChip tone="neutral" icon={<Rows3Icon className="size-3 shrink-0" aria-hidden="true" />} tooltip={mark.fact}>
      部分读取
    </FactChip>
  )
}

export function SkillReadNote({ mark, className }: SkillReadMarkProps & { className?: string }) {
  if (mark.kind === "truncated") {
    return (
      <FactNote tone="amber" icon={<ScissorsIcon className="mt-0.5 size-3 shrink-0" aria-hidden="true" />} className={className}>
        {mark.fact}
      </FactNote>
    )
  }
  return (
    <FactNote tone="neutral" icon={<Rows3Icon className="mt-0.5 size-3 shrink-0" aria-hidden="true" />} className={className}>
      {mark.fact}
    </FactNote>
  )
}

/** 结果正文里的截断痕迹（横幅 / 中缝丢弃标记）：琥珀底色衬出，与正文区分 */
export function OutputSeam({ children }: { children: ReactNode }) {
  return (
    <span
      data-slot="output-seam"
      className="rounded-sm bg-amber-500/15 text-amber-700 outline-1 -outline-offset-1 outline-amber-500/20 dark:bg-amber-500/20 dark:text-amber-400"
    >
      {children}
    </span>
  )
}
