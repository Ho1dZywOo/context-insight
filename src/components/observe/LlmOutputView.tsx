"use client"
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// LLM 输出块（Turn 详情叙事舞台的上半）：正文与 thinking 共用统一文本块
// 语法（detail-blocks），thinking 只以字色区分（紫色标签 + muted 正文），
// 不再有独立的引用条形态。段头是方位词 + 发丝线 + copy（唯一整段操作）；
// 异常 finish（截断/审查/拒答）是唯一随标签直出的信号；纯工具轮标签
// 常驻 + 构成注记。旧独立模式（自带外框/整卡折叠/预览徽标）已随详情页
// Player 化退役——本组件唯一消费方是 TurnDetail 舞台卡。
import { useState, useEffect, useRef, useMemo, memo } from "react"
import { CopyButton } from "./CopyButton"
import { ExpandableText } from "./ExpandableText"
import { BashEscapeView, parseBashEscape } from "./BashEscapeView"
import { MarkdownLite } from "./MarkdownLite"
import { BLOCK, BLOCK_ROW, BLOCK_SUB, BLOCK_TRI } from "./detail-blocks"
import { highlightKeyword, type TurnHighlight } from "@/lib/shared/highlight"

interface LlmOutputViewProps {
  content: string | null
  contentJson: string | null
  outputTokens: number
  reasoningTokens?: number
  role?: string | null
  highlight?: TurnHighlight | null
  toolCallCount?: number
  finishReason?: string | null
}

function formatTokenCount(n: number): string {
  if (n === 0) return ""
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return `${n}`
}

interface ContentSection {
  type: "thinking" | "text"
  content: string
}

function parseContentSections(content: string | null, contentJson: string | null): ContentSection[] {
  const sections: ContentSection[] = []

  let rawContent = content ?? ""

  if (contentJson) {
    try {
      const parsed = JSON.parse(contentJson)
      if (typeof parsed === "string") {
        rawContent = parsed
      } else if (Array.isArray(parsed)) {
        for (const block of parsed) {
          if (block.type === "thinking" || block.type === "reasoning") {
            sections.push({ type: "thinking", content: block.thinking ?? block.content ?? block.text ?? String(block) })
          } else if (block.type === "text") {
            sections.push({ type: "text", content: block.text ?? block.content ?? String(block) })
          }
        }
        if (sections.length > 0) return sections
      } else if (typeof parsed === "object" && parsed.content) {
        rawContent = parsed.content
      }
    } catch {
      rawContent = content ?? ""
    }
  }

  if (sections.length === 0 && rawContent) {
    const thinkingPattern = new RegExp("<thinking>(.*?)<\\/thinking>", "gs")
    const matches = [...rawContent.matchAll(thinkingPattern)]

    if (matches.length > 0) {
      let remaining = rawContent
      for (const match of matches) {
        sections.push({ type: "thinking", content: match[1] })
        remaining = remaining.replace(match[0], "")
      }
      const trimmed = remaining.trim()
      if (trimmed) {
        sections.push({ type: "text", content: trimmed })
      }
    } else {
      sections.push({ type: "text", content: rawContent })
    }
  }

  return sections
}

