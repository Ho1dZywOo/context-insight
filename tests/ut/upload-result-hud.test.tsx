// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details on how to use this file in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom
// 上传结果提示 IT（顶部 HUD，全路径一致；issue #167 的回归锁）：#167 首修给
// 弹窗加了滚动条——方向错了。现口径：上传弹窗版面固定（表单 + 操作钮），变长的
// 结果内容一律不进弹窗，进 NoticeHud：成功 = 瞬态确认；失败 = 报错卡（需确认，
// 不自动退场）；缺正文清单 = 带明细块的需确认警示卡。覆盖：
//   ① 会话上传成功 → 瞬态确认 + 弹窗即关
//   ② 会话上传失败 → 报错卡承载原因；弹窗版面不变、表单原样可重试
//   ③ run 上传干净成功 → 瞬态确认 + 即关
//   ④ run 上传带缺正文告警 → 需确认警示卡承载完整清单（持久）+ 弹窗即关
//   ⑤ HUD 生命周期：瞬态到点自动退场 / 点击即收；需确认卡是居中 Alert、不自动
//      消失、点卡片本体不关，必须点「知道了」确认，同文案合并 ×N、异文案排队
//   ⑥ 非法时间戳兜底
//   ⑦ 长报错原文：首行作副文 + 全文进明细块（可整段复制）
//   ⑧ 原生会话同步：上传失败 = 需确认警示卡；未找到 = 瞬态确认
//   ⑨ 明细块：长清单在块内滚动（容器带滚动约束），60 条全呈现

import { describe, it, expect, afterEach, afterAll, beforeAll, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { UploadDialog } from '@/components/collection/UploadDialog'
import { NoticeHudHost, notifyNotice, notifyError, dismissAllNotices, splitErrorDetail } from '@/components/NoticeHud'
import { BAY_NAME } from '@/lib/branding'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLDivElement | null = null
// 每用例可重置的上传应答（成功/失败/形态由各用例注入）
let uploadResponder: (() => Response | Promise<Response>) | null = null
// 最近一次上传请求体（用于断言描述等请求细节——如非法时间戳的兜底文案）
let lastUploadBody: Record<string, unknown> | null = null

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
        lastUploadBody = body
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
  act(() => { dismissAllNotices() })
  if (root) { const r = root; act(() => { r.unmount() }); root = null }
  container?.remove(); container = null
  vi.useRealTimers()
  lastUploadBody = null
})

/** 渲染 HUD 挂载点 + 上传弹窗（同一棵树），并等范式目录/凭据预检拉平 */
async function renderDialog(props: Parameters<typeof UploadDialog>[0]): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  const r = createRoot(container)
  root = r
  await act(async () => {
    r.render(createElement('div', null,
      createElement(NoticeHudHost),
      createElement(UploadDialog, props),
    ))
  })
  // 范式目录（useParadigmDirs）与凭据预检（useCredentialPrecheck）在打开时
  // 各发一串 fetch——空 act 轮转冲平微任务
  await act(async () => {})
  await act(async () => {})
}

/** 卸掉当前这一棵（同一用例内要再渲染一次时必须先卸：残留的旧弹窗会抢走
 *  按 document 取元素的填表与点击） */
