// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// run-first 统一 Overview IT（bundle 形态）：run 是基本单元——bundle run 与
// solo run 走同一 RunOverviewTab（五端点零 member 取数），bundle 常态 =
// N 成员。锁六件事：①Σ指标大瓦片（memberStats + executions Σ + totalErrors，
// 总览头元信息网格成员项可见）；②泳道 V2 run 级——root 按成员分道（成员 = 泳道，
// data-lane = 成员 taskId）+ 子代理车道/最大并发；③run 框架专属区块
// （结构卡/导入信息）附加渲染，成员表不摆（成员维度由泳道分道承载）；
// ④跨成员 Error Turns 带 member 归因徽标，深链点击 → Turns tab；
// ⑤面板预取与 run 详情并行（页面挂载瞬间五端点齐发，两级瀑布消除——
//   详情悬而未决时面板 URL 已发出，含 lanes 并行）；
// ⑥面板在途骨架屏：服务端聚合瓦片即刻可见、不渲染空态误导（无空泳道
//   标题/No skills loaded），数据到位骨架换真身。

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createElement, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import RunDetailPage from '@/app/run/[runId]/page';
import { resetRunOverviewPrefetchCache } from '@/lib/run/overview-data';
import { parseAndIndex } from '@/lib/run/reader';
import { buildViewModel } from '@/lib/run/view-model';
import { attachSessionRefs } from '@/lib/run/session-link';
import type { SessionRef } from '@/lib/run/model';

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const searchState = vi.hoisted(() => ({ current: '' }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, refresh: () => {} }),
  usePathname: () => '/run/minidemo01',
  useSearchParams: () => new URLSearchParams(searchState.current),
}))

const RUN_ID = 'minidemo01'
const SID_A = 'rfmv-ses-mini-a'
const SID_B = 'rfmv-ses-mini-b'
const SID_C = 'rfmv-ses-mini-c'
const SUB_SID = 'sub_bundler_1'
const T0 = Date.parse('2026-10-13T02:00:12.000Z')

const rewrite = (v: unknown): unknown => {
  if (typeof v === 'string') return v.replace(/^ses_mini_/, 'rfmv-ses-mini-');
  if (Array.isArray(v)) return v.map(rewrite);
  if (v != null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, rewrite(val)]));
  }
  return v;
}
const multiIndex = parseAndIndex(
  rewrite(JSON.parse(fs.readFileSync(path.resolve(__dirname, './data/run/mini-bundle/workflow.json'), 'utf-8'))) as Parameters<typeof parseAndIndex>[0],
)
const viewModel = buildViewModel(multiIndex)
const mkRef = (taskId: string, label: string): SessionRef => ({
  taskId, framework: 'opencode', rowId: `row-${taskId}`, turns: 2,
  totalTokens: 2300, durationMs: 60000, label, startTime: '2026-10-13T02:00:12.000Z',
  endTime: '2026-10-13T02:01:12.000Z', cacheReadTokens: 0, contextPeakPct: 72.5,
  model: 'volc-gateway/glm-4.7', totalCost: 0.2, version: null, totalLatencyMs: 60000,
})
attachSessionRefs(viewModel, new Map([
  [SID_A, mkRef(SID_A, '成员 A 会话')],
  [SID_B, mkRef(SID_B, '成员 B 会话')],
  [SID_C, mkRef(SID_C, '成员 C 会话')],
]))

const responseBody = {
  run: {
    runId: RUN_ID,
    kind: 'run' as const,
    name: 'rfmv 多成员',
    status: viewModel.status,
    exportDataComplete: true,
    startedAt: '2026-10-13T02:00:00Z',
    finishedAt: '2026-10-13T02:10:00Z',
    import: {
      importedAt: '2026-10-13T02:11:00Z',
      sourceDir: '/bundle/mini',
      sessions: { total: 3, imported: 3, existing: 0, missingFile: 0, failed: 0 },
      warnings: [],
    },
  },
  viewModel,
  memberStats: {
    joinedCount: 3, totalTokens: 6900, totalCost: 0.6, totalTurns: 5,
    totalActiveMs: 1_110_000, totalDurationMs: 7_440_000, memberRowIds: ['row-a', 'row-b', 'row-c'],
    models: [{ model: 'glm-4.7', count: 3 }],
    earliestStart: '2026-10-13T02:00:12.000Z', latestEnd: '2026-10-13T02:01:12.000Z',
  },
  totalErrors: 2,
  members: [
    { taskId: SID_A, framework: 'opencode', version: null, label: '成员 A 会话' },
    { taskId: SID_B, framework: 'opencode', version: null, label: '成员 B 会话' },
    { taskId: SID_C, framework: 'opencode', version: null, label: '成员 C 会话' },
  ],
  codeStats: { additions: 30, deletions: 6, files: 5 },
}

