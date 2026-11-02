// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// 会话视图状态层（useSessionView）IT：锁四组契约——
//   ① 深链读路径：tab 恢复（非法值回落 overview / 退役别名 trace→turns）、
//      turn 深链 once-per-value（数据重放不把选中弹回 URL 旧轮，深链换值才重应用）；
//   ② errorTurn 深链：数据就绪后跳 turns 并定位（URL 订正为真实视图），
//      已有选中不抢（用户先选的不被错误卡深链顶掉）；
//   ③ 写路径分治：navigate() 合并 state 并写 URL 镜像（replace，不带选中时
//      turn 参数从 URL 删除）；select() 纯 state、URL 一字不动；
//   ④ 子代理高亮派生：navigate 到子代理轮带出 lane 高亮，显式给出时覆盖派生值。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { useSessionView, type SessionViewHandle } from '@/components/export-view/session-view'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// —— next/navigation 桩：URL 由测试按需改写，replace 记录用于断言写路径 ——
const nav = vi.hoisted(() => ({
  params: new URLSearchParams(),
  replaces: [] as string[],
  setQuery(q: string) {
    nav.params = new URLSearchParams(q)
  },
  reset() {
    nav.params = new URLSearchParams()
    nav.replaces = []
  },
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: () => {},
    replace: (href: string) => {
      nav.replaces.push(href)
    },
    back: () => {},
    refresh: () => {},
  }),
  useSearchParams: () => new URLSearchParams(nav.params.toString()),
}))

let root: Root | null = null
let container: HTMLElement | null = null

afterEach(() => {
  if (root) act(() => { root!.unmount() })
  container?.remove()
  root = null
  container = null
  nav.reset()
})

// 数据注入桩：轮次表由测试给定，身份稳定（重放场景单独换身份模拟 setTurns 重跑）
const TURNS: Record<string, { isSubagent: boolean }> = {
  t2: { isSubagent: false },
  t3: { isSubagent: false },
  sub1: { isSubagent: true },
}
let resolveTurn: (turnId: string) => { isSubagent: boolean } | undefined = (id) => TURNS[id]
const resolveTurnIndex: (i: number) => ({ turnId: string } & { isSubagent: boolean }) | undefined = (i) =>
  i === 2 ? { turnId: 't2', isSubagent: false } : i === 9 ? { turnId: 'sub1', isSubagent: true } : undefined

/** 句柄捕获 holder：effect 内赋值（渲染期无副作用），act 落定后可读 */
const holder: { current: SessionViewHandle | null } = { current: null }
function Probe(props: { turnsReady: boolean }) {
  const h = useSessionView({ resolveTurn, resolveTurnIndex, turnsReady: props.turnsReady })
  useEffect(() => {
    holder.current = h
  })
  return null
}
function latest(): SessionViewHandle {
  if (!holder.current) throw new Error('Probe 未挂载')
  return holder.current
}

function mount(turnsReady: boolean) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => { root!.render(createElement(Probe, { turnsReady })) })
}
function rerender(turnsReady: boolean) {
  act(() => { root!.render(createElement(Probe, { turnsReady })) })
}
/** 模拟父层 5s 自动同步 setTurns 重放：注入新的 resolver 身份触发 effect 重跑 */
function replayTurnsData() {
  const prev = resolveTurn
  resolveTurn = (id) => prev(id)
  rerender(true)
}

