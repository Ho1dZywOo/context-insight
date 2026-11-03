// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// run-first 刀I3 页面 IT（design: docs/design/run-first-architecture/design.md
// §3.4，能力闸挂载）：统一工作台补 Wire/Replay/Score 三 tab + solo Audit 能力闸。
// 锁四件事：①solo run 的 Audit = session AI 审计板（AuditBoardTab 装配：skillEvents
// 平铺 + 主 agent 编排可用性，均走 run 成员视图端点）；②Score 卡按成员钻取
// （scorecard GET 命中成员视图端点，零 session 端点触达）；③Replay 富轮次
// （includeContent+includeToolDetail）真实渲染 + wire/replay 默认隐藏（?a 展开）；
// ④多成员 run 的 Wire 轮次经成员 chips 切换执行目标（solo/单成员免 chips）。

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createElement } from 'react';
import { Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import RunDetailPage from '@/app/run/[runId]/page';
import { soloRunIndex } from '@/lib/run/solo';
import { buildViewModel } from '@/lib/run/view-model';
import { attachSessionRefs } from '@/lib/run/session-link';
import { parseAndIndex } from '@/lib/run/reader';
import type { SessionRef } from '@/lib/run/model';
import { soloRunIdOf } from '@/lib/run/identity';

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const nav = vi.hoisted(() => ({ replace: vi.fn() }))
const searchState = vi.hoisted(() => ({ current: '' }))
const pathState = vi.hoisted(() => ({ current: '/run/solo:ses_mtabs' }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: nav.replace, back: () => {}, refresh: () => {} }),
  usePathname: () => pathState.current,
  useSearchParams: () => new URLSearchParams(searchState.current),
}))

const SID = 'ses_mtabs'
const SOLO_RUN_ID = soloRunIdOf(SID)
const MODEL = 'volc-gateway/glm-4.7'

const mkRef = (taskId: string, label: string): SessionRef => ({
  taskId, framework: 'opencode', rowId: `row-${taskId}`, turns: 2,
  totalTokens: 2300, durationMs: 60000, label, startTime: '2026-10-13T02:00:12.000Z',
  endTime: '2026-10-13T02:01:12.000Z', cacheReadTokens: 0, contextPeakPct: 72.5,
  model: MODEL, totalCost: 0.2, version: null, totalLatencyMs: 60000,
})

const soloRef = mkRef(SID, '修一下登录页样式')
const soloViewModel = buildViewModel(soloRunIndex(soloRef))
attachSessionRefs(soloViewModel, new Map([[SID, soloRef]]))

const soloBody = {
  run: {
    runId: SOLO_RUN_ID, kind: 'solo' as const, name: soloRef.label, status: soloViewModel.status,
    exportDataComplete: true, startedAt: soloRef.startTime, finishedAt: soloRef.endTime, import: null,
  },
  viewModel: soloViewModel,
  memberStats: null,
  totalErrors: 0,
}

// —— 多成员（mini-bundle 3 成员，rfm3- 前缀隔离）——
const MULTI_RUN_ID = 'minidemo01'
const MULTI_SIDS = ['rfm3-ses-mini-a', 'rfm3-ses-mini-b', 'rfm3-ses-mini-c']
const rewrite = (v: unknown): unknown => {
  if (typeof v === 'string') return v.replace(/^ses_mini_/, 'rfm3-ses-mini-')
  if (Array.isArray(v)) return v.map(rewrite)
  if (v != null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, rewrite(val)]))
  }
  return v
}
const multiIndex = parseAndIndex(
  rewrite(JSON.parse(fs.readFileSync(path.resolve(__dirname, './data/run/mini-bundle/workflow.json'), 'utf-8'))) as Parameters<typeof parseAndIndex>[0],
)
const multiViewModel = buildViewModel(multiIndex)
const multiRefs = new Map(MULTI_SIDS.map((sid, i) => [sid, mkRef(sid, `成员 ${i + 1}`)]))
attachSessionRefs(multiViewModel, multiRefs)
const multiBody = {
  run: {
    runId: MULTI_RUN_ID, kind: 'run' as const, name: 'rfm3 多成员', status: multiViewModel.status,
    exportDataComplete: true, startedAt: '2026-10-13T02:00:00Z', finishedAt: '2026-10-13T02:10:00Z', import: null,
  },
  viewModel: multiViewModel,
  memberStats: null,
  totalErrors: 0,
}

