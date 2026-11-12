// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom
// 统一导入向导 browse 步「win32 盘符列表」IT：驱动真实 ImportDialog——模拟
// 服务端返回盘根（parentPath 为空串 = 根层级标识），点击 Parent directory
// 请求空串 → 盘符列表（头显示「此电脑」标签、行可点导航、向上按钮到顶消失）。
// 锁的是空串作为合法父级的页面层接线（旧实现 `parentDir &&` 会把空串当无父级）。

import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { ImportDialog } from '@/components/collection/ImportDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null

interface MockEntry {
  name: string
  fullPath: string
  isDir: boolean
  size: number
  mtime: number | null
  isImportableFile: boolean
  importableType: string | null
}

const usersDir: MockEntry = {
  name: 'Users',
  fullPath: 'C:\\Users',
  isDir: true,
  size: 0,
  mtime: 1790000000000,
  isImportableFile: false,
  importableType: null,
}

const drives: MockEntry[] = [
  { name: 'C:', fullPath: 'C:\\', isDir: true, size: 0, mtime: 1790000000000, isImportableFile: false, importableType: null },
  { name: 'D:', fullPath: 'D:\\', isDir: true, size: 0, mtime: 1790000000001, isImportableFile: false, importableType: null },
]

beforeAll(() => {
  ;(globalThis as { fetch: typeof fetch }).fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes('/api/ingest/browse-directory')) {
      const { dirPath } = JSON.parse(String(init?.body ?? '{}')) as { dirPath: string }
      if (dirPath === '') {
        return Promise.resolve(new Response(JSON.stringify({
          isDirectory: true,
          isRootLevel: true,
          entries: drives,
          currentPath: '',
          parentPath: null,
        }), { status: 200, headers: { 'content-type': 'application/json' } }))
      }
      // 快捷路径与盘内目录统一回盘根视图：parentPath 为空串（= 根层级标识）
      return Promise.resolve(new Response(JSON.stringify({
        isDirectory: true,
        entries: [usersDir],
        currentPath: 'C:\\',
        parentPath: '',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    }
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } }))
  }) as typeof fetch
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
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

function visibleRows(): HTMLElement[] {
  return [...document.querySelectorAll('tbody tr')] as HTMLElement[]
}

describe('Import Session browse 步：win32 盘符列表（空串根层级）', () => {
  it('盘根向上（parentPath 为空串）→ 盘符列表；到顶后向上按钮消失', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => { root!.render(createElement(ImportDialog)) })
    await flush()

    click(findButtonByText('Import')!)
    await flush()
    click(findButtonByText('Codex 原生')!)
    await flush()

    // 快捷路径落在盘根：parentPath 为空串（根层级标识），向上按钮必须存在
    expect(document.body.textContent).toContain('C:\\')
    const up = findButtonByText('Parent directory')
    expect(up).not.toBeNull()

    click(up!)
    await flush()

    // 盘符列表：头显示根层级标签、两行盘符可点；parentPath null → 向上按钮消失
    expect(document.body.textContent).toContain('此电脑（所有盘符）')
    const rowTexts = visibleRows().map(r => r.textContent ?? '')
    expect(rowTexts.some(t => t.includes('C:'))).toBe(true)
    expect(rowTexts.some(t => t.includes('D:'))).toBe(true)
    expect(findButtonByText('Parent directory')).toBeNull()
  })
})
