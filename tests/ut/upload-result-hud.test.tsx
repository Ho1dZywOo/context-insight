// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details on how to use this file in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom
// 上传结果提示 IT（顶置 HUD，全路径一致）：此前上传结果只在部分调用方
// 接了反馈——run 页弹窗零结果提示、会话上传失败只在主页横幅可见、导出查看器
// toast 依赖调用方各自接线。重构后结果统一在 UploadDialog 组件内经顶部 HUD
// 弹出：成功（绿勾，副文带原生同步结果）/警示（琥珀，缺正文驻留明细）/
// 失败（红叉，弹窗内驻留错误）三态，任何上传面一致。覆盖：
//   ① 会话上传成功 → HUD 确认 + 弹窗即关
//   ② 会话上传失败 → HUD 报错 + 弹窗驻留明细
//   ③ run 上传干净成功 → HUD 确认 + 即关
//   ④ run 上传带缺正文告警 → HUD 警示 + 弹窗驻留完整清单
//   ⑤ HUD 生命周期：到点自动退场 / 点击即收

import { describe, it, expect, afterEach, afterAll, beforeAll, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { UploadDialog } from '@/components/collection/UploadDialog'
import { UploadHudHost, notifyUploadResult, dismissAllUploadHuds } from '@/components/collection/UploadResultHud'
import { BAY_NAME } from '@/lib/branding'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLDivElement | null = null
// 每用例可重置的上传应答（成功/失败/形态由各用例注入）
let uploadResponder: (() => Response | Promise<Response>) | null = null

const json = (data: unknown, status = 200): Promise<Response> =>
  Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }))

beforeAll(() => {
  ;(globalThis as { fetch: typeof fetch }).fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes('/api/settings/lake-config')) {
      return json({ configured: true, address: 'https://example.com/lake.git', branch: 'main' })
    }
    if (url.includes('/api/settings/lake-auth')) {
      return json({ remotes: [{ url: 'https://example.com/lake.git', username: 'u', tokenMasked: '****' }] })
    }
    if (url.includes('/api/ingest/lake')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      if (body.action === 'list') return json({ dirs: ['hud-it'], sessions: [] })
      if (body.action === 'upload' || body.action === 'bundle-upload') {
        return uploadResponder ? uploadResponder() : json({ error: 'no responder' }, 500)
      }
      return json({ error: 'unknown action' }, 400)
    }
    return json({ error: 'unmocked' }, 404)
  }) as typeof fetch
})

afterAll(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  act(() => { dismissAllUploadHuds() })
  if (root) { const r = root; act(() => { r.unmount() }); root = null }
  container?.remove(); container = null
  vi.useRealTimers()
})

/** 渲染 HUD 挂载点 + 上传弹窗（同一棵树），并等范式目录/凭据预检拉平 */
async function renderDialog(props: Parameters<typeof UploadDialog>[0]): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  const r = createRoot(container)
  root = r
  await act(async () => {
    r.render(createElement('div', null,
      createElement(UploadHudHost),
      createElement(UploadDialog, props),
    ))
  })
  // 范式目录（useParadigmDirs）与凭据预检（useCredentialPrecheck）在打开时
  // 各发一串 fetch——空 act 轮转冲平微任务
  await act(async () => {})
  await act(async () => {})
}

function findButton(text: string): HTMLButtonElement {
  const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === text)
  if (!btn) throw new Error(`button not found: ${text}`)
  return btn as HTMLButtonElement
}

/** React 受控表单赋值：React 在节点上补丁 value 描述符（value tracker），
 *  直接 .value 赋值会被 tracker 视为「未变」而吞掉 onChange——须走原型
 *  native setter 绕开实例补丁，再派发对应事件 */
function setControlledValue(
  el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: string,
): void {
  const proto = el instanceof HTMLSelectElement
    ? HTMLSelectElement.prototype
    : el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  setter?.call(el, value)
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
}

async function fillSessionForm(): Promise<void> {
  const submitter = document.querySelector('input[placeholder="必填：真实姓名或账号"]') as HTMLInputElement
  await act(async () => { setControlledValue(submitter, '张三') })
  const select = document.querySelector('select') as HTMLSelectElement
  await act(async () => { setControlledValue(select, 'hud-it') })
  await act(async () => { findButton('成功').click() })
}

const SESSION_TARGET = {
  taskId: 'ses-hud-it-0001',
  query: '查一下构建失败原因',
  framework: 'claude-code',
  user: '',
}

const flush = async (): Promise<void> => {
  await act(async () => {})
  await act(async () => {})
}

