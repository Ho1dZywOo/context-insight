// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 离线内核：run 工作台在导出 HTML 里的「服务端」。拦截 fetch，按序应答——
// ① 静态档案（gather 期已按 UI 同一 URL 构造器存档的端点，精确键匹配）；
// ② 动态合成器（成员富轮仓为单一数据源）：run turns 分页（MergedTurnItem
//    投影 + member 过滤 + offset/page 切片 + errorDigest 预算）、turns/search
//    （与服务端同一 matchTurnSearch 单点）、turns/by-index（#N 跨成员解析）、
//    /api/observe/turn/[turnId]（详情形状映射 + 输入窗口惰性重建——与
//    turn-detail 处理器同一 input-reconstruct 纯函数，离线详情不再是缺口）；
// ③ 其余 /api/*（auto-refresh 探针 / 各 POST 动作）→ 空 200，防悬挂。
// 合成语义与四个服务端实现共享同一纯函数层，离线/在线不可能分裂。

import { matchTurnSearch, type TurnSearchRow } from "@/lib/observe/collectors/search"
import { selectInputContextTurns, toWireOrder, buildInputMessages, type PriorTurnRef } from "@/lib/ingest/input-reconstruct"
import { summarizeToolCallErrors, toolCallErrorMessage, type TurnErrorDigest } from "@/lib/tool-call-errors"

/** 成员富轮档案项：member-turns 端点 includeContent+includeToolDetail+
 * includeMeta 响应项的结构投影（超集字段容忍缺省） */
export interface MemberTurnItem {
  turnId: string
  turnIndex: number
  role: string
  content?: string | null
  contentJson?: string | null
  contentSummary: string | null
  agentName: string | null
  isSubagent: boolean
  subagentName: string | null
  subagentSessionId: string | null
  subagentType?: string | null
  dispatchStep?: string | null
  parentExecutionId?: string | null
  totalTokens: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  inputMessagesCount: number
  inputMessagesTokens?: number
  contextWindowPct: number | null
  systemOverheadTokens?: number
  latencyMs: number
  turnMs?: number
  createdAt: string
  completedAt: string | null
  model: string | null
  ttftMs?: number | null
  modelId?: string | null
  providerId?: string | null
  contextWindowLimit?: number | null
  finishReason: string | null
  toolCalls: Array<{
    id?: string
    toolCallId: string
    toolName: string
    dispatchBridgeId?: string | null
    argsJson?: string | null
    resultJson?: string | null
    state: string
    errorType?: string | null
    errorMessage?: string | null
    durationMs: number
    isSkillRelated?: boolean
  }>
  skillEvents: Array<{
    id?: string
    skillName: string
    skillVersion?: string | null
    eventType: string
    success: boolean
    errorMessage?: string | null
    argsJson?: string | null
    durationMs?: number
  }>
}

export interface OfflineMemberTurns {
  member: { taskId: string; label: string | null }
  /** 成员会话行 id（member-detail 提供；turn 详情/搜索归因用） */
  sessionId: string | null
  framework?: string | null
  items: MemberTurnItem[]
}

declare global {
  interface Window {
    __EXPORT_RUN_ID?: string
    __EXPORT_ARCHIVE?: Record<string, unknown>
    __EXPORT_MEMBER_TURNS?: OfflineMemberTurns[]
  }
}

// —— 合并轻投影（MergedTurnItem 形状，member 归因内嵌） ————————————

interface MergedItem {
  turnId: string
  turnIndex: number
  role: string
  contentSummary: string | null
  agentName: string | null
  isSubagent: boolean
  subagentName: string | null
  subagentSessionId: string | null
  parentExecutionId: string | null
  totalTokens: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  inputMessagesCount: number
  contextWindowPct: number | null
  latencyMs: number
  turnMs: number
  createdAt: string | null
  completedAt: string | null
  model: string | null
  finishReason: string | null
  subagentType: string | null
  dispatchStep: string | null
  toolCalls: Array<{ toolCallId: string; toolName: string; state: string; durationMs: number; resultJson?: string | null }>
  skillEvents: Array<{ skillName: string; eventType: string; success: boolean; errorMessage: string | null }>
  member: { taskId: string; label: string | null } | null
  errorDigest?: TurnErrorDigest
}

