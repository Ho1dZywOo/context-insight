// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// 数据仓源视图 IT（design: docs/design/unified-workbench/design.md §4 刀4）：
// lake_viewer 整页并入统一工作台后，锁三件事：
//   ① 数据源切换：/?src=lake 渲染 LakeSourceView（范式侧栏 + 运行表），
//      本地视图 header 出「数据仓」入口 → /?src=lake，lake 视图出「本地洞察库」回链
//   ② 取数全部走 /api/ingest/lake action 集（paradigm-summary / lake-runs /
//      import / bundle-list / bundle-import）——旧 viewer 8 路由零残留
//   ③ URL 镜像：lake 视图内导航（范式切换/筛选）保持 src=lake 参数

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import Home from '@/app/page';

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const h = vi.hoisted(() => ({
  search: new URLSearchParams(''),
  replace: vi.fn((url: string) => {
    h.search = new URLSearchParams(url.split('?')[1] ?? '')
  }),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: h.replace, back: () => {}, refresh: () => {} }),
  useSearchParams: () => h.search,
}))

const fetchCalls: Array<Record<string, unknown>> = []
const actionsOf = (action: string) => fetchCalls.filter(b => b.action === action)

const RUN_ITEM = {
  sid: 'lake-it-run01',
  isBaseline: false,
  recording: 'capture' as const,
  framework: 'claude-code',
  ccVersion: '1.2.3',
  workflow: null,
  description: 'lake 源视图行',
  author: 'zhang3',
  opGen: 'success' as const,
  startTime: '2026-09-01T11:20:00+08:00',
  startTimeApprox: false,
  durationMs: 30 * 60_000,
  activeKnown: true,
  wallMs: 35 * 60_000,
  totalTokens: 45_000,
  model: 'glm-4.7',
  imported: false,
  totalScore: 87,
  scoreSource: 'local' as const,
  dimensions: [{ dimensionId: 'correctness', name: '正确性', score: 0.9 }],
  baselineDelta: null,
  insightUrl: '/session/lake-it-run01',
}

const BUNDLE_ITEM = {
  runId: 'bundle-it-0001',
  name: 'lake bundle 行',
  status: 'passed',
  exportDataComplete: true,
  memberCount: 3,
  sessionCount: 2,
  submitter: 'li4',
  description: 'bundle 专区行',
  paradigm: 'opsbot-bundle',
  uploadedAt: '2026-09-02T10:00:00+08:00',
  commitTime: '2026-09-02T10:00:00+08:00',
  imported: false,
}

vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { body?: string }) => {
  const body: Record<string, unknown> = init?.body ? JSON.parse(init.body) : {}
  fetchCalls.push(body)
  const mk = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } })
  switch (body.action) {
    case 'paradigm-summary':
      return mk({ items: [{ name: 'elementwise', runCount: 1, hasBaseline: true }, { name: 'opsbot-bundle', runCount: 1, hasBaseline: false }] })
    case 'lake-runs':
      // legacy 专区目录只含包（统一布局：真实形态——会话运行数为 0，
      // 视图只呈现"工作流包"区块）；其余范式返回一条会话运行
      return mk({
        paradigm: body.paradigm,
        total: body.paradigm === 'opsbot-bundle' ? 0 : 1,
        baselineSid: null,
        insightReachable: true,
        facets: { frameworks: ['claude-code'], ccVersions: ['1.2.3'] },
        items: body.paradigm === 'opsbot-bundle' ? [] : [RUN_ITEM],
      })
    case 'bundle-list':
      return mk({ items: [BUNDLE_ITEM], dirs: ['elementwise', 'opsbot-bundle'] })
    case 'import':
      return mk({ result: { ok: true, imported: true } })
    case 'bundle-import':
      return mk({ jobId: 'job-it-1', runId: body.runId })
    default:
      return mk({})
  }
}))

let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
  fetchCalls.length = 0
  h.replace.mockClear()
  h.search = new URLSearchParams('')
})

const settle = async (): Promise<void> => {
  await act(async () => { await new Promise(r => setTimeout(r, 20)) })
}

async function renderHome(params: Record<string, string | undefined>): Promise<void> {
  const tree = await Home({ searchParams: Promise.resolve(params) })
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(tree) })
  await settle()
  await settle()
}