describe('上传结果 HUD（组件内单点，全上传面一致）', () => {
  it('① 会话上传成功：HUD 确认（已上传到）+ 弹窗即关 + onResult ok', async () => {
    uploadResponder = () => json({ ok: true })
    const onOpenChange = vi.fn()
    const onResult = vi.fn()
    await renderDialog({ open: true, onOpenChange, kind: 'session', target: SESSION_TARGET, onResult })
    await fillSessionForm()

    await act(async () => { findButton('确认上传').click() })
    await flush()

    // HUD 成功卡（宿主渲染在容器内）
    expect(container!.textContent).toContain(`已上传到 ${BAY_NAME}`)
    // 弹窗即关 + 调用方回调（行内状态用）
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ ok: true }))
  })

  it('② 会话上传失败：HUD 报错 + 弹窗驻留明细 + onResult !ok', async () => {
    uploadResponder = () => json({ error: '清洗失败：检测到疑似泄漏内容' }, 500)
    const onOpenChange = vi.fn()
    const onResult = vi.fn()
    await renderDialog({ open: true, onOpenChange, kind: 'session', target: SESSION_TARGET, onResult })
    await fillSessionForm()

    await act(async () => { findButton('确认上传').click() })
    await flush()

    // HUD 报错卡：标题 + 原因副文
    expect(container!.textContent).toContain('上传失败')
    expect(container!.textContent).toContain('清洗失败：检测到疑似泄漏内容')
    // 弹窗不关 + 错误驻留弹窗内（可读可复制）+ 回调
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    const dialogEl = document.querySelector('[role="dialog"]')
    expect(dialogEl?.textContent).toContain('清洗失败：检测到疑似泄漏内容')
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
  })

  it('③ run 上传干净成功：HUD 确认（N 个成员会话）+ 弹窗即关', async () => {
    uploadResponder = () => json({ unchanged: false, sessionCount: 5, missingSessions: [] })
    const onOpenChange = vi.fn()
    await renderDialog({ open: true, onOpenChange, kind: 'run', target: { runId: 'run-hud-1', runName: 'HUD 冒烟' } })

    await fillSessionForm()
    await act(async () => { findButton('确认上传').click() })
    await flush()

    expect(container!.textContent).toContain(`已上传 5 个成员会话到 ${BAY_NAME}`)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('④ run 上传带缺正文告警：HUD 警示（琥珀）+ 弹窗驻留完整清单', async () => {
    uploadResponder = () => json({ unchanged: false, sessionCount: 3, missingSessions: ['ses-a', 'ses-b'] })
    const onOpenChange = vi.fn()
    await renderDialog({ open: true, onOpenChange, kind: 'run', target: { runId: 'run-hud-2', runName: 'HUD 告警' } })

    await fillSessionForm()
    await act(async () => { findButton('确认上传').click() })
    await flush()

    // HUD 警示卡：标题 + 摘要副文 + 琥珀图标
    expect(container!.textContent).toContain(`已上传 3 个成员会话到 ${BAY_NAME}`)
    expect(container!.textContent).toContain('缺其正文')
    expect(container!.querySelector('.hud-card span.bg-amber-500')).toBeTruthy()
    // 弹窗驻留：完整 sid 清单在弹窗内可见
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    const dialogEl = document.querySelector('[role="dialog"]')
    expect(dialogEl?.textContent).toContain('ses-a')
    expect(dialogEl?.textContent).toContain('ses-b')
  })

  it('⑤ HUD 生命周期：到点自动退场 / 点击即收', async () => {
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const r = root!
    await act(async () => {
      r.render(createElement(UploadHudHost))
    })

    // 成功色调默认驻留 3200ms：期内可见，到点 + 退场动画（180ms）后消失
    act(() => { notifyUploadResult({ ok: true, title: 'T-success', description: 'D-success' }) })
    expect(container!.textContent).toContain('T-success')
    await act(async () => { vi.advanceTimersByTime(3300) })
    expect(container!.textContent).toContain('T-success') // 退场动画中仍占位
    await act(async () => { vi.advanceTimersByTime(200) })
    expect(container!.textContent).not.toContain('T-success')

    // 点击即收：不等驻留时长
    act(() => { notifyUploadResult({ ok: false, title: 'T-error', description: 'D-error' }) })
    expect(container!.textContent).toContain('T-error')
    await act(async () => { (container!.querySelector('.hud-card') as HTMLElement).click() })
    await act(async () => { vi.advanceTimersByTime(200) })
    expect(container!.textContent).not.toContain('T-error')
  })
})
