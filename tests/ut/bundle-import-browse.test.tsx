// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// 统一导入向导 · Run（bundle）通路 IT（页面级 Dialog 交互）：
// - 本地来源：Browse 进入双绿目录表 → bundle 目录绿色高亮（Bundle 类型标签 +
//   计数）→ 点击直接触发 import-bundle POST → 轮询到 done → Done 关闭 + 写
//   run 历史。普通目录点击只导航、文件点击不导入。
// - 数据仓来源（统一布局：目录即目录，按数据加载）：目录选择阶段（各顶层
//   目录双计数 = 会话数 + 包数，根目录卡同格）→ 进入目录 → 会话表与包表
//   同格呈现 → 混选/批量导入（import + bundle-import 按选择键分域，包导入
//   透传 paradigm 精确定位）→ 逐项状态轮询到完成。
// - bundle-list 失败非致命：降级为无包表 + 黄字提示，会话浏览不受阻。

import { describe, it, expect, afterEach, vi, beforeAll } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { ImportDialog } from '@/components/collection/ImportDialog'
import { BAY_NAME } from '@/lib/branding'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// handleDone 完成后 window.location.reload()——测试环境替换为 spy
const reloadSpy = vi.fn()

interface Entry {
  name: string
  fullPath: string
  isDir: boolean
  size: number
  mtime: number
  isImportableFile: boolean
  importableType: string | null
  isBundleDir?: boolean
}

// /bundles：一个 bundle 目录 + 一个普通目录 + 散文件
const bundlesDir = (): Entry[] => [
  { name: 'my-run', fullPath: '/bundles/my-run', isDir: true, size: 0, mtime: 1790000001000, isImportableFile: false, importableType: null, isBundleDir: true },
  { name: 'plain-dir', fullPath: '/bundles/plain-dir', isDir: true, size: 0, mtime: 1790000002000, isImportableFile: false, importableType: null, isBundleDir: false },
  { name: 'notes.txt', fullPath: '/bundles/notes.txt', isDir: false, size: 10, mtime: 1790000003000, isImportableFile: false, importableType: null },
]

// /bundles/my-run：包内部（workflow.json + sessions/）
const bundleInside = (): Entry[] => [
  { name: 'workflow.json', fullPath: '/bundles/my-run/workflow.json', isDir: false, size: 61000, mtime: 1790000004000, isImportableFile: false, importableType: null },
  { name: 'sessions', fullPath: '/bundles/my-run/sessions', isDir: true, size: 0, mtime: 1790000005000, isImportableFile: false, importableType: null },
]

const importCalls: { dirPath?: string }[] = []
const lakeCalls: Array<{ action?: string; runId?: string; sid?: string; paradigm?: string; recording?: string }> = []
// 数据仓顶层目录（与会话范式注册表同源）：统一布局——含 legacy 专区名，无特殊语义
const LAKE_DIRS = ['elementwise', 'opsbot-bundle', 'reduction']
// 会话列表响应（list）：elementwise 一个范式会话 + 一个根级会话（根目录卡）
const defaultListValue = () => ({
  dirs: LAKE_DIRS,
  sessions: [
    { sid: 'sess-e1', fileCount: 3, author: '张三', submitter: '张三', description: 'elementwise 会话', commitTime: '2026-10-17T01:00:00+08:00', paradigm: 'elementwise', recording: 'capture' },
    { sid: 'sess-root', fileCount: 2, author: '李四', submitter: '李四', description: '根级会话', commitTime: '2026-10-16T01:00:00+08:00', paradigm: null, recording: 'capture' },
  ],
})
// bundle 列表响应（bundle-list，统一布局：条目自带所在目录 paradigm）；
// 错误用例临时切换
const defaultBundleListValue = () => ({
  dirs: LAKE_DIRS,
  items: [
    { runId: 'lakerun01', name: '数据仓包 A', status: 'passed', memberCount: 5, sessionCount: 3, submitter: '张三', paradigm: 'opsbot-bundle', uploadedAt: '2026-10-17T02:00:00.000Z', commitTime: '2026-10-17T02:00:00.000Z', fileCount: 12, imported: true },
    { runId: 'lakerun02', name: '数据仓包 B', status: 'failed', memberCount: 2, sessionCount: 1, submitter: '李四', paradigm: 'elementwise', uploadedAt: null, commitTime: '2026-10-16T08:00:00.000Z', fileCount: 4, imported: false },
    { runId: 'lakerun03', name: '根级包 C', status: 'passed', memberCount: 1, sessionCount: 1, submitter: '王五', paradigm: null, uploadedAt: null, commitTime: '2026-10-15T08:00:00.000Z', fileCount: 3, imported: false },
  ],
})
const listResponse: { status: number; value: Record<string, unknown> } = { status: 200, value: defaultListValue() }
const bundleListResponse: { status: number; value: Record<string, unknown> } = { status: 200, value: defaultBundleListValue() }

