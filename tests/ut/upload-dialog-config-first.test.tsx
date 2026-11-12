// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom
// 上传弹窗「配置先行」IT：服务端 lake-config 未配置时打开上传弹窗（主页 /
// 详情页两入口共用本组件）——修复前打开沿预检对未配置静默，范式列表因无
// 远端 400、上传按钮被门禁锁死，提交时的未配置引导结构性不可达（死弹窗）。
// 本文件锁定：打开即弹「连接数据仓」引导；保存（地址+令牌）后范式列表自动
// 重载、表单解锁；取消引导后「重试」重跑预检再弹引导；已配置且凭据齐全时
// 打开不弹引导、列表正常。

import { describe, it, expect, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

import { UploadDialog } from '@/components/collection/UploadDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const LAKE_ADDR = 'https://example.com/lake.git'

let root: Root | null = null
// PUT lake-config 成功后置位：后续 GET 回 configured，范式列表也转成功——
// 模拟「配置保存 → 列表可拉」的真实服务端状态迁移
let lakeConfigured = false
let authRemotes: Array<{ url: string; username: string; tokenMasked: string }> = []
let lakeListFails = true
const onOpenChange = vi.fn()

function installFetch(): void {
  const json = (data: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }))
  ;(globalThis as { fetch: typeof fetch }).fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes('/api/settings/lake-config') && init?.method === 'PUT') {
      lakeConfigured = true
      return json({ configured: true, address: LAKE_ADDR, branch: 'main', lfs: true })
    }
    if (url.includes('/api/settings/lake-config')) {
      return json(lakeConfigured
        ? { configured: true, address: LAKE_ADDR, branch: 'main', lfs: true }
        : { configured: false, address: '', branch: 'main', lfs: true })
    }
    if (url.includes('/api/settings/lake-auth') && init?.method === 'PUT') {
      return json({ username: 'oauth2', tokenMasked: 'ab…CD', verifiedAt: null, reachable: true })
    }
    if (url.includes('/api/settings/lake-auth')) {
      return json({ remotes: authRemotes })
    }
    if (url.includes('/api/ingest/lake')) {
      return lakeListFails || !lakeConfigured
        ? json({ error: '数据仓地址未配置' }, 400)
        : json({ dirs: ['p1', 'p2'], sessions: [] })
    }
    return json({})
  }) as typeof fetch
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
  lakeConfigured = false
  authRemotes = []
  lakeListFails = true
  onOpenChange.mockClear()
})

async function flush(ms = 200): Promise<void> {
  const steps = Math.max(1, Math.ceil(ms / 50))
  for (let i = 0; i < steps; i++) {
    await act(async () => { await new Promise(r => setTimeout(r, 50)) })
  }
}

async function renderDialog(): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(UploadDialog, {
      open: true,
      onOpenChange,
      kind: 'session',
      target: { taskId: 't-1', query: '首问', framework: 'opencode', user: 'alice' },
    }))
  })
  await flush(200)
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
  const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
  act(() => {
    set.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function clickButton(match: (text: string) => boolean, last = false): Promise<void> {
  const buttons = [...document.querySelectorAll('button')].filter(x => match(x.textContent ?? ''))
  const b = last ? buttons[buttons.length - 1] : buttons[0]
  if (!b) throw new Error('button not found')
  await act(async () => { b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
  await flush(200)
}

function bodyText(): string {
  return document.body.textContent ?? ''
}

function paradigmSelect(): HTMLSelectElement {
  const s = document.querySelector('select')
  if (!s) throw new Error('paradigm select not found')
  return s as HTMLSelectElement
}

function submitButton(): HTMLButtonElement {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent?.includes('确认上传'))
  if (!b) throw new Error('upload button not found')
  return b as HTMLButtonElement
}

/** 填满表单可选项（提交人已由 target.user 预填 alice）：范式 + 任务结果 */
async function fillForm(): Promise<void> {
  const sel = paradigmSelect()
  if (sel.options.length > 1) setSelectValue(sel, 'p1')
  await clickButton(t => t.trim() === '成功')
}

describe('未配置打开上传弹窗：配置先行（修复前死弹窗）', () => {
  it('打开即弹「连接数据仓」引导；范式列表失败可见、填满表单后上传按钮仍锁死', async () => {
    installFetch()
    await renderDialog()

    expect(bodyText()).toContain('连接数据仓')
    expect(bodyText()).toContain('尚未配置数据仓地址')
    expect(bodyText()).toContain('范式目录列表加载失败')
    await fillForm()
    expect(submitButton().disabled).toBe(true)
  })

  it('引导中保存地址+令牌 → 范式列表自动重载、表单解锁可上传', async () => {
    lakeListFails = false
    installFetch()
    await renderDialog()
    await fillForm()
    expect(submitButton().disabled).toBe(true)

    setInputValue(document.getElementById('cb-token-addr') as HTMLInputElement, LAKE_ADDR)
    setInputValue(document.getElementById('cb-token-secret') as HTMLInputElement, 'glpat-xxxx1234')
    await clickButton(t => t.includes('连接数据仓'))

    // open-precheck 语境保存后不自动续传（表单未提交），只重载范式列表
    expect(bodyText()).not.toContain('范式目录列表加载失败')
    const sel = paradigmSelect()
    expect([...sel.options].map(o => o.value)).toContain('p1')
    setSelectValue(sel, 'p1')
    expect(submitButton().disabled).toBe(false)
  })

  it('取消引导 → 「重试」重跑预检再次弹引导', async () => {
    installFetch()
    await renderDialog()
    expect(bodyText()).toContain('连接数据仓')

    // 令牌弹窗的「取消」（页面上还有上传弹窗自己的「取消」，取最后一个）
    await clickButton(t => t.trim() === '取消', true)
    expect(bodyText()).not.toContain('连接数据仓')
    expect(bodyText()).toContain('范式目录列表加载失败')

    await clickButton(t => t.trim() === '重试')
    expect(bodyText()).toContain('连接数据仓')
  })
})

describe('已配置且凭据齐全：打开不弹引导', () => {
  it('直接进入可用表单，范式列表正常', async () => {
    lakeConfigured = true
    lakeListFails = false
    authRemotes = [{ url: LAKE_ADDR, username: 'oauth2', tokenMasked: 'ab…CD' }]
    installFetch()
    await renderDialog()

    expect(bodyText()).not.toContain('连接数据仓')
    expect(bodyText()).not.toContain('范式目录列表加载失败')
    const sel = paradigmSelect()
    expect([...sel.options].map(o => o.value)).toContain('p2')
    await fillForm()
    expect(submitButton().disabled).toBe(false)
  })
})