const memberTurns = [
  {
    turnId: 't-mtabs-0', turnIndex: 0, role: 'user', content: '帮我修登录页样式', contentSummary: '帮我修登录页样式',
    agentName: null, isSubagent: false, subagentName: null, subagentSessionId: null,
    totalTokens: 50, inputTokens: 50, inputMessagesCount: 1, inputMessagesTokens: 50, outputTokens: 0,
    latencyMs: 100, createdAt: '2026-10-13T02:00:10Z', model: null, toolCalls: [],
    skillEvents: [{ skillName: 'demo-skill', eventType: 'invoke', success: true }],
  },
  {
    turnId: 't-mtabs-1', turnIndex: 1, role: 'assistant', content: '已修复样式问题', contentSummary: '已修复样式问题',
    agentName: null, isSubagent: false, subagentName: null, subagentSessionId: null,
    totalTokens: 80, inputTokens: 10, inputMessagesCount: 1, inputMessagesTokens: 10, outputTokens: 70,
    latencyMs: 900, createdAt: '2026-10-13T02:00:40Z', model: MODEL, toolCalls: [], skillEvents: [],
  },
]

const fetchedUrls: string[] = []
const json = (data: unknown) => ({ ok: true, json: async () => data, text: async () => '' })

vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
  const url = typeof input === 'string' ? input : input.toString()
  fetchedUrls.push(url)
  if (url.includes('/member-turns')) return json({ items: memberTurns, total: memberTurns.length })
  if (url.includes('/main-agent-workflow')) return json({ available: true, name: 'demo-flow', source: 'state' })
  if (url.includes('/scorecard')) return json({})
  if (url.includes('/wire-rounds')) return json({ rounds: [], delta: false })
  if (url.includes(`/api/observe/run/${encodeURIComponent(SOLO_RUN_ID)}`)) return json(soloBody)
  if (url.includes(`/api/observe/run/${encodeURIComponent(MULTI_RUN_ID)}`)) return json(multiBody)
  return json({})
}))

let root: Root | null = null

async function renderPage(initialSearch: string, runId: string, pathname: string) {
  searchState.current = initialSearch
  pathState.current = pathname
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      createElement(
        Suspense,
        { fallback: null },
        createElement(RunDetailPage, { params: Promise.resolve({ runId }) }),
      ),
    )
  })
  await act(async () => {
    await new Promise(r => setTimeout(r, 0))
  })
}

const renderSolo = (search = '') => renderPage(search, SOLO_RUN_ID, `/run/${SOLO_RUN_ID}`)
const renderMulti = (search = '') => renderPage(search, MULTI_RUN_ID, `/run/${MULTI_RUN_ID}`)

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
  fetchedUrls.length = 0
})

