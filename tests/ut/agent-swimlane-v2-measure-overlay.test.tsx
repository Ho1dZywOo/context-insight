// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// V2 测距覆盖层回归锁：多成员 run（rootLanes.length > 1）下，测时距的两条 dashed
// 标记线 + 阴影区原先是 per-lane 各画一份——点单条泳道测距时其余成员泳道也画出
// 完全相同标记，造成「到底在测哪条道」的视觉歧义。修复后覆盖层提升到 plot 容器
// 层只画一次。本 IT 在真实多成员分道（两 root member + 一 slot）下断言标记线唯一。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { AgentSwimlaneV2 } from '@/components/observe/AgentSwimlaneV2'
import type { AgentItem, BridgeItem } from '../../src/components/observe/AgentCallGraph'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLElement | null = null

afterEach(() => {
  if (root) act(() => { root!.unmount() })
  container?.remove()
  root = null
  container = null
})

const T0 = '2026-10-15T10:00:00Z'

function mkAgent(over: {
  executionId: string
  span: { start: number; end: number }
  isSubagent?: boolean
  agentSessionId?: string
  member?: { taskId: string; label: string } | null
}): AgentItem {
  return {
    executionId: over.executionId,
    agentName: 'general',
    agentSessionId: over.agentSessionId ?? null,
    isSubagent: over.isSubagent ?? true,
    parentExecutionId: null,
    tokens: 1000,
    maxSingleCallTokens: 500,
    cost: 0,
    toolCallCount: 3,
    skillLoadCount: 0,
    model: 'glm-5.3',
    createdAt: new Date(over.span.start).toISOString(),
    latencyMs: over.span.end - over.span.start,
    firstPrompt: null,
    activeIntervals: null,
    span: over.span,
    member: over.member ?? null,
  } as unknown as AgentItem
}

async function renderV2(agents: AgentItem[]) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(AgentSwimlaneV2, { agents, bridges: [] as BridgeItem[], lanes: [] }))
  })
  return container!
}

function clickAt(node: Element, clientX: number) {
  act(() => { node.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX })) })
}

const settleMeasure = () => new Promise(r => setTimeout(r, 300))

describe('AgentSwimlaneV2 测距覆盖层：多成员 run 只画一次', () => {
  it('多成员分道下单击泳道 → dashed 标记线唯一（不逐泳道重复）', async () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 1000, height: 40, left: 0, top: 0, right: 1000, bottom: 40,
      x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect)

    const T = Date.parse(T0)
    const agents = [
      mkAgent({ executionId: 'm1', span: { start: T, end: T + 200_000 }, isSubagent: false, member: { taskId: 't1', label: '成员一' } }),
      mkAgent({ executionId: 'm2', span: { start: T, end: T + 200_000 }, isSubagent: false, member: { taskId: 't2', label: '成员二' } }),
      mkAgent({ executionId: 'subA', span: { start: T + 10_000, end: T + 60_000 }, agentSessionId: 'ses_g1' }),
    ]

    const el = await renderV2(agents)

    // 确认确实多成员分道：两 root 泳道 + 至少一个 slot
    const lanes = [...el.querySelectorAll<HTMLElement>('[data-lane]')].map(d => d.getAttribute('data-lane'))
    expect(lanes).toContain('t1')
    expect(lanes).toContain('t2')
    expect(lanes.length).toBeGreaterThanOrEqual(3)

    // 单击第一条 root 道（clientX=500 → pct=50 > 0）记录起点
    const lane1 = el.querySelector<HTMLElement>('[data-lane="t1"]')!
    clickAt(lane1, 500)
    await settleMeasure()
    expect(el.textContent).toContain('已标记起点')

    // 关键断言：覆盖层提升到容器层只画一次，标记线全图仅一条
    const markers = el.querySelectorAll('.border-rose-500')
    expect(markers.length).toBe(1)

    rectSpy.mockRestore()
  })
})