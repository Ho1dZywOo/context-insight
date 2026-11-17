// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Run 时间口径单一源（Overview 与 Perf 必须展示同一组数字）。
//
// Wall Clock（墙钟）：
//   从最早 execution span.start 到最晚 execution span.end 的真实时间跨度。
//   多成员并行时重叠只算一次，不能用 Σ成员 session 时长代替。
//
// Agent Active（活跃）：
//   把每个 turn 的 createdAt_ts 当成一个事件点，再加上 assistant 推理窗口；
//   所有区间合并后，相邻间隔 <= 5min 的片段继续合并。
//   这是“事件聚类活跃”，不是工具连续执行时长，也不使用整个 turn 生命周期。
//
// LLM Active（模型活跃）：
//   只统计 assistant 的模型推理窗口，主 Agent 和 subagent 都包含，重叠只算一次。
//   不包含工具执行、等待工具结果、等待资源或用户空闲。
//   注意 native 各框架对 latencyMs 的语义不完全一致（codex 是模型生成跨度；
//   opencode/claude 可能是 completed-created 的 turn 跨度），因此所有 native
//   推理窗口也统一限制在 10min 内，避免把异常长 turn 当成模型推理。
//
// Idle（非活跃）：
//   Wall Clock - Agent Active。
//
// 必须满足：LLM Active <= Agent Active <= Wall Clock。

import {
  ACTIVE_GAP_THRESHOLD_MS,
  ACTIVE_LATENCY_CAP_MS,
  clusterActiveSegments,
} from '@/lib/active-time'
import { buildAgentSpans } from '@/lib/observe/agent-spans'
import { isProxyVersion } from '@/lib/shared/session-format'

export interface RunTimeSessionRow {
  id: string
  startTime: Date
  endTime: Date | null
  version: string | null
}

export interface RunTimeTurnRow {
  sessionId: string
  role: string
  isSubagent: boolean
  subagentSessionId: string | null
  createdAt_ts: Date | null
  completedAt: Date | null
  latencyMs: number
}

export interface RunTimeSummary {
  start: string | null
  end: string | null
  wallMs: number
  activeMs: number | null
  idleMs: number | null
  llmActiveMs: number
}

export interface RunTimeObservability {
  summary: RunTimeSummary
  /** 每个成员会话自己的固定 5min 事件聚类活跃值；run 级 Active 另做全成员并集。 */
  activeByRow: Map<string, { activeMs: number | null }>
}

function sumSegments(segments: Array<{ start: number; end: number }>): number {
  return segments.reduce((sum, seg) => sum + Math.max(0, seg.end - seg.start), 0)
}

function llmWindowOf(turn: RunTimeTurnRow, isProxy: boolean): [number, number] | null {
  const ts = turn.createdAt_ts?.getTime()
  if (!Number.isFinite(ts) || turn.role !== 'assistant' || turn.latencyMs <= 0) return null

  // proxy：createdAt_ts 是响应完成时刻，用 wire latency 向前反推；
  // latency 可能包含异常伪值，因此反推窗口最多 10min。
  if (isProxy && !turn.completedAt) {
    const latency = Math.min(turn.latencyMs, ACTIVE_LATENCY_CAP_MS)
    return [ts! - latency, ts!]
  }

  // native：createdAt_ts 是 turn 开始。codex 的 latencyMs 是模型生成跨度；
  // opencode/claude 的 latencyMs 可能等于 completed-created，包含工具执行/等待。
  // 各框架无法在通用 TurnRow 上完全区分，因此统一取 10min 可信上界；
  // completedAt 只作为 turn 边界上界，不能直接当 LLM 推理结束。
  const completed = turn.completedAt?.getTime()
  const latency = Math.min(turn.latencyMs, ACTIVE_LATENCY_CAP_MS)
  const end = Number.isFinite(completed)
    ? Math.min(ts! + latency, completed!)
    : ts! + latency
  return end > ts! ? [ts!, end] : null
}

