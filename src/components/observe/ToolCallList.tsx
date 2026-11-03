"use client"
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 工具调用块（叙事舞台下半）：skill 与普通调用同一块语法（detail-blocks），
// 区别只在头行的 ⚡ 前缀与 skill 名。状态 = 字色（不再药丸徽标）；Args /
// Result 走发丝分节 + 长内容夹断（ExpandableText，与整页「一条滚动条」
// 哲学一致——旧 max-h + overflow 滚动条退役）。三角唯一触发点契约保持。
import { useState, useEffect, useRef } from "react"
import { ZapIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { CopyButton } from "./CopyButton"
import { ExpandableText } from "./ExpandableText"
import { BLOCK, BLOCK_ROW, BLOCK_SUB, BLOCK_TRI } from "./detail-blocks"
import { highlightKeyword, type TurnHighlight } from "@/lib/shared/highlight"

interface ToolCallItem {
  id: string
  toolCallId: string
  toolName: string
  argsJson: string | null
  resultJson: string | null
  state: string
  errorType: string | null
  errorMessage: string | null
  durationMs: number
  isSkillRelated: boolean
}

interface ToolCallListProps {
  toolCalls: ToolCallItem[]
  highlight?: TurnHighlight | null
}

function hasResultError(resultJson: string | null): boolean {
  if (!resultJson) return false
  return resultJson.includes('<tool_use_error>') || resultJson.includes('Exit code')
}

function toolCallDisplayState(state: string, errorType: string | null, resultJson: string | null): { label: string; variant: "green" | "red" | "gray" | "orange" } {
  if ((state === "ok" || state === "completed") && (errorType || hasResultError(resultJson))) return { label: "error", variant: "red" }
  if (state === "ok" || state === "completed") return { label: state, variant: "green" }
  if (state === "error" || state === "failed") return { label: state, variant: "red" }
  return { label: state, variant: "orange" }
}

const STATUS_TEXT: Record<string, string> = {
  green: "text-emerald-600 dark:text-emerald-400",
  red: "text-red-600 dark:text-red-400",
  orange: "text-orange-600 dark:text-orange-400",
  gray: "text-muted-foreground",
}

function formatDuration(ms: number): string {
  if (ms === 0) return ""
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function truncateJson(json: string | null, maxLen: number): string | null {
  if (!json) return null
  if (json.length <= maxLen) return json
  return json.substring(0, maxLen) + `... (${json.length} chars total)`
}

function extractSkillLabel(argsJson: string | null): string | null {
  if (!argsJson) return null
  try {
    const args = JSON.parse(argsJson)
    return args.skill_name ?? args.name ?? null
  } catch { /* ignore */ }
  return null
}

export function ToolCallList({ toolCalls, highlight }: ToolCallListProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [prevKw, setPrevKw] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const skillCalls = toolCalls.filter(tc => tc.isSkillRelated)
  const nonSkillCalls = toolCalls.filter(tc => !tc.isSkillRelated)

  function toggleExpanded(id: string) {
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Trace-search jump: when the highlight keyword changes, auto-expand tool
  // calls that carry the match. Render-phase prop-change pattern (no
  // setState-in-effect).
  const currentKw = highlight?.keyword ?? null
  if (currentKw !== prevKw) {
    setPrevKw(currentKw)
    if (currentKw && highlight) {
      const isToolMatch = highlight.matchField === "toolResult" || highlight.matchField === "toolError" || highlight.matchField === "toolArgs"
      if (isToolMatch) {
        const lower = currentKw.trim().toLowerCase()
        if (lower) {
          const toExpand = new Set<string>()
          for (const tc of nonSkillCalls) {
            if (highlight.toolName && tc.toolName === highlight.toolName) {
              toExpand.add(tc.id)
              continue
            }
            if (
              (tc.argsJson?.toLowerCase().includes(lower) ?? false) ||
              (tc.resultJson?.toLowerCase().includes(lower) ?? false) ||
              (tc.errorMessage?.toLowerCase().includes(lower) ?? false)
            ) {
              toExpand.add(tc.id)
            }
          }
          if (toExpand.size > 0) {
            setExpandedIds(prev => {
              const next = new Set(prev)
              for (const id of toExpand) next.add(id)
              return next
            })
          }
        }
      }
    }
  }

  // Scroll the first highlighted match into view once expanded.
  useEffect(() => {
    if (!highlight?.keyword) return
    const t = setTimeout(() => {
      rootRef.current?.querySelector("mark")?.scrollIntoView({ behavior: "smooth", block: "center" })
    }, 60)
    return () => clearTimeout(t)
  }, [highlight, expandedIds])

  // skill 调用排前（派发语义先于执行细节），渲染同一块语法
  const ordered = [...skillCalls, ...nonSkillCalls]

  return (
    <div ref={rootRef} className="space-y-2">
      {ordered.map(tc => {
        const isExpanded = expandedIds.has(tc.id)
        const displayState = toolCallDisplayState(tc.state, tc.errorType, tc.resultJson)
        const skillLabel = tc.isSkillRelated ? extractSkillLabel(tc.argsJson) : null

        return (
          <div key={tc.id} className={BLOCK}>
            <div className={cn(BLOCK_ROW, "text-sm")}>
              {tc.isSkillRelated && <ZapIcon className="size-3.5 shrink-0 text-amber-500" aria-hidden="true" />}
              <span className="font-medium truncate">{skillLabel ?? tc.toolName}</span>
              {skillLabel && <span className="text-xs text-muted-foreground shrink-0">{tc.toolName}</span>}
              <span className={cn("text-xs shrink-0", STATUS_TEXT[displayState.variant])}>{displayState.label}</span>
              {tc.durationMs > 0 && (
                <span className="text-xs text-muted-foreground tabular-nums shrink-0">{formatDuration(tc.durationMs)}</span>
              )}
              {tc.errorType && (
                <span className="text-xs text-red-600 dark:text-red-400 shrink-0 truncate">{tc.errorType}</span>
              )}
              {(tc.argsJson || tc.resultJson) ? (
                <CopyButton text={[tc.argsJson, tc.resultJson].filter(Boolean).join("\n\n---\n\n")} className="ml-auto size-4 text-muted-foreground hover:text-foreground shrink-0" />
              ) : (
                <span className="ml-auto" />
              )}
              <span
                role="button"
                tabIndex={0}
                className={BLOCK_TRI}
                onClick={() => toggleExpanded(tc.id)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") toggleExpanded(tc.id) }}
              >
                {isExpanded ? "▼" : "▶"}
              </span>
            </div>

            {isExpanded && (
              <>
                {tc.errorMessage && (
                  <div className={cn(BLOCK_SUB, "text-xs leading-relaxed text-red-600 dark:text-red-400")}>
                    {highlightKeyword(tc.errorMessage, highlight?.keyword)}
                  </div>
                )}
                {tc.argsJson && (
                  <div className={BLOCK_SUB}>
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className="text-[11px] font-medium text-muted-foreground">Args</span>
                      <CopyButton text={tc.argsJson} className="size-3.5 text-muted-foreground hover:text-foreground" />
                    </div>
                    <ExpandableText clampPx={200}>
                      <pre className="text-xs font-mono whitespace-pre-wrap break-words">
                        {highlightKeyword(highlight?.keyword ? tc.argsJson : (truncateJson(tc.argsJson, 2000) ?? tc.argsJson), highlight?.keyword)}
                      </pre>
                    </ExpandableText>
                  </div>
                )}
                {tc.resultJson && (
                  <div className={BLOCK_SUB}>
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className="text-[11px] font-medium text-muted-foreground">Result</span>
                      <CopyButton text={tc.resultJson} className="size-3.5 text-muted-foreground hover:text-foreground" />
                    </div>
                    <ExpandableText clampPx={200}>
                      <pre className="text-xs font-mono whitespace-pre-wrap break-words">
                        {highlightKeyword(highlight?.keyword ? tc.resultJson : (truncateJson(tc.resultJson, 2000) ?? tc.resultJson), highlight?.keyword)}
                      </pre>
                    </ExpandableText>
                  </div>
                )}
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}
