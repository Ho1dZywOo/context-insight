// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom
// 回收站面板 IT：挂载即取列表（GET /api/recycle）、恢复动作（POST restore +
// 行移除 + 整页 reload 同步主列表——主列表 items 是客户端 state，
// router.refresh() 只换 props 不重置 state，回流行不会浮现）、彻底删除两步
// 确认（行内武装→确认）、清空两步确认。fetch/导航全 mock，组件层渲染。

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { RecycleBin } from '../../src/components/RecycleBin'

const { toastErrorSpy } = vi.hoisted(() => ({ toastErrorSpy: vi.fn() }))

vi.mock('sonner', () => ({ toast: { error: toastErrorSpy, success: vi.fn(), warning: vi.fn() } }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ENTRIES = [
  { name: 'ses-a__dsh.db', taskId: 'ses-a', framework: 'dsh', query: '登录 bug 修复', model: 'glm-4.7', size: 20480, deletedAt: new Date(Date.now() - 5 * 60_000).toISOString() },
  { name: 'ses-b__opencode.db', taskId: 'ses-b', framework: 'opencode', query: null, model: null, size: 4096, deletedAt: new Date(Date.now() - 2 * 3600_000).toISOString() },
]

let entries = [...ENTRIES]
// restore 服务端返回的 imported 标记（默认成功导入；imported:false 用例覆盖空会话/已存在）
let restorePayload: { imported: boolean; query: string | null } = { imported: true, query: null }
const calls: Array<{ url: string; body: Record<string, unknown> | null }> = []
const fetchMock = vi.fn()

async function settle(ms = 30) {
  await act(async () => { await new Promise(r => setTimeout(r, ms)) })
}

describe('回收站面板', () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null
  let origFetch: typeof fetch
  // 恢复成功 → window.location.reload（整页同步主列表）；happy-dom 的
  // location.reload 可被 spyOn，断言导航出口而不真跳页
  let reloadMock: MockInstance

  beforeEach(() => {
    entries = [...ENTRIES]
    restorePayload = { imported: true, query: null }
    calls.length = 0
    reloadMock = vi.spyOn(window.location, 'reload').mockImplementation(() => {})
    toastErrorSpy.mockClear()
    fetchMock.mockClear()
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const body = init?.body ? JSON.parse(String(init.body)) : null
      if (url === '/api/recycle' && init?.method === 'POST') {
        calls.push({ url: 'POST /api/recycle', body: body as Record<string, unknown> })
        if (body?.action === 'restore') {
          // imported:true 才真正回流并移除快照（服务端语义）；imported:false 保留
          if (restorePayload.imported) entries = entries.filter(e => e.name !== body.name)
          return { ok: true, json: async () => ({ ok: true, imported: restorePayload.imported, query: restorePayload.query }) }
        }
        if (body?.action === 'purge') entries = entries.filter(e => e.name !== body.name)
        if (body?.action === 'empty') entries = []
        return { ok: true, json: async () => ({ ok: true }) }
      }
      if (url === '/api/recycle') return { ok: true, json: async () => ({ entries }) }
      throw new Error(`unexpected fetch: ${url}`)
    })
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
    reloadMock.mockRestore()
  })

  it('挂载即列回收条目（query 兜底 taskId、计数角标、删除时间）', async () => {
    act(() => root!.render(createElement(RecycleBin)))
    await settle()
    const rows = [...container!.querySelectorAll('[data-recycle-row]')]
    expect(rows.length).toBe(2)
    expect(rows[0].textContent).toContain('登录 bug 修复')
    expect(rows[1].textContent).toContain('ses-b')
    expect(rows[0].textContent).toContain('5 分钟前')
    const header = container!.querySelector('[data-recycle-panel]')!
    expect(header.textContent).toContain('Recycle Bin')
    expect(header.textContent!.match(/Recycle Bin2/)).toBeTruthy()
  })

  it('恢复：POST restore + 行移除 + 整页 reload（主列表同步浮现）', async () => {
    act(() => root!.render(createElement(RecycleBin)))
    await settle()
    const restoreBtn = [...container!.querySelectorAll('[data-recycle-restore]')][0] as HTMLButtonElement
    await act(async () => { restoreBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await settle()
    expect(calls.some(c => c.body?.action === 'restore' && c.body?.name === 'ses-a__dsh.db')).toBe(true)
    expect(reloadMock).toHaveBeenCalled()
    expect([...container!.querySelectorAll('[data-recycle-row]')].length).toBe(1)
  })

  it('恢复 imported:false（空会话）：保留条目 + 提示失败，不 refresh', async () => {
    restorePayload = { imported: false, query: null }
    act(() => root!.render(createElement(RecycleBin)))
    await settle()
    const restoreBtn = [...container!.querySelectorAll('[data-recycle-restore]')][0] as HTMLButtonElement
    await act(async () => { restoreBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await settle()
    // 服务端 imported:false 不删快照、未回流——条目必须保留，不能静默移除
    expect([...container!.querySelectorAll('[data-recycle-row]')].length).toBe(2)
    expect(reloadMock).not.toHaveBeenCalled()
    expect(toastErrorSpy).toHaveBeenCalled()
    expect(String(toastErrorSpy.mock.calls[0][0])).toContain('空会话无法恢复')
  })

  it('恢复 imported:false（会话已存在）：保留条目 + 提示「会话已存在」', async () => {
    restorePayload = { imported: false, query: '登录 bug 修复' }
    act(() => root!.render(createElement(RecycleBin)))
    await settle()
    const restoreBtn = [...container!.querySelectorAll('[data-recycle-restore]')][0] as HTMLButtonElement
    await act(async () => { restoreBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await settle()
    expect([...container!.querySelectorAll('[data-recycle-row]')].length).toBe(2)
    expect(reloadMock).not.toHaveBeenCalled()
    expect(toastErrorSpy).toHaveBeenCalled()
    expect(String(toastErrorSpy.mock.calls[0][0])).toContain('会话已存在')
  })

  it('彻底删除两步确认：首次点击武装、再次点击才 POST purge', async () => {
    act(() => root!.render(createElement(RecycleBin)))
    await settle()
    const purgeBtn = [...container!.querySelectorAll('[data-recycle-purge]')][0] as HTMLButtonElement
    await act(async () => { purgeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await settle()
    expect(purgeBtn.textContent).toContain('确认')
    expect(calls.some(c => c.body?.action === 'purge')).toBe(false)
    await act(async () => { purgeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await settle()
    expect(calls.some(c => c.body?.action === 'purge' && c.body?.name === 'ses-a__dsh.db')).toBe(true)
    expect([...container!.querySelectorAll('[data-recycle-row]')].length).toBe(1)
  })

  it('清空两步确认 + 空态文案', async () => {
    act(() => root!.render(createElement(RecycleBin)))
    await settle()
    const emptyBtn = container!.querySelector('[data-recycle-empty]') as HTMLButtonElement
    await act(async () => { emptyBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await settle()
    expect(emptyBtn.textContent).toContain('确认')
    expect(calls.some(c => c.body?.action === 'empty')).toBe(false)
    await act(async () => { emptyBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await settle()
    expect(calls.some(c => c.body?.action === 'empty')).toBe(true)
    expect([...container!.querySelectorAll('[data-recycle-row]')].length).toBe(0)
    expect(container!.textContent).toContain('先落入这里')
  })
})
