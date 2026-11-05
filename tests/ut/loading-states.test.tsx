// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// 加载态契约 IT：异步取数界面在数据在途窗口必须呈现可见加载动效（role=status
// 播报 + 动效），禁止半空内容裸奔——锁三个代表面：
// ① ui/loading 原语本体；② run 工作台自取数 tab（Skills/Context）；
// ③ 数据仓视图（远端连接窗口：侧栏同形骨架 + 内容区 LoadState，深链直入
// paradigm 也走同一加载态）。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { LoadState, BreathCards, Spinner } from '@/components/ui/loading'
import { RunSkillsTab } from '@/components/run/RunSkillsTab'
import { RunContextTab } from '@/components/run/RunContextTab'
import { LakeSourceView } from '@/components/collection/LakeSourceView'
import { SessionBlock, SubagentLaneView, toLaneDisplayTurn, type TurnsNodeSession } from '@/components/run/RunTurnsNodes'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null

// 稳定实例（hoisted）：useSearchParams 每渲染返回同一引用，否则 filters
// memo 失稳 → 取数 effect 无限重跑（真实 Next 全程缓存同一实例）
const h = vi.hoisted(() => ({
  search: new URLSearchParams('paradigm=alpha'),
  router: { push: () => {}, replace: () => {}, back: () => {}, refresh: () => {} },
}))

vi.mock('next/navigation', () => ({
  useRouter: () => h.router,
  useSearchParams: () => h.search,
}))

// fetch 路由：lake action 集按 action 分发，响应器可切换 pending → resolved
const json = (data: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }))
const pending = () => new Promise<Response>(() => {})
const responders: Record<string, () => Promise<Response>> = {
  'paradigm-summary': pending,
  'lake-runs': pending,
  'bundle-list': pending,
}
;(globalThis as { fetch: typeof fetch }).fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  if (url.includes('/api/ingest/lake')) {
    let body: { action?: string } | null = null
    try { body = init?.body ? JSON.parse(String(init.body)) : null } catch { /* 非 JSON body */ }
    const r = responders[body?.action ?? '']
    if (r) return r()
  }
  return pending()
}) as typeof fetch

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

async function flush(ms = 120): Promise<void> {
  const steps = Math.max(1, Math.ceil(ms / 40))
  for (let i = 0; i < steps; i++) {
    await act(async () => { await new Promise(r => setTimeout(r, 40)) })
  }
}

async function mount(el: React.ReactElement): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(el) })
  await flush()
}

async function rerender(el: React.ReactElement): Promise<void> {
  await act(async () => { root!.render(el) })
  await flush(40)
}

describe('ui/loading 原语', () => {
  it('LoadState：role=status 播报 + 呼吸占位 + 文案', async () => {
    await mount(createElement(LoadState, { label: '载入中' }))
    const status = document.querySelector('[role="status"]')
    expect(status).not.toBeNull()
    expect(status!.textContent).toContain('载入中')
    expect(status!.querySelector('.load-breathe')).not.toBeNull()
  })

  it('BreathCards：N 张呼吸卡错峰浮现（入场 + 呼吸相位差）', async () => {
    await mount(createElement(BreathCards, { count: 3, compact: true }))
    const status = document.querySelector('[role="status"]')
    expect(status).not.toBeNull()
    expect(status!.querySelectorAll('.load-breathe').length).toBe(3)
    expect(status!.querySelectorAll('.animate-in').length).toBe(3)
  })

  it('Spinner 独立可用（内联轻量场景）', async () => {
    await mount(createElement(Spinner, { className: 'size-3.5' }))
    expect(document.querySelector('.animate-spin')).not.toBeNull()
  })
})

describe('run 工作台自取数 tab 加载窗口', () => {
  it('Skills：取数在途 → LoadState（不再裸文字），不渲染全景', async () => {
    await mount(createElement(RunSkillsTab, { runId: 'run-1', onOpenTurn: () => {} }))
    const status = document.querySelector('[role="status"]')
    expect(status?.textContent).toContain('载入技能观测')
    expect(status?.querySelector('.load-breathe')).not.toBeNull()
  })

  it('Context：取数在途 → LoadState 播报', async () => {
    await mount(createElement(RunContextTab, { runId: 'run-1' }))
    const status = document.querySelector('[role="status"]')
    expect(status?.textContent).toContain('载入上下文数据')
    expect(status?.querySelector('.load-breathe')).not.toBeNull()
  })
})

