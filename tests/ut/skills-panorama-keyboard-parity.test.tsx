// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// IT（SkillsPanorama 键盘/鼠标行为一致性）：键盘分支必须与对应 onClick 完全对齐——
//   ① agent 声明按钮的键盘 Enter 需带 framework（点击路径会从派发成员解析 fw 传入，
//      键盘路径此前漏传 → agent-content 路由按缺省框架解析，可能读到错误成员）；
//   ② 错误态可用键盘收起（content || error 都可 clear），不得落到重新请求。
// 注：批量 14（本 PR）依赖批量 15 的 perf-shared 共享符号（perfEntrance / PERF_CARD_CLS
//   等），批量 15 尚未合入——此处 mock 掉该批量共享面，单独渲染本组件锁定其自身行为。

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

vi.mock('@/components/observe/perf-shared', async () => {
  const React = await import('react')
  const ce = React.createElement as typeof React.createElement
  return {
    perfEntrance: () => ({}),
    PERF_CARD_CLS: '',
    PERF_CARD_SM: '',
    fmtTok: (n: number) => String(n),
    svgViewX: () => 0,
    PerfSegmented: ({ options, onChange }: { options: Array<{ value: string; label: string }>; onChange: (v: string) => void }) =>
      ce('div', { 'data-testid': 'perf-segmented' },
        options.map(o => ce('button', { key: o.value, type: 'button', onClick: () => onChange(o.value) }, o.label))),
  }
})

import { SkillsPanorama, type SkillsPanoramaData } from '@/components/observe/SkillsPanorama'

function skillData(): SkillsPanoramaData {
  return {
    skills: [{ skillName: 'demo-skill', version: 1, invocationCount: 1 }],
    events: [{
      id: 'e1', skillName: 'demo-skill', skillVersion: 1, eventType: 'invoke',
      success: true, errorMessage: null, durationMs: 0, turnIndex: 0,
      agentName: null, isSubagent: false, subagentSessionId: null,
      turnTokens: { totalTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      member: { taskId: 'm1', label: 'Alice' },
    }],
    total: 1,
  }
}

function dispatchData(): SkillsPanoramaData {
  return {
    skills: [],
    events: [],
    dispatches: [{
      id: 'd1', name: 'general', turnId: 't1', at: null, verify: false,
      member: { taskId: 'm1', label: 'Alice', framework: 'claude-code' },
      source: 'member',
    }],
    total: 1,
  }
}

function render(data: SkillsPanoramaData): { host: HTMLElement; root: Root } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => { root.render(createElement(SkillsPanorama, { runId: 'run-1', data, onOpenTurn: () => {} })) })
  return { host, root }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await act(async () => {})
}

function click(el: Element): void {
  act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

function keyDown(el: HTMLElement, key: string): void {
  act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })) })
}

function findByText(host: HTMLElement, text: string): HTMLElement | null {
  for (const el of host.querySelectorAll('[role="button"]')) {
    if (el.textContent?.trim() === text) return el as HTMLElement
  }
  return null
}

let origFetch: typeof fetch

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  origFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = origFetch
})

describe('SkillsPanorama 键盘/鼠标行为一致性', () => {
  it('派发 agent 声明按钮：键盘 Enter 与点击一致地带 framework', async () => {
    const agentUrls: string[] = []
    ;(globalThis as { fetch: typeof fetch }).fetch = ((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/agent-content')) {
        agentUrls.push(url)
        return Promise.resolve(new Response(JSON.stringify({ skillName: 'general', content: 'X', source: null, length: 1, fullRead: true, maxLine: null }), { status: 200, headers: { 'content-type': 'application/json' } }))
      }
      return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
    }) as typeof fetch

    const { host, root } = render(dispatchData())
    await flush()

    // 切换到派发维度（入 mock 的 PerfSegmented 触发 onChange）
    const seg = host.querySelector('[data-testid="perf-segmented"]')
    expect(seg).toBeTruthy()
    const dispatchBtn = Array.from(seg!.querySelectorAll('button')).find(b => b.textContent === '派发')
    expect(dispatchBtn).toBeTruthy()
    click(dispatchBtn!)
    await flush()

    // 选中派发 agent 行 → 明细面板出现「声明」按钮
    const row = host.querySelector('[data-skill-row]')
    expect(row).toBeTruthy()
    click(row!)
    await flush()

    const decl = findByText(host, '声明')
    expect(decl).toBeTruthy()
    keyDown(decl!, 'Enter')
    await flush()

    expect(agentUrls).toHaveLength(1)
    expect(agentUrls[0]).toContain('agentName=general')
    expect(agentUrls[0]).toContain('framework=claude-code')

    await act(async () => { root.unmount() })
    host.remove()
  })

  it('技能全文按钮：键盘在错误态收起（不重新请求）', async () => {
    let skillFetchCount = 0
    ;(globalThis as { fetch: typeof fetch }).fetch = ((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/skill-content')) {
        skillFetchCount += 1
        return Promise.resolve(new Response('boom', { status: 500 }))
      }
      return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
    }) as typeof fetch

    const { host, root } = render(skillData())
    await flush()

    const row = host.querySelector('[data-skill-row]')
    expect(row).toBeTruthy()
    click(row!)
    await flush()

    const full = findByText(host, '全文')
    expect(full).toBeTruthy()

    // 首次 Enter → fetchOne → 500 → 错误态（content 空、error 有值）
    keyDown(full!, 'Enter')
    await flush()
    expect(skillFetchCount).toBe(1)

    // 二次 Enter → 错误态应收起（clear），不得重新请求
    keyDown(full!, 'Enter')
    await flush()
    expect(skillFetchCount).toBe(1)

    await act(async () => { root.unmount() })
    host.remove()
  })

  it('派发 agent 声明按钮：键盘在错误态收起（不重新请求）', async () => {
    let agentFetchCount = 0
    ;(globalThis as { fetch: typeof fetch }).fetch = ((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/agent-content')) {
        agentFetchCount += 1
        return Promise.resolve(new Response('boom', { status: 500 }))
      }
      return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
    }) as typeof fetch

    const { host, root } = render(dispatchData())
    await flush()

    const seg = host.querySelector('[data-testid="perf-segmented"]')
    const dispatchBtn = Array.from(seg!.querySelectorAll('button')).find(b => b.textContent === '派发')
    click(dispatchBtn!)
    await flush()

    const row = host.querySelector('[data-skill-row]')
    click(row!)
    await flush()

    const decl = findByText(host, '声明')
    expect(decl).toBeTruthy()

    keyDown(decl!, 'Enter')
    await flush()
    expect(agentFetchCount).toBe(1)

    keyDown(decl!, 'Enter')
    await flush()
    expect(agentFetchCount).toBe(1)

    await act(async () => { root.unmount() })
    host.remove()
  })
})