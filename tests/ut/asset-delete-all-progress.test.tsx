// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom
// 主页「清空全部资产」进度守卫 IT：handleDeleteAll 的 run 清空循环在整轮无一
// 删除成功（失败的 run 不随列表收缩）时必须跳出——否则会对同一批 run 无限重试、
// 页面卡在「正在清空全部资产…」并持续打 DELETE。驱动真实 AssetList 客户端
// 组件 + mock fetch：run 列表恒返一个 run、其 DELETE 恒失败，断言循环一轮即退
// （delete-session 被触达 = 循环已退出）且 run 列表只取一次。

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot as createClientRoot, type Root } from 'react-dom/client'
import { AssetList } from '../../src/components/collection/AssetList'
import { dismissAllNotices } from '../../src/components/NoticeHud'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/',
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type SessionAsset = {
  kind: 'session'
  key: string
  sessionId: string
  taskId: string
  query: string
  framework: string
  version: string | null
  startTime: string
  importedAt: string
  endTime: string | null
  totalTokens: number
  totalCost: number
  totalLatencyMs: number
  totalToolCallCount: number
  totalSkillLoadCount: number
  totalSubagentCount: number
  model: string | null
  user: string | null
  sourcePath: string | null
}

function makeSession(taskId: string): SessionAsset {
  return {
    kind: 'session', key: `session:${taskId}`, sessionId: taskId, taskId, query: '占位会话',
    framework: 'opencode', version: null, startTime: '2026-09-01T00:00:00Z', importedAt: '2026-09-01T00:00:00Z',
    endTime: null, totalTokens: 0, totalCost: 0, totalLatencyMs: 0, totalToolCallCount: 0,
    totalSkillLoadCount: 0, totalSubagentCount: 0, model: null, user: null, sourcePath: null,
  }
}

async function flushTicks(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0))
}

describe('主页「清空全部资产」run 清空循环退出（无进展即止）', () => {
  let runListCalls = 0
  const fetchCalls: Array<{ url: string; method: string }> = []

  beforeAll(() => {
    ;(globalThis as { fetch: typeof fetch }).fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = init?.method ?? 'GET'
      fetchCalls.push({ url, method })

      // run 列表：恒返一个 run；第二次被请求即抛错（旧实现会循环重取，用它把
      // 「未跳出」变成可断言的失败而非挂死）
      if (url.includes('/api/observe/data') && url.includes('kind=run')) {
        runListCalls++
        if (runListCalls > 1) throw new Error('run 列表被重复拉取：清空循环未按无进展退出')
        return Promise.resolve(new Response(JSON.stringify({ items: [{ runId: 'run-fail' }] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        }))
      }
      // run DELETE：恒失败（run 不随列表收缩，正是会触发无限重试的现场）
      if (url.includes('/api/observe/run/')) {
        return Promise.resolve(new Response(JSON.stringify({}), {
          status: 500, headers: { 'content-type': 'application/json' },
        }))
      }
      // 剩余会话 delete-all（循环退出后才会触达）
      if (url.includes('/api/ingest/delete-session')) {
        return Promise.resolve(new Response(JSON.stringify({}), {
          status: 200, headers: { 'content-type': 'application/json' },
        }))
      }
      // 删除结算后的列表软同步
      return Promise.resolve(new Response(JSON.stringify({ items: [], total: 0 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))
    }) as typeof fetch
  })

  afterEach(() => {
    dismissAllNotices()
    window.history.replaceState(null, '', '/')
  })

  it('run 删除失败时不无限重试：清空循环一轮即退、delete-session 仍被触达', async () => {
    runListCalls = 0
    fetchCalls.length = 0

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createClientRoot(container)
    await act(async () => {
      root.render(createElement(AssetList, {
        items: [makeSession('del-all-it-1')], total: 1, page: 1, pageSize: 20, totalCount: 1,
      }))
    })

    // 打开「Delete All Assets」确认弹窗
    const delAllBtn = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('Delete All Assets'))
    expect(delAllBtn, 'Delete All Assets 按钮未找到').toBeTruthy()
    await act(async () => { delAllBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    // 点「确认删除」→ handleDeleteAll 异步结算（弹窗内容经 Portal 挂在 document.body）
    const confirmBtn = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('确认删除'))
    expect(confirmBtn, '确认删除按钮未找到').toBeTruthy()
    await act(async () => { confirmBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    await act(async () => { await flushTicks() })

    // 循环已退出：剩余会话 delete-session 被触达
    expect(fetchCalls.some(c => c.url.includes('/api/ingest/delete-session'))).toBe(true)
    // run 列表只取一次：失败 run 未被无限重试
    expect(runListCalls).toBe(1)

    root.unmount()
    container.remove()
  })
})