"use client"
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Turn Inspector · Session Player 布局：
//   ① 导航条（sticky 全出血，毛玻璃）：圆形走查钮 ◀ ▶ + Turn n/total 标题
//      与元信息行 + 身份药丸 + 刷新钮，下衬时间线胶片（播放头 + 刻度）——
//      「会话是一卷胶片，turn 是一帧」，←/→ 与点击同为走查语义
//   ② 指标瓦片：耗时 / token / 窗口三张圆角卡横排（小标签上 + 大数字下 +
//      微条 + 图例），数值 tabular 三卡对齐
//   ③ 叙事舞台：Δ 优先输入卡（阅读主体）→ 输出卡——所有文本块（正文 /
//      thinking / 工具调用 / 输入消息）共用 detail-blocks 统一块语法
// 视觉语法：灰画布 + 无边框圆角分组卡（卡靠底色对比立足，不靠描边）、
// 统一灰底圆角块 + 块内发丝分节、状态 = 字色不框色、时长 muted
// tabular、动效只走 transform/opacity。
import { useState, useEffect } from "react"
import { ChevronLeftIcon, ChevronRightIcon, TimerIcon, CoinsIcon, GaugeIcon, ZapIcon, RefreshCwIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { LlmOutputView } from "./LlmOutputView"
import { ToolCallList } from "./ToolCallList"
import { SkillEventList } from "./SkillEventList"
import { TurnFilmstrip, type FilmstripTurn } from "./TurnFilmstrip"
import { TurnInputCard } from "./TurnInputCard"
import type { TurnHighlight } from "@/lib/shared/highlight"

export interface TurnDetailData {
  turnId: string
  /** 成员 taskId（run 节点归属解析；会话级消费方可缺省） */
  taskId?: string | null
  turnIndex: number
  role: string
  content: string | null
  contentJson: string | null
  contentSummary: string | null
  inputMessagesJson: string | null
  inputMessagesCount: number
  inputMessagesTokens: number
  contextWindowPct: number | null
  systemOverheadTokens?: number
  systemPrompt?: string | null
  fullContext?: {
    tools: Array<{ name: string; description: string }>
    memoryFiles: string
    skills: string
  } | null
  agentName: string | null
  subagentName: string | null
  subagentSessionId?: string | null
  isSubagent: boolean
  totalTokens: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  contextWindowLimit?: number
  latencyMs: number
  ttftMs: number | null
  createdAt: string | null
  completedAt: string | null
  model: string | null
  modelId: string | null
  providerId: string | null
  finishReason: string | null
  toolCalls: Array<{
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
  }>
  skillEvents: Array<{
    id: string
    skillName: string
    skillVersion: number | null
    eventType: string
    success: boolean
    errorMessage: string | null
    argsJson: string | null
    durationMs: number
  }>
}

const ROLE_DOT: Record<string, string> = {
  user: "bg-blue-500",
  assistant: "bg-emerald-500",
  system: "bg-slate-400",
  tool_result: "bg-teal-500",
  command: "bg-slate-400",
  continuation: "bg-purple-400",
  compaction: "bg-amber-400",
}

const ROLE_PILL: Record<string, string> = {
  user: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  assistant: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  system: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
  tool_result: "bg-teal-500/10 text-teal-600 dark:text-teal-400",
  command: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
  continuation: "bg-purple-500/10 text-purple-600 dark:text-purple-400",
  compaction: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
}

function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}min`
}

// 大数字拆量级单位（数值大字 + 单位小字，图例仍走 formatLatency）
function splitLatency(ms: number): { n: string; u: string } {
  if (ms < 1000) return { n: `${ms}`, u: "ms" }
  if (ms < 60000) return { n: (ms / 1000).toFixed(1), u: "s" }
  return { n: (ms / 60000).toFixed(1), u: "min" }
}

function fmtTokens(n: number): string {
  if (n === 0) return "0"
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return `${n}`
}

function formatTimestamp(ts: string | null): string {
  if (!ts) return "N/A"
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return ts
  }
}

export function TurnDetail({ turn, highlight, onRefresh, subagentLabel, onPrevTurn, onNextTurn, prevInputTokens, prevInputMessagesCount, filmstripTurns, onSelectTurn, entrance }: {
  turn: TurnDetailData
  highlight?: TurnHighlight | null
  onRefresh?: () => void
  subagentLabel?: string
  onPrevTurn?: () => void
  onNextTurn?: () => void
  prevInputTokens?: number | null
  prevInputMessagesCount?: number | null
  filmstripTurns?: FilmstripTurn[]
  onSelectTurn?: (turnId: string) => void
  /** 点击选轮首次落地时启用：内容卡按加载骨架同款节奏阶梯入场；
   *  走查与缓存命中不传——无感切换 = 无动画 */
  entrance?: boolean
}) {
  // ←/→ 逐轮走查（输入框聚焦时不劫持）；胶片点击与播放按钮共用同一导航语义
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return
      if (e.key === "ArrowLeft" && onPrevTurn) { e.preventDefault(); onPrevTurn() }
      if (e.key === "ArrowRight" && onNextTurn) { e.preventDefault(); onNextTurn() }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [onPrevTurn, onNextTurn])

  if (!turn) return null

  const contentLength = (turn.content ?? "").length + (turn.contentJson ?? "").length
  const isLongContent = contentLength > 10000
  const toolOverheadTokens = Math.round(
    turn.toolCalls.reduce((s, tc) => s + (tc.argsJson?.length ?? 0) + (tc.resultJson?.length ?? 0), 0) / 3.5
  )
  const skillToolCalls = turn.toolCalls.filter(tc => tc.isSkillRelated).map(tc => ({
    id: tc.id, toolCallId: tc.toolCallId, toolName: tc.toolName,
    argsJson: tc.argsJson, resultJson: tc.resultJson, state: tc.state, durationMs: tc.durationMs,
  }))

  // ── 指标条数字 ──
  const contextWindowLimit = turn.contextWindowLimit ?? 1000000
  const totalInput = turn.inputTokens + turn.cacheReadTokens + turn.cacheWriteTokens
  const totalOutput = turn.outputTokens + turn.reasoningTokens
  const windowPct = contextWindowLimit > 0 ? (totalInput / contextWindowLimit) * 100 : 0
  // 单轮耗时 = 模型请求（wire latency）+ 本轮发起的工具执行：现网数据下
  // 永远可分解的两段（ttft 仅 cpx 捕获源有，缺省不显）
  const hasTtft = turn.ttftMs != null && turn.ttftMs > 0 && turn.ttftMs < turn.latencyMs
  const streamMs = hasTtft ? turn.latencyMs - turn.ttftMs! : turn.latencyMs
  const toolTotalMs = turn.toolCalls.reduce((s, tc) => s + Math.max(tc.durationMs, 0), 0)
  const modelMs = Math.max(turn.latencyMs, 0)
  const turnTotalMs = modelMs + toolTotalMs
  const delta = prevInputTokens != null && prevInputTokens > 0 ? totalInput - prevInputTokens : null
  const deltaPct = delta != null ? (delta / prevInputTokens!) * 100 : null

  // 时间线位置计数（Turn n/total）：以胶片序列为准（与点击走查同一坐标系）
  const filmTotal = filmstripTurns?.length ?? 0
  const filmPos = filmstripTurns?.findIndex(t => t.turnId === turn.turnId) ?? -1

  const iconBtn = "flex size-8 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground active:scale-90 cursor-pointer select-none transition-[color,background-color,transform] duration-200"

  // 卡片入场（entrance）：淡入 + 底部滑移 500ms，延迟阶梯复用加载骨架的
  // 节奏（瓦片 0/70/140 → 输入 210 → 舞台 280）；fill-mode-backwards 让
  // 延迟期保持初始态，纯 CSS 无运行时成本
  const entCls = entrance ? "animate-in fade-in slide-in-from-bottom-4 duration-500 fill-mode-backwards" : ""
  const entDelay = (ms: number) => (entrance ? { animationDelay: `${ms}ms` } : undefined)

  return (
    <div id="turn-detail-top" data-turn-detail={turn.turnId} className="flex min-h-full flex-col bg-muted/40">
      {/* ① 导航条 + 胶片轨（sticky 全出血，毛玻璃）：走查钮 | 标题/位置 + 元信息 | 身份药丸 + 刷新。
          入场时快速淡入（chrome 不位移只浮现）；延迟窗口内换轮则原位更新 */}
      <div className={cn(
        "sticky top-0 z-20 border-b border-foreground/[0.07] bg-muted/40 backdrop-blur-xl",
        entrance && "animate-in fade-in duration-300 fill-mode-backwards",
      )}>
        <div className="flex items-center gap-2.5 px-4 py-2.5">
          <div className="flex shrink-0 items-center gap-1.5">
            {onPrevTurn && (
              <span role="button" tabIndex={0} onClick={onPrevTurn}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onPrevTurn() }}
                className={iconBtn} title="上一轮（←）">
                <ChevronLeftIcon className="size-4" />
              </span>
            )}
            {onNextTurn && (
              <span role="button" tabIndex={0} onClick={onNextTurn}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onNextTurn() }}
                className={iconBtn} title="下一轮（→）">
                <ChevronRightIcon className="size-4" />
              </span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-1.5 whitespace-nowrap">
              <span className="text-base font-semibold leading-tight tracking-tight tabular-nums" title="turn 编号（与列表/刻度一致） · 播放位置">
                Turn #{turn.turnIndex}
              </span>
              {filmTotal > 1 && filmPos >= 0 && (
                <span className="text-xs text-muted-foreground tabular-nums">{filmPos + 1}/{filmTotal}</span>
              )}
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              {turn.model && <span className="truncate font-medium text-foreground/70">{turn.model}</span>}
              {turn.finishReason && <span className="shrink-0">· {turn.finishReason}</span>}
              {turn.createdAt && <span className="shrink-0 tabular-nums">· {formatTimestamp(turn.createdAt)}</span>}
            </div>
          </div>
          <span className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium",
            ROLE_PILL[turn.role] ?? "bg-foreground/[0.06] text-muted-foreground",
          )}>
            <span className={cn("inline-block size-1.5 rounded-full align-middle", ROLE_DOT[turn.role] ?? "bg-slate-300")} aria-hidden />
            {turn.role}
          </span>
          {turn.isSubagent && (
            <span className="inline-flex shrink-0 items-center rounded-full bg-orange-500/10 px-2.5 py-1 text-[11px] font-medium text-orange-600 dark:text-orange-400">
              {subagentLabel ?? turn.subagentName ?? "subagent"}
            </span>
          )}
          {turn.agentName && (
            <span className="hidden shrink-0 rounded-full bg-foreground/[0.05] px-2.5 py-1 text-[11px] text-muted-foreground sm:inline">{turn.agentName}</span>
          )}
          {isLongContent && (
            <span className="hidden shrink-0 rounded-full bg-foreground/[0.05] px-2.5 py-1 text-[11px] text-muted-foreground md:inline" title="正文超过 10k 字符">long</span>
          )}
          {onRefresh && (
            <span role="button" tabIndex={0} onClick={onRefresh}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onRefresh() }}
              className={cn(iconBtn, "shrink-0")}
              title="重新加载本 turn（会话仍在进行时，详情不会随自动同步刷新，点此取最新）">
              <RefreshCwIcon className="size-4" />
            </span>
          )}
        </div>
        {filmstripTurns && filmstripTurns.length > 1 && onSelectTurn && (
          <div className="px-3 pt-1 pb-2">
            <TurnFilmstrip turns={filmstripTurns} selectedTurnId={turn.turnId} onSelect={onSelectTurn} />
          </div>
        )}
      </div>

      {/* ②③④ 随 turn 换 key 重挂（状态干净重置）。入场动画只在点击选轮的
          首次落地时由 entrance 挂上；走查与缓存命中不入场——无感切换 =
          无动画，opacity 从 0 起步的 fade 本身就是一次可感知的「灭-亮」 */}
      <div key={turn.turnId} className="flex flex-1 flex-col gap-3 px-4 py-4">
      {/* ② 指标瓦片：三卡同构四槽（小标签/大数字/微条/图例）。大数字槽固定
          h-7 且禁换行——换行内容（窗口 Δ 药丸）下沉图例行，条形在三卡间
          永远同一水平线 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {/* 单轮耗时：模型 vs 工具双色分段——两段数据现网永远可得，
            不像 ttft 那样依赖捕获源；总额回答"这轮花了多久"，分段条
            回答"时间花在了哪" */}
        <div className={cn("rounded-2xl bg-card p-4", entCls)} style={entDelay(0)}>
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
            title="模型请求时长 + 本轮发起的工具执行时长">
            <TimerIcon className="size-3.5" /> 单轮耗时
          </div>
          <div className="mt-2 h-7 flex items-baseline whitespace-nowrap">
            {(() => {
              if (turnTotalMs <= 0) return <span className="text-2xl font-semibold tracking-tight text-muted-foreground">—</span>
              const lat = splitLatency(turnTotalMs)
              return (
                <span className="text-[28px] font-semibold leading-none tracking-tight tabular-nums">
                  {lat.n}<span className="ml-0.5 text-sm font-medium text-muted-foreground">{lat.u}</span>
                </span>
              )
            })()}
          </div>
          {turnTotalMs > 0 && (
            <div className="mt-2.5 flex h-1.5 gap-px overflow-hidden rounded-full bg-foreground/[0.06]">
              <div className="h-full bg-amber-500" style={{ width: `${(modelMs / turnTotalMs) * 100}%` }} title={`模型 ${formatLatency(modelMs)}`} />
              {toolTotalMs > 0 && (
                <div className="h-full bg-orange-500" style={{ width: `${(toolTotalMs / turnTotalMs) * 100}%` }} title={`工具 ${formatLatency(toolTotalMs)}`} />
              )}
            </div>
          )}
          {turnTotalMs > 0 && (
            <div className="mt-2 text-[11px] text-muted-foreground tabular-nums flex items-center gap-2 flex-wrap">
              <span className="inline-flex items-center gap-1">
                <span className="size-1.5 rounded-full bg-amber-500" />模型 {formatLatency(modelMs)}
              </span>
              {toolTotalMs > 0 && (
                <span className="inline-flex items-center gap-1">
                  <span className="size-1.5 rounded-full bg-orange-500" />工具 {formatLatency(toolTotalMs)} · {turn.toolCalls.length} calls
                </span>
              )}
            </div>
          )}
          {hasTtft && (
            <div className="mt-0.5 text-[11px] text-muted-foreground/75 tabular-nums" title="模型段内分解（cpx 捕获实测）">
              首 token {formatLatency(turn.ttftMs!)} · 流式 {formatLatency(streamMs)}
            </div>
          )}
        </div>
        {/* token 瓦片 */}
        <div className={cn("rounded-2xl bg-card p-4", entCls)} style={entDelay(70)}>
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <CoinsIcon className="size-3.5" /> Token
          </div>
          <div className="mt-2 h-7 flex items-baseline gap-1.5 tabular-nums leading-none whitespace-nowrap">
            <span className="text-sm font-medium text-muted-foreground">入</span>
            <span className="text-[28px] font-semibold tracking-tight text-blue-600 dark:text-blue-400">{fmtTokens(totalInput)}</span>
            <span className="text-sm text-muted-foreground">→</span>
            <span className="text-sm font-medium text-muted-foreground">出</span>
            <span className="text-[28px] font-semibold tracking-tight text-emerald-600 dark:text-emerald-400">{fmtTokens(totalOutput)}</span>
          </div>
          <div className="mt-2.5 flex h-1.5 gap-px overflow-hidden rounded-full bg-foreground/[0.06]" title={`缓存读 ${fmtTokens(turn.cacheReadTokens)} · 新输入 ${fmtTokens(turn.inputTokens)} · 缓存写 ${fmtTokens(turn.cacheWriteTokens)} · 推理 ${fmtTokens(turn.reasoningTokens)} · 文本/参数 ${fmtTokens(turn.outputTokens)}${toolOverheadTokens > 0 ? ` · 工具往返 ${fmtTokens(toolOverheadTokens)}` : ""}`}>
            {[
              { v: turn.cacheReadTokens, c: "bg-blue-800" },
              { v: turn.inputTokens, c: "bg-blue-500" },
              { v: turn.cacheWriteTokens, c: "bg-blue-300" },
              { v: turn.reasoningTokens, c: "bg-purple-500" },
              { v: turn.outputTokens, c: "bg-emerald-500" },
              ...(toolOverheadTokens > 0 ? [{ v: toolOverheadTokens, c: "bg-orange-500" }] : []),
            ].filter(s => s.v > 0).map((s, i) => (
              <div key={i} className={cn("h-full", s.c)} style={{ width: `${(s.v / (totalInput + totalOutput + toolOverheadTokens)) * 100}%`, minWidth: "1px" }} />
            ))}
          </div>
          <div className="mt-2 text-[11px] text-muted-foreground tabular-nums leading-relaxed">
            缓存读 {fmtTokens(turn.cacheReadTokens)} · 新 {fmtTokens(turn.inputTokens)} · 写 {fmtTokens(turn.cacheWriteTokens)}
            {" "}· 推理 {fmtTokens(turn.reasoningTokens)} · 文本/参数 {fmtTokens(turn.outputTokens)}
            {toolOverheadTokens > 0 && <> · 工具 {fmtTokens(toolOverheadTokens)}</>}
          </div>
        </div>
        {/* 窗口瓦片 */}
        <div className={cn("rounded-2xl bg-card p-4", entCls)} style={entDelay(140)}>
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <GaugeIcon className="size-3.5" /> 上下文窗口
          </div>
          <div className="mt-2 h-7 flex items-baseline gap-1.5 whitespace-nowrap">
            <span className={cn(
              "text-[28px] font-semibold leading-none tracking-tight tabular-nums",
              windowPct > 80 ? "text-red-600 dark:text-red-400" : windowPct > 50 ? "text-orange-600 dark:text-orange-400" : "",
            )}>
              {windowPct.toFixed(1)}%
            </span>
            <span className="text-xs text-muted-foreground tabular-nums">/ {fmtTokens(contextWindowLimit)}</span>
          </div>
          <div className="mt-2.5 flex h-1.5 overflow-hidden rounded-full bg-foreground/[0.06]">
            <div className={cn("h-full transition-[width]", windowPct > 80 ? "bg-red-500" : windowPct > 50 ? "bg-orange-500" : "bg-blue-500")} style={{ width: `${Math.min(windowPct, 100)}%` }} />
          </div>
          <div className="mt-2 text-[11px] text-muted-foreground tabular-nums flex items-center gap-2 flex-wrap">
            <span>输入合计 {fmtTokens(totalInput)}</span>
            {delta != null && (
              <span
                className={cn(
                  "rounded-full bg-foreground/[0.05] px-1.5",
                  delta > 0 ? "text-muted-foreground" : "text-emerald-600 dark:text-emerald-400",
                )}
                title="同一 agent 维度，与上一轮输入 token 的差值"
              >
                较上轮 {delta >= 0 ? "▲" : "▼"} {fmtTokens(Math.abs(delta))}
                {deltaPct != null && Math.abs(deltaPct) >= 1 ? ` (${deltaPct > 0 ? "+" : ""}${deltaPct.toFixed(0)}%)` : ""}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ③ 输入卡（Δ 优先）：默认折叠（三段一行收纳，与输出默认展开成对）；
          阅读序 = 输入（agent 看到什么）→ 输出（agent 做了什么）。
          包裹层只为入场动画服务（无入场时是透明容器，不改内部结构） */}
      {turn.inputMessagesCount > 0 && (
        <div className={entCls || undefined} style={entDelay(210)}>
          <TurnInputCard
            key={`in-${turn.turnId}`}
            inputMessagesJson={turn.inputMessagesJson}
            inputMessagesCount={turn.inputMessagesCount}
            inputMessagesTokens={turn.inputMessagesTokens}
            contextWindowPct={turn.contextWindowPct}
            systemOverheadTokens={turn.systemOverheadTokens ?? 0}
            systemPrompt={turn.systemPrompt ?? null}
            fullContext={turn.fullContext ?? null}
            prevInputMessagesCount={prevInputMessagesCount}
          />
        </div>
      )}

      {/* ④ 叙事舞台（全宽分组卡）：正文与它发起的调用同居一张卡 */}
      <div data-testid="stage-card" className={cn("min-w-0 rounded-2xl bg-card", entCls)} style={entDelay(280)}>
        <LlmOutputView
          key={`out-${turn.turnId}`}
          content={turn.content}
          contentJson={turn.contentJson}
          outputTokens={turn.outputTokens}
          reasoningTokens={turn.reasoningTokens}
          role={turn.role}
          highlight={highlight}
          toolCallCount={turn.toolCalls.length}
          finishReason={turn.finishReason}
        />
        <OutputSections
          key={`sec-${turn.turnId}`}
          toolCalls={turn.toolCalls}
          skillEvents={turn.skillEvents}
          skillToolCalls={skillToolCalls}
          highlight={highlight}
        />
      </div>
      </div>

    </div>
  )
}

// 舞台卡内的调用段：Tool Calls 与 Skills 合并为一段——技能相关调用本就
// 出现在 ToolCallList 里，SkillEvent 的增量信息只有「技能名 + 版本 + 成败
// + 时长」（一枚徽标的信息量），压成段头技能徽标条；点击徽标条才展开
// 事件明细（SkillEventList），三角唯一触发点契约保持。
function OutputSections({ toolCalls, skillEvents, skillToolCalls, highlight }: {
  toolCalls: TurnDetailData["toolCalls"]
  skillEvents: TurnDetailData["skillEvents"]
  skillToolCalls: Array<{ id: string; toolCallId: string; toolName: string; argsJson: string | null; resultJson: string | null; state: string; durationMs: number }>
  highlight?: TurnHighlight | null
}) {
  const [toolsOpen, setToolsOpen] = useState(true)
  const [skillsOpen, setSkillsOpen] = useState(false)

  if (toolCalls.length === 0 && skillEvents.length === 0) return null

  const skillGroups = new Map<string, { version: number | null; success: boolean; ms: number }>()
  for (const se of skillEvents) {
    const g = skillGroups.get(se.skillName) ?? { version: null, success: true, ms: 0 }
    g.version ??= se.skillVersion
    g.success = g.success && se.success
    g.ms += Math.max(se.durationMs, 0)
    skillGroups.set(se.skillName, g)
  }

  const toggleCls = "shrink-0 px-2 py-1 -mr-2 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 cursor-pointer select-none"

  return (
    <section className="border-t border-foreground/[0.06]">
      <div className="flex items-center gap-2.5 px-4 py-2.5 flex-wrap">
        {toolCalls.length > 0 && (
          <span className="text-xs font-medium text-muted-foreground">Tool Calls</span>
        )}
        {toolCalls.length > 0 && (
          <span className="text-xs text-muted-foreground tabular-nums">{toolCalls.length}</span>
        )}
        <div className="h-px flex-1 bg-foreground/[0.08] min-w-6" />
        {skillEvents.length > 0 && (
          <span
            role="button"
            tabIndex={0}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground cursor-pointer select-none tabular-nums"
            title="技能事件明细"
            onClick={() => setSkillsOpen(!skillsOpen)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setSkillsOpen(!skillsOpen) }}
          >
            <ZapIcon className="size-3.5 shrink-0" />
            {[...skillGroups.entries()].map(([name, g], i) => (
              <span key={name} className="flex items-center gap-1">
                {i > 0 && <span className="text-muted-foreground/50">·</span>}
                <span className="font-medium text-foreground/80">{name}</span>
                {g.version != null && <span className="text-muted-foreground/70">v{g.version}</span>}
                <span className={g.success ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}>{g.success ? "✓" : "✗"}</span>
                <span className="text-muted-foreground/70">{formatLatency(g.ms)}</span>
              </span>
            ))}
            {skillsOpen ? "▾" : "▸"}
          </span>
        )}
        {toolCalls.length > 0 && (
          <span
            role="button"
            tabIndex={0}
            className={toggleCls}
            title="工具列表"
            onClick={() => setToolsOpen(!toolsOpen)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setToolsOpen(!toolsOpen) }}
          >
            {toolsOpen ? "▼" : "▶"}
          </span>
        )}
      </div>
      {toolsOpen && toolCalls.length > 0 && (
        <div className="px-4 pb-3">
          <ToolCallList toolCalls={toolCalls} highlight={highlight} />
        </div>
      )}
      {skillsOpen && (
        <div className="border-t border-foreground/[0.06] px-4 pb-3 pt-2">
          <SkillEventList skillEvents={skillEvents} skillToolCalls={skillToolCalls} />
        </div>
      )}
    </section>
  )
}
