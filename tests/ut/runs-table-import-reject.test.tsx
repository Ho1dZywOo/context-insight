// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom
// RunsTable 导入拒绝兜底 IT：onImport 若 reject（编排层抛异常 / 网络错误未被
// 调用方捕获），此前 `setImporting(delete)` 在 await 之后才执行，行会永久停在
// 「导入中…」。修复后 try/catch/finally 兜底：busy 态清理 + 错误写入 importErrors
//（行显示「重试导入」并带错误 title），与同仓 BundleTable.importBundle 同款。

import { describe, it, expect, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { RunsTable, type RunItemView } from '@/components/collection/lake/RunsTable'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null

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

const item: RunItemView = {
  sid: 'sid-123',
  isBaseline: false,
  recording: 'capture',
  framework: 'opencode',
  ccVersion: null,
  workflow: null,
  description: null,
  author: null,
  opGen: null,
  startTime: '2026-01-01T00:00:00Z',
  startTimeApprox: false,
  durationMs: 1000,
  activeKnown: true,
  wallMs: 1200,
  totalTokens: 100,
  model: 'claude-3',
  imported: false,
  totalScore: null,
  scoreSource: null,
  dimensions: [],
  baselineDelta: null,
  insightUrl: null,
}

describe('RunsTable 导入拒绝兜底', () => {
  it('onImport reject：busy 态清理 + 错误写入 importErrors（显示「重试导入」）', async () => {
    const onImport = vi.fn(() => Promise.reject(new Error('network exploded')))
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(createElement(RunsTable, { items: [item], onImport }))
    })
    await flush()

    const importBtn = findButtonByText('导入查看')
    expect(importBtn, '未导入行应有「导入查看」按钮').not.toBeNull()
    await act(async () => {
      importBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await flush()

    // 拒绝后 busy 态必须清理：不再显示「导入中…」，出现「重试导入」且 title 带错误
    expect(document.body.textContent ?? '', 'busy 态未清理').not.toContain('导入中…')
    const retry = findButtonByText('重试导入')
    expect(retry, '拒绝后应显示「重试导入」').not.toBeNull()
    expect(retry!.getAttribute('title')).toContain('network exploded')
  })
})
