// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom
// 统一导入向导 select 步卡片溢出修复 IT：本地会话表此前是向导四表中唯一
// auto 布局的（漏 table-fixed），TableCell 基语 nowrap 下长 firstQuery / 时
// 间列把表撑破卡片右缘。驱动真实 ImportDialog 验证定宽纪律（table-fixed +
// 外壳横向禁溢出），并锁四表外壳只允许经共享 TableCard 单点供给。

import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ImportDialog } from '@/components/collection/ImportDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null

const LONG_QUERY = '重构数据湖镜像层的推送编排逻辑并补齐 gzip 产物布局的回归测试这是一个非常长的首条查询用于复现卡片右缘溢出'
const MOCK_SESSIONS = [
  { id: 'ses_overflow-0001', createdAt: '2026-11-01T02:00:00.000Z', endedAt: '2026-11-01T02:35:00.000Z', firstQuery: LONG_QUERY, turnCount: 5, totalTokens: 12000 },
  { id: 'ses_overflow-0002', createdAt: '2026-11-02T09:00:00.000Z', endedAt: null, firstQuery: null, turnCount: 2, totalTokens: 300 },
]

beforeAll(() => {
  ;(globalThis as { fetch: typeof fetch }).fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes('/api/ingest/import-file/sessions')) {
      return Promise.resolve(new Response(JSON.stringify({ sessions: MOCK_SESSIONS }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))
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

async function openSelectStep(): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(createElement(ImportDialog)) })
  await flush()

  click(findButtonByText('Import')!)
  await flush()
  click(findButtonByText('JSONL (auto)')!)
  await flush()
  const pathInput = document.querySelector('input[placeholder*="sessions-dir"]') as HTMLInputElement
  expect(pathInput).not.toBeNull()
  typeInto(pathInput, '/home/tester/.codex/sessions')
  click(findButtonByText('Load')!)
  await flush()
}

const STAGE_FILES = [
  'src/components/collection/steps/TableCard.tsx',
  'src/components/collection/steps/BrowseStep.tsx',
  'src/components/collection/steps/LakeSessionTable.tsx',
  'src/components/collection/steps/LakeBundleTable.tsx',
  'src/components/collection/steps/LocalSessionTable.tsx',
  'src/components/collection/ImportDialog.tsx',
]

describe('统一导入向导：会话表卡片定宽纪律', () => {
  it('Load 之后 select 步表格 table-fixed + 外壳横向禁溢出；长文本仍在 DOM（truncate 只是视觉裁剪）', async () => {
    await openSelectStep()

    expect(document.body.textContent).toContain('Select sessions to import')

    const table = document.querySelector('table')
    expect(table).not.toBeNull()
    expect(table!.className).toContain('table-fixed')

    // 外壳（Table primitive 的 table-container）横向禁溢出由 TableCard 保证
    const shell = table!.parentElement
    expect(shell).not.toBeNull()
    expect(shell!.className).toContain('overflow-x-auto')
    // TableCard 外层卡片：横向禁溢出（卡片右缘不可能再被表撑破）
    const card = shell!.parentElement
    expect(card).not.toBeNull()
    expect(card!.className).toContain('overflow-x-hidden')

    // 长文本完整在 DOM：CSS truncate 只裁显示，可搜可复制
    expect(table!.textContent).toContain(LONG_QUERY)

    // 规模列合并渲染（turns · tokens）与空 firstQuery 占位
    expect(table!.textContent).toContain('5t · 12.0K')
    expect(table!.textContent).toContain('(empty)')
  })

  it('四张步骤表外壳只经共享 TableCard 供给：纪律单点 + 定宽不可旁路', () => {
    const rootDir = process.cwd()
    const tableCard = readFileSync(join(rootDir, 'src/components/collection/steps/TableCard.tsx'), 'utf8')
    expect(tableCard).toContain('table-fixed')
    expect(tableCard).toContain('overflow-x-hidden')

    for (const rel of STAGE_FILES.slice(1)) {
      const src = readFileSync(join(rootDir, rel), 'utf8')
      // 步骤表不再内联卡片外壳（含 overflow-y-auto 的容器）——只能走 TableCard
      expect(src, `${rel} 不得内联卡片外壳`).not.toContain('overflow-y-auto')
      if (!rel.endsWith('ImportDialog.tsx')) {
        expect(src).toContain('TableCard')
      }
    }
    // 向导主体也不再持有表原语（select 表已抽到步骤组件）
    const dialog = readFileSync(join(rootDir, 'src/components/collection/ImportDialog.tsx'), 'utf8')
    expect(dialog).not.toContain('from "@/components/ui/table"')
  })
})
