// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { describe, expect, it } from 'vitest'
import { buildRunTimeObservability, type RunTimeSessionRow, type RunTimeTurnRow } from '@/lib/observe/run-time-summary'

const MIN = 60_000
const HOUR = 60 * MIN
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0)

function session(version: string | null, endTime: number): RunTimeSessionRow {
  return { id: 's1', startTime: new Date(T0), endTime: new Date(endTime), version }
}

function turn(over: Partial<RunTimeTurnRow>): RunTimeTurnRow {
  return {
    sessionId: 's1',
    role: 'assistant',
    isSubagent: false,
    subagentSessionId: null,
    createdAt_ts: new Date(T0),
    completedAt: null,
    latencyMs: 0,
    ...over,
  }
}

describe('RunTimeSummary 口径', () => {
  it('native LLM Active 使用 latency，而不是 completedAt 的完整 turn 生命周期', () => {
    const sessions = [session('0.167.0', T0 + 2 * HOUR)]
    const turns = [
      turn({ role: 'user' }),
      turn({
        createdAt_ts: new Date(T0 + HOUR),
        completedAt: new Date(T0 + 2 * HOUR),
        latencyMs: 30_000,
      }),
    ]

    const { summary } = buildRunTimeObservability(sessions, turns)
    expect(summary.wallMs).toBe(2 * HOUR)
    expect(summary.llmActiveMs).toBe(30_000)
    expect(summary.activeMs).toBe(30_000)
    expect(summary.llmActiveMs).toBeLessThanOrEqual(summary.activeMs!)
    expect(summary.activeMs!).toBeLessThanOrEqual(summary.wallMs)
  })

  it('opencode/claude native 的超长 latency 被 10min 可信上限截断', () => {
    const sessions = [session('1.0-opencode', T0 + 2 * HOUR)]
    const turns = [
      turn({ role: 'user' }),
      turn({
        completedAt: new Date(T0 + 2 * HOUR),
        latencyMs: 2 * HOUR,
      }),
    ]

    const { summary } = buildRunTimeObservability(sessions, turns)
    expect(summary.llmActiveMs).toBe(10 * MIN)
    expect(summary.llmActiveMs).toBeLessThan(2 * HOUR)
    expect(summary.llmActiveMs).toBeLessThanOrEqual(summary.activeMs!)
  })

  it('proxy 反推窗口以完成时刻为锚，且最多 10min', () => {
    const sessions = [session('1.0-opencode-proxy', T0 + 20 * MIN)]
    const turns = [
      turn({ role: 'user' }),
      turn({
        createdAt_ts: new Date(T0 + 20 * MIN),
        latencyMs: 49.66 * HOUR,
      }),
    ]

    const { summary } = buildRunTimeObservability(sessions, turns)
    expect(summary.wallMs).toBe(20 * MIN)
    expect(summary.llmActiveMs).toBe(10 * MIN)
    expect(summary.activeMs).toBe(10 * MIN)
    expect(summary.llmActiveMs).toBeLessThanOrEqual(summary.activeMs!)
    expect(summary.activeMs!).toBeLessThanOrEqual(summary.wallMs)
  })
})