/** 成员富轮仓 → 全员合并轻投影序列（排序三键对齐 collector：coalesce 后
 *  事件时间 asc、turnId asc——档案 createdAt 已是 coalesce 值） */
export function mergedItemsOf(members: OfflineMemberTurns[]): MergedItem[] {
  // subagent null-model 回退（collector 同款：该 subagent 首个 assistant 的 model）
  const subagentModels = new Map<string, string>()
  for (const m of members) {
    for (const it of m.items) {
      if (it.role === "assistant" && it.subagentSessionId && it.model && !subagentModels.has(it.subagentSessionId)) {
        subagentModels.set(it.subagentSessionId, it.model)
      }
    }
  }
  const out: MergedItem[] = []
  for (const m of members) {
    for (const it of m.items) {
      if (it.agentName === "continuation") continue
      out.push({
        turnId: it.turnId,
        turnIndex: it.turnIndex,
        role: it.role,
        contentSummary: it.contentSummary,
        agentName: it.agentName,
        isSubagent: it.isSubagent,
        subagentName: it.subagentName,
        subagentSessionId: it.subagentSessionId,
        parentExecutionId: it.parentExecutionId ?? null,
        totalTokens: it.totalTokens,
        inputTokens: it.inputTokens,
        outputTokens: it.outputTokens,
        reasoningTokens: it.reasoningTokens,
        cacheReadTokens: it.cacheReadTokens,
        cacheWriteTokens: it.cacheWriteTokens,
        inputMessagesCount: it.inputMessagesCount,
        contextWindowPct: it.contextWindowPct,
        latencyMs: it.latencyMs,
        turnMs: it.turnMs ?? it.latencyMs,
        createdAt: it.createdAt,
        completedAt: it.completedAt,
        model: it.model || (it.subagentSessionId ? subagentModels.get(it.subagentSessionId) ?? null : null),
        finishReason: it.finishReason,
        subagentType: it.subagentType ?? null,
        dispatchStep: it.dispatchStep ?? null,
        toolCalls: it.toolCalls.map(tc => ({
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          state: tc.state,
          durationMs: tc.durationMs,
          resultJson: tc.resultJson,
        })),
        skillEvents: it.skillEvents.map(se => ({
          skillName: se.skillName,
          eventType: se.eventType,
          success: se.success,
          errorMessage: se.errorMessage ?? null,
        })),
        member: { taskId: m.member.taskId, label: m.member.label },
      })
    }
  }
  out.sort((a, b) => {
    const at = a.createdAt ?? ""
    const bt = b.createdAt ?? ""
    if (at !== bt) return at < bt ? -1 : 1
    return a.turnId < b.turnId ? -1 : a.turnId > b.turnId ? 1 : 0
  })
  return out
}

/** 轮级错误摘要（collector 的 includeErrorDigest 预算同口径：错误调用超集
 *  过滤 + 共享 summarize/toolCallErrorMessage 单点） */
function errorDigestOf(it: MemberTurnItem): TurnErrorDigest | null {
  const errCalls = it.toolCalls.filter(tc =>
    ["error", "failed"].includes(tc.state)
    || tc.errorType != null
    || (tc.resultJson ?? "").includes("<tool_use_error>")
    || (tc.resultJson ?? "").includes("Exit code"))
  const skillFail = it.skillEvents.some(se => !se.success && se.errorMessage != null)
  const truncated = it.finishReason === "length" || it.finishReason === "max_tokens"
  if (errCalls.length === 0 && !skillFail && !truncated) return null
  const patched = it.toolCalls.map(tc => {
    const err = errCalls.find(c => c.toolCallId === tc.toolCallId)
    return err != null
      ? { toolName: tc.toolName, state: tc.state, errorType: err.errorType, resultJson: err.resultJson }
      : tc
  })
  const summary = summarizeToolCallErrors(patched, it.skillEvents, it.finishReason)
  if (summary.total === 0) return null
  return {
    ...summary,
    messages: patched
      .map(tc => ({ toolName: tc.toolName, message: toolCallErrorMessage(tc) }))
      .filter(m => m.message !== ""),
    skillMessages: it.skillEvents
      .filter(se => !se.success && se.errorMessage != null)
      .map(se => ({ skillName: se.skillName, message: (se.errorMessage ?? "").substring(0, 60) })),
  }
}

// —— 合成器①：run turns 分页 ————————————————————————————

