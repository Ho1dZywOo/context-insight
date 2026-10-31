// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// run-first 刀I2 IT（design: docs/design/run-first-architecture/design.md §3.4）：
// 会话独有能力组件的 urlFor 端点覆盖——挂入 run 工作台时 session 语义组件
// （WireRounds / TrajectoryScoring / SkillDetail 族）经 runMemberUrlFor 把
// /api/observe/session/* 取数切到 /api/observe/run/<runId>/*?member=<taskId>
// （刀I1 转发端点）；缺省 urlFor 时 session 端点逐字节不变。
// 另锁 RunMemberPicker：多成员 chips + allLabel 全部态 + 成员必选态行为。

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { WireRounds } from '@/components/observe/WireRounds';
import { TrajectoryScoring } from '@/components/scoring/TrajectoryScoring';
import { SkillDetail } from '@/components/observe/SkillDetail';
import { RunMemberPicker } from '@/components/run/RunMemberPicker';
import { runMemberUrlFor, sessionViewUrlFor } from '@/lib/observe/member-url';
import type { RunMemberRow } from '@/lib/run/member-rows';

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const fetchedUrls: string[] = []
const respond = (url: string): { ok: boolean; json: () => Promise<unknown>; text: () => Promise<string> } => {
  if (url.includes('/scorecard') && !url.includes('bench-report')) return { ok: true, json: async () => ({}), text: async () => '' }
  if (url.includes('skill-coverage')) return { ok: true, json: async () => ({ items: [], stats: { total: 0, invoked: 0, usedOnly: 0, unused: 0, unknown: 0 } }), text: async () => '' }
  if (url.includes('skill-content-audit')) return { ok: true, json: async () => ({ items: [] }), text: async () => '' }
  if (url.includes('wire-rounds')) return { ok: true, json: async () => ({ rounds: [], delta: false }), text: async () => '' }
  return { ok: true, json: async () => ({}), text: async () => '' }
}

let root: Root | null = null

async function render(node: React.ReactElement): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(node)
  })
  await act(async () => { await vi.waitFor(() => {}) })
}

afterEach(() => {
  root?.unmount()
  root = null
  document.body.innerHTML = ''
  fetchedUrls.length = 0
})

const RUN = 'run-wire-01'
const MEMBER = 'ses-member-a'

describe('run-first 刀I2：urlFor 成员视图端点覆盖', () => {
  it('runMemberUrlFor：query 合并 + 保留字编码（solo: 命名空间）', () => {
    const f = runMemberUrlFor('solo:ses_x', 'ses-a')
    expect(f('scorecard')).toBe('/api/observe/run/solo%3Ases_x/scorecard?member=ses-a')
    expect(f('wire-rounds?taskId=ses-a&delta=1')).toBe('/api/observe/run/solo%3Ases_x/wire-rounds?taskId=ses-a&delta=1&member=ses-a')
    expect(sessionViewUrlFor('wire-rounds?taskId=a')).toBe('/api/observe/session/wire-rounds?taskId=a')
  })

  it('WireRounds：run 挂载取数走成员视图端点；缺省 urlFor 时 session 端点不变', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      fetchedUrls.push(url)
      return respond(url)
    }))
    await render(createElement(WireRounds, { taskId: MEMBER, framework: 'opencode', urlFor: runMemberUrlFor(RUN, MEMBER) }))
    expect(fetchedUrls).toEqual([
      `/api/observe/run/${RUN}/wire-rounds?taskId=${MEMBER}&delta=1&framework=opencode&member=${MEMBER}`,
    ])
    expect(fetchedUrls.some(u => u.includes('/api/observe/session/'))).toBe(false)

    fetchedUrls.length = 0
    await render(createElement(WireRounds, { taskId: MEMBER, framework: 'opencode' }))
    expect(fetchedUrls).toEqual([
      `/api/observe/session/wire-rounds?taskId=${MEMBER}&delta=1&framework=opencode`,
    ])
    vi.unstubAllGlobals()
  })

  it('TrajectoryScoring：评分卡 GET 走 run 成员视图端点（POST 族同闭包，端点族一致性由 I3 页面 IT 再锁）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      fetchedUrls.push(url)
      return respond(url)
    }))
    await render(createElement(TrajectoryScoring, {
      taskId: MEMBER, framework: 'opencode', embedded: true, urlFor: runMemberUrlFor(RUN, MEMBER),
    }))
    expect(fetchedUrls.some(u => u === `/api/observe/run/${RUN}/scorecard?taskId=${MEMBER}&framework=opencode&member=${MEMBER}`)).toBe(true)
    expect(fetchedUrls.some(u => u.includes('/api/observe/session/'))).toBe(false)
    vi.unstubAllGlobals()
  })

  it('SkillDetail 族：skill-coverage / skill-content-audit 挂载取数走 run 成员视图端点', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      fetchedUrls.push(url)
      return respond(url)
    }))
    await render(createElement(SkillDetail, {
      taskId: MEMBER,
      sessionSkills: [{ skillName: 'demo-skill', version: null, invocationCount: 1 }] as never,
      skillEvents: [] as never,
      urlFor: runMemberUrlFor(RUN, MEMBER),
    }))
    expect(fetchedUrls).toContain(`/api/observe/run/${RUN}/skill-coverage?taskId=${MEMBER}&member=${MEMBER}`)
    expect(fetchedUrls).toContain(`/api/observe/run/${RUN}/skill-content-audit?taskId=${MEMBER}&member=${MEMBER}`)
    expect(fetchedUrls.some(u => u.includes('/api/observe/session/'))).toBe(false)
    vi.unstubAllGlobals()
  })
})