describe('Turns 会话块首次装载门', () => {
  const mkTurn = (i: number, overrides: Record<string, unknown> = {}) => ({
    turnId: `t-${i}`,
    turnIndex: i,
    role: 'assistant',
    contentSummary: `turn ${i}`,
    agentName: null,
    isSubagent: false,
    subagentName: null,
    subagentSessionId: null,
    parentExecutionId: null,
    totalTokens: 100,
    inputTokens: 0,
    inputMessagesCount: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    latencyMs: 0,
    createdAt: null,
    completedAt: null,
    model: null,
    contextWindowPct: null,
    toolCalls: [],
    skillEvents: [],
    ...overrides,
  })
  const session: TurnsNodeSession = {
    taskId: 'ses-big',
    label: 'ses-big',
    role: 'execute',
    attemptOrdinal: 1,
    ref: {
      taskId: 'ses-big',
      framework: '',
      rowId: '',
      turns: 0,
      totalTokens: 0,
      durationMs: null,
      label: 'ses-big',
      startTime: null,
      endTime: null,
      cacheReadTokens: null,
    },
  }
  const turns = [mkTurn(1), mkTurn(2)]
  const blockProps = (state: { turns: typeof turns; total: number; loading: boolean }) => ({
    session,
    state,
    bridges: [],
    selectedTurnId: null,
    onSelectTurn: () => {},
    onLoadMore: () => {},
  })

  it('拉齐在途 → 呼吸卡装载门在场，半量轮次行不出场', async () => {
    await mount(createElement(SessionBlock, blockProps({ turns, total: 10, loading: true })))
    expect(document.body.textContent).toContain('载入中 · 2/10')
    expect(document.querySelector('.load-breathe')).not.toBeNull()
    expect(document.body.textContent).not.toContain('turn 1')
  })

  it('装载完成 → 门撤场，轮次行一次性入场', async () => {
    await mount(createElement(SessionBlock, blockProps({ turns, total: 10, loading: true })))
    await rerender(createElement(SessionBlock, blockProps({ turns, total: 2, loading: false })))
    expect(document.body.textContent).not.toContain('载入中 ·')
    expect(document.body.textContent).toContain('turn 1')
    expect(document.body.textContent).toContain('turn 2')
    expect(document.querySelector('.load-breathe')).toBeNull()
  })

  it('装载闩：完成后再在途（手动补拉/纪元刷新）保持已读行，仅头部指示', async () => {
    await mount(createElement(SessionBlock, blockProps({ turns, total: 10, loading: true })))
    await rerender(createElement(SessionBlock, blockProps({ turns, total: 2, loading: false })))
    await rerender(createElement(SessionBlock, blockProps({ turns, total: 10, loading: true })))
    expect(document.body.textContent).toContain('turn 1')
    expect(document.body.textContent).toContain('载入中 · 2/10')
    expect(document.querySelector('.load-breathe')).toBeNull()
  })

  it('分帧填充：大列表非一次全量挂载，逐帧补齐收敛；填充期尾部呼吸占位', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] })
    try {
      const many = Array.from({ length: 500 }, (_, i) => mkTurn(i + 1))
      const container = document.createElement('div')
      document.body.appendChild(container)
      root = createRoot(container)
      await act(async () => { root!.render(createElement(SessionBlock, blockProps({ turns: many, total: 500, loading: false }))) })
      const firstCount = document.querySelectorAll('[data-turn-row]').length
      expect(firstCount).toBeGreaterThan(0)
      expect(firstCount).toBeLessThan(500)
      expect(document.querySelector('.load-breathe')).not.toBeNull()
      expect(document.querySelector('[data-fill-hidden]')).not.toBeNull()
      for (let i = 0; i < 8; i++) {
        await act(async () => { await vi.advanceTimersByTimeAsync(64) })
      }
      expect(document.querySelectorAll('[data-turn-row]').length).toBe(500)
      expect(document.body.textContent).toContain('turn 500')
      expect(document.querySelector('.load-breathe')).toBeNull()
      expect(document.querySelector('[data-fill-hidden]')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('分帧填充（泳道）：大 lane 展开同样非一次全量挂载，逐帧补齐收敛', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] })
    try {
      const lane = {
        bridgeId: 'br-1',
        sessionId: 'ses-sub',
        name: 'worker #1',
        type: 'general',
        summary: null,
        turnCount: 500,
        totalTokens: 0,
        latencyMs: 0,
        status: 'completed',
        turns: Array.from({ length: 500 }, (_, i) => toLaneDisplayTurn(mkTurn(i + 1, {
          isSubagent: true,
          subagentSessionId: 'ses-sub',
          subagentName: 'worker',
        }))),
      }
      const ctx = {
        subagentBlocksByTurnId: new Map(),
        expandedSubagents: new Set(['br-1']),
        onToggleBridge: () => {},
        selectedTurnId: null,
        onSelectTurn: () => {},
      }
      const container = document.createElement('div')
      document.body.appendChild(container)
      root = createRoot(container)
      await act(async () => { root!.render(createElement(SubagentLaneView, { lane, ctx })) })
      const firstCount = document.querySelectorAll('[data-turn-row]').length
      expect(firstCount).toBeGreaterThan(0)
      expect(firstCount).toBeLessThan(500)
      expect(document.querySelector('[data-fill-hidden]')).not.toBeNull()
      for (let i = 0; i < 8; i++) {
        await act(async () => { await vi.advanceTimersByTimeAsync(64) })
      }
      expect(document.querySelectorAll('[data-turn-row]').length).toBe(500)
      expect(document.querySelector('[data-fill-hidden]')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('数据仓视图远端连接窗口', () => {
  it('深链 paradigm：清单/运行均在途 → 侧栏骨架 + 内容区「正在连接数据湖」LoadState', async () => {
    await mount(createElement(LakeSourceView))

    const statuses = [...document.querySelectorAll('[role="status"]')]
    expect(statuses.some(s => s.textContent?.includes('正在连接数据湖'))).toBe(true)
    expect(document.body.textContent).toContain('连接数据仓中…')
    // 侧栏：清单在途 → 目录按钮未出现（骨架占位在场）
    expect(document.querySelectorAll('aside nav button').length).toBe(0)
    expect(document.querySelector('aside [role="status"]')).not.toBeNull()
  })

  it('数据落地 → 连接态让位（LoadState 撤场，空目录文案呈现）', async () => {
    responders['paradigm-summary'] = () => json({ items: [{ name: 'alpha', runCount: 0, hasBaseline: false }] })
    responders['lake-runs'] = () => json({ paradigm: 'alpha', total: 0, baselineSid: null, insightReachable: true, facets: { frameworks: [], ccVersions: [] }, items: [] })
    responders['bundle-list'] = () => json({ items: [] })
    await mount(createElement(LakeSourceView))

    expect(document.body.textContent).not.toContain('正在连接数据湖')
    expect(document.body.textContent).toContain('该目录暂无会话与 Run 包')
    expect(document.querySelector('aside nav button')?.textContent).toContain('alpha')
  })
})