export function buildRunTimeObservability(
  sessions: RunTimeSessionRow[],
  turns: RunTimeTurnRow[],
): RunTimeObservability {
  const turnsBySession = new Map<string, RunTimeTurnRow[]>()
  for (const turn of turns) {
    const rows = turnsBySession.get(turn.sessionId) ?? []
    rows.push(turn)
    turnsBySession.set(turn.sessionId, rows)
  }

  const spans: Array<{ start: number; end: number }> = []
  // activeWindows = turn 事件点 + LLM 推理窗口；用于 Agent Active。
  const activeWindows: Array<[number, number]> = []
  // llmWindows 只保存 assistant 推理窗口；用于 LLM Active。
  const llmWindows: Array<[number, number]> = []
  const windowsBySession = new Map<string, Array<[number, number]>>()
  for (const session of sessions) {
    const isProxy = isProxyVersion(session.version)
    const rows = turnsBySession.get(session.id) ?? []
    // Wall Clock 的 execution 包络来自主 Agent + subagent 的 turns 跨度。
    for (const entry of buildAgentSpans(rows, isProxy).values()) {
      if (entry.span) spans.push(entry.span)
    }
    const sessionWindows: Array<[number, number]> = []
    for (const turn of rows) {
      // 每个 turn 的时间点都参与事件聚类（不论角色），保证 Overview 原有
      // “turn 事件活跃”口径不丢失。
      const ts = turn.createdAt_ts?.getTime()
      if (Number.isFinite(ts)) sessionWindows.push([ts!, ts!])
      const llm = llmWindowOf(turn, isProxy)
      if (llm) {
        // LLM 窗口同时进入 LLM Active 和 Agent Active，保证前者是后者子集。
        llmWindows.push(llm)
        sessionWindows.push(llm)
      }
    }
    activeWindows.push(...sessionWindows)
    windowsBySession.set(session.id, sessionWindows)
  }

  const sessionStarts = sessions.map(s => s.startTime.getTime()).filter(Number.isFinite)
  const sessionEnds = sessions.map(s => s.endTime?.getTime()).filter((v): v is number => Number.isFinite(v))
  const start = spans.length > 0 ? Math.min(...spans.map(s => s.start)) : (sessionStarts.length > 0 ? Math.min(...sessionStarts) : null)
  const end = spans.length > 0 ? Math.max(...spans.map(s => s.end)) : (sessionEnds.length > 0 ? Math.max(...sessionEnds) : null)
  if (start == null || end == null || end <= start) {
    return {
      summary: {
        start: start != null ? new Date(start).toISOString() : null,
        end: end != null ? new Date(end).toISOString() : null,
        wallMs: 0,
        activeMs: null,
        idleMs: null,
        llmActiveMs: 0,
      },
      activeByRow: new Map(),
    }
  }

  const clip = (windows: Array<[number, number]>, keepPoints: boolean) => windows
    .map(([a, b]) => [Math.max(start, a), Math.min(end, b)] as [number, number])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && (keepPoints ? b >= a : b > a))
  const wallMs = end - start
  // LLM Active：推理窗口精确并集，不做 5min 间隔扩张；并行调用重叠只算一次。
  const llmActiveMs = Math.min(wallMs, sumSegments(clusterActiveSegments(clip(llmWindows, false), 0)))
  // Agent Active：事件点 + 推理窗口，固定 5min 间隔聚类；0 宽事件点必须保留。
  const activeMs = Math.min(
    wallMs,
    sumSegments(clusterActiveSegments(clip(activeWindows, true), ACTIVE_GAP_THRESHOLD_MS)),
  )
  const activeByRow = new Map<string, { activeMs: number | null }>()
  for (const session of sessions) {
    const windows = windowsBySession.get(session.id) ?? []
    if (windows.length === 0) {
      activeByRow.set(session.id, { activeMs: null })
      continue
    }
    const sessionStart = session.startTime.getTime()
    const sessionEnd = session.endTime?.getTime() ?? Math.max(...windows.map(([, b]) => b))
    // 成员级 active 仅用于 memberStats 展示；run 级 Active 仍是全成员并集，
    // 多成员并行时不能把这里的值直接相加来冒充 run 级活跃。
    const sessionActive = sumSegments(clusterActiveSegments(
      windows
        .map(([a, b]) => [Math.max(sessionStart, a), Math.min(sessionEnd, b)] as [number, number])
        .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b >= a),
      ACTIVE_GAP_THRESHOLD_MS,
    ))
    activeByRow.set(session.id, { activeMs: Math.min(sessionActive, Math.max(0, sessionEnd - sessionStart)) })
  }
  return {
    summary: {
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      wallMs,
      activeMs,
      idleMs: Math.max(0, wallMs - activeMs),
      llmActiveMs: Math.min(llmActiveMs, activeMs),
    },
    activeByRow,
  }
}

export function buildRunTimeSummary(
  sessions: RunTimeSessionRow[],
  turns: RunTimeTurnRow[],
): RunTimeSummary {
  return buildRunTimeObservability(sessions, turns).summary
}