describe('run-first 刀I2：RunMemberPicker', () => {
  const members = [
    { taskId: 'ses-a', displayName: '规划', framework: 'opencode', label: null, kind: 'session' },
    { taskId: 'ses-b', displayName: '执行', framework: 'opencode', label: null, kind: 'session' },
  ] as unknown as RunMemberRow[]

  it('多成员渲染全部 + 成员 chips；点成员选中、再点回全部（allLabel 模式）', async () => {
    const onChange = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const r = createRoot(container)
    await act(async () => {
      r.render(createElement(RunMemberPicker, { members, value: null, onChange, allLabel: '发现（合并）' }))
    })
    const buttons = [...document.querySelectorAll('button')].map(b => b.textContent ?? '')
    expect(buttons).toEqual(['发现（合并）', '规划', '执行'])

    const memberBtn = [...document.querySelectorAll('button')].find(b => b.textContent === '规划')!
    await act(async () => { memberBtn.click() })
    expect(onChange).toHaveBeenLastCalledWith('ses-a')

    // 受控态：父组件回填 value='ses-a' 后再点当前成员 → 回全部
    await act(async () => {
      r.render(createElement(RunMemberPicker, { members, value: 'ses-a', onChange, allLabel: '发现（合并）' }))
    })
    await act(async () => { memberBtn.click() })
    expect(onChange).toHaveBeenLastCalledWith(null)
    r.unmount()
  })

  it('成员必选模式：单成员免渲染；当前成员再点为 no-op', async () => {
    const onChange = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const r = createRoot(container)
    await act(async () => {
      r.render(createElement(RunMemberPicker, { members: [members[0]], value: 'ses-a', onChange }))
    })
    expect(document.querySelectorAll('button').length).toBe(0)

    await act(async () => {
      r.render(createElement(RunMemberPicker, { members, value: 'ses-a', onChange }))
    })
    expect(document.querySelectorAll('button').length).toBe(2)
    const active = [...document.querySelectorAll('button')].find(b => b.textContent === '规划')!
    await act(async () => { active.click() })
    expect(onChange).not.toHaveBeenCalled()
    r.unmount()
  })

  it('大成员量：单行轨道全量渲染不裁剪，搜索过滤直达任意成员，尾挂总数计数', async () => {
    const many = Array.from({ length: 239 }, (_, i) => ({
      taskId: `ses-${i}`, displayName: `成员${i}`, framework: 'opencode', label: null, kind: 'session',
    })) as unknown as RunMemberRow[]
    const container = document.createElement('div')
    document.body.appendChild(container)
    const r = createRoot(container)
    await act(async () => {
      r.render(createElement(RunMemberPicker, { members: many, value: 'ses-200', onChange: vi.fn() }))
    })
    // 239 枚卡舌全部在 DOM（单行横滚，不是只渲染可见项）
    const pills = [...document.querySelectorAll('button[data-member-pill]')]
    expect(pills.length).toBe(239)
    expect(pills[200]!.getAttribute('data-member-pill')).toBe('ses-200')
    // 计数：成员量 > 8 时挂总数
    expect(container.textContent).toContain('239')

    // 搜索过滤：输入即过滤（名称/taskId 子串），计数变 命中/总数
    const input = container.querySelector('input[data-member-search]')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, '成员20')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(document.querySelectorAll('button[data-member-pill]').length).toBe(11)
    expect(container.textContent).toContain('11/239')
    // taskId 子串同样可搜
    await act(async () => {
      setter.call(input, 'ses-137')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(document.querySelectorAll('button[data-member-pill]').length).toBe(1)
    await act(async () => {
      setter.call(input, '不存在的成员')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(document.querySelectorAll('button[data-member-pill]').length).toBe(0)
    expect(container.textContent).toContain('0/239')
    expect(container.textContent).toContain('无匹配成员')
    r.unmount()
  })
})