describe('数据源切换（?src=lake）', () => {
  it('本地视图：header 出「数据仓」入口 → /?src=lake（品牌名按钮）；本地内容（导入历史）在场', async () => {
    await renderHome({})
    const link = document.querySelector('a[href="/?src=lake"]') as HTMLAnchorElement | null
    expect(link).not.toBeNull()
    // 按钮文案 = BAY_VIEWER_NAME（数据仓显示名，随品牌翻转）
    expect(link!.textContent).toContain('Viewer')
    // 本地视图仍渲染本地工作台内容（指标卡 + 统一资产表），lake 侧栏不在场
    expect(document.body.textContent).toContain('Total Tokens')
    expect(document.querySelector('input[placeholder="过滤范式…"]')).toBeNull()
  })

  it('lake 视图：渲染范式侧栏 + 运行表，本地内容不在场，header 出「本地洞察库」回链', async () => {
    h.search = new URLSearchParams('src=lake')
    await renderHome({ src: 'lake' })
    // 侧栏范式清单（paradigm-summary 通路）
    expect(actionsOf('paradigm-summary')).toHaveLength(1)
    expect(document.body.textContent).toContain('elementwise')
    // 运行表行（lake-runs 通路：缺省范式 = 清单首项）
    expect(actionsOf('lake-runs')[0]?.paradigm).toBe('elementwise')
    expect(document.body.textContent).toContain('lake-it-run01'.slice(0, 8))
    // 本地工作台内容不在场（数据源切换是整页内容切换），lake 侧栏在场
    expect(document.body.textContent).not.toContain('Total Tokens')
    expect(document.querySelector('input[placeholder="过滤范式…"]')).not.toBeNull()
    // header 回链
    const back = document.querySelector('a[href="/"]') as HTMLAnchorElement | null
    expect(back).not.toBeNull()
    expect(back!.textContent).toContain('本地洞察库')
  })
})

describe('lake 视图取数与导入（全走 /api/ingest/lake action 集）', () => {
  it('行内「导入查看」→ action import（sid + recording），成功无错误提示', async () => {
    h.search = new URLSearchParams('src=lake')
    await renderHome({ src: 'lake' })
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent === '导入查看')
    expect(btn).toBeTruthy()
    await act(async () => { btn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    await settle()
    const imports = actionsOf('import')
    expect(imports).toHaveLength(1)
    expect(imports[0]).toMatchObject({ sid: 'lake-it-run01', recording: 'capture' })
  })

  it('目录视图（paradigm=opsbot-bundle，只含包）→ bundle-list 取数 + 工作流包区块 + 行内 bundle-import（paradigm 透传）', async () => {
    h.search = new URLSearchParams('src=lake&paradigm=opsbot-bundle')
    await renderHome({ src: 'lake', paradigm: 'opsbot-bundle' })
    expect(actionsOf('bundle-list')).toHaveLength(1)
    // 会话运行表空 → 只呈现"工作流包"区块（统一布局：同目录两类资产同格，
    // 无资产即无区块）
    expect(document.body.textContent).toContain('工作流包（Run bundle）')
    expect(document.body.textContent).toContain('lake bundle 行')
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent === '导入查看')
    expect(btn).toBeTruthy()
    await act(async () => { btn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    await settle()
    const imports = actionsOf('bundle-import')
    expect(imports).toHaveLength(1)
    // paradigm = 列表行所在目录（位置即身份）：透传即精确物化
    expect(imports[0]).toMatchObject({ runId: 'bundle-it-0001', paradigm: 'opsbot-bundle' })
  })

  it('URL 镜像：视图内范式切换保持 src=lake 参数（router.replace）', async () => {
    h.search = new URLSearchParams('src=lake')
    await renderHome({ src: 'lake' })
    const entry = [...document.querySelectorAll('button, [role="button"], a')].find(el => (el.textContent ?? '').includes('opsbot-bundle'))
    expect(entry).toBeTruthy()
    await act(async () => { entry!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    expect(h.replace).toHaveBeenCalled()
    const url = h.replace.mock.calls[h.replace.mock.calls.length - 1]![0] as string
    expect(url.startsWith('/?')).toBe(true)
    expect(url).toContain('src=lake')
    expect(url).toContain('paradigm=opsbot-bundle')
  })
})
