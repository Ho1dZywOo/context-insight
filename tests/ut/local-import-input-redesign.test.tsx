// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom
// 统一导入向导 input 步重做 IT：双源大卡选择（radio-card）取代三层 label
// 堆叠；底部路径小字说明退役（快捷路径 chip 悬停 title 即完整路径）。
// 驱动真实 ImportDialog 验证新结构 + 旧文案不再渲染。

import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { ImportDialog } from '@/components/collection/ImportDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null

beforeAll(() => {
  ;(globalThis as { fetch: typeof fetch }).fetch = (() => {
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

async function openInputDialog(): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(createElement(ImportDialog)) })
  await flush()
  await act(async () => { click(findButtonByText('Import')!) })
  await flush()
}

describe('统一导入向导 input 步：双源卡重做', () => {
  it('双源大卡就位（本地文件 + 数据仓），选中态与工作区联动', async () => {
    await openInputDialog()

    // 双源卡：默认选中本地（主行动色），数据仓卡未选中
    expect(document.body.textContent).toContain('本地文件')
    expect(document.body.textContent).toContain('浏览文件系统或输入路径 · Bundle 目录自动识别')
    const localCard = findButtonByText('本地文件')!
    expect(localCard.className).toContain('border-emerald-500/40')

    // 选中源的工作区：路径输入 + 格式 segmented + 快捷 chips（JSONL 默认集）
    expect(document.querySelector('input[placeholder*="sessions-dir"]')).not.toBeNull()
    for (const label of ['cpx proxy 捕获', 'Claude 原生', '主目录']) {
      expect(findButtonByText(label), `快捷按钮缺: ${label}`).toBeTruthy()
    }
  })

  it('底部路径小字退役：不再渲染 ~/.claude/projects 等路径提示与 Browse 引导', async () => {
    await openInputDialog()

    expect(document.body.textContent).not.toContain('~/.claude/projects')
    expect(document.body.textContent).not.toContain('~/.context-insight/proxy')
    expect(document.body.textContent).not.toContain('Click Browse to explore')
    expect(document.body.textContent).not.toContain('Run 的 Bundle 目录：')

    // 快捷 chip 悬停 title 仍携带完整路径（说明能力由 tooltip 承接）
    const chip = findButtonByText('Claude 原生')!
    expect(chip.getAttribute('title')).toBe('~/.claude/projects')
  })

  it('旧三层 label（导入来源 / 文件格式 / File Path）不再渲染；格式切换仍可用', async () => {
    await openInputDialog()

    expect(document.body.textContent).not.toContain('导入来源')
    expect(document.body.textContent).not.toContain('文件格式')
    expect(document.body.textContent).not.toContain('File Path')
    expect(document.body.textContent).not.toContain('快捷路径:')

    // 格式切换：SQLite 快捷集替换 JSONL 集
    await act(async () => { click(findButtonByText('SQLite (auto)')!) })
    await flush()
    expect(findButtonByText('opencode 数据')).toBeTruthy()
    expect(findButtonByText('cpx proxy 捕获')).toBeNull()
  })
})