// executions：run 级 agent 全景（3 成员 root + 成员 A 的 1 个子代理）
const executionsBody = {
  items: [
    {
      executionId: 'exec_a_root', sessionId: 'row-a', agentName: 'main', agentSessionId: SID_A, isSubagent: false,
      parentExecutionId: null, tokens: 1800, maxSingleCallTokens: 900, cost: 0.15,
      toolCallCount: 1, skillLoadCount: 0, llmCallCount: 2, model: 'glm-4.7',
      createdAt: '2026-10-13T02:00:12.000Z', latencyMs: 45000,
      span: { start: T0, end: T0 + 60000 }, activeIntervals: [{ start: T0, end: T0 + 45000 }],
      firstPrompt: '初始化构建', member: { taskId: SID_A, label: '成员 A 会话', isProxy: false },
    },
    {
      executionId: 'exec_b_root', sessionId: 'row-b', agentName: 'main', agentSessionId: SID_B, isSubagent: false,
      parentExecutionId: null, tokens: 1600, maxSingleCallTokens: 800, cost: 0.12,
      toolCallCount: 0, skillLoadCount: 0, llmCallCount: 1, model: 'glm-4.7',
      createdAt: '2026-10-13T02:00:42.000Z', latencyMs: 30000,
      span: { start: T0 + 30000, end: T0 + 90000 }, activeIntervals: [{ start: T0 + 30000, end: T0 + 60000 }],
      firstPrompt: '构建产物', member: { taskId: SID_B, label: '成员 B 会话', isProxy: false },
    },
    {
      executionId: 'exec_c_root', sessionId: 'row-c', agentName: 'main', agentSessionId: SID_C, isSubagent: false,
      parentExecutionId: null, tokens: 2000, maxSingleCallTokens: 1000, cost: 0.18,
      toolCallCount: 0, skillLoadCount: 0, llmCallCount: 1, model: 'glm-4.7',
      createdAt: '2026-10-13T02:01:12.000Z', latencyMs: 20000,
      span: { start: T0 + 60000, end: T0 + 120000 }, activeIntervals: [{ start: T0 + 60000, end: T0 + 80000 }],
      firstPrompt: '发布', member: { taskId: SID_C, label: '成员 C 会话', isProxy: false },
    },
    {
      executionId: 'exec_a_sub', sessionId: 'row-a', agentName: 'reviewer', agentSessionId: SUB_SID, isSubagent: true,
      parentExecutionId: 'exec_a_root', tokens: 500, maxSingleCallTokens: 500, cost: 0.05,
      toolCallCount: 1, skillLoadCount: 0, llmCallCount: 1, model: 'glm-4.7',
      createdAt: '2026-10-13T02:00:30.000Z', latencyMs: 15000,
      span: { start: T0 + 18000, end: T0 + 33000 }, activeIntervals: [{ start: T0 + 18000, end: T0 + 33000 }],
      firstPrompt: 'review the build', member: { taskId: SID_A, label: '成员 A 会话', isProxy: false },
    },
  ],
  subagentCount: 1,
}