describe('useSessionView 深链读路径', () => {
  it('tab 深链恢复：?tab=skills → skills', () => {
    nav.setQuery('?tab=skills')
    mount(true)
    expect(latest().view.tab).toBe('skills')
    expect(latest().view.turnId).toBeNull()
  })

  it('非法 tab 回落 overview；无参默认 overview', () => {
    nav.setQuery('?tab=bogus')
    mount(true)
    expect(latest().view.tab).toBe('overview')
  })

  it('退役 tab 深链别名：?tab=trace → turns（Trace 已并入 Turns）', () => {
    nav.setQuery('?tab=trace')
    mount(true)
    expect(latest().view.tab).toBe('turns')
  })

  it('tab 变化的 URL 随动（popstate/换参）：skills → wireRounds', () => {
    nav.setQuery('?tab=skills')
    mount(true)
    nav.setQuery('?tab=wireRounds')
    rerender(true)
    expect(latest().view.tab).toBe('wireRounds')
  })

  it('turn 深链：数据就绪后定位 + 滚动 + 主代理轮不带 lane 高亮', () => {
    nav.setQuery('?tab=turns&turn=t2')
    mount(false)
    expect(latest().view.turnId).toBeNull() // 未就绪不应用
    rerender(true)
    expect(latest().view.turnId).toBe('t2')
    expect(latest().view.scrollTargetTurnId).toBe('t2')
    expect(latest().view.subagentHighlightId).toBeNull()
  })

  it('turn 深链子代理轮：带出 lane 高亮', () => {
    nav.setQuery('?turn=sub1')
    mount(true)
    expect(latest().view.turnId).toBe('sub1')
    expect(latest().view.subagentHighlightId).toBe('sub1')
  })

  it('once-per-value：数据重放不把选中弹回 URL 旧轮，手动选中优先', () => {
    nav.setQuery('?turn=t2')
    mount(true)
    expect(latest().view.turnId).toBe('t2')
    act(() => { latest().select({ turnId: 't3' }) }) // 用户手动换轮
    expect(latest().view.turnId).toBe('t3')
    replayTurnsData() // 5s 自动同步 setTurns 重放深链 effect
    expect(latest().view.turnId).toBe('t3') // 不被弹回 t2
  })

  it('深链换值（值变化）重新应用', () => {
    nav.setQuery('?turn=t2')
    mount(true)
    expect(latest().view.turnId).toBe('t2')
    nav.setQuery('?turn=t3')
    rerender(true)
    expect(latest().view.turnId).toBe('t3')
  })
})

describe('useSessionView errorTurn 深链', () => {
  it('?errorTurn=2：就绪后跳 turns 定位真实轮，URL 订正为真实视图', () => {
    nav.setQuery('?errorTurn=2')
    mount(false)
    expect(latest().view.tab).toBe('overview')
    expect(nav.replaces).toHaveLength(0)
    rerender(true)
    expect(latest().view.tab).toBe('turns')
    expect(latest().view.turnId).toBe('t2')
    const href = nav.replaces.at(-1)!
    expect(href).toContain('tab=turns')
    expect(href).toContain('turn=t2')
  })

  it('已有选中不抢：用户先选的轮不被 errorTurn 深链顶掉', () => {
    nav.setQuery('?turn=t2')
    mount(true)
    expect(latest().view.turnId).toBe('t2')
    const replacesBefore = nav.replaces.length
    nav.setQuery('?turn=t2&errorTurn=2') // 之后 URL 才出现错误卡深链
    rerender(true)
    expect(latest().view.turnId).toBe('t2')
    expect(latest().view.tab).toBe('overview') // 未被抢跳 turns
    expect(nav.replaces.length).toBe(replacesBefore)
  })

  it('errorTurn 只应用一次：重放不重复跳转', () => {
    nav.setQuery('?errorTurn=2')
    mount(true)
    expect(nav.replaces).toHaveLength(1)
    replayTurnsData()
    expect(nav.replaces).toHaveLength(1)
  })
})

describe('useSessionView 写路径分治（选中态权威在用户）', () => {
  it('navigate：state 合并 + URL 镜像（replace）；仅 tab 时 URL 删除 turn 参数', () => {
    nav.setQuery('?tab=turns&turn=t2')
    mount(true)
    act(() => { latest().navigate({ tab: 'wireRounds' }) })
    expect(latest().view.tab).toBe('wireRounds')
    const href = nav.replaces.at(-1)!
    expect(href).toContain('tab=wireRounds')
    expect(href).not.toContain('turn=')
  })

  it('navigate 带 turnId：URL 镜像带上定位', () => {
    mount(true)
    act(() => { latest().navigate({ tab: 'turns', turnId: 't3' }) })
    expect(latest().view.turnId).toBe('t3')
    expect(latest().view.scrollTargetTurnId).toBe('t3')
    expect(nav.replaces.at(-1)).toContain('turn=t3')
  })

  it('select：纯 state，URL 一字不动', () => {
    nav.setQuery('?tab=turns')
    mount(true)
    const before = nav.replaces.length
    act(() => { latest().select({ turnId: 't3', scrollTargetTurnId: null }) })
    expect(latest().view.turnId).toBe('t3')
    expect(nav.replaces.length).toBe(before) // select 不写 URL
  })

  it('navigate 到子代理轮：派生 lane 高亮；显式给出时覆盖派生值', () => {
    mount(true)
    act(() => { latest().navigate({ tab: 'turns', turnId: 'sub1' }) })
    expect(latest().view.subagentHighlightId).toBe('sub1') // 派生
    act(() => { latest().navigate({ tab: 'turns', turnId: 't2', subagentHighlightId: 'sub1' }) })
    expect(latest().view.turnId).toBe('t2')
    expect(latest().view.subagentHighlightId).toBe('sub1') // 显式覆盖：跨轮定位仍高亮原 lane
  })
})
