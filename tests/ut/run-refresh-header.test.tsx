// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// run 工作台页头刷新能力 IT（session 页刷新/自动同步在 run-first 架构下的对偶）：
// 锁四件事：①solo + 原生 opencode 源 → 「自动同步」指示灯（页头工具行小字）
//   + 刷新钮可手动触发（单一控件三态：图标随态变化——wifi+呼吸点=自动同步中
//   可点击、spinner=同步中禁用、静止=手动刷新）；②claude 格式源（proxy 捕获）
//   / 无源 → 手动刷新钮（可用/禁用，title=立即刷新）；③手动刷新 → POST
//   /api/ingest/refresh-session（taskId+framework 消歧）+ run 详情重载；
//   ④自动同步轮询（5s 探针 → settled 且有变化 → 增量导入）。

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createElement, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import RunDetailPage from '@/app/run/[runId]/page';
import { soloRunIndex } from '@/lib/run/solo';
import { buildViewModel } from '@/lib/run/view-model';
import { attachSessionRefs } from '@/lib/run/session-link';
import type { SessionRef } from '@/lib/run/model';
import { soloRunIdOf } from '@/lib/run/identity';

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const nav = vi.hoisted(() => ({ replace: vi.fn() }))
const searchState = vi.hoisted(() => ({ current: '' }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: nav.replace, back: () => {}, refresh: () => {} }),
  usePathname: () => '/run/solo:ses_rfh',
  useSearchParams: () => new URLSearchParams(searchState.current),
}))

const SID = 'ses_rfh'
const SOLO_RUN_ID = soloRunIdOf(SID)
const MODEL = 'volc-gateway/glm-4.7'

const mkRef = (framework: string, sourcePath: string | null): SessionRef => ({
  taskId: SID, framework, rowId: `row-${SID}`, turns: 2,
  totalTokens: 2300, durationMs: 60000, label: '刷新能力回归', startTime: '2026-10-13T02:00:12.000Z',
  endTime: '2026-10-13T02:01:12.000Z', cacheReadTokens: 0, contextPeakPct: 72.5,
  model: MODEL, totalCost: 0.2, version: null, totalLatencyMs: 60000, sourcePath,
})

const bodyOf = (ref: SessionRef) => {
  const vm = buildViewModel(soloRunIndex(ref))
  attachSessionRefs(vm, new Map([[SID, ref]]))
  return {
    run: {
      runId: SOLO_RUN_ID, kind: 'solo' as const, name: ref.label, status: vm.status,
      exportDataComplete: true, startedAt: ref.startTime, finishedAt: ref.endTime, import: null,
    },
    viewModel: vm,
    memberStats: null,
    totalErrors: 0,
  }
}

const fetchedUrls: string[] = []
const postedBodies: Array<Record<string, unknown>> = []
const autoRefreshState = { countChanged: false, maxTimeUpdated: 1 }

const json = (data: unknown) => ({ ok: true, json: async () => data, text: async () => '' })

vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input.toString()
  fetchedUrls.push(url)
  if (url.includes('/api/ingest/refresh-session')) {
    postedBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
    return json({ success: true, addedTurns: 2, updatedTurns: 0 })
  }
  if (url.includes('/auto-refresh')) {
    return json({
      countChanged: autoRefreshState.countChanged,
      sourceMessageCount: 5, ourTurnCount: 3,
      maxTimeUpdated: autoRefreshState.maxTimeUpdated,
      streaming: false, pendingInput: false, settled: true,
    })
  }
  if (url.includes(`/api/observe/run/${encodeURIComponent(SOLO_RUN_ID)}`)) return json(bodyOf(activeRef))
  return json({})
}))

// 当前渲染的 solo ref（fetch mock 闭包引用——按用例切换源形态）
let activeRef = mkRef('opencode', '/tmp/fake-opencode.db')

let root: Root | null = null

