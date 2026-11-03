// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// run-first 页面 IT：solo run（无主 session 合成）在统一工作台渲染——
// 真实合成链（soloRunIndex → buildViewModel → attachSessionRefs）+ mock fetch。
// 锁四件事：①页头「会话」标签（kind=solo 判别，bundle 显示「工作流」）；
// ②Overview = run 级统一总览（run 是基本单元——executions/turns/bridges/
// skills/lanes 五端点零 member 取数，solo = 单成员退化；元信息/指标卡/
// Agent 泳道图 V2：真实最大并发 + 范式声明车道/Skills/Tool Calls/Error
// Turns——组合面板与离线导出 viewer 同源），且不渲染 run 框架专属区块
// （结构卡）；③Graph tab 退化单节点图真实渲染；④Error Turns 深链
// 点击 → Turns tab。

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createElement } from 'react';
import { Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import RunDetailPage from '@/app/run/[runId]/page';
import { soloRunIndex } from '@/lib/run/solo';
import { buildViewModel } from '@/lib/run/view-model';
import { attachSessionRefs } from '@/lib/run/session-link';
import type { SessionRef } from '@/lib/run/model';
import { soloRunIdOf } from '@/lib/run/identity';

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const nav = vi.hoisted(() => ({ back: vi.fn(), replace: vi.fn() }))
const searchState = vi.hoisted(() => ({ current: '' }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: nav.replace, back: nav.back, refresh: () => {} }),
  usePathname: () => '/run/solo:ses_solo_x',
  useSearchParams: () => new URLSearchParams(searchState.current),
}))

const SID = 'ses_solo_x'
const SUB_SID = 'sub_ses_1'
const T0 = Date.parse('2026-10-13T02:00:12.000Z')
const ref: SessionRef = {
  taskId: SID, framework: 'opencode', rowId: 'row_solo', turns: 3,
  totalTokens: 2300, durationMs: 60000, label: '修一下登录页样式',
  startTime: '2026-10-13T02:00:12.000Z', endTime: '2026-10-13T02:01:12.000Z',
  cacheReadTokens: 0, contextPeakPct: 72.5, model: 'volc-gateway/glm-4.7',
  totalCost: 0.2, version: null, totalLatencyMs: 60000, sourcePath: '/tmp/fake-opencode.db',
}
const viewModel = buildViewModel(soloRunIndex(ref))
attachSessionRefs(viewModel, new Map([[SID, ref]]))

const responseBody = {
  run: {
    runId: soloRunIdOf(SID),
    kind: 'solo' as const,
    name: ref.label,
    status: viewModel.status,
    exportDataComplete: true,
    startedAt: ref.startTime,
    finishedAt: ref.endTime,
    import: null,
  },
  viewModel,
  memberStats: {
    joinedCount: 1, totalTokens: 2300, totalCost: 0.2, totalTurns: 3,
    totalActiveMs: 1_110_000, totalDurationMs: 7_440_000, memberRowIds: ['row_solo'],
    models: [{ model: 'glm-4.7', count: 1 }],
    earliestStart: ref.startTime, latestEnd: ref.endTime,
  },
  totalErrors: 1,
  // 成员身份名册 + Σ代码统计（统一 Overview 元信息卡数据源）
  members: [{ taskId: SID, framework: 'opencode', version: null, label: ref.label }],
  codeStats: { additions: 12, deletions: 3, files: 2 },
}

// executions：run 级 agent 全景（AgentItem + member 归因 + llmCallCount）
const executionsBody = {
  items: [
    {
      executionId: 'exec_root', sessionId: 'row_solo', agentName: 'main', agentSessionId: SID, isSubagent: false,
      parentExecutionId: null, tokens: 1800, maxSingleCallTokens: 900, cost: 0.15,
      toolCallCount: 1, skillLoadCount: 0, llmCallCount: 2, model: 'glm-4.7',
      createdAt: ref.startTime, latencyMs: 45000,
      span: { start: T0, end: T0 + 60000 }, activeIntervals: [{ start: T0, end: T0 + 45000 }],
      firstPrompt: '修一下登录页样式',
      member: { taskId: SID, label: null, isProxy: false },
    },
    {
      executionId: 'exec_sub', sessionId: 'row_solo', agentName: 'reviewer', agentSessionId: SUB_SID, isSubagent: true,
      parentExecutionId: 'exec_root', tokens: 500, maxSingleCallTokens: 500, cost: 0.05,
      toolCallCount: 1, skillLoadCount: 0, llmCallCount: 1, model: 'glm-4.7',
      createdAt: '2026-10-13T02:00:30.000Z', latencyMs: 15000,
      span: { start: T0 + 18000, end: T0 + 33000 }, activeIntervals: [{ start: T0 + 18000, end: T0 + 33000 }],
      firstPrompt: 'review the fix',
      member: { taskId: SID, label: null, isProxy: false },
    },
  ],
  subagentCount: 1,
}