beforeAll(() => {
  vi.stubGlobal('location', { ...window.location, reload: reloadSpy })
  ;(globalThis as { fetch: typeof fetch }).fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const json = (data: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }))
    if (url.includes('/api/settings/lake-config')) {
      return json({ configured: true, address: 'https://example.com/lake.git', branch: 'main' })
    }
    if (url.includes('/api/ingest/lake')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string; runId?: string; sid?: string; paradigm?: string; recording?: string }
      if (body.action === 'bundle-import') {
        lakeCalls.push(body)
        return json({ jobId: 'job-lake', state: { runId: body.runId, step: 'validate' } })
      }
      if (body.action === 'import') {
        lakeCalls.push(body)
        return json({ result: { imported: true, reason: null, query: '会话首问', framework: 'opencode', version: '1.0' } })
      }
      if (body.action === 'list') return json(listResponse.value, listResponse.status)
      if (body.action === 'bundle-list') return json(bundleListResponse.value, bundleListResponse.status)
      return json({})
    }
    if (url.includes('/api/ingest/browse-directory')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { dirPath?: string }
      const isBundleInside = body.dirPath === '/bundles/my-run'
      return json({
        isDirectory: true,
        entries: isBundleInside ? bundleInside() : bundlesDir(),
        parentPath: isBundleInside ? '/bundles' : '/',
        currentPath: body.dirPath ?? '/',
      })
    }
    if (url.includes('/api/ingest/import-bundle/status')) {
      return json({
        job: {
          jobId: 'job-1', runId: 'minidemo01', step: 'done', total: 4,
          imported: 3, existing: 1, missingFile: 0, failed: 0,
          currentSid: null, error: null, warnings: [],
        },
      })
    }
    if (url.includes('/api/ingest/import-bundle')) {
      importCalls.push(JSON.parse(String(init?.body ?? '{}')))
      return json({ ok: true, jobId: 'job-1', runId: 'minidemo01' })
    }
    return json({})
  }) as typeof fetch
})

let root: Root | null = null

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

async function openDialog(): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(createElement(ImportDialog)) })
  await flush()
  click(findButtonByText('Import')!)
  await flush()
}

async function openBrowseStep(): Promise<void> {
  await openDialog()
  click(findButtonByText('Browse')!)
  await flush()
}

function visibleRows(): HTMLElement[] {
  return [...document.querySelectorAll('tbody tr')] as HTMLElement[]
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
  importCalls.length = 0
  lakeCalls.length = 0
  reloadSpy.mockClear()
  localStorage.clear()
  listResponse.status = 200
  listResponse.value = defaultListValue()
  bundleListResponse.status = 200
  bundleListResponse.value = defaultBundleListValue()
})

