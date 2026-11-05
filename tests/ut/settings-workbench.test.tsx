// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// 设置页工作台化 IT：设置不再是独立裸页——嵌入 AppShell（侧栏导航 + 底部
// 齿轮激活态 + 状态栏版本号），表单控件升级为分段控件（认证方式/日志
// 级别）与开关（LFS/日志布尔项），且分段控件仍是原生 button（键盘可达）。
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import SettingsPage from '@/app/settings/page'
import { VERSION_DISPLAY } from '@/lib/version'
import { BAY_NAME } from '@/lib/branding'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// 设置页已嵌入 AppShell（含侧栏 RecycleBin 的 useRouter）——happy-dom 下
// 需 mock next/navigation
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, refresh: () => {} }),
}))

let root: Root | null = null

beforeAll(() => {
  ;(globalThis as { fetch: typeof fetch }).fetch = (() => {
    const json = (data: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }))
    return ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/api/settings/lake-config')) return json({ configured: false })
      if (url.includes('/api/settings/lake-auth')) return json({ remotes: [] })
      if (url.includes('/api/settings/logger-config')) return json({})
      if (url.includes('/api/recycle')) return json({ entries: [] })
      if (url.includes('/api/')) return json({})
      return Promise.reject(new Error(`unexpected fetch: ${url} ${init?.method ?? ''}`))
    }) as typeof fetch
  })()
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
  localStorage.clear()
})

async function flush(ms = 200): Promise<void> {
  const steps = Math.max(1, Math.ceil(ms / 50))
  for (let i = 0; i < steps; i++) {
    await act(async () => { await new Promise(r => setTimeout(r, 50)) })
  }
}

async function renderSettings(): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(createElement(SettingsPage)) })
  await flush(300)
}

describe('设置页工作台化（AppShell + 分段控件）', () => {
  it('嵌入工作台外壳：侧栏导航在位、齿轮为 a[href=/settings]、工具栏标题与状态栏版本号', async () => {
    await renderSettings()

    expect(document.querySelector('a[href="/settings"]')).not.toBeNull()
    expect(document.querySelector('a[href="/"]')).not.toBeNull()
    const h1 = document.querySelector('h1')
    expect(h1?.textContent).toContain('设置')
    expect(document.body.textContent).toContain(VERSION_DISPLAY)
  })

  it('分段控件与开关就位：认证方式/日志级别为原生 button，LFS 为 role=switch', async () => {
    await renderSettings()

    for (const label of ['令牌', '账户密码', '匿名', 'Debug', 'Info', 'Warn', 'Error']) {
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent === label)
      expect(btn, `分段按钮缺: ${label}`).toBeTruthy()
    }
    const switches = [...document.querySelectorAll('button[role="switch"]')]
    expect(switches.length).toBeGreaterThanOrEqual(4)
  })

  it('数据之湖分区与 LLM 分区渲染（BAY_NAME 段头 + 保存按钮）', async () => {
    await renderSettings()

    expect(document.body.textContent).toContain(`${BAY_NAME} 数据之湖`)
    expect(document.body.textContent).toContain('LLM API 配置')
    const save = [...document.querySelectorAll('button')].find(b => b.textContent === '保存配置')
    expect(save).toBeTruthy()
  })
})
