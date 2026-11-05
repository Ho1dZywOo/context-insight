// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom
// 命令面板 IT：⌘K 全局开关、防抖取数（/api/observe/data，q 同列表语义）、
// ↑↓ 键导航、↵ 打开（session → /run/solo:{taskId}，run → /run/{runId}）、
// Esc 关闭。闭合态 = 工具栏伪装搜索框（⌘K 角标在场）。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CommandPalette } from '../../src/components/layout/CommandPalette'

const { pushSpy } = vi.hoisted(() => ({ pushSpy: vi.fn() }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushSpy, replace: () => {}, back: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/',
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// 最小资产形状（组件只读 kind/key/taskId/runId/query/name/model/framework）
const ITEMS = [
  { kind: 'session', key: 's1', taskId: 'ses-cmd-001', query: '登录 bug 修复', model: 'glm-4.7', framework: 'opencode' },
  { kind: 'run', key: 'r1', runId: 'run-cmd-002', name: '评测批次 A', model: null, framework: null },
]

const fetchMock = vi.fn(async (_input: RequestInfo | URL) => ({ ok: true, json: async () => ({ items: ITEMS }) }))

async function settle(ms: number) {
  await act(async () => { await new Promise(r => setTimeout(r, ms)) })
}

function fireKey(target: EventTarget, key: string, extra: KeyboardEventInit = {}) {
  act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra })) })
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('命令面板（⌘K）', () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null
  let origFetch: typeof fetch

  beforeEach(() => {
    pushSpy.mockClear()
    fetchMock.mockClear()
    origFetch = globalThis.fetch
    ;(globalThis as { fetch: unknown }).fetch = fetchMock
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    ;(globalThis as { fetch: unknown }).fetch = origFetch
  })

  it('闭合态 = 伪装搜索框（Search + ⌘K 角标）；⌘K 呼出并自动聚焦', async () => {
    act(() => root!.render(createElement(CommandPalette)))
    const trigger = container!.querySelector('button')!
    expect(trigger.textContent).toContain('Search')
    expect(trigger.textContent).toContain('⌘K')
    expect(container!.querySelector('[data-command-input]')).toBeNull()

    fireKey(window, 'k', { metaKey: true })
    await settle(0)
    const input = container!.querySelector('[data-command-input]') as HTMLInputElement | null
    expect(input).not.toBeNull()
  })

  it('打开即取资产首页（空 q），↑↓ 导航 + ↵ 打开（session 语义 /run/solo:）', async () => {
    act(() => root!.render(createElement(CommandPalette)))
    fireKey(window, 'k', { ctrlKey: true })
    await settle(320)
    expect(fetchMock).toHaveBeenCalled()
    const rows = [...container!.querySelectorAll('[data-command-item]')]
    expect(rows.length).toBe(2)
    expect(rows[0].getAttribute('data-command-item')).toBe('session')
    expect(rows[1].getAttribute('data-command-item')).toBe('run')

    // 首项默认激活；Enter → session 跳转语义
    const input = container!.querySelector('[data-command-input]') as HTMLInputElement
    fireKey(input, 'Enter')
    expect(pushSpy).toHaveBeenCalledWith('/run/solo:ses-cmd-001')

    // 重开 → ArrowDown 到 run 行 → Enter → run 跳转语义
    fireKey(window, 'k', { metaKey: true })
    await settle(320)
    const input2 = container!.querySelector('[data-command-input]') as HTMLInputElement
    fireKey(input2, 'ArrowDown')
    fireKey(input2, 'Enter')
    expect(pushSpy).toHaveBeenCalledWith('/run/run-cmd-002')
  })

  it('输入防抖带 q 查询；Esc 关闭回触发位', async () => {
    act(() => root!.render(createElement(CommandPalette)))
    fireKey(window, 'k', { metaKey: true })
    const input = container!.querySelector('[data-command-input]') as HTMLInputElement
    typeInto(input, '登录')
    await settle(320)
    const url = String(fetchMock.mock.calls[0]?.[0])
    expect(url).toContain('/api/observe/data?')
    expect(url).toContain('q=')

    fireKey(input, 'Escape')
    await settle(0)
    expect(container!.querySelector('[data-command-input]')).toBeNull()
    expect(container!.querySelector('button')!.textContent).toContain('Search')
  })
})
