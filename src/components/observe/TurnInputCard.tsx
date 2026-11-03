"use client"
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Turn 输入卡（Δ 优先）：读 turn 输入的第一问题是「这轮新进了什么」，
// 不是「12 条历史长什么样」——历史与上轮逐条相同（跨轮冗余），且时间线
// 走查已能在每轮看到当时的「新增」。默认整体折叠（打开详情先读输出），
// 展开后三段式：
//   ① 本轮新增（= 上轮输入条数之后的消息，精确边界来自同 agent 维度上轮
//      的 inputMessagesCount）：段内短消息默认展开正文
//   ② 历史上下文：压成一行摘要（条数/token），点开才见逐条折叠行；
//      上轮→本轮条数变少 = 压缩/裁剪，显式标注
//   ③ System 开销（tools/memory/skills/system prompt）：一行收纳
// 消息行渲染与 LlmContextView 同源能力（reminder 子块、tool_calls 派发、
// copy），块语法走 detail-blocks 统一文本块（与输出区同屏同口径：状态 =
// 字色、发丝分节、灰底圆角块）。
import { memo, useCallback, useMemo, useState } from "react"
import { ZapIcon, LayersIcon, ShieldIcon, PlusIcon, ChevronRightIcon, WrenchIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { CopyButton } from "./CopyButton"
import { ExpandableText } from "./ExpandableText"
import { BLOCK, BLOCK_ROW, BLOCK_SUB, BLOCK_TRI } from "./detail-blocks"
import { parseInputMessages, estimateTokensFromChars, reminderPrefix, type InputMessage } from "./LlmContextView"

function fmtTokens(n: number): string {
  if (n === 0) return "0"
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return `${n}`
}

function msgTokens(m: InputMessage): number {
  return m.tokenCount ?? estimateTokensFromChars(m.content?.length ?? 0)
}

// 超过此长度的新增消息不默认展开全文（折叠为预览行，一键点开）
const AUTO_EXPAND_MAX_CHARS = 1200

function contentPreview(m: InputMessage, max = 90): string | null {
  if (!m.content) return null
  const rp = reminderPrefix(m.content)
  const text = (rp ? rp.prompt : m.content).replace(/\s+/g, " ").trim()
  if (!text) return null
  return text.length > max ? text.substring(0, max) + "…" : text
}

const ROLE_TEXT_COLOR: Record<string, string> = {
  system: "text-purple-600 dark:text-purple-400",
  user: "text-blue-600 dark:text-blue-400",
  assistant: "text-emerald-600 dark:text-emerald-400",
  tool_result: "text-teal-600 dark:text-teal-400",
  tool: "text-gray-600",
}

const ROLE_DOT_COLOR: Record<string, string> = {
  system: "bg-purple-500",
  user: "bg-blue-500",
  assistant: "bg-emerald-500",
  tool_result: "bg-teal-500",
  tool: "bg-gray-400",
}

// 三段头同构收纳行（①新增/②历史/③System 同一风格）：图标 + 一行摘要 +
// hairline + 弹簧旋转 chevron——三段默认收纳（输入默认折叠，输出是第一
// 阅读主体；与 LlmOutputView 的默认展开成对）
const sectionRow = "w-full flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground cursor-pointer select-none py-1"
const sectionChevron = "size-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-300 [transition-timing-function:cubic-bezier(0.32,0.72,0,1)]"

// 消息行提到模块级 + memo：杜绝每次父级重渲染都生成新的组件 type，
// 否则 React 把 element type 变化当作「换组件」处理，整棵 MessageRow 子树
// 卸载重挂（ExpandableText 的「展开全文」状态被重置、数百行 DOM 全量重挂）。
// expanded/onToggle 经 props 传入：toggle 某行只重渲染受影响的行（memo 命中）。
const MessageRow = memo(function MessageRow({
  msg,
  index,
  expanded,
  onToggle,
}: {
  msg: InputMessage
  index: number
  expanded: boolean
  onToggle: (index: number) => void
}) {
  const isExpanded = expanded
  const isContinuation = msg.agentName === "continuation"
  const tokens = msgTokens(msg)
  const rp = isExpanded && msg.content ? reminderPrefix(msg.content) : null

  return (
    <div key={index} className={BLOCK}>
      <div className={cn(BLOCK_ROW, "text-sm")}>
        <div className={cn("w-1.5 h-1.5 rounded-full shrink-0", isContinuation ? "bg-purple-500" : (ROLE_DOT_COLOR[msg.role] ?? "bg-gray-400"))} />
        <span className={cn("text-xs font-medium shrink-0", isContinuation ? "text-purple-600 dark:text-purple-400" : (ROLE_TEXT_COLOR[msg.role] ?? "text-gray-600"))}>
          {isContinuation ? "continuation" : msg.role}
        </span>
        {msg.name && <span className="text-xs text-muted-foreground truncate max-w-32">{msg.name}</span>}
        {msg.tool_calls && msg.tool_calls.length > 0 && (
          <span className="flex items-center gap-0.5 text-xs text-muted-foreground shrink-0" title="派发的工具调用">
            <WrenchIcon className="size-3" />{msg.tool_calls.length}
          </span>
        )}
        {!isExpanded && (
          <span className="text-xs text-muted-foreground/70 truncate flex-1">{contentPreview(msg)}</span>
        )}
        <span className="flex-1" />
        {tokens > 0 && <span className="text-xs text-muted-foreground tabular-nums shrink-0">{fmtTokens(tokens)}t</span>}
        {msg.content && <CopyButton text={msg.content} className="size-4 text-muted-foreground hover:text-foreground shrink-0" />}
        <span
          role="button"
          tabIndex={0}
          className={BLOCK_TRI}
          onClick={() => onToggle(index)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onToggle(index) }}
        >
          {isExpanded ? "▼" : "▶"}
        </span>
      </div>

      {isExpanded && msg.content && !rp && (
        <div className={BLOCK_SUB}>
          <ExpandableText clampPx={300} className="text-sm whitespace-pre-wrap break-words">
            {msg.content}
          </ExpandableText>
        </div>
      )}
      {isExpanded && rp && (
        <>
          <div className={BLOCK_SUB}>
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-[11px] font-medium text-purple-600 dark:text-purple-400">system-reminder</span>
              <span className="text-[10px] text-muted-foreground tabular-nums">{fmtTokens(estimateTokensFromChars(rp.reminder.length))}t</span>
            </div>
            <ExpandableText clampPx={180}>
              <pre className="text-xs font-mono whitespace-pre-wrap break-words text-foreground/70">{rp.reminder}</pre>
            </ExpandableText>
          </div>
          {rp.prompt && (
            <div className={BLOCK_SUB}>
              <ExpandableText clampPx={300} className="text-sm whitespace-pre-wrap break-words">
                {rp.prompt}
              </ExpandableText>
            </div>
          )}
        </>
      )}

      {isExpanded && msg.tool_calls && msg.tool_calls.length > 0 && msg.tool_calls.map((tc, tcIdx) => {
        const tcTokens = Math.round(((tc.args?.length ?? 0) + (tc.result?.length ?? 0)) / 3.5)
        return (
          <div key={tcIdx} className={BLOCK_SUB}>
            <div className="flex items-center gap-2 text-xs">
              {tc.isSkillRelated && <ZapIcon className="size-3 shrink-0 text-amber-500" />}
              <span className="font-medium">{tc.isSkillRelated ? `dispatch: ${tc.name}` : tc.name}</span>
              <span className="text-muted-foreground">{tc.isSkillRelated ? "skill 派发" : "tool call"}</span>
              {tcTokens > 0 && <span className="text-muted-foreground tabular-nums">{fmtTokens(tcTokens)}t</span>}
              {(tc.args || tc.result) && <CopyButton text={[tc.args, tc.result].filter(Boolean).join("\n\n---\n\n")} className="ml-auto size-4 text-muted-foreground hover:text-foreground" />}
            </div>
            <div className="mt-1 space-y-1">
              {tc.args && (
                <ExpandableText clampPx={200} className="text-xs whitespace-pre-wrap break-words">
                  <span className="font-medium text-muted-foreground">args:</span> {tc.args}
                </ExpandableText>
              )}
              {tc.result && (
                <ExpandableText clampPx={200} className="text-xs whitespace-pre-wrap break-words">
                  <span className="font-medium text-muted-foreground">result:</span> {tc.result}
                </ExpandableText>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
})

export function TurnInputCard({
  inputMessagesJson,
  inputMessagesCount,
  inputMessagesTokens,
  contextWindowPct,
  systemOverheadTokens,
  systemPrompt,
  fullContext,
  prevInputMessagesCount,
}: {
  inputMessagesJson: string | null
  inputMessagesCount: number
  inputMessagesTokens: number
  contextWindowPct: number | null
  systemOverheadTokens: number
  systemPrompt: string | null
  fullContext: { tools: Array<{ name: string; description: string }>; memoryFiles: string; skills: string } | null
  prevInputMessagesCount?: number | null
}) {
  // 切换走查高频重渲染：JSON 解析（inputMessagesJson 可达数十 KB）必须 memo
  const messages = useMemo(() => parseInputMessages(inputMessagesJson), [inputMessagesJson])

  // Δ 边界：同 agent 维度上轮输入条数（父级计算）。无上轮（首轮）→ 全部
  // 为新增；上轮条数 ≥ 本轮（压缩/裁剪）→ 边界失效，退回全量 + 显式标注
  const compacted = prevInputMessagesCount != null && prevInputMessagesCount >= messages.length && messages.length > 0
  const boundary = prevInputMessagesCount != null && prevInputMessagesCount > 0 && prevInputMessagesCount < messages.length
    ? prevInputMessagesCount
    : 0
  const newMessages = messages.slice(boundary)
  const historyMessages = messages.slice(0, boundary)
  const newTokens = newMessages.reduce((s, m) => s + msgTokens(m), 0)
  const historyTokens = historyMessages.reduce((s, m) => s + msgTokens(m), 0)

  const [historyOpen, setHistoryOpen] = useState(false)
  const [systemOpen, setSystemOpen] = useState(false)
  // 输入默认折叠（与 LLM Output 默认展开成对）：三段一律收纳成行——
  // 打开详情先读输出，输入是按需展开的参考材料
  const [newOpen, setNewOpen] = useState(false)
  // 段展开后短消息默认展开正文，超长的（大 tool_result 等）折叠为预览行
  // 一键点开——数千行 DOM 是切换卡顿的可观来源；历史消息默认折叠
  const [expandedMessages, setExpandedMessages] = useState<Set<number>>(() => {
    const set = new Set<number>()
    for (let i = boundary; i < messages.length; i++) {
      if ((messages[i].content?.length ?? 0) <= AUTO_EXPAND_MAX_CHARS) set.add(i)
    }
    return set
  })

  // 稳定引用：setExpandedMessages 来自 useState（身份恒定），空依赖即可
  const toggleMessage = useCallback((index: number) => {
    setExpandedMessages(prev => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }, [])

  // 无输入可展示（hooks 之后再早退，保证 Hook 调用顺序稳定）
  if (inputMessagesCount === 0 && messages.length === 0 && !inputMessagesJson) return null

  const pct = contextWindowPct ?? 0
  const pctColor = pct > 80 ? "bg-red-500" : pct > 50 ? "bg-orange-500" : pct > 0 ? "bg-blue-500" : "bg-gray-300"

  return (
    <div className="rounded-2xl bg-card">
      {/* 段头：方位词 + 全量摘要 + 窗口占比（accumulate 回归锁锚点：叶 span "LLM Input"） */}
      <div className="flex items-center gap-2.5 px-4 py-3 flex-wrap">
        <span className="text-xs font-medium text-muted-foreground">LLM Input</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {messages.length} messages · {fmtTokens(inputMessagesTokens)} tokens
          {pct > 0 && ` · ${pct.toFixed(1)}% context`}
        </span>
        <div className="h-px flex-1 bg-foreground/[0.08] min-w-6" />
        {pct > 0 && (
          <div className="w-20 h-1 bg-muted rounded-full overflow-hidden shrink-0">
            <div className={cn("h-full rounded-full", pctColor)} style={{ width: `${Math.min(pct, 100)}%` }} />
          </div>
        )}
      </div>

      <div className="border-t border-foreground/[0.06] px-4 py-3 space-y-3">
        {/* ① 本轮新增：与②③同构的收纳行头（三段默认全收纳，输入按需展开） */}
        {newMessages.length > 0 && (
          <div>
            <div
              role="button"
              tabIndex={0}
              className={sectionRow}
              onClick={() => setNewOpen(!newOpen)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setNewOpen(!newOpen) }}
            >
              <PlusIcon className="size-3.5 shrink-0" />
              <span>本轮新增 {newMessages.length} 条 · {fmtTokens(newTokens)}t</span>
              {compacted && (
                <span className="text-purple-600 dark:text-purple-400" title="上轮输入条数多于本轮：发生了 /compact 压缩或上下文裁剪">
                  ↑ 输入被压缩（上轮 {prevInputMessagesCount} 条 → 本轮 {messages.length} 条）
                </span>
              )}
              <div className="h-px flex-1 bg-foreground/[0.06]" />
              <ChevronRightIcon className={cn(sectionChevron, newOpen && "rotate-90")} />
            </div>
            {newOpen && (
              <div className="space-y-1.5 pt-1">
                {newMessages.map((msg, i) => {
                  const idx = boundary + i
                  return <MessageRow key={idx} msg={msg} index={idx} expanded={expandedMessages.has(idx)} onToggle={toggleMessage} />
                })}
              </div>
            )}
          </div>
        )}

        {/* ② 历史上下文：一行收纳（与上轮逐条相同，时间线走查可见彼时新增） */}
        {historyMessages.length > 0 && (
          <div>
            <div
              role="button"
              tabIndex={0}
              className={sectionRow}
              onClick={() => setHistoryOpen(!historyOpen)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setHistoryOpen(!historyOpen) }}
            >
              <LayersIcon className="size-3.5 shrink-0" />
              <span>历史上下文 {historyMessages.length} 条 · {fmtTokens(historyTokens)}t</span>
              <div className="h-px flex-1 bg-foreground/[0.06]" />
              <ChevronRightIcon className={cn(sectionChevron, historyOpen && "rotate-90")} />
            </div>
            {historyOpen && (
              <div className="space-y-1.5 pt-1">
                {historyMessages.map((msg, i) => (
                  <MessageRow key={i} msg={msg} index={i} expanded={expandedMessages.has(i)} onToggle={toggleMessage} />
                ))}
              </div>
            )}
          </div>
        )}

        {/* ③ System 开销：一行收纳 */}
        {(systemOverheadTokens > 100 || systemPrompt || fullContext) && (
          <div>
            <div
              role="button"
              tabIndex={0}
              className={sectionRow}
              onClick={() => setSystemOpen(!systemOpen)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setSystemOpen(!systemOpen) }}
            >
              <ShieldIcon className="size-3.5 shrink-0" />
              <span>System 开销 {fmtTokens(systemOverheadTokens)}t</span>
              {fullContext?.tools && fullContext.tools.length > 0 && <span className="text-muted-foreground/50">· tools {fullContext.tools.length}</span>}
              {fullContext?.memoryFiles && <span className="text-muted-foreground/50">· memory</span>}
              {fullContext?.skills && <span className="text-muted-foreground/50">· skills</span>}
              <div className="h-px flex-1 bg-foreground/[0.06]" />
              <ChevronRightIcon className={cn(sectionChevron, systemOpen && "rotate-90")} />
            </div>
            {systemOpen && (
              <div className="space-y-2 pt-1">
                {systemPrompt && (
                  <div className={BLOCK}>
                    <div className={cn(BLOCK_ROW, "text-xs")}>
                      <span className="font-medium text-purple-600 dark:text-purple-400">System Prompt</span>
                      <span className="text-muted-foreground tabular-nums">{fmtTokens(estimateTokensFromChars(systemPrompt.length))}t</span>
                      <span className="flex-1" />
                      <CopyButton text={systemPrompt} className="size-4 text-muted-foreground hover:text-foreground" />
                    </div>
                    <div className={BLOCK_SUB}>
                      <ExpandableText clampPx={300}>
                        <pre className="text-xs font-mono whitespace-pre-wrap break-words text-foreground/80">{systemPrompt}</pre>
                      </ExpandableText>
                    </div>
                  </div>
                )}
                {fullContext?.tools && fullContext.tools.length > 0 && (
                  <div className={BLOCK}>
                    <div className={cn(BLOCK_ROW, "text-xs")}>
                      <span className="font-medium">Tools</span>
                      <span className="text-muted-foreground tabular-nums">{fullContext.tools.length}</span>
                    </div>
                    <div className={BLOCK_SUB}>
                      <ExpandableText clampPx={240} className="space-y-0.5">
                        {fullContext.tools.map(t => (
                          <div key={t.name} className="text-xs flex gap-2">
                            <span className="font-mono text-foreground/80 shrink-0">{t.name}</span>
                            <span className="text-muted-foreground truncate" title={t.description}>{t.description}</span>
                          </div>
                        ))}
                      </ExpandableText>
                    </div>
                  </div>
                )}
                {fullContext?.memoryFiles && (
                  <div className={BLOCK}>
                    <div className={cn(BLOCK_ROW, "text-xs")}>
                      <span className="font-medium">Memory Files</span>
                    </div>
                    <div className={BLOCK_SUB}>
                      <ExpandableText clampPx={200}>
                        <pre className="text-xs font-mono whitespace-pre-wrap break-words text-foreground/80">{fullContext.memoryFiles}</pre>
                      </ExpandableText>
                    </div>
                  </div>
                )}
                {fullContext?.skills && (
                  <div className={BLOCK}>
                    <div className={cn(BLOCK_ROW, "text-xs")}>
                      <span className="font-medium">Skills</span>
                    </div>
                    <div className={BLOCK_SUB}>
                      <ExpandableText clampPx={200}>
                        <pre className="text-xs font-mono whitespace-pre-wrap break-words text-foreground/80">{fullContext.skills}</pre>
                      </ExpandableText>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