// turns：跨成员轮次（成员 A 错误轮 + 子代理截断轮；成员 B 正常轮）
const runTurns = [
  {
    turnId: 'turn_a_1', turnIndex: 1, role: 'assistant', contentSummary: '跑命令失败',
    agentName: 'main', isSubagent: false, subagentName: null, subagentSessionId: null,
    totalTokens: 1200, inputTokens: 500, outputTokens: 700, contextWindowPct: 30,
    latencyMs: 8000, createdAt: '2026-10-13T02:00:20.000Z', completedAt: '2026-10-13T02:00:28.000Z',
    model: 'glm-4.7', finishReason: null, subagentType: null, dispatchStep: null,
    toolCalls: [{ toolCallId: 'tc_a_1', toolName: 'Bash', state: 'error', durationMs: 300, resultJson: 'Exit code 1' }],
    skillEvents: [], member: { taskId: SID_A, label: '成员 A 会话' },
  },
  {
    turnId: 'turn_a_2', turnIndex: 2, role: 'assistant', contentSummary: '复查修改',
    agentName: 'reviewer', isSubagent: true, subagentName: 'reviewer', subagentSessionId: SUB_SID,
    totalTokens: 200, inputTokens: 50, outputTokens: 150, contextWindowPct: 10,
    latencyMs: 5000, createdAt: '2026-10-13T02:00:30.000Z', completedAt: '2026-10-13T02:00:35.000Z',
    model: 'glm-4.7', finishReason: 'length', subagentType: 'reviewer', dispatchStep: 'review the build',
    toolCalls: [], skillEvents: [], member: { taskId: SID_A, label: '成员 A 会话' },
  },
  {
    turnId: 'turn_b_1', turnIndex: 1, role: 'assistant', contentSummary: '构建完成',
    agentName: 'main', isSubagent: false, subagentName: null, subagentSessionId: null,
    totalTokens: 900, inputTokens: 400, outputTokens: 500, contextWindowPct: 20,
    latencyMs: 6000, createdAt: '2026-10-13T02:00:50.000Z', completedAt: '2026-10-13T02:00:56.000Z',
    model: 'glm-4.7', finishReason: null, subagentType: null, dispatchStep: null,
    toolCalls: [], skillEvents: [], member: { taskId: SID_B, label: '成员 B 会话' },
  },
]

const bridgeItems = [
  {
    bridgeId: 'bridge_1', dispatchExecutionId: 'exec_a_root', dispatchTurnId: 'turn_a_1',
    dispatchToolCallId: 'tc_dispatch', dispatchContent: '④ 模板计算流：base', dispatchTimestamp: '2026-10-13T02:00:29.000Z',
    responseExecutionId: 'exec_a_sub', responseTurnId: 'turn_a_2', responseContent: '构建没问题',
    responseTimestamp: '2026-10-13T02:00:35.000Z', subagentSessionId: SUB_SID, subagentType: 'reviewer',
    subagentName: 'reviewer', agentName: 'main', status: 'done', subagentTokens: 200, subagentLatencyMs: 5000,
  },
]

const skillsBody = {
  skills: [{ skillName: 'demo-skill', version: 1, invocationCount: 3 }],
  events: [],
  total: 1,
}

const json = (data: unknown) => ({ ok: true, json: async () => data, text: async () => '' })

vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
  const url = typeof input === 'string' ? input : input.toString()
  if (url.includes('/executions')) return json(executionsBody)
  if (url.includes('/turns?')) return json({ items: runTurns, total: runTurns.length })
  if (url.includes('/bridges')) return json({ items: bridgeItems })
  if (url.includes('/skills')) return json(skillsBody)
  if (url.includes('/lanes')) return json({ paradigm: 'op-fusion', lanes: ['base', 'group'], source: 'paradigm' })
  return json(responseBody)
}))

let root: Root | null = null

async function renderPage(initialSearch = '') {
  resetRunOverviewPrefetchCache()
  searchState.current = initialSearch
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      createElement(
        Suspense,
        { fallback: null },
        createElement(RunDetailPage, { params: Promise.resolve({ runId: RUN_ID }) }),
      ),
    )
  })
  await act(async () => {
    await new Promise(r => setTimeout(r, 0))
  })
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