// skills：run 级技能聚合（SessionSkill 合并口径）
const skillsBody = {
  skills: [{ skillName: 'demo-skill', version: 1, invocationCount: 2 }],
  events: [],
  total: 1,
}

// member-turns：全量轮次（含 error 工具调用 / 截断 finishReason / 子代理轮）
const memberTurns = [
  {
    turnId: 'turn_1', turnIndex: 1, role: 'user', contentSummary: '修一下登录页样式',
    agentName: 'main', isSubagent: false, subagentName: null, subagentSessionId: null,
    parentExecutionId: 'exec_root', totalTokens: 100, inputTokens: 100, outputTokens: 0,
    reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    inputMessagesCount: 1, inputMessagesTokens: 100, contextWindowPct: 5,
    latencyMs: 0, createdAt: ref.startTime, completedAt: ref.startTime, model: 'glm-4.7',
    finishReason: null, toolCalls: [], skillEvents: [],
  },
  {
    turnId: 'turn_2', turnIndex: 2, role: 'assistant', contentSummary: '读文件后跑命令修样式',
    agentName: 'main', isSubagent: false, subagentName: null, subagentSessionId: null,
    parentExecutionId: 'exec_root', totalTokens: 1200, inputTokens: 500, outputTokens: 700,
    reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    inputMessagesCount: 3, inputMessagesTokens: 500, contextWindowPct: 30,
    latencyMs: 8000, createdAt: '2026-10-13T02:00:20.000Z', completedAt: '2026-10-13T02:00:28.000Z',
    model: 'glm-4.7', finishReason: null,
    toolCalls: [
      { toolCallId: 'tc_1', toolName: 'Read', state: 'ok', durationMs: 120, argsJson: null, resultJson: null },
      { toolCallId: 'tc_2', toolName: 'Bash', state: 'error', durationMs: 300, argsJson: null, resultJson: 'Exit code 1' },
    ],
    skillEvents: [{ skillName: 'demo-skill', eventType: 'load', success: true, errorMessage: null }],
  },
  {
    turnId: 'turn_3', turnIndex: 3, role: 'assistant', contentSummary: '复查修改',
    agentName: 'reviewer', isSubagent: true, subagentName: 'reviewer', subagentSessionId: SUB_SID,
    parentExecutionId: 'exec_sub', totalTokens: 200, inputTokens: 50, outputTokens: 150,
    reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    inputMessagesCount: 1, inputMessagesTokens: 50, contextWindowPct: 10,
    latencyMs: 5000, createdAt: '2026-10-13T02:00:30.000Z', completedAt: '2026-10-13T02:00:35.000Z',
    model: 'glm-4.7', finishReason: 'length', toolCalls: [], skillEvents: [],
  },
]

const bridgeItems = [
  {
    bridgeId: 'bridge_1', dispatchExecutionId: 'exec_root', dispatchTurnId: 'turn_2',
    dispatchToolCallId: 'tc_dispatch', dispatchContent: '④ 模板计算流：base', dispatchTimestamp: '2026-10-13T02:00:29.000Z',
    responseExecutionId: 'exec_sub', responseTurnId: 'turn_3', responseContent: '修改没问题',
    responseTimestamp: '2026-10-13T02:00:35.000Z', subagentSessionId: SUB_SID, subagentType: 'reviewer',
    subagentName: 'reviewer', agentName: 'main', status: 'done', subagentTokens: 200, subagentLatencyMs: 5000,
  },
]

const json = (data: unknown) => ({ ok: true, json: async () => data, text: async () => '' })

vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
  const url = typeof input === 'string' ? input : input.toString()
  if (url.includes('/executions')) return json(executionsBody)
  if (url.includes('/turns?')) return json({ items: memberTurns, total: memberTurns.length })
  if (url.includes('/api/observe/turn/')) {
    return json({
      turnId: 'turn_2', taskId: SID, turnIndex: 2, role: 'assistant',
      content: '读文件后跑命令修样式', contentJson: null, contentSummary: '读文件后跑命令修样式',
      inputMessagesJson: null, inputMessagesCount: 3, inputMessagesTokens: 500, contextWindowPct: 30,
      agentName: 'main', subagentName: null, isSubagent: false,
      totalTokens: 1200, inputTokens: 500, outputTokens: 700, reasoningTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, latencyMs: 8000, ttftMs: null,
      createdAt: '2026-10-13T02:00:20.000Z', completedAt: '2026-10-13T02:00:28.000Z',
      model: 'glm-4.7', modelId: null, providerId: null, finishReason: null,
      toolCalls: [], skillEvents: [],
    })
  }
  if (url.includes('/bridges')) return json({ items: bridgeItems })
  if (url.includes('/skills')) return json(skillsBody)
  if (url.includes('/lanes')) return json({ paradigm: 'op-fusion', lanes: ['base', 'group'], source: 'paradigm' })
  return json(responseBody)
}))

let root: Root | null = null