describe('统一导入向导 · 本地 bundle 通路：目录浏览选包导入', () => {
  it('Browse → bundle 目录高亮 + 计数 → 点击 bundle 目录直接导入 → 轮询到 done → Done 关闭 + 写 run 历史', async () => {
    await openBrowseStep()

    // 浏览步：3 行；bundle 目录有 Bundle 类型标签与计数（双绿并存）
    expect(visibleRows()).toHaveLength(3)
    expect(document.body.textContent).toContain('my-run')
    expect(document.body.textContent).toContain('Bundle')
    expect(document.body.textContent).toContain('plain-dir')
    expect(document.body.textContent).toContain('Directory')
    expect(document.body.textContent).toContain('1 bundle directories')

    // 点击 bundle 目录行 → 直接触发导入 job（POST 带包路径）
    const bundleRow = visibleRows().find(tr => tr.textContent?.includes('my-run'))!
    click(bundleRow)
    await flush()
    expect(importCalls).toEqual([{ dirPath: '/bundles/my-run' }])
    // 导入步已渲染（job 初始 validate 态）
    expect(document.body.textContent).toContain('校验 manifest')

    // 等 1s 轮询打到 done：进度满格 + 完成摘要 + Done 按钮（run 项不自动关闭）
    await act(async () => { await new Promise(r => setTimeout(r, 1300)) })
    expect(document.body.textContent).toContain('Progress: 4/4')
    expect(document.body.textContent).toContain('Import complete')
    expect(document.body.textContent).toContain('完成：新导入 3 · 已存在 1')
    expect(findButtonByText('Done')).toBeTruthy()

    // Done 关闭弹窗 + 整页 reload + 写 run 历史条目（kind=run、taskId=runId、
    // filePath=本地目录——删除只清历史，run 删除在资产表行内）
    click(findButtonByText('Done')!)
    await flush()
    expect(reloadSpy).toHaveBeenCalled()
    const history = JSON.parse(localStorage.getItem('context-import-history') ?? '[]') as Array<{ taskId: string; kind?: string; filePath: string | null; sourceType?: string }>
    expect(history).toHaveLength(1)
    expect(history[0].taskId).toBe('minidemo01')
    expect(history[0].kind).toBe('run')
    expect(history[0].filePath).toBe('/bundles/my-run')
    expect(history[0].sourceType).toBe('workflow-bundle')
    expect(document.body.textContent).not.toContain('文件格式')
  })

  it('普通目录点击只导航；文件点击不触发导入；主目录快捷键可达浏览步', async () => {
    await openBrowseStep()

    // 普通目录点击 = 导航（currentDir 变化），不触发导入
    const plainRow = visibleRows().find(tr => tr.textContent?.includes('plain-dir'))!
    click(plainRow)
    await flush()
    expect(document.body.textContent).toContain('/bundles/plain-dir')
    expect(importCalls).toHaveLength(0)

    // 文件行点击不导入（bundle 导入目标是目录）
    const fileRow = visibleRows().find(tr => tr.textContent?.includes('notes.txt'))!
    click(fileRow)
    await flush()
    expect(importCalls).toHaveLength(0)

    // Back 回 input 步；主目录快捷按钮重新进入浏览步
    click(findButtonByText('Back')!)
    await flush()
    expect(document.body.textContent).toContain('本地文件')
    click(findButtonByText('主目录')!)
    await flush()
    expect(document.querySelector('input[placeholder*="Filter by file name"]')).not.toBeNull()
    expect(importCalls).toHaveLength(0)
  })

  it('手动输入 bundle 目录路径 → 探测（目录含 workflow.json）→ 走 run job 通路', async () => {
    await openDialog()
    // 手动路径不走 jsonl 单文件直导（无 .jsonl 后缀）→ detectLocalImportKind
    // browse /bundles/my-run → 子项含 workflow.json → run
    const pathInput = [...document.querySelectorAll('input')].find(i => i.placeholder?.includes('path/to')) as HTMLInputElement
    expect(pathInput).toBeTruthy()
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      set.call(pathInput, '/bundles/my-run')
      pathInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()
    click(findButtonByText('Load')!)
    await flush()
    expect(importCalls).toEqual([{ dirPath: '/bundles/my-run' }])
    expect(document.body.textContent).toContain('校验 manifest')
  })
})

