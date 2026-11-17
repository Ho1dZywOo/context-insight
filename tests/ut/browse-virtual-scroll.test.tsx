// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom
// browse 步大目录虚拟滚动 IT：十万级条目（如 /tmp 顶层）全量返回后，DOM 不
// 可能也不应该全量渲染——表格行恒定高度 + 滚动容器只渲染可视窗口附近的行
// （前后 spacer 行撑总高）。驱动真实 ImportDialog：3000 条目夹具 → 断言
// 实体行数受窗口约束 → 滚动后窗口推进 → 过滤词把目标收敛进首窗 → 小夹具
// （既有语义）不触发窗口化、全量直渲。

import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { ImportDialog } from '@/components/collection/ImportDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null

const BIG_COUNT = 3000

function bigDir(): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = []
  for (let i = 0; i < BIG_COUNT; i++) {
    const name = i % 10 === 0 ? `dir-${i}` : `plain-${i}.log`
    const isDir = i % 10 === 0
    entries.push({
      name,
      fullPath: `/tmp/virtual-it/${name}`,
      isDir,
      size: isDir ? 0 : 123,
      mtime: 1790000000000 + i,
      isImportableFile: !isDir && i % 10 === 5,
      importableType: !isDir && i % 10 === 5 ? 'codex-jsonl' : null,
      isBundleDir: false,
    })
  }
  return entries
}

beforeAll(() => {
  ;(globalThis as { fetch: typeof fetch }).fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes('/api/ingest/browse-directory')) {
      return Promise.resolve(new Response(JSON.stringify({
        isDirectory: true,
        entries: bigDir(),
        parentPath: '/tmp',
        currentPath: '/tmp/virtual-it',
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

function typeInto(input: HTMLInputElement, value: string): void {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function openBrowseStep(): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(createElement(ImportDialog)) })
  await flush()

  click(findButtonByText('Import')!)
  await flush()

  // 快捷路径「主目录」直达 browse 步（mock 对任意 dirPath 恒返回大夹具）
  click(findButtonByText('主目录')!)
  await flush()

  expect(document.body.textContent).toContain('/tmp/virtual-it')
  expect(document.querySelector('input[placeholder*="Filter by file name or session ID"]')).not.toBeNull()
}

/** 实体行 = Name 列（第 2 格）有文本的行；spacer/空态行只有 1 个 colspan cell */
function entityRows(): Element[] {
  return [...document.querySelectorAll('tbody tr')].filter(tr => {
    const cells = tr.querySelectorAll('td')
    return cells.length >= 2 && (cells[1].textContent ?? '').length > 0
  })
}

function scrollContainer(): HTMLElement | null {
  return document.querySelector('.max-h-\\[320px\\].overflow-y-auto') as HTMLElement | null
}

describe('ImportDialog browse 步 — 大目录虚拟滚动', () => {
  it('3000 条目只渲染窗口内实体行（DOM 行数受窗口约束，非全量）', async () => {
    await openBrowseStep()
    const rows = entityRows()
    expect(rows.length).toBeGreaterThan(0)
    // 窗口 ≈ 视口 8 + overscan 12 = 20 行量级；3000 行绝不能全渲染
    expect(rows.length).toBeLessThanOrEqual(24)
    expect(rows.length).toBeLessThan(BIG_COUNT)
  })

  it('滚动推进窗口：滚到中部后出现中部条目，首窗条目让位', async () => {
    await openBrowseStep()
    const firstWindow = entityRows().map(r => r.textContent ?? '')
    const scroller = scrollContainer()
    expect(scroller).not.toBeNull()
    await act(async () => {
      scroller!.scrollTop = 40 * 1000 // 第 1000 行处（排序后靠 plain- 开头的行）
      scroller!.dispatchEvent(new Event('scroll', { bubbles: true }))
    })
    await flush()
    const laterWindow = entityRows().map(r => r.textContent ?? '')
    expect(laterWindow.length).toBeGreaterThan(0)
    // 窗口内容确实换了（非同一批行）
    const overlap = firstWindow.filter(n => laterWindow.includes(n))
    expect(laterWindow.length - overlap.length).toBeGreaterThan(0)
  })

  it('过滤词收敛：输入目标词后匹配行进窗（在超大目录里找指定条目）', async () => {
    await openBrowseStep()
    const filterInput = document.querySelector('input[placeholder*="Filter"]') as HTMLInputElement
    expect(filterInput).not.toBeNull()
    typeInto(filterInput, 'dir-299')
    await flush()
    const rows = entityRows()
    expect(rows.length).toBeGreaterThan(0)
    const text = rows.map(r => r.textContent ?? '').join('\n')
    expect(text).toContain('dir-2990')
  })
})