export function synthesizeRunTurns(
  members: OfflineMemberTurns[],
  query: URLSearchParams,
): { items: MergedItem[]; total: number; page: number; pageSize: number; offset: number | null } {
  const page = Math.max(1, Math.floor(Number(query.get("page") ?? "1")) || 1)
  const requested = Math.floor(Number(query.get("pageSize") ?? "0")) || 200
  const pageSize = Math.min(Math.max(requested, 1), 20000)
  const offsetParam = query.get("offset")
  const offsetRaw = offsetParam == null ? NaN : Number(offsetParam)
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.floor(offsetRaw) : null
  const member = query.get("member")
  const includeToolResult = query.get("includeToolResult") === "true"
  const includeErrorDigest = query.get("includeErrorDigest") === "true"

  let items = mergedItemsOf(members)
  if (member != null && member !== "") items = items.filter(it => it.member?.taskId === member)
  const total = items.length
  const start = offset != null ? offset : (page - 1) * pageSize
  const slice = items.slice(start, start + pageSize).map(it => {
    const next: MergedItem = { ...it }
    if (!includeToolResult) {
      next.toolCalls = it.toolCalls.map(tc => ({
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        state: tc.state,
        durationMs: tc.durationMs,
      }))
    }
    return next
  })
  if (includeErrorDigest) {
    const byTurnId = new Map(members.flatMap(m => m.items.map(it => [it.turnId, it] as const)))
    for (let i = 0; i < slice.length; i++) {
      const src = byTurnId.get(slice[i].turnId)
      const digest = src ? errorDigestOf(src) : null
      if (digest) slice[i] = { ...slice[i], errorDigest: digest }
    }
  }
  return { items: slice, total, page, pageSize, offset }
}

// —— 合成器②：turns/search ————————————————————————————

export function synthesizeSearch(
  members: OfflineMemberTurns[],
  keyword: string,
): { items: ReturnType<typeof matchTurnSearch>; total: number } {
  const memberOfRow = new Map<string, { taskId: string; label: string | null }>()
  for (const m of members) {
    if (m.sessionId != null) memberOfRow.set(m.sessionId, m.member)
  }
  const rows: TurnSearchRow[] = []
  for (const m of members) {
    for (const it of m.items) {
      if (it.agentName === "continuation") continue
      rows.push({
        id: it.turnId,
        sessionId: m.sessionId ?? "",
        turnIndex: it.turnIndex,
        role: it.role,
        content: it.content ?? null,
        contentSummary: it.contentSummary,
        agentName: it.agentName,
        isSubagent: it.isSubagent,
        subagentName: it.subagentName,
        subagentSessionId: it.subagentSessionId,
        createdAt_ts: new Date(it.createdAt),
        createdAt: new Date(it.createdAt),
        reasoningTokens: it.reasoningTokens,
        totalTokens: it.totalTokens,
        turnMs: it.turnMs ?? it.latencyMs,
        toolCalls: it.toolCalls.map(tc => ({
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          dispatchBridgeId: tc.dispatchBridgeId ?? null,
          argsJson: tc.argsJson ?? null,
          resultJson: tc.resultJson ?? null,
          errorMessage: tc.errorMessage ?? null,
        })),
      })
    }
  }
  const items = matchTurnSearch(rows, keyword, {
    memberOf: sessionId => memberOfRow.get(sessionId) ?? null,
  })
  return { items, total: items.length }
}

// —— 合成器③：turns/by-index（#N 跨成员解析，成员序对齐 gather） ————————

export function synthesizeByIndex(
  members: OfflineMemberTurns[],
  index: number,
): { items: Array<{ turnId: string; memberTaskId: string; memberLabel: string; contentSummary: string | null }> } {
  const items: Array<{ turnId: string; memberTaskId: string; memberLabel: string; contentSummary: string | null }> = []
  for (const m of members) {
    // 虚拟 continuation 轮不在 DB（by-index 服务端只见真实轮）——排除
    const hit = m.items.find(it => it.turnIndex === index && it.agentName !== "continuation")
    if (!hit) continue
    items.push({
      turnId: hit.turnId,
      memberTaskId: m.member.taskId,
      memberLabel: m.member.label ?? m.member.taskId,
      contentSummary: hit.contentSummary,
    })
  }
  return { items }
}