async function unmountRendered(): Promise<void> {
  if (root) { const r = root; await act(async () => { r.unmount() }); root = null }
  container?.remove(); container = null
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
    expect(lastUploadBody).toMatchObject({
      action: 'upload',
      taskId: SESSION_TARGET.taskId,
      framework: SESSION_TARGET.framework,
    })
    // 弹窗即关 + 调用方回调（行内状态用）
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ ok: true }))
  })

  it('② 会话上传失败：报错卡承载原因；弹窗版面不变、不自动消失、须「知道了」确认，表单原样可重试', async () => {
    uploadResponder = () => json({ error: '清洗失败：检测到疑似泄漏内容' }, 500)
    const onOpenChange = vi.fn()
    const onResult = vi.fn()
    await renderDialog({ open: true, onOpenChange, kind: 'session', target: SESSION_TARGET, onResult })
    await fillSessionForm()
    const dialogEl = document.querySelector('[role="dialog"]') as HTMLElement
    const layoutBefore = layoutOf(dialogEl)

    await act(async () => { findButton('确认上传').click() })
    await flush()

    // 报错卡：标题 + 原因副文，是需确认卡
    const card = document.querySelector('[data-notice-ack][data-notice-tone="error"]')
    expect(card?.textContent).toContain('上传失败')
    expect(card?.textContent).toContain('清洗失败：检测到疑似泄漏内容')
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))

    // 弹窗不关、版面不随报错变（#167：报错内容不进弹窗，弹窗不出滚动条）
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(document.querySelector('[role="dialog"]')).toBe(dialogEl)
    expect(layoutOf(dialogEl)).toEqual(layoutBefore)
    expect(dialogEl.textContent).not.toContain('清洗失败')

    // 持久：静置 1 分钟仍在；唯一出口是「知道了」
    vi.useFakeTimers()
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect(document.querySelector('[data-notice-ack]')).toBeTruthy()
    await act(async () => { (document.querySelector('[data-notice-confirm]') as HTMLElement).click() })
    await act(async () => { vi.advanceTimersByTime(200) })
    expect(document.querySelector('[data-notice-ack]')).toBeNull()

    // 重试上下文不丢：表单值原样，可直接再传
    vi.useRealTimers()
    expect((document.querySelector('input[placeholder="必填：真实姓名或账号"]') as HTMLInputElement).value).toBe('张三')
    expect((document.querySelector('select') as HTMLSelectElement).value).toBe('hud-it')
    uploadResponder = () => json({ ok: true })
    await act(async () => { findButton('确认上传').click() })
    await flush()
    expect(onOpenChange).toHaveBeenCalledWith(false)
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

  it('④ run 上传带缺正文告警：需确认警示卡承载完整清单（持久），弹窗照常关闭', async () => {
    uploadResponder = () => json({ unchanged: false, sessionCount: 3, missingSessions: ['ses-a', 'ses-b'] })
    const onOpenChange = vi.fn()
    const onResult = vi.fn()
    await renderDialog({ open: true, onOpenChange, kind: 'run', target: { runId: 'run-hud-2', runName: 'HUD 告警' }, onResult })

    await fillSessionForm()
    await act(async () => { findButton('确认上传').click() })
    await flush()

    // 需确认的琥珀卡：标题带计数、副文说清含义、明细块逐行给出完整 sid 清单
    const card = document.querySelector('[data-notice-ack][data-notice-tone="warning"]')
    expect(card?.textContent).toContain(`已上传 3 个成员会话到 ${BAY_NAME}，2 个缺正文`)
    expect(card?.textContent).toContain('包内缺其正文')
    expect(card?.querySelector('span.bg-amber-500')).toBeTruthy()
    expect(card?.querySelector('[data-slot="notice-detail-text"]')?.textContent).toBe('ses-a\nses-b')
    expect(card?.textContent).toContain('缺正文的成员会话（2）')
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ ok: true }))

    // 弹窗照常关闭：清单不再堆进弹窗
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(document.querySelector('[role="dialog"]')?.textContent ?? '').not.toContain('ses-a')

    // 清单是必须读到的内容：静置 1 分钟仍在，须确认才离场
    vi.useFakeTimers()
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect(document.querySelector('[data-notice-ack]')).toBeTruthy()
    await act(async () => { (document.querySelector('[data-notice-confirm]') as HTMLElement).click() })
    await act(async () => { vi.advanceTimersByTime(200) })
    expect(document.querySelector('[data-notice-ack]')).toBeNull()
  })

  it('⑤ HUD 生命周期：瞬态到点退场/点击即收；报错持久须「知道了」确认', async () => {
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const r = root!
    await act(async () => {
      r.render(createElement(NoticeHudHost))
    })

    // 成功色调默认驻留 3200ms：期内可见，到点 + 退场动画（180ms）后消失
    act(() => { notifyNotice({ tone: 'success', title: 'T-success', description: 'D-success' }) })
    expect(container!.textContent).toContain('T-success')
    await act(async () => { vi.advanceTimersByTime(3300) })
    expect(container!.textContent).toContain('T-success') // 退场动画中仍占位
    await act(async () => { vi.advanceTimersByTime(200) })
    expect(container!.textContent).not.toContain('T-success')

    // 瞬态点击即收：不等驻留时长
    act(() => { notifyNotice({ tone: 'success', title: 'T-click', description: null }) })
    expect(container!.textContent).toContain('T-click')
    await act(async () => { (container!.querySelector('[data-notice-tone="success"]') as HTMLElement).click() })
    await act(async () => { vi.advanceTimersByTime(200) })
    expect(container!.textContent).not.toContain('T-click')

    // 瞬态同屏上限：连弹 5 张只留最近 3 张（更早的让位，不堆墙）
    act(() => {
      for (let i = 1; i <= 5; i++) notifyNotice({ tone: 'success', title: `T-cap-${i}`, description: null })
    })
    expect(container!.querySelectorAll('[data-notice-tone="success"]')).toHaveLength(3)
    // 退场走两拍：3200ms 驻留到期 → closing；+200ms 动画结束移除
    await act(async () => { vi.advanceTimersByTime(4000) })
    await act(async () => { vi.advanceTimersByTime(200) })
    expect(container!.querySelectorAll('[data-notice-tone="success"]')).toHaveLength(0)

    // 确认卡持久：推进 1 分钟仍在——失败原因不许超时蒸发。它是居中 Alert
    // （挂 body 传送门，盖在下层界面之上），不落在横幅列里
    act(() => { notifyError('T-error', 'D-error') })
    const ack = () => document.querySelector('[data-notice-ack][data-notice-tone="error"]')
    expect(ack()?.textContent).toContain('T-error')
    expect(ack()?.getAttribute('role')).toBe('alertdialog')
    expect(container!.querySelector('[data-notice-ack]')).toBeNull()
    // 焦点落位依赖真实浏览器焦点事件（happy-dom 不支持），在 e2e 里验
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect(ack()?.textContent).toContain('T-error')
    // 点卡片本体不关：唯一出口是「知道了」；焦点落在确认钮上
    await act(async () => { (ack() as HTMLElement).click() })
    expect(ack()).toBeTruthy()
    // 同文案报错合并计数：再弹收敛为同一张卡 ×2
    act(() => { notifyError('T-error', 'D-error') })
    expect(document.querySelectorAll('[data-notice-ack]')).toHaveLength(1)
    expect(ack()?.textContent).toContain('×2')
    // 异文案不合并：排队，同时只呈现一张——前一张确认后才轮到
    act(() => { notifyError('T-error-2', 'D-error-2') })
    expect(document.querySelectorAll('[data-notice-ack]')).toHaveLength(1)
    expect(document.body.textContent).not.toContain('T-error-2')
    await act(async () => { (document.querySelector('[data-notice-confirm]') as HTMLElement).click() })
    await act(async () => { vi.advanceTimersByTime(200) })
    expect(document.querySelector('[data-notice-ack] h2')?.textContent).toBe('T-error-2')
    await act(async () => { (document.querySelector('[data-notice-confirm]') as HTMLElement).click() })
    await act(async () => { vi.advanceTimersByTime(200) })
    expect(document.querySelector('[data-notice-ack]')).toBeNull()
  })

  it('⑥ 非法时间戳兜底：ISO 非法时回显原串、不渲染 NaN（上传描述时间线）', async () => {
    uploadResponder = () => json({ ok: true })
    const onOpenChange = vi.fn()
    // 非法 ISO 字符串（truthy）：`new Date` 不 throw、只产 Invalid Date——
    // 未兜底时 getMonth() 等得 NaN，拼出 "NaN/NaN NaN:NaN"
    await renderDialog({
      open: true,
      onOpenChange,
      kind: 'session',
      target: { ...SESSION_TARGET, startTime: 'not-a-date', endTime: '非法时间' },
    })
    await fillSessionForm()
    await act(async () => { findButton('确认上传').click() })
    await flush()

    const description = String(lastUploadBody?.description ?? '')
    // 兜底回显原串：时间线不含 NaN，提交描述保持可读
    expect(description).not.toContain('NaN')
    expect(description).toContain('not-a-date')
    expect(description).toContain('非法时间')
    // 成功路径不受影响（弹窗即关）
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('⑦ 长报错原文：首行作副文 + 全文进明细块，明细可整段复制；短句整体作副文', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    // 短句：不拆
    expect(splitErrorDetail('清洗失败：检测到疑似泄漏内容')).toEqual({ description: '清洗失败：检测到疑似泄漏内容', detail: null })
    expect(splitErrorDetail(null)).toEqual({ description: null, detail: null })
    // 超长单行：副文截断（带省略号），全文进明细
    const longLine = 'x'.repeat(200)
    const splitLong = splitErrorDetail(longLine)
    expect(splitLong.description).toBe(`${'x'.repeat(79)}…`)
    expect(splitLong.detail).toBe(longLine)

    // 多行报错（服务端堆栈 / 逐条拒绝原因）走真实上传失败路径
    const multiline = ['敏感信息清洗未通过，以下 3 处拒绝上传：', '  L12: 疑似密钥 sk-****', '  L48: 内网地址 10.0.0.1', '  L90: 身份证号 110***********1234'].join('\n')
    uploadResponder = () => json({ error: multiline }, 500)
    await renderDialog({ open: true, onOpenChange: vi.fn(), kind: 'session', target: SESSION_TARGET })
    await fillSessionForm()
    await act(async () => { findButton('确认上传').click() })
    await flush()

    const card = document.querySelector<HTMLElement>('[data-notice-ack][data-notice-tone="error"]')!
    // 副文只有首行；全文逐字进明细块，一处不丢
    expect(Array.from(card.querySelectorAll('p')).map(p => p.textContent)).toContain('敏感信息清洗未通过，以下 3 处拒绝上传：')
    expect(card.querySelector('[data-slot="notice-detail-text"]')?.textContent).toBe(multiline)
    expect(card.textContent).toContain('明细 · 4 行')
    // 弹窗里一个字的报错都没有
    expect(document.querySelector('[role="dialog"]')?.textContent ?? '').not.toContain('拒绝上传')

    // 交互：整段复制（拿到的是全文，不是首行副文），按钮回「已复制」
    const copyButton = card.querySelector<HTMLElement>('[data-notice-copy]')!
    expect(copyButton.textContent).toBe('复制')
    vi.useFakeTimers()
    await act(async () => { copyButton.click() })
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText.mock.calls[0]![0]).toBe(multiline)
    expect(copyButton.textContent).toBe('已复制')
    // 回执 1.6s 后复原
    await act(async () => { vi.advanceTimersByTime(1700) })
    expect(copyButton.textContent).toBe('复制')
  })

  it('⑧ 原生会话同步：上传失败 = 需确认警示卡（报错内容不许一闪而过）；未找到 = 瞬态确认', async () => {
    let attempt = 0
    uploadResponder = () => {
      attempt += 1
      return attempt === 1
        ? json({ ok: true, native: { status: 'failed', reason: '远端拒绝：凭据只读' } })
        : json({ ok: true, native: { status: 'not-found', reason: '本机没有对应记录' } })
    }
    const proxyTarget = { ...SESSION_TARGET, framework: 'claude-code-proxy' }
    await renderDialog({ open: true, onOpenChange: vi.fn(), kind: 'session', target: proxyTarget })
    await act(async () => { (document.querySelector('[role="checkbox"]') as HTMLElement).click() })
    await flush()
    await fillSessionForm()
    await act(async () => { findButton('确认上传').click() })
    await flush()

    const failed = document.querySelector('[data-notice-ack][data-notice-tone="warning"]')
    expect(failed?.textContent).toContain('原生会话上传失败')
    expect(failed?.textContent).toContain('远端拒绝：凭据只读')

    // 未找到 = 上传前预检已提示过的预期结果，不是报错：瞬态确认（自动退场）
    act(() => { dismissAllNotices() })
    await unmountRendered()
    await renderDialog({ open: true, onOpenChange: vi.fn(), kind: 'session', target: proxyTarget })
    await fillSessionForm()
    await act(async () => { findButton('确认上传').click() })
    await flush()
    const transient = container!.querySelector('[data-notice-tone="success"]:not([data-notice-ack])')
    expect(transient?.textContent).toContain(`已上传到 ${BAY_NAME}`)
    expect(transient?.textContent).toContain('原生会话未找到：本机没有对应记录')
    expect(document.querySelector('[data-notice-ack]')).toBeNull()
  })

  it('⑨ 明细块：长清单在块内滚动（容器带高度上限与滚动约束），60 条全呈现', async () => {
    const sids = Array.from({ length: 60 }, (_, i) => `ses-${String(i).padStart(4, '0')}`)
    uploadResponder = () => json({ unchanged: false, sessionCount: 2, missingSessions: sids })
    await renderDialog({ open: true, onOpenChange: vi.fn(), kind: 'run', target: { runId: 'run-hud-9', runName: '清单' } })
    await fillSessionForm()
    await act(async () => { findButton('确认上传').click() })
    await flush()

    const detailText = document.querySelector<HTMLElement>('[data-slot="notice-detail-text"]')!
    expect(detailText.textContent).toBe(sids.join('\n'))
    expect(detailText.className).toMatch(/max-h-\[/)
    expect(detailText.className).toMatch(/overflow-y-auto/)
    expect(detailText.className).toMatch(/select-text/)
    // 60 条全部呈现，不截断、不折叠成「等 N 个」
    expect(document.querySelector('[data-notice-ack]')?.textContent).toContain('缺正文的成员会话（60）')
  });
});

/** 弹窗版面指纹：直接子块的槽位序列（#167 的反面——报错不该往弹窗里加块） */
function layoutOf(dialog: HTMLElement): string[] {
  return Array.from(dialog.children).map(el => `${el.tagName.toLowerCase()}:${el.getAttribute('data-slot') ?? ''}`)
}
