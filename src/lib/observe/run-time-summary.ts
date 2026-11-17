// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Run 时间口径单一源（Overview = Perf）：
// - wall = 全部执行 span 的最早开始 → 最晚结束
// - active = turn 事件点 + assistant 推理窗口的并集，固定 5min 间隔聚类
// - llmActive = 主 Agent 与 subagent 的 assistant 推理窗口并集（重叠只算一次）
// - inactive = wall - active
// proxy 反推窗口以完成时刻为锚向前生成；反推时长最多 10min。

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

function sumSegments(segments: Array<{ start: number; end: number }>): number {
  return segments.reduce((sum, seg) => sum + Math.max(0, seg.end - seg.start), 0)
}

function llmWindowOf(turn: RunTimeTurnRow, isProxy: boolean): [number, number] | null {
  const ts = turn.createdAt_ts?.getTime()
  if (!Number.isFinite(ts) || turn.role !== 'assistant' || turn.latencyMs <= 0) return null
  if (isProxy && !turn.completedAt) {
    const latency = Math.min(turn.latencyMs, ACTIVE_LATENCY_CAP_MS)
    return [ts! - latency, ts!]
  }
  const completed = turn.completedAt?.getTime()
  const end = Number.isFinite(completed)
    ? Math.min(ts! + turn.latencyMs, completed!)
    : ts! + turn.latencyMs
  return end > ts! ? [ts!, end] : null
}

export function buildRunTimeSummary(
  sessions: RunTimeSessionRow[],
  turns: RunTimeTurnRow[],
): RunTimeSummary {
  const turnsBySession = new Map<string, RunTimeTurnRow[]>()
  for (const turn of turns) {
    const rows = turnsBySession.get(turn.sessionId) ?? []
    rows.push(turn)
    turnsBySession.set(turn.sessionId, rows)
  }

  const spans: Array<{ start: number; end: number }> = []
  const activeWindows: Array<[number, number]> = []
  const llmWindows: Array<[number, number]> = []
  for (const session of sessions) {
    const isProxy = isProxyVersion(session.version)
    const rows = turnsBySession.get(session.id) ?? []
    for (const entry of buildAgentSpans(rows, isProxy).values()) {
      if (entry.span) spans.push(entry.span)
    }
    for (const turn of rows) {
      const ts = turn.createdAt_ts?.getTime()
      if (Number.isFinite(ts)) activeWindows.push([ts!, ts!])
      const llm = llmWindowOf(turn, isProxy)
      if (llm) {
        llmWindows.push(llm)
        activeWindows.push(llm)
      }
    }
  }

  const sessionStarts = sessions.map(s => s.startTime.getTime()).filter(Number.isFinite)
  const sessionEnds = sessions.map(s => s.endTime?.getTime()).filter((v): v is number => Number.isFinite(v))
  const start = spans.length > 0 ? Math.min(...spans.map(s => s.start)) : (sessionStarts.length > 0 ? Math.min(...sessionStarts) : null)
  const end = spans.length > 0 ? Math.max(...spans.map(s => s.end)) : (sessionEnds.length > 0 ? Math.max(...sessionEnds) : null)
  if (start == null || end == null || end <= start) {
    return {
      start: start != null ? new Date(start).toISOString() : null,
      end: end != null ? new Date(end).toISOString() : null,
      wallMs: 0,
      activeMs: null,
      idleMs: null,
      llmActiveMs: 0,
    }
  }

  const clip = (windows: Array<[number, number]>, keepPoints: boolean) => windows
    .map(([a, b]) => [Math.max(start, a), Math.min(end, b)] as [number, number])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && (keepPoints ? b >= a : b > a))
  const wallMs = end - start
  const llmActiveMs = Math.min(wallMs, sumSegments(clusterActiveSegments(clip(llmWindows, false), 0)))
  const activeMs = Math.min(
    wallMs,
    sumSegments(clusterActiveSegments(clip(activeWindows, true), ACTIVE_GAP_THRESHOLD_MS)),
  )
  return {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    wallMs,
    activeMs,
    idleMs: Math.max(0, wallMs - activeMs),
    llmActiveMs: Math.min(llmActiveMs, activeMs),
  }
}