describe('Run 详情页统一 Overview（bundle 形态，run-first）', () => {
  it('Overview = run 级统一总览：Σ指标 + Skills/ToolCalls + 框架专属区块（时间线归 Perf）', async () => {
    await renderPage()
    const overview = document.querySelector('[data-run-tab="overview"]')
    expect(overview).toBeTruthy()
    const ovText = overview!.textContent ?? ''
    // 元信息键值网格：成员项（多成员可见）+ 模型（展示口径）+ 导入源目录
    expect(ovText).toContain('成员')
    expect(ovText).toContain('glm-4.7')
    expect(ovText).toContain('/bundle/mini')
    // Σ指标大瓦片：Tokens/Cost/Wall 拆分/LLM/Subagents/Errors/Turns（总览头主角）
    expect(ovText).toContain('6.9k')
    expect(ovText).toContain('$0.60')
    expect(ovText).toContain('Wall Clock')
    expect(ovText).toContain('活跃')
    expect(ovText).toContain('LLM Calls')
    expect(ovText).toContain('Subagents')
    expect(ovText).toContain('⚠ Errors')
    // 时间维度（Agent 泳道）不在此面——迁至 Perf 页执行时间线（Overview 摘除锁）
    expect(ovText).not.toContain('Agent Swimlane (')
    expect(overview!.querySelector('[data-lane]')).toBeNull()
    // run 框架专属区块：结构卡（代际）+ 导入信息（成员表不摆——Members 瓦片承载）
    expect(ovText).toContain('执行结构')
    expect(ovText).not.toContain('成员会话')
    expect(ovText).toContain('导入信息')
    // Skills / Tool Calls 卡（卡内计数 = 跨成员轮次拍平）；Skills 瓦片 = 去重
    // 技能数，与 Skills 列表头同口径（fixture 无 load 事件——真实 CANNBot
    // workflow 技能全走 use/invoke，旧口径会误显 0）
    const skillsTile = overview!.querySelector('[data-metric="Skills"]')
    expect(skillsTile).toBeTruthy()
    expect(skillsTile!.textContent).toBe('Skills1')
    expect(ovText).toContain('Skills (1)')
    expect(ovText).toContain('demo-skill')
    expect(ovText).toContain('Tool Calls (1)')
    expect(ovText).toContain('1 err')
  })

  it('跨成员 Error Turns：member 归因徽标 + 深链点击 → Turns tab', async () => {
    await renderPage()
    const overview = document.querySelector('[data-run-tab="overview"]')
    expect(overview).toBeTruthy()
    const ovText = overview!.textContent ?? ''
    expect(ovText).toContain('Error Turns (2)')
    expect(ovText).toContain('max_tokens 截断')
    // 多成员时错误轮带成员归因徽标（run 深链定位成员的锚点）
    expect(ovText).toContain('成员 A 会话')
    const errorTurnBtn = [...overview!.querySelectorAll('button')].find(b => b.textContent?.includes('#1'))
    expect(errorTurnBtn).toBeTruthy()
    await act(async () => {
      errorTurnBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    const turns = document.querySelector('[data-run-tab="turns"]')
    expect(turns).toBeTruthy()
    expect(turns!.classList.contains('hidden')).toBe(false)
    const overviewAfter = document.querySelector('[data-run-tab="overview"]')!
    expect(overviewAfter.classList.contains('hidden')).toBe(true)
  })

  it('Overview 错误卡经服务端 errorDigest 渲染：turns 请求不再携带原文', async () => {    // 性能层契约：Overview 的 turns 取数带 includeErrorDigest、不带
    // includeToolDetail（18MB 级原文出响应）；错误卡计数/明细/消息全部消费
    // digest——resultJson 缺席时渲染不降级
    const requestedUrls: string[] = []
    const digestTurns = [{
      turnId: 'turn_a_dig', turnIndex: 1, role: 'assistant', contentSummary: 'digest 失败轮',
      agentName: 'main', isSubagent: false, subagentName: null, subagentSessionId: null,
      totalTokens: 100, inputTokens: 40, outputTokens: 60, contextWindowPct: 5,
      latencyMs: 1000, createdAt: '2026-10-13T02:00:20.000Z', completedAt: null,
      model: 'glm-4.7', finishReason: null, subagentType: null, dispatchStep: null,
      toolCalls: [{ toolCallId: 'tc_dig', toolName: 'Bash', state: 'error', durationMs: 200 }],
      skillEvents: [], member: { taskId: SID_A, label: '成员 A 会话' },
      errorDigest: {
        total: 2, cancelled: 0, failed: 1, skillFail: 1, truncated: 0,
        details: [{ toolName: 'Bash', type: 'failed' }, { toolName: 'demo-skill', type: 'skill_fail' }],
        messages: [{ toolName: 'Bash', message: 'exit 2' }],
        skillMessages: [{ skillName: 'demo-skill', message: '技能炸了' }],
      },
    }]
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      requestedUrls.push(url)
      if (url.includes('/executions')) return json(executionsBody)
      if (url.includes('/turns?')) return json({ items: digestTurns, total: digestTurns.length })
      if (url.includes('/bridges')) return json({ items: bridgeItems })
      if (url.includes('/skills')) return json(skillsBody)
      if (url.includes('/lanes')) return json({ paradigm: null, lanes: [], source: null })
      return json(responseBody)
    }))
    await renderPage()
    const turnsUrl = requestedUrls.find(u => u.includes('/turns?'))
    expect(turnsUrl).toBeTruthy()
    expect(turnsUrl).toContain('includeErrorDigest=true')
    expect(turnsUrl).not.toContain('includeToolDetail')
    const overview = document.querySelector('[data-run-tab="overview"]')
    expect(overview).toBeTruthy()
    const ovText = overview!.textContent ?? ''
    expect(ovText).toContain('Error Turns (1)')
    expect(ovText).toContain('1 failed')
    expect(ovText).toContain('1 skill_fail')
    expect(ovText).toContain('Bash: exit 2')
    expect(ovText).toContain('⚡ demo-skill: 技能炸了')
  })

  it('面板预取与 run 详情并行：详情悬而未决时三端点已全部发出（两级瀑布消除）', async () => {
    const requested: string[] = []
    let releaseDetail!: (v: unknown) => void
    const detailDeferred = new Promise<unknown>(r => { releaseDetail = r })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      requested.push(url)
      if (url.endsWith(`/run/${RUN_ID}`)) {
        await detailDeferred
        return json(responseBody)
      }
      if (url.includes('/executions')) return json(executionsBody)
      if (url.includes('/turns?')) return json({ items: runTurns, total: runTurns.length })
      if (url.includes('/bridges')) return json({ items: bridgeItems })
      if (url.includes('/skills')) return json(skillsBody)
      return json({ paradigm: 'op-fusion', lanes: ['base', 'group'], source: 'paradigm' })
    }))
    await renderPage()
    // 详情 fetch 被挂起（tab 尚未挂载），但页面挂载瞬间预取已把三个面板
    // 端点全部发出——面板取数不再串在详情往返之后；bridges / lanes 归
    // Perf 页时间线自取，Overview 不再预取（不发出即负向锁）
    for (const seg of ['/executions', '/turns?', '/skills']) {
      expect(requested.some(u => u.includes(seg)), `面板端点 ${seg} 应已发出`).toBe(true)
    }
    expect(requested.some(u => u.includes('/bridges'))).toBe(false)
    expect(requested.some(u => u.includes('/lanes'))).toBe(false)
    releaseDetail(null)
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })
  })

  it('面板在途 = 骨架屏：服务端聚合瓦片即刻可见、空态不误导、数据到位换真身', async () => {
    let releasePanels!: () => void
    const panelsDeferred = new Promise<void>(r => { releasePanels = r })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/executions')) {
        await panelsDeferred
        return json(executionsBody)
      }
      if (url.includes('/turns?')) return json({ items: runTurns, total: runTurns.length })
      if (url.includes('/bridges')) return json({ items: bridgeItems })
      if (url.includes('/skills')) return json(skillsBody)
      if (url.includes('/lanes')) return json({ paradigm: 'op-fusion', lanes: ['base', 'group'], source: 'paradigm' })
      return json(responseBody)
    }))
    await renderPage()
    const overview = document.querySelector('[data-run-tab="overview"]')
    expect(overview).toBeTruthy()
    const pendingText = overview!.textContent ?? ''
    // 服务端聚合（memberStats）即刻渲染：总览头与瓦片不等人
    expect(pendingText).toContain('Wall Clock')
    expect(pendingText).toContain('Tokens')
    // 面板在途：不渲染空技能空态（旧实现的误导性空内容）
    expect(pendingText).not.toContain('No skills loaded')
    // 骨架 shimmer 在场
    expect(overview!.querySelector('.animate-pulse')).toBeTruthy()
    // 数据到位 → 骨架换真身（泳道不再落位——迁至 Perf 页执行时间线）
    releasePanels()
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })
    const readyText = overview!.textContent ?? ''
    expect(readyText).not.toContain('Agent Swimlane (')
    expect(readyText).toContain('demo-skill')
  })
})