describe('统一导入向导 · 数据仓通路：目录即注册表 + 同格混选导入', () => {
  /** 行 checkbox：目录视图内会话表 + 包表所有数据行（全选 checkbox 在表格外） */
  function rowCheckboxes(): HTMLElement[] {
    return [...document.querySelectorAll('[data-slot="dialog-content"] table tbody tr [role="checkbox"]')] as HTMLElement[]
  }

  function dirButton(dir: string): HTMLButtonElement | undefined {
    return [...document.querySelectorAll('button')].find(b => b.textContent?.startsWith(dir))
  }

  /** 打开弹窗 → 切数据仓源（点击即并行拉会话列表 + bundle 清单）→ 停在目录选择阶段 */
  async function openLakePhase1(): Promise<void> {
    await openDialog()
    click([...document.querySelectorAll('button')].find(b => b.textContent?.includes(BAY_NAME))!)
    await flush()
  }

  it('目录选择阶段：各目录双计数（会话 · 包）+ 根目录卡同格；不按资产类型分区', async () => {
    await openLakePhase1()

    expect(document.body.textContent).toContain('https://example.com/lake.git')
    // 各顶层目录卡 + 根目录卡；双计数同格呈现
    expect(dirButton('elementwise')?.textContent).toContain('1 会话')
    expect(dirButton('elementwise')?.textContent).toContain('1 包')
    expect(dirButton('opsbot-bundle')?.textContent).toContain('1 包')
    expect(dirButton('根目录')?.textContent).toContain('1 会话')
    expect(dirButton('根目录')?.textContent).toContain('1 包')
    expect(dirButton('reduction')?.textContent).toContain('空')
    // 目录不重复出现（legacy 专区名只是一张普通目录卡）
    expect([...document.querySelectorAll('button')].filter(b => b.textContent?.startsWith('opsbot-bundle'))).toHaveLength(1)
    expect([...document.querySelectorAll('button')].filter(b => b.textContent?.startsWith('根目录'))).toHaveLength(1)
    // 说明文案（目录即注册表，会话与 Run 包都存放在各目录里）
    expect(document.body.textContent).toContain('目录 = 数据仓顶层目录')
  })

  it('范式目录：会话表与包表同格 → 混选导入（import + bundle-import 分域，包透传 paradigm）', async () => {
    await openLakePhase1()

    click(dirButton('elementwise')!)
    await flush()
    // 会话表 + 包表同视图
    expect(document.body.textContent).toContain('sess-e1')
    expect(document.body.textContent).toContain('数据仓包 B')
    expect(document.body.textContent).toContain('目录 elementwise 的 Run 包')

    // 勾选会话行 + 包行（第一张表 = 会话表，第二张 = 包表）
    const boxes = rowCheckboxes()
    expect(boxes).toHaveLength(2)
    click(boxes[0])
    click(boxes[1])
    await flush()
    click(findButtonByText('Import 2 Selected')!)
    await flush()

    // 选择键分域：会话走 import（sid + recording），包走 bundle-import（带所在目录）
    expect(lakeCalls).toEqual([
      { action: 'import', sid: 'sess-e1', recording: 'capture' },
      { action: 'bundle-import', runId: 'lakerun02', paradigm: 'elementwise' },
    ])
    expect(importCalls).toHaveLength(0)
    expect(document.body.textContent).toContain('数据仓包 B')

    // 轮询到 done（包 job 复用本地导入同款 status mock）→ 完成摘要
    await act(async () => { await new Promise(r => setTimeout(r, 1300)) })
    expect(document.body.textContent).toContain('Progress: 2/2')
    expect(document.body.textContent).toContain('Import complete')

    // Done 关闭弹窗：写两条历史（会话 + run 各一，filePath = 仓引用）
    click(findButtonByText('Done')!)
    await flush()
    expect(reloadSpy).toHaveBeenCalled()
    const history = JSON.parse(localStorage.getItem('context-import-history') ?? '[]') as Array<{ taskId: string; kind?: string; filePath: string | null }>
    expect(history).toHaveLength(2)
    expect(history.some(e => e.taskId === 'sess-e1' && e.kind === undefined && e.filePath?.endsWith('elementwise/sess-e1'))).toBe(true)
    expect(history.some(e => e.taskId === 'lakerun02' && e.kind === 'run' && e.filePath?.endsWith('elementwise/lakerun02'))).toBe(true)
  })

  it('legacy 专区目录（只含包）：会话表隐藏直接呈现包表；paradigm 透传', async () => {
    await openLakePhase1()

    click(dirButton('opsbot-bundle')!)
    await flush()
    expect(document.body.textContent).toContain('数据仓包 A')
    expect(document.body.textContent).toContain('已导入')
    expect(document.body.textContent).toContain('5 成员 · 3 会话')
    expect(document.body.textContent).toContain('12 files · lakerun01')
    expect(document.body.textContent).toContain('1 bundles')
    expect(document.body.textContent).not.toContain('该范式下暂无会话')

    const boxes = rowCheckboxes()
    expect(boxes).toHaveLength(1)
    click(boxes[0])
    await flush()
    click(findButtonByText('Import 1 Selected')!)
    await flush()
    expect(lakeCalls).toEqual([{ action: 'bundle-import', runId: 'lakerun01', paradigm: 'opsbot-bundle' }])
  })

  it('根目录卡：根级会话与根级包同格；根级包导入不带 paradigm（服务端全仓搜索）', async () => {
    await openLakePhase1()

    click(dirButton('根目录')!)
    await flush()
    expect(document.body.textContent).toContain('sess-root')
    expect(document.body.textContent).toContain('根级包 C')

    const boxes = rowCheckboxes()
    expect(boxes).toHaveLength(2)
    click(boxes[1])
    await flush()
    click(findButtonByText('Import 1 Selected')!)
    await flush()
    expect(lakeCalls).toEqual([{ action: 'bundle-import', runId: 'lakerun03' }])
  })

  it('bundle 清单读取失败（非凭据类）→ 非致命降级：黄字提示 + 会话浏览不受阻（无包表）', async () => {
    bundleListResponse.status = 500
    bundleListResponse.value = { error: '清单读取失败：远端抖动' }

    await openLakePhase1()

    expect(document.body.textContent).toContain('elementwise')
    expect(document.body.textContent).toContain('Bundle 清单读取失败')
    // 目录卡只剩会话侧计数；进目录只有会话表
    click(dirButton('elementwise')!)
    await flush()
    expect(document.body.textContent).toContain('sess-e1')
    expect(document.body.textContent).not.toContain('的 Run 包')
    expect(lakeCalls).toHaveLength(0)
  })

  it('空目录 → 会话表空态；目录选择返回阶段1', async () => {
    await openLakePhase1()

    click(dirButton('reduction')!)
    await flush()
    expect(document.body.textContent).toContain('该范式下暂无会话')
    expect(document.body.textContent).toContain('0 sessions')
    expect(document.body.textContent).not.toContain('的 Run 包')

    click(findButtonByText('目录选择')!)
    await flush()
    expect(document.body.textContent).toContain('elementwise')
  })

  it('会话列表失败（非凭据类错误）→ 错误展示，不进 lake 步', async () => {
    listResponse.status = 500
    listResponse.value = { error: '数据仓读取失败：远端不可达' }

    await openLakePhase1()

    expect(document.body.textContent).toContain('数据仓读取失败：远端不可达')
    // 停在 input 步（来源选择卡仍在）
    expect(document.body.textContent).toContain('本地文件')
    expect(lakeCalls).toHaveLength(0)
  })
})