async function renderPage(initialSearch = '') {
  searchState.current = initialSearch
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      createElement(
        Suspense,
        { fallback: null },
        createElement(RunDetailPage, { params: Promise.resolve({ runId: soloRunIdOf(SID) }) }),
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

describe('Run 详情页 solo run 渲染（run-first 刀H）', () => {
  it('Overview 首卡身份：会话标签 + runId 常驻（标题位一处呈现）', async () => {
    await renderPage()
    const header = document.body.textContent ?? ''
    expect(header).toContain('会话')
    expect(header).not.toContain('工作流')
    // run 身份归入 Overview：runId 在标题位 mono 常驻 + 悬停可达；展示位省去
    // solo: 前缀（类型药丸已表达）——完整 runId 只在悬停与复制里
    expect(header).toContain(SID)
    expect(header).not.toContain(soloRunIdOf(SID))
    const title = document.querySelector('h1') as HTMLElement | null
    expect(title).toBeTruthy()
    expect(title!.getAttribute('title')).toContain(soloRunIdOf(SID))
    expect(header).toContain(ref.label!)
  })

  it('Overview 首卡标题截短：prompt 长名按句读截短，全文与 runId 进悬停', async () => {
    const longName = '加载当前目录下的 SKILL.md , 完成 dua_quantize_add_layer_norm 算子的设计文档，请自动执行全流程，不需要我确认。算子公式及约束，必须按规范来'
    const prev = responseBody.run.name
    responseBody.run.name = longName
    try {
      await renderPage()
      const h1 = document.querySelector('h1') as HTMLElement | null
      expect(h1).toBeTruthy()
      // 首句超 32 字 → 取首个逗号分句：标题不展示整段 prompt
      expect(h1!.textContent).toBe('加载当前目录下的 SKILL.md')
      // 全文与 runId 在悬停提示里可达（截短不丢信息）
      expect(h1!.getAttribute('title')).toContain(longName)
      expect(h1!.getAttribute('title')).toContain(soloRunIdOf(SID))
    } finally {
      responseBody.run.name = prev
    }
  })

  it('Overview = run 级统一总览（五端点零 member 取数 + 共享组合面板，solo = 单成员退化）', async () => {
    await renderPage()
    const overview = document.querySelector('[data-run-tab="overview"]')
    expect(overview).toBeTruthy()
    const ovText = overview!.textContent ?? ''
    // solo 无 run 框架专属区块（结构卡/导入信息；成员表任何形态都不摆）
    expect(ovText).not.toContain('成员会话汇总')
    expect(ovText).not.toContain('执行结构')
    expect(ovText).not.toContain('成员会话')
    // 总览头：框架/模型/代码/来源（键值网格）
    expect(ovText).toContain('OpenCode')
    expect(ovText).toContain('volc-gateway/glm-4.7')
    expect(ovText).toContain('+12')
    expect(ovText).toContain('/tmp/fake-opencode.db')
    // Σ指标大瓦片：Tokens/Cost/Wall Clock 拆分/LLM/Subagents/Errors
    expect(ovText).toContain('2.3k')
    expect(ovText).toContain('$0.20')
    expect(ovText).toContain('Wall Clock')
    expect(ovText).toContain('活跃')
    expect(ovText).toContain('LLM Calls')
    expect(ovText).toContain('Subagents')
    expect(ovText).toContain('⚠ Errors')
    // 时间维度（Agent 泳道）不在此面——迁至 Perf 页执行时间线（Overview 摘除锁）
    expect(ovText).not.toContain('Agent Swimlane (')
    // Skills 瓦片 = 去重技能数，与 Skills 列表头同口径（fixture 无 load 事件，
    // 旧口径 Σ skillLoadCount 会误显 0）
    const skillsTile = document.querySelector('[data-run-tab="overview"] [data-metric="Skills"]')
    expect(skillsTile).toBeTruthy()
    expect(skillsTile!.textContent).toBe('Skills1')
    expect(ovText).toContain('Skills (1)')
    // Skills 卡：技能 chip（计数 + token）
    expect(ovText).toContain('demo-skill')
    expect(ovText).toContain('2x')
    // Tool Calls 卡：分组 chip + 错误计数
    expect(ovText).toContain('Tool Calls (2)')
    expect(ovText).toContain('Read')
    expect(ovText).toContain('Bash')
    expect(ovText).toContain('1 err')
    // Error Turns 卡：error 工具调用 + max_tokens 截断两轮
    expect(ovText).toContain('Error Turns (2)')
    expect(ovText).toContain('max_tokens 截断')
  })

  it('Error Turns 深链：点击错误轮 → Turns tab 激活', async () => {
    await renderPage()
    const overview = document.querySelector('[data-run-tab="overview"]')
    expect(overview).toBeTruthy()
    const errorTurnBtn = [...overview!.querySelectorAll('button')].find(b => b.textContent?.includes('#2'))
    expect(errorTurnBtn).toBeTruthy()
    await act(async () => {
      errorTurnBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    const turns = document.querySelector('[data-run-tab="turns"]')
    expect(turns).toBeTruthy()
    expect(turns!.classList.contains('hidden')).toBe(false)
    const overviewAfter = document.querySelector('[data-run-tab="overview"]')!
    expect(overviewAfter.classList.contains('hidden')).toBe(true)

    // solo 退化 = 单节点形态：唯一节点自动展开（无需手动点开），成员轮次直接可读
    const turnsText = turns!.textContent ?? ''
    expect(turnsText).toContain('第 1 次运行')
    expect(turnsText).toContain('修一下登录页样式')
    // 深链选中错误轮 → 节点归属经详情 taskId 解析，播放器接管右侧
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })
    expect(turns!.textContent).not.toContain('选择一轮开始走查')
    expect(turns!.textContent).toContain('读文件后跑命令修样式')
  })

  it('Graph tab：退化单节点图真实渲染（结构工作台零改动消费）', async () => {
    await renderPage('?tab=graph')
    const graph = document.querySelector('[data-run-tab="graph"]')
    expect(graph).toBeTruthy()
    expect(graph!.classList.contains('hidden')).toBe(false)
    // 画布挂载 + 单节点（短名 = sessionId）+ 第 1 次运行带（无回滚）
    expect(document.querySelector('.run-canvas')).toBeTruthy()
    const nodes = document.querySelectorAll('.run-node')
    expect(nodes).toHaveLength(1)
    expect(nodes[0].textContent).toContain(SID)
    const graphText = graph!.textContent ?? ''
    expect(graphText).toContain('第 1 次运行')
  })

  it('tab 反复切换恒一可见容器、DOM 不复制（兄弟重复 key 修复回归锁）', async () => {
    await renderPage()
    const clickTab = async (label: string) => {
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent?.includes(label))
      expect(btn, `tab 按钮 ${label}`).toBeTruthy()
      await act(async () => {
        btn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      })
    }
    // 多轮 skills ↔ perf 交替（历史 bug：懒挂载容器 div 带 key={refreshEpoch}，
    // 多 tab 访问后同级出现重复 key 兄弟 → React 协调复制子树，卡片越叠越多）
    for (let i = 0; i < 3; i++) {
      await clickTab('Skills')
      await clickTab('Perf')
    }
    // 可见容器 = 当前 tab 恰一个；已访问 tab 在 DOM 中各至多一份
    const visible = [...document.querySelectorAll('[data-run-tab]')].filter(d => !d.classList.contains('hidden'))
    expect(visible.map(d => d.getAttribute('data-run-tab'))).toEqual(['perf'])
    expect(document.querySelectorAll('[data-run-tab="perf"]').length).toBe(1)
    expect(document.querySelectorAll('[data-run-tab="skills"]').length).toBe(1)
    expect(document.querySelectorAll('[data-run-tab="overview"]').length).toBe(1)
    // 回切 Overview 仍正常（hidden 切换不丢挂载）
    await clickTab('Overview')
    const visibleBack = [...document.querySelectorAll('[data-run-tab]')].filter(d => !d.classList.contains('hidden'))
    expect(visibleBack.map(d => d.getAttribute('data-run-tab'))).toEqual(['overview'])
    const skillsKept = document.querySelector('[data-run-tab="skills"]')
    expect(skillsKept).toBeTruthy()
    expect(skillsKept!.classList.contains('hidden')).toBe(true)
  })
})
