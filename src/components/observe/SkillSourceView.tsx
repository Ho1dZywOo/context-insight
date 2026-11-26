// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See the License in the root of the software repository for the full text of the License.

// 恢复出的声明正文（SKILL.md）的单一展示面：正文行带文件行号栏，缺失的行是独立的
// 标记行——界面元素，不写进正文（选中复制、复制按钮、下载拿到的只有确实读到的行）。
// 没恢复出全文时顶部给一张结论条：覆盖面、缺了哪些行、为什么缺。结论与文案全部来自
// skill-evidence（describeMissingLines / layOutSource / formatGap），这里只负责呈现。
// 色调沿用读取事实提示的约定：工具输出被截断（内容丢了）= 琥珀；只是命令限了范围 /
// 尾部是否读完未知 = 中性。行序是纯静态列表，不逐行做动效；只有结论条入场动一次。
//
// 版面：结论条是「额外长出来的」，所以正文区的限高由展示面按结论条的有无让出——
// 打开全文前后卡片总高不变。处置建议不在本面自绘：要么所在卡片已有一条
// （TruncationAdviceView，每卡一条），要么由调用方传入 advice 在结论条内渲染同一个
// 视觉源。

import { Fragment, type ClipboardEvent, type ReactNode } from "react"
import { AlertCircleIcon, ScissorsIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { CopyButton } from "./CopyButton"
import { TruncationAdviceView } from "./ReadNotice"
import { toolOutputTruncationAdvice, type TruncationAdvice } from "@/lib/tool-output-truncation"
import { describeMissingLines, formatGap, layOutSource, type LineEvidence } from "@/lib/skill-evidence"

type Tone = "amber" | "neutral"

const TONE_BOX: Record<Tone, string> = {
  amber: "border-amber-500/30 bg-amber-500/[0.06] text-amber-700 dark:border-amber-400/25 dark:bg-amber-400/[0.07] dark:text-amber-300",
  neutral: "border-foreground/15 bg-foreground/[0.03] text-muted-foreground",
}
const TONE_TAG: Record<Tone, string> = {
  amber: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:border-amber-400/35 dark:bg-amber-400/10 dark:text-amber-300",
  neutral: "border-foreground/20 bg-foreground/[0.05] text-muted-foreground",
}
const TONE_TEXT: Record<Tone, string> = {
  amber: "text-amber-700 dark:text-amber-300",
  neutral: "text-muted-foreground",
}

const TAG_CLS = "select-none rounded-md border px-1.5 py-0.5 font-mono text-[11px] leading-[18px] tabular-nums"
/** 结论条里最多列这么多段缺失行；再多给合计（每一段在正文里都有标记行） */
export const MAX_GAP_TAGS = 6

export interface SkillSourceViewProps {
  content: string
  evidence?: LineEvidence | null
  fullRead: boolean
  /** 读取来源通道；skill-tool / command 是注入快照，行号即 1..N */
  source?: string | null
  /** 读取被截断时的处置建议（所在卡片已有一条时不要传，避免同卡重复） */
  advice?: TruncationAdvice | null
  /** 正文滚动区的限高类，由展示面按版面给 */
  bodyClassName?: string
  className?: string
}

/** 正文区内选中的文字，按行拼回（行间换行）。正文是逐行的独立元素，浏览器原生选区
 *  会丢空白行、行号栏与标记行也可能混进去——复制事件里按「选区经过哪些正文行」
 *  现算：首尾两行取选区内的部分，中间整行；行号栏与标记行不在其中。选区不在正文内
 *  或没有选中任何正文行 → null（交给浏览器默认行为）。 */
export function selectedSourceText(body: Element, sel: Selection | null): string | null {
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  if (!body.contains(range.commonAncestorContainer)) return null
  const out: string[] = []
  for (const span of Array.from(body.querySelectorAll<HTMLElement>('[data-slot="skill-source-line"]'))) {
    if (!range.intersectsNode(span)) continue
    const r = document.createRange()
    r.selectNodeContents(span)
    const startsInside = range.startContainer === span || span.contains(range.startContainer)
    const endsInside = range.endContainer === span || span.contains(range.endContainer)
    if (startsInside) r.setStart(range.startContainer, range.startOffset)
    if (endsInside) r.setEnd(range.endContainer, range.endOffset)
    // 选区边界恰好落在某行的行尾 / 行首：那一行只是被擦到，不算选中
    if ((startsInside || endsInside) && r.collapsed) continue
    out.push(r.toString())
  }
  return out.length > 0 ? out.join("\n") : null
}

export function SkillSourceView({ content, evidence, fullRead, source, advice, bodyClassName, className }: SkillSourceViewProps) {
  const notice = describeMissingLines(content, evidence, fullRead)
  const rows = layOutSource(content, evidence)
  const numbered = notice.located || source === "skill-tool" || source === "command"
  const tone: Tone = notice.truncated ? "amber" : "neutral"
  const headline = notice.missing > 0 || notice.truncated || !notice.located ? "未恢复全文" : "未确认是全文"
  const tags: ReactNode[] = []
  if (notice.truncated) {
    tags.push(
      <li key="truncated" data-gap-kind="truncated" className={cn(TAG_CLS, "inline-flex items-center gap-1 border-solid", TONE_TAG.amber)}>
        <ScissorsIcon className="size-3" />
        读取该文件的工具输出被截断
      </li>,
    )
  }
  notice.gaps.slice(0, MAX_GAP_TAGS).forEach((g) => {
    tags.push(
      <li
        key={`${g.from}-${g.to}-${g.kind}`}
        data-gap-kind={g.kind}
        data-from={g.from}
        data-to={g.to}
        title={g.tail ? "一直缺到文件末尾" : undefined}
        className={cn(TAG_CLS, "border-dashed", TONE_TAG[g.kind === "conflict" ? "neutral" : tone])}
      >
        {formatGap(g)}
        {g.tail ? "（到文件末尾）" : ""}
      </li>,
    )
  })
  const rest = notice.gaps.slice(MAX_GAP_TAGS)
  if (rest.length > 0) {
    tags.push(
      <li key="rest" data-gap-kind="rest" data-count={rest.length} className={cn(TAG_CLS, "border-dashed", TONE_TAG[tone])}>
        另有 {rest.length} 段共 {rest.reduce((sum, g) => sum + g.to - g.from + 1, 0)} 行
      </li>,
    )
  }
  if (notice.tailUnknown) {
    tags.push(<li key="tail" data-gap-kind="tail-unknown" className={cn(TAG_CLS, "border-dashed", TONE_TAG.neutral)}>文件到此是否结束未知</li>)
  }
  if (!notice.located) {
    tags.push(<li key="unlocated" data-gap-kind="unlocated" className="py-0.5 text-[11px] leading-[18px]">行号不可定，无法指出缺在哪一行</li>)
  }

  const onCopy = (e: ClipboardEvent<HTMLDivElement>) => {
    const text = selectedSourceText(e.currentTarget, window.getSelection())
    if (text == null) return
    e.preventDefault()
    e.clipboardData.setData("text/plain", text)
  }

  return (
    <div data-slot="skill-source" data-partial={notice.partial || undefined} className={cn("min-w-0 space-y-2", className)}>
      {notice.partial && (
        <div role="note" data-slot="skill-source-notice" data-tone={tone} data-located={notice.located} className={cn("hud-enter rounded-md border px-2.5 py-2", TONE_BOX[tone])}>
          <p className="flex items-center gap-1.5 text-[11.5px] font-medium leading-5">
            <AlertCircleIcon className="size-3.5 shrink-0" />
            <span>
              {headline} · {notice.summary}
              {notice.missing > 0 && <span> · 缺 {notice.missing} 行</span>}
            </span>
          </p>
          {tags.length > 0 && (
            <ul data-slot="skill-source-gaps" className="mt-1.5 flex flex-wrap gap-1">
              {tags}
            </ul>
          )}
          {notice.truncated && advice && <TruncationAdviceView advice={advice} collapsible className="mt-1.5" />}
        </div>
      )}

      <div
        data-slot="skill-source-body"
        onCopy={onCopy}
        className={cn("grid overflow-auto rounded border bg-background p-2 font-mono text-xs leading-5", numbered ? "grid-cols-[minmax(2.5rem,auto)_minmax(0,1fr)]" : "grid-cols-1", bodyClassName)}
      >
        {rows.map((row, i) => {
          if (row.kind === "line") {
            return (
              <Fragment key={i}>
                {numbered && (
                  <span aria-hidden className="select-none pr-3 text-right tabular-nums text-muted-foreground/70">
                    {row.n ?? i + 1}
                  </span>
                )}
                <span data-slot="skill-source-line" className="min-w-0 whitespace-pre-wrap break-words">{row.text}</span>
              </Fragment>
            )
          }
          const conflict = row.kind === "gap" && row.gap.kind === "conflict"
          return (
            <div
              key={i}
              data-slot="skill-source-gap"
              data-kind={conflict ? "conflict" : row.kind}
              data-from={row.kind === "gap" ? row.gap.from : undefined}
              data-to={row.kind === "gap" ? row.gap.to : undefined}
              className={cn("col-span-full my-0.5 flex select-none items-center gap-2 px-1 text-[11px] leading-5", TONE_TEXT[conflict || tone === "neutral" ? "neutral" : "amber"])}
            >
              <span className="h-px min-w-3 flex-1 border-t border-dashed border-current opacity-50" />
              <span className="whitespace-nowrap">
                {row.kind === "gap" ? `⋯ ${formatGap(row.gap)}${row.gap.tail ? "（到文件末尾）" : ""}` : `⋯ 第 ${row.after} 行之后是否还有内容：未知`}
              </span>
              <span className="h-px min-w-3 flex-1 border-t border-dashed border-current opacity-50" />
            </div>
          )
        })}
      </div>

      <div className="flex items-center justify-between gap-2 text-[11px] leading-5 text-muted-foreground">
        <span>
          {source && <span>{skillSourceLabel(source)} · </span>}
          {rows.length > 0 && `${rows.filter(r => r.kind === "line").length} 行`}
          {notice.partial && " · 标记行是界面标注，复制与下载的正文不含"}
        </span>
        <CopyButton text={content} className="size-5 rounded text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground" />
      </div>
    </div>
  )
}

/** 读取来源通道 → 用户可读名称（各展示面共用，不在展示层各抄一份三元表达式）。 */
export function skillSourceLabel(source: string | null | undefined): string {
  switch (source) {
    case "skill-tool": return "Skill 工具注入"
    case "command": return "命令注入"
    case "shell": return "Shell 读取"
    case "read": return "Read 读取"
    default: return "未知来源"
  }
}

/** shell 读取被截断时的处置建议（codex 是唯一确有可调开关的形态）；其余通道为 null。 */
export function skillSourceAdvice(source: string | null | undefined): TruncationAdvice | null {
  return source === "shell" ? toolOutputTruncationAdvice("codex") : null
}