// —— 合成器④：/api/observe/turn/[turnId]（详情形状 + 输入窗口惰性重建） ————

function detailOf(members: OfflineMemberTurns[], turnId: string): Record<string, unknown> | null {
  for (const m of members) {
    const it = m.items.find(x => x.turnId === turnId)
    if (!it) continue
    // 虚拟 continuation 轮：系统开销取其压缩源轮（同会话同域，live 端点同值）
    let systemOverhead = it.systemOverheadTokens ?? 0
    if (it.agentName === "continuation") {
      const prefix = turnId.replace(/-continuation$/, "")
      const src = m.items.find(x => x.turnId === prefix)
      if (src) systemOverhead = src.systemOverheadTokens ?? 0
    }
    let inputMessagesJson: string | null = null
    if (it.role === "assistant") {
      // 先验池对齐服务端重建（DB 真实轮）：虚拟 continuation 轮不在库中，
      // 排除——窗口边界由真实 compaction 轮承担（selectInputContextTurns 同源）
      const prev = m.items
        .filter(x => x.agentName !== "continuation"
          && x.turnIndex < it.turnIndex
          && ["user", "assistant", "system", "tool_result"].includes(x.role)
          && (it.isSubagent && it.subagentSessionId
            ? x.subagentSessionId === it.subagentSessionId
            : !x.isSubagent))
        .map(x => ({ ...x, id: x.turnId }))
      const prior: PriorTurnRef[] = toWireOrder(selectInputContextTurns(prev as PriorTurnRef[], it.turnIndex, it.agentName)) as PriorTurnRef[]
      for (const p of prior) {
        const src = m.items.find(x => x.turnId === (p as { id: string }).id)
        if (src && p.role === "assistant") {
          p.toolCalls = src.toolCalls.map(tc => ({
            toolName: tc.toolName,
            argsJson: tc.argsJson ?? null,
            resultJson: tc.resultJson ?? null,
            isSkillRelated: tc.isSkillRelated ?? false,
          }))
        }
      }
      const compactionTotals = new Map<string, number>()
      for (const p of m.items) {
        if (p.agentName === "compaction") compactionTotals.set(p.turnId, p.totalTokens)
      }
      inputMessagesJson = buildInputMessages(
        prior,
        { agentName: it.agentName, inputMessagesTokens: it.inputMessagesTokens ?? 0, outputTokens: it.outputTokens },
        compactionTotals,
      )
    }
    const inputMessagesCount = it.agentName !== "compaction" && inputMessagesJson
      ? JSON.parse(inputMessagesJson).length
      : it.inputMessagesCount
    return {
      turnId: it.turnId,
      sessionId: m.sessionId,
      taskId: m.member.taskId,
      turnIndex: it.turnIndex,
      role: it.role,
      content: it.content ?? null,
      contentJson: it.contentJson ?? null,
      contentSummary: it.contentSummary,
      inputMessagesJson,
      inputMessagesCount,
      inputMessagesTokens: it.inputMessagesTokens ?? 0,
      contextWindowPct: it.contextWindowPct,
      systemOverheadTokens: systemOverhead,
      temperature: null,
      maxTokens: null,
      systemPrompt: null,
      fullContext: null,
      agentName: it.agentName,
      subagentName: it.subagentName,
      subagentSessionId: it.subagentSessionId,
      subagentType: it.subagentType ?? null,
      dispatchStep: it.dispatchStep ?? null,
      isSubagent: it.isSubagent,
      totalTokens: it.totalTokens,
      inputTokens: it.inputTokens,
      outputTokens: it.outputTokens,
      reasoningTokens: it.reasoningTokens,
      cacheReadTokens: it.cacheReadTokens,
      cacheWriteTokens: it.cacheWriteTokens,
      latencyMs: it.latencyMs,
      ttftMs: it.ttftMs ?? null,
      createdAt: it.createdAt,
      completedAt: it.completedAt,
      model: it.model,
      modelId: it.modelId ?? null,
      providerId: it.providerId ?? null,
      contextWindowLimit: it.contextWindowLimit ?? null,
      finishReason: it.finishReason,
      toolCalls: it.toolCalls.map(tc => ({
        id: tc.id,
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        argsJson: tc.argsJson ?? null,
        resultJson: tc.resultJson ?? null,
        state: tc.state,
        errorType: tc.errorType ?? null,
        errorMessage: tc.errorMessage ?? null,
        startedAt: null,
        completedAt: null,
        durationMs: tc.durationMs,
        dispatchBridgeId: tc.dispatchBridgeId ?? null,
        isSkillRelated: tc.isSkillRelated ?? false,
      })),
      skillEvents: it.skillEvents.map(se => ({
        id: se.id,
        skillName: se.skillName,
        skillVersion: se.skillVersion ?? null,
        eventType: se.eventType,
        success: se.success,
        errorMessage: se.errorMessage ?? null,
        argsJson: se.argsJson ?? null,
        startedAt: null,
        completedAt: null,
        durationMs: se.durationMs ?? 0,
      })),
    }
  }
  return null
}