// memo：走查高频路径上（缓存命中 + revalidate 双渲染）props 全等时整树
// 跳过——正文/代码块是详情页最重的渲染面。props 均为原始值或稳定引用
export const LlmOutputView = memo(function LlmOutputView({
  content,
  contentJson,
  outputTokens,
  reasoningTokens,
  role,
  highlight,
  toolCallCount,
  finishReason,
}: LlmOutputViewProps) {
  // 输出默认展开：正文常驻、thinking 块也随开（LLM Output 是打开详情的
  // 第一阅读主体，与 LLM Input 默认折叠成对）
  const [isThinkingExpanded, setIsThinkingExpanded] = useState(true)
  const [prevKw, setPrevKw] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // 走查高频路径（缓存命中 + revalidate 双渲染）下 content 不变则不重解析
  const sections = useMemo(() => parseContentSections(content, contentJson), [content, contentJson])
  // 异常完成原因显式化（正常类 stop/tool_calls/end_turn/tool_use 不标——
  // 加徽标是噪音）：截断/审查/拒答类的输出不完整或为空，静默吞掉会被读
  // 成"突然结束/没输出"。两套线缆约定都认（OpenAI 'length'/'content_filter'；
  // Claude 透传 'max_tokens'/'refusal'，claude-emitter 原样透传 stop_reason，
  // scoring collect 同款判定）。两档：有部分文本只挂徽标（正文可见）；
  // 全空的再加强制展开 + 解释文案
  const ABNORMAL_FINISH: Record<string, { label: string; emptyNote: string }> = {
    length: { label: "⛔ max_tokens 截断", emptyNote: `本轮输出被 max_tokens 上限截断（stopReason = ${finishReason}）：{TOKENS}t 输出已消耗，但没有文本落盘（content 为空）。该轮不是正常收尾——若需完整结果，请提高该 agent 的输出上限或缩小单轮任务后重试。` },
    max_tokens: { label: "⛔ max_tokens 截断", emptyNote: `本轮输出被 max_tokens 上限截断（stopReason = ${finishReason}）：{TOKENS}t 输出已消耗，但没有文本落盘（content 为空）。该轮不是正常收尾——若需完整结果，请提高该 agent 的输出上限或缩小单轮任务后重试。` },
    content_filter: { label: "⛔ 内容过滤截断", emptyNote: `本轮输出被内容审查策略截断（stopReason = content_filter）：生成中途被拦截，落盘内容不完整或为空。请检查提示词或调整审查策略。` },
    refusal: { label: "⛔ 模型拒答", emptyNote: `模型拒绝了本次请求（stopReason = refusal）：无有效输出落盘。请检查任务描述是否触发拒答策略。` },
  }
  const abnormal = finishReason != null ? ABNORMAL_FINISH[finishReason] : undefined
  const abnormalEmpty = abnormal != null && sections.every(s => !s.content.trim())

  // Scroll the first highlighted match into view.
  useEffect(() => {
    if (!highlight?.keyword) return
    const t = setTimeout(() => {
      rootRef.current?.querySelector("mark")?.scrollIntoView({ behavior: "smooth", block: "center" })
    }, 60)
    return () => clearTimeout(t)
  }, [highlight])

  // 纯工具轮：正文/思考皆空但输出存在（工具调用即输出主体）——输出块
  // 不整体消失，标签常驻让「输出」概念在所有构成下可见
  const toolOnly = sections.length === 0 && (toolCallCount ?? 0) > 0

  if (!content && !contentJson && !abnormalEmpty && !toolOnly) return null

  // Trace-search jump: when the highlight keyword changes, auto-expand the
  // thinking block carrying the match. Uses the render-phase prop-change
  // pattern instead of setState-in-effect.
  const currentKw = highlight?.keyword ?? null
  if (currentKw !== prevKw) {
    setPrevKw(currentKw)
    if (currentKw && highlight) {
      const isContentMatch = !highlight.matchField || highlight.matchField === "content" || highlight.matchField === "contentSummary"
      if (isContentMatch) {
        const lower = currentKw.trim().toLowerCase()
        if (sections.some(s => s.type === "thinking" && s.content.toLowerCase().includes(lower))) {
          setIsThinkingExpanded(true)
        }
      }
    }
  }

  const HEADER_LABELS: Record<string, string> = {
    user: "User Input",
    assistant: "LLM Output",
    system: "System Message",
    tool_result: "Tool Result",
  }
  const headerLabel = HEADER_LABELS[role ?? ""] ?? "Content"

  return (
    <div ref={rootRef}>
      {/* 段头：方位词 + 发丝线。异常 finish 是唯一随标签直出的信号；整段
          copy 已退役——复制下沉到各文本块（thinking 块行内 + 文本块角标） */}
      <div className="flex items-center gap-2.5 px-4 pt-3.5 pb-1">
        <span className="text-xs font-medium text-muted-foreground">{headerLabel}</span>
        {abnormal && (
          <span className="text-xs font-medium text-red-600 dark:text-red-400" title={`stopReason = ${finishReason}`}>{abnormal.label}</span>
        )}
        <div className="h-px flex-1 bg-foreground/[0.08]" />
      </div>
      {abnormal && abnormalEmpty && (
        <div className="px-4 pb-2 text-xs leading-relaxed text-red-600 dark:text-red-400">
          {abnormal.emptyNote.replace("{TOKENS}", formatTokenCount(outputTokens))}
        </div>
      )}
      {toolOnly && (
        <div className="px-4 pb-2.5 text-xs text-muted-foreground">
          本轮无正文——输出为下方 {toolCallCount} 个工具调用
        </div>
      )}
      {sections.length > 0 && (
        <div className="space-y-2 px-4 pb-3.5">
          {sections.map((section, index) => {
            // shell 转义显示糖：有关键字高亮时退回普通渲染，保住 <mark> 跳转
            const bashEscape = parseBashEscape(section.content)
            if (section.type === "thinking") {
              return (
                <div key={index} className={BLOCK}>
                  <div className={BLOCK_ROW}>
                    <span className="text-xs font-medium text-purple-600 dark:text-purple-400">thinking</span>
                    {(reasoningTokens ?? 0) > 0 && (
                      <span className="text-xs text-muted-foreground tabular-nums">{formatTokenCount(reasoningTokens ?? 0)}t</span>
                    )}
                    <span className="flex-1" />
                    <CopyButton text={section.content} className="size-4 text-muted-foreground hover:text-foreground shrink-0" />
                    <span
                      role="button"
                      tabIndex={0}
                      className={BLOCK_TRI}
                      onClick={() => setIsThinkingExpanded(!isThinkingExpanded)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setIsThinkingExpanded(!isThinkingExpanded) }}
                    >
                      {isThinkingExpanded ? "▼" : "▶"}
                    </span>
                  </div>
                  {isThinkingExpanded && (
                    <div className={BLOCK_SUB}>
                      <ExpandableText clampPx={400} className="text-sm whitespace-pre-wrap break-words text-muted-foreground">
                        {highlightKeyword(section.content, highlight?.keyword)}
                      </ExpandableText>
                    </div>
                  )}
                </div>
              )
            }
            return (
              <div key={index} className={`${BLOCK} group/copy relative px-3.5 py-3 text-sm`}>
                {/* 块级 copy：hover 显形角标（文本块无行头，复制意图出现时才
                    可见，多块输出不堆图标）；能力与 thinking 块/输入消息行同源 */}
                <span className="absolute right-1 top-1.5 rounded opacity-0 transition-opacity group-hover/copy:opacity-100">
                  <CopyButton text={section.content} />
                </span>
                {!highlight?.keyword && bashEscape ? (
                  <BashEscapeView esc={bashEscape} />
                ) : highlight?.keyword ? (
                  // 关键字命中态退回纯文本：<mark> 跳转依赖文本节点，markdown
                  // 结构化渲染会把命中词拆进不同节点（BashEscapeView 同款退路）
                  <ExpandableText clampPx={600} className="whitespace-pre-wrap break-words">
                    {highlightKeyword(section.content, highlight?.keyword)}
                  </ExpandableText>
                ) : (
                  <ExpandableText clampPx={600}>
                    <MarkdownLite text={section.content} />
                  </ExpandableText>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
})