async function renderSolo(search = '') {
  searchState.current = search
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(Suspense, { fallback: null }, createElement(RunDetailPage, { params: Promise.resolve({ runId: SOLO_RUN_ID }) })))
  })
  await act(async () => { await Promise.resolve() })
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
  fetchedUrls.length = 0
  postedBodies.length = 0
  autoRefreshState.countChanged = false
  autoRefreshState.maxTimeUpdated = 1
  vi.useRealTimers()
})

describe('run 工作台页头刷新能力（session 刷新/自动同步对偶）', () => {
  it('solo + 原生 opencode 源：自动同步指示灯 + 刷新钮可手动触发（无手动「刷新」文字按钮）', async () => {
    activeRef = mkRef('opencode', '/tmp/fake-opencode.db')
    await renderSolo('?tab=overview')
    const header = document.body.textContent ?? ''
    expect(header).toContain('自动同步')
    // 单一刷新控件（自动同步态 title 含「点击立即刷新」）
    const btn = document.querySelector('button[title*="立即刷新"]') as HTMLButtonElement | null
    expect(btn).toBeTruthy()
    expect(btn!.disabled).toBe(false)
    // 无「刷新」文字按钮（动作簇全图标化）
    expect([...document.querySelectorAll('button')].some(b => b.textContent?.trim() === '刷新')).toBe(false)
  })

  it('claude 格式源（proxy 捕获）：手动刷新钮可用', async () => {
    activeRef = mkRef('claude-code-proxy', '/tmp/fake-capture.jsonl.gz')
    await renderSolo('?tab=overview')
    const btn = document.querySelector('button[title="立即刷新"]') as HTMLButtonElement | null
    expect(btn).toBeTruthy()
    expect(btn!.disabled).toBe(false)
    // 非原生 opencode 源不开启自动同步
    expect(document.body.textContent ?? '').not.toContain('自动同步')
  })

  it('无源会话：手动刷新钮禁用', async () => {
    activeRef = mkRef('opencode', null)
    await renderSolo('?tab=overview')
    const btn = document.querySelector('button[title="立即刷新"]') as HTMLButtonElement | null
    expect(btn).toBeTruthy()
    expect(btn!.disabled).toBe(true)
  })

  it('手动刷新：POST refresh-session（taskId+framework 消歧）+ run 详情重载', async () => {
    activeRef = mkRef('claude-code-proxy', '/tmp/fake-capture.jsonl.gz')
    await renderSolo('?tab=overview')
    const detailFetchesBefore = fetchedUrls.filter(u => u === `/api/observe/run/${encodeURIComponent(SOLO_RUN_ID)}`).length
    const btn = document.querySelector('button[title="立即刷新"]') as HTMLButtonElement
    await act(async () => { btn.click() })
    await act(async () => { await Promise.resolve() })
    expect(postedBodies).toEqual([{ taskId: SID, framework: 'claude-code-proxy' }])
    const detailFetchesAfter = fetchedUrls.filter(u => u === `/api/observe/run/${encodeURIComponent(SOLO_RUN_ID)}`).length
    expect(detailFetchesAfter).toBeGreaterThan(detailFetchesBefore)
  })

  it('自动同步轮询：首询建基线，次询 settled 且有变化 → 增量导入', async () => {
    activeRef = mkRef('opencode', '/tmp/fake-opencode.db')
    vi.useFakeTimers()
    await renderSolo('?tab=overview')
    // 首询：建基线，不触发导入
    await act(async () => { await vi.advanceTimersByTimeAsync(5100) })
    expect(fetchedUrls.some(u => u.includes('/auto-refresh'))).toBe(true)
    expect(fetchedUrls.some(u => u.includes('/api/ingest/refresh-session'))).toBe(false)
    // 次询：settled + countChanged → 增量导入
    autoRefreshState.countChanged = true
    await act(async () => { await vi.advanceTimersByTimeAsync(5100) })
    expect(postedBodies).toEqual([{ taskId: SID, framework: 'opencode' }])
  })
})