// —— fetch 拦截链 ——————————————————————————————————

export function urlKeyOf(u: string): string {
  try {
    const parsed = new URL(u, "http://e")
    const params = [...parsed.searchParams.entries()].sort().map(([k, v]) => `${k}=${v}`).join("&")
    return params ? `${parsed.pathname}?${params}` : parsed.pathname
  } catch {
    return u.split("?")[0]
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } })
}

export function createOfflineFetch(members: OfflineMemberTurns[], archive: Record<string, unknown>, runId: string, origFetch: typeof fetch): typeof fetch {
  const runPrefix = `/api/observe/run/${encodeURIComponent(runId)}`
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const u = (() => { try { return new URL(url, "http://e") } catch { return null } })()
    const pathname = u?.pathname ?? url.split("?")[0]
    const query = u?.searchParams ?? new URLSearchParams()

    // ① 静态档案：精确 URL 键（gather 与 UI 用同一 URL 构造器，键按构造相等）
    const hit = archive[urlKeyOf(url)]
    if (hit !== undefined) return Promise.resolve(jsonResponse(hit))

    // ② 成员富轮端点（Replay 消费；档案即仓，query 形态不作键）
    if (pathname === `${runPrefix}/member-turns`) {
      return Promise.resolve(jsonResponse({ items: members.find(m => m.member.taskId === query.get("member"))?.items ?? [], total: 0 }))
    }
    // ③ run turns 分页（任意 member/page/offset 组合）
    if (pathname === `${runPrefix}/turns`) {
      return Promise.resolve(jsonResponse(synthesizeRunTurns(members, query)))
    }
    if (pathname === `${runPrefix}/turns/search`) {
      const keyword = query.get("keyword")
      if (!keyword || keyword.trim().length === 0) return Promise.resolve(jsonResponse({ error: "Missing required param: keyword" }, 400))
      return Promise.resolve(jsonResponse(synthesizeSearch(members, keyword)))
    }
    if (pathname === `${runPrefix}/turns/by-index`) {
      const raw = query.get("index")
      const index = raw != null && /^-?\d+$/.test(raw) ? Number(raw) : NaN
      if (!Number.isInteger(index) || index < 0) return Promise.resolve(jsonResponse({ error: "Missing or invalid param: index" }, 400))
      return Promise.resolve(jsonResponse(synthesizeByIndex(members, index)))
    }
    // ④ 轮详情（turnId 全局唯一）
    const turnMatch = pathname.match(/^\/api\/observe\/turn\/(.+)$/)
    if (turnMatch) {
      const detail = detailOf(members, decodeURIComponent(turnMatch[1]))
      if (detail) return Promise.resolve(jsonResponse(detail))
      return Promise.resolve(jsonResponse({ error: `Turn not found: "${turnMatch[1]}"` }, 404))
    }
    // ⑤ 其余 /api/*（auto-refresh 探针 / 写路径动作）：空 200 防悬挂
    if (pathname.startsWith("/api/") || url.includes("/api/")) {
      return Promise.resolve(new Response("", { status: 200, headers: { "content-type": "text/plain" } }))
    }
    return origFetch(input, init)
  }) as typeof fetch
}

/** 内核装弹：entry 挂载前调用（读 window 档案并替换 fetch/EventSource） */
export function installOfflineKernel(): void {
  const members = window.__EXPORT_MEMBER_TURNS ?? []
  const archive = window.__EXPORT_ARCHIVE ?? {}
  const runId = window.__EXPORT_RUN_ID ?? ""
  const origFetch = window.fetch.bind(window)
  window.fetch = createOfflineFetch(members, archive, runId, origFetch)
}