describe('run-first 刀I3：能力闸挂载（Wire/Replay/Score + solo Audit）', () => {
  it('solo Audit 能力闸：四域审计板（solo = 单成员退化，装配数据走 run 级端点）', async () => {
    await renderSolo('?tab=audit')
    const audit = document.querySelector('[data-run-tab="audit"]')
    expect(audit).toBeTruthy()
    expect(audit!.classList.contains('hidden')).toBe(false)
    const text = audit!.textContent ?? ''
    // 四域分段：Skill / Agent / Workflow / Run（solo 与 bundle 同一组件，单成员退化）
    for (const d of ['Skill', 'Agent', 'Workflow', 'Run']) {
      expect(text).toContain(d)
    }
    // 装配数据走 run 级 skills 端点（零 member 参数，成员归因在事件里）
    expect(fetchedUrls).toContain(`/api/observe/run/${encodeURIComponent(SOLO_RUN_ID)}/skills`)
    // 旧 session 域端点零触达（审计目标不再下沉单成员会话）
    expect(fetchedUrls.some(u => u.includes('/api/observe/session/'))).toBe(false)
  })

  it('Score tab：评分卡按成员钻取，scorecard GET 命中成员视图端点（零 session 端点触达）', async () => {
    await renderSolo('?tab=score')
    const score = document.querySelector('[data-run-tab="score"]')
    expect(score).toBeTruthy()
    expect(score!.classList.contains('hidden')).toBe(false)
    expect(fetchedUrls).toContain(
      `/api/observe/run/${encodeURIComponent(SOLO_RUN_ID)}/scorecard?taskId=${SID}&framework=opencode&member=${SID}`,
    )
    // §N 跳转映射：走 turn-digest 轻摘要（只要 turnIndex→turnId）
    expect(fetchedUrls).toContain(`/api/observe/run/${encodeURIComponent(SOLO_RUN_ID)}/turn-digest?member=${SID}`)
    expect(fetchedUrls.some(u => u.includes('/api/observe/session/'))).toBe(false)
  })

  it('Replay tab：富轮次（includeContent+includeToolDetail）真实渲染；wire/replay 默认隐藏、?a 展开', async () => {
    await renderSolo('?tab=replay&a')
    const replay = document.querySelector('[data-run-tab="replay"]')
    expect(replay).toBeTruthy()
    expect(replay!.classList.contains('hidden')).toBe(false)
    expect(fetchedUrls).toContain(
      `/api/observe/run/${encodeURIComponent(SOLO_RUN_ID)}/member-turns?includeContent=true&includeToolDetail=true&member=${SID}`,
    )
    // ChatReplayView 为播放步进式渲染（▶ Play 逐条揭示）：锁挂载 + 双面板 +
    // 消息分组计数（2 轮 → 3 组消息，进度「— / 3」），内容揭示由播放态驱动
    expect(replay!.textContent).toContain('对话回放')
    expect(replay!.textContent).toContain('User ↔ Assistant')
    expect(replay!.textContent).toContain('/ 3')
    // ?a 展开后 tab 栏可见 Wire 轮次 / Replay；默认（无 a）不可见
    const tabLabels = [...document.querySelectorAll('button')].map(b => b.textContent ?? '')
    expect(tabLabels.some(t => t.includes('Wire 轮次'))).toBe(true)
    expect(tabLabels.some(t => t.includes('Replay'))).toBe(true)
  })

  it('高级门：默认不渲染 wire/replay tab 项（Score 常驻）', async () => {
    await renderSolo('')
    const tabLabels = [...document.querySelectorAll('button')].map(b => b.textContent ?? '')
    expect(tabLabels.some(t => t.includes('Wire 轮次'))).toBe(false)
    expect(tabLabels.some(t => t === 'Replay')).toBe(false)
    expect(tabLabels.some(t => t === 'Score')).toBe(true)
  })

  it('多成员 Wire 轮次：成员 chips 切换执行目标，wire-rounds 取数随成员切换', async () => {
    await renderMulti('?tab=wire&a')
    const wire = document.querySelector('[data-run-tab="wire"]')
    expect(wire).toBeTruthy()
    // 3 枚成员 chips（title = 成员 taskId）
    const chips = [...document.querySelectorAll('button[title]')].filter(b =>
      MULTI_SIDS.includes(b.getAttribute('title') ?? ''),
    )
    expect(chips.length).toBe(3)
    // 缺省执行目标（首个成员）已发起 wire-rounds 取数
    const firstFetch = fetchedUrls.find(u => u.includes('/wire-rounds'))
    expect(firstFetch).toBeTruthy()
    const firstMember = MULTI_SIDS.find(sid => firstFetch!.includes(`member=${sid}`))
    expect(firstMember).toBeTruthy()
    // 点另一枚成员 chip → 成员视图端点重取
    const other = chips.find(b => (b.getAttribute('title') ?? '') !== firstMember)
    expect(other).toBeTruthy()
    await act(async () => { (other as HTMLElement).click() })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    const switched = fetchedUrls.filter(u => u.includes('/wire-rounds'))
    expect(switched.some(u => u.includes(`member=${other!.getAttribute('title')}`))).toBe(true)
    expect(fetchedUrls.some(u => u.includes('/api/observe/session/'))).toBe(false)
  })

  it('多成员 Score：成员凹槽轨道单行选择（执行目标）；solo 单成员免轨道', async () => {
    await renderMulti('?tab=score')
    const score = document.querySelector('[data-run-tab="score"]')
    expect(score).toBeTruthy()
    // 壳：浅灰画布（对齐工作台卡片语法）
    const root = score!.querySelector('[data-run-score]')
    expect(root?.className).toContain('bg-muted/30')
    const chips = [...document.querySelectorAll('button[title]')].filter(b =>
      MULTI_SIDS.includes(b.getAttribute('title') ?? ''),
    )
    expect(chips.length).toBe(3)
    // 凹槽轨道 × 浮起卡舌：轨道圆角胶囊 + 选中成员浮起投影
    const track = chips[0]!.closest('div')
    expect(track?.className).toContain('rounded-full')
    expect(track?.className).toContain('overflow-x-auto')
    const activePill = chips.find(b => b.className.includes('bg-card'))
    expect(activePill?.className).toContain('shadow-')
    expect(activePill?.className).toContain('ring-1')

    await renderSolo('?tab=score')
    const soloChips = [...document.querySelectorAll('button[title]')].filter(b =>
      b.getAttribute('title') === SID,
    )
    expect(soloChips.length).toBe(0)
    // solo 仍自动定向唯一成员取数
    expect(fetchedUrls).toContain(
      `/api/observe/run/${encodeURIComponent(SOLO_RUN_ID)}/scorecard?taskId=${SID}&framework=opencode&member=${SID}`,
    )
  })
})
