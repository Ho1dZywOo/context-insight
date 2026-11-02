// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom
// UploadDialog 非法 ISO 时间兜底 IT：`new Date(iso)` 对非法字符串不抛异常（返回
// Invalid Date），原 try/catch 起不到兜底，getMonth() 等返回 NaN 产出「NaN/NaN
// NaN:NaN」并随 buildUploadDescription 写进数据仓描述。修复后参照 formatDateTime
// 用 Number.isNaN(d.getTime()) 判断，非法即回退原串。此处走会话上传完整交互，
// 断言发往 /api/ingest/lake 的 description 回退原串、不含 NaN。

import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { UploadDialog } from '@/components/collection/UploadDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let uploadBody: Record<string, unknown> | null = null

const origFetch = globalThis.fetch

beforeAll(() => {
  ;(globalThis as { fetch: typeof fetch }).fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const json = (data: unknown) => Promise.resolve(new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } }))
    if (url.includes('/api/settings/lake-config')) return json({ configured: true, address: 'https://example.com/lake.git', branch: 'main' })
    if (url.includes('/api/settings/lake-auth')) return json({ remotes: [{ url: 'https://example.com/lake.git', username: 'tester', tokenMasked: 'glpat-****' }] })
    if (url.includes('/api/ingest/lake')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      if (body.action === 'list') return json({ dirs: ['demo'], sessions: [] })
      if (body.action === 'upload') {
        uploadBody = body
        return json({ folder: 'demo/x/', unchanged: false, sid: body.taskId })
      }
      return json({})
    }
    return json({})
  }) as typeof fetch
})

afterAll(() => {
  ;(globalThis as { fetch: typeof fetch }).fetch = origFetch
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
  uploadBody = null
})

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })
  }
}

function findButtonByText(text: string): HTMLButtonElement | null {
  return [...document.querySelectorAll('button')].find(b => b.textContent?.includes(text)) ?? null
}

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

describe('UploadDialog 非法 ISO 时间兜底', () => {
  it('startTime 非法 → 上传描述回退原串、不产出 NaN', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(createElement(UploadDialog, {
        open: true,
        onOpenChange: () => {},
        kind: 'session',
        target: {
          taskId: 'sid-abc',
          query: null,
          framework: 'opencode',
          model: 'claude-3',
          startTime: 'garbage-value',
          endTime: null,
          sourcePath: null,
          user: null,
        },
      }))
    })
    await flush()

    const dlg = document.querySelector('[data-slot="dialog-content"]') as HTMLElement
    expect(dlg, '上传弹窗未渲染').toBeTruthy()

    // 提交人 + 范式目录 + 任务结果（必选）
    const submitterInput = [...dlg.querySelectorAll('input')].find(i => i.placeholder?.includes('真实姓名')) as HTMLInputElement
    const setInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setInput.call(submitterInput, '张三')
      submitterInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const select = dlg.querySelector('select') as HTMLSelectElement
    const setSelect = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    await act(async () => {
      setSelect.call(select, 'demo')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => { click(findButtonByText('成功')!) })
    await flush()

    const confirm = [...dlg.querySelectorAll('button')].find(b => b.textContent?.includes('确认上传')) as HTMLButtonElement
    expect(confirm, '确认上传按钮未找到').toBeTruthy()
    expect(confirm.disabled).toBe(false)
    await act(async () => { click(confirm) })
    await flush()

    expect(uploadBody, '上传请求未发出').toBeTruthy()
    const desc = String(uploadBody!.description)
    expect(desc).toContain('garbage-value')
    expect(desc).not.toContain('NaN')
  })
})
