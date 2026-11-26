// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.


'use client'

// 通知系统（iOS 系统画风，合成器友好动效）——全站统一的结果通知面，按「用户
// 要不要对此负责」二分，两种形态各司其职：
//   - 瞬态卡（success / warning 缺省）= 顶部横幅：到点自动退场、点击即收、
//     同屏至多 3 张，更早的让位——连续成功/告警不堆墙；
//   - 需确认卡（error 恒是；带必须读到的明细的警示可显式标 ack）= 居中
//     Alert：盖在当前界面之上，不自动消失，点遮罩 / Esc / 卡片本体都不关，
//     只有「知道了」能让它离场——原因和明细用户必须有机会读到，不允许静默
//     挤掉或超时蒸发。同时只呈现一张，其余排队；卡片自带明细块：长内容在
//     块内滚动、可整段复制；同文案报错合并为一张卡 + 计数，报错风暴不刷屏。
// 版面分工（issue #167）：需确认卡是「变长内容」的唯一去处——弹窗、面板等
// 表单面保持版面固定，不靠自身出滚动条收纳结果明细。
// 调用方：notifyNotice / notifyError（模块级单例，任何客户端组件直接调，
// 无需 context/prop 链）。挂载：NoticeHudHost，app layout 与导出 bundle
// entry 各挂一次。动画只走 transform/opacity（globals.css hud-* / ack-* 段），
// prefers-reduced-motion 下退化为纯淡入淡出。

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { CheckIcon, TriangleAlertIcon, XIcon } from 'lucide-react'

export type NoticeTone = 'success' | 'warning' | 'error'

export interface NoticeInput {
  tone: NoticeTone
  title: string
  /** 副文（白话概要）：一句话说清发生了什么 */
  description?: string | null
  /** 需确认：转为居中确认卡（不自动退场、须点「知道了」）；error 恒需确认 */
  ack?: boolean
  /** 明细全文（仅确认卡渲染）：清单 / 长报错原文，块内可滚、可复制 */
  detail?: string | null
  /** 明细块的引导语，如「缺正文的成员会话」；缺省显示「明细」 */
  detailLabel?: string | null
  /** 瞬态驻留时长覆写（确认卡不排退场定时器，忽略本字段） */
  durationMs?: number
}

export interface HudNotice {
  id: number
  tone: NoticeTone
  title: string
  description: string | null
  detail: string | null
  detailLabel: string | null
  /** 需确认：不排自动退场，唯一出口是「知道了」 */
  ack: boolean
  /** 驻留时长；确认卡为 Infinity 语义 */
  durationMs: number
  /** 同文案合并计数（确认卡专用，展示 ×N） */
  count: number
}

// 驻留时长：成功一瞥即走；警示留足阅读（均可点击提前收）；确认卡持久
const TONE_DURATION: Record<NoticeTone, number> = {
  success: 3200,
  warning: 6400,
  error: Number.POSITIVE_INFINITY,
}

// 瞬态同屏上限：更早的让位；确认卡不参与（只能经用户确认离场）
const MAX_TRANSIENT = 3

// 报错原文作副文的上限：单行且不超长直接作副文，否则首行作副文 + 全文进明细块
const SUMMARY_MAX = 80

// 确认卡离场动效时长（globals.css ack-out），到点才真正移除
export const ACK_EXIT_MS = 160

let nextId = 1
let notices: HudNotice[] = []
const listeners = new Set<() => void>()

function emit(): void {
  for (const fn of listeners) fn()
}

/** 报错原文 → 卡片版面：短句整体作副文；多行或超长时首行（截断）作副文，
 *  全文不丢——进明细块 */
export function splitErrorDetail(message?: string | null): { description: string | null; detail: string | null } {
  const text = message?.trim() || null
  if (!text) return { description: null, detail: null }
  if (!text.includes('\n') && text.length <= SUMMARY_MAX) return { description: text, detail: null }
  const firstLine = text.split('\n').find(line => line.trim())?.trim() ?? ''
  return {
    description: firstLine.length > SUMMARY_MAX ? `${firstLine.slice(0, SUMMARY_MAX - 1)}…` : firstLine,
    detail: text,
  }
}

/** 弹出一张通知（语义见文件头；同文案确认卡合并计数） */
export function notifyNotice(input: NoticeInput): number {
  const ack = input.tone === 'error' || input.ack === true
  const description = input.description?.trim() || null
  const detail = ack ? input.detail?.trim() || null : null
  if (ack) {
    // 同文案合并：批量失败风暴收敛为一张卡 + 计数
    const existing = notices.find(
      n => n.ack && n.tone === input.tone && n.title === input.title
        && n.description === description && n.detail === detail,
    )
    if (existing) {
      notices = notices.map(n => (n.id === existing.id ? { ...n, count: n.count + 1 } : n))
      emit()
      return existing.id
    }
  }
  const notice: HudNotice = {
    id: nextId++,
    tone: input.tone,
    title: input.title,
    description,
    detail,
    detailLabel: detail ? input.detailLabel?.trim() || null : null,
    ack,
    durationMs: ack ? Number.POSITIVE_INFINITY : input.durationMs ?? TONE_DURATION[input.tone],
    count: 1,
  }
  if (ack) {
    notices = [...notices, notice]
  } else {
    // 瞬态限流：确认卡全保留 + 瞬态只留最近 MAX_TRANSIENT 张
    notices = [...notices.filter(n => n.ack), ...[...notices.filter(n => !n.ack), notice].slice(-MAX_TRANSIENT)]
  }
  emit()
  return notice.id
}

/** 弹出报错确认卡：message 是报错原文——短句作副文，长文/多行自动拆成
 *  「首行副文 + 全文明细」；必须点「知道了」确认后消失 */
export function notifyError(title: string, message?: string | null): number {
  const { description, detail } = splitErrorDetail(message)
  return notifyNotice({ tone: 'error', title, description, detail })
}

/** 主动收回（瞬态提前关 / 测试隔离用） */
export function dismissNotice(id: number): void {
  if (!notices.some(n => n.id === id)) return
  notices = notices.filter(n => n.id !== id)
  emit()
}

/** 清空全部（测试隔离 / 路由切换收尾用） */
export function dismissAllNotices(): void {
  if (notices.length === 0) return
  notices = []
  emit()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

function getSnapshot(): HudNotice[] {
  return notices
}

// SSR/水合首帧快照：服务端无弹出态，恒空数组（引用稳定，水合与客户端首帧一致）
const EMPTY_NOTICES: HudNotice[] = []

/** 挂载点：一个表面挂一次（app layout + 导出 bundle entry 各一） */
export function NoticeHudHost() {
  const current = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_NOTICES)
  const transients = current.filter(n => !n.ack)
  const ack = current.find(n => n.ack) ?? null
  return (
    <>
      {transients.length > 0 && (
        // 外层 pointer-events-none：整条顶带不挡页面交互；pointer-events-auto
        // 收窄到卡片区列
        <div className="pointer-events-none fixed inset-x-0 top-4 z-[70] flex justify-center">
          <div className="pointer-events-auto flex w-[min(26rem,calc(100vw-2rem))] flex-col gap-2">
            {transients.map(n => (
              <TransientCard key={n.id} notice={n} />
            ))}
          </div>
        </div>
      )}
      {ack && <AckAlert key={ack.id} notice={ack} />}
    </>
  )
}

const TONE_META: Record<NoticeTone, { icon: typeof CheckIcon; badge: string }> = {
  success: { icon: CheckIcon, badge: 'bg-emerald-500' },
  warning: { icon: TriangleAlertIcon, badge: 'bg-amber-500' },
  error: { icon: XIcon, badge: 'bg-red-500' },
}

function CountBadge({ count }: { count: number }) {
  if (count <= 1) return null
  return (
    <span className="ml-1.5 inline-block align-[2px] rounded-full bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-red-600 dark:bg-red-500/15 dark:text-red-400">
      ×{count}
    </span>
  )
}

/** 明细块：引导语 + 行数 / 复制；全文可滚、可选中，滚动只发生在块内 */
export function NoticeDetail({ label, text }: { label: string | null; text: string }) {
  const [copied, setCopied] = useState(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lines = text.split('\n').length

  useEffect(() => () => { if (resetTimer.current) clearTimeout(resetTimer.current) }, [])

  function copy(): void {
    const writing = globalThis.navigator?.clipboard?.writeText?.(text)
    if (!writing) return
    void writing.then(() => {
      setCopied(true)
      if (resetTimer.current) clearTimeout(resetTimer.current)
      resetTimer.current = setTimeout(() => setCopied(false), 1600)
    }).catch(() => { /* 剪贴板不可用（非安全上下文 / 被拒）：保持「复制」不谎报 */ })
  }

  return (
    <div
      data-slot="notice-detail"
      className="mt-3 overflow-hidden rounded-xl bg-black/[0.045] text-left ring-1 ring-black/[0.05] dark:bg-white/[0.07] dark:ring-white/[0.08]"
    >
      <div className="flex items-center justify-between gap-2 px-3 pt-1.5">
        <span className="truncate text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
          {label ? `${label}（${lines}）` : `明细 · ${lines} 行`}
        </span>
        <button
          type="button"
          data-notice-copy=""
          className="shrink-0 cursor-pointer text-[11px] font-medium text-blue-600 transition-opacity active:opacity-50 dark:text-blue-400"
          onClick={copy}
        >
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre
        data-slot="notice-detail-text"
        className="max-h-[min(30dvh,16rem)] select-text overflow-y-auto whitespace-pre-wrap break-words px-3 pb-2 pt-0.5 font-mono text-[11px] leading-[18px] text-zinc-700 dark:text-zinc-300"
      >
        {text}
      </pre>
    </div>
  )
}

/** 瞬态横幅：点击即收、到点自退 */
function TransientCard({ notice }: { notice: HudNotice }) {
  const [closing, setClosing] = useState(false)
  const { icon: Icon, badge } = TONE_META[notice.tone]

  useEffect(() => {
    if (!Number.isFinite(notice.durationMs)) return
    const t = setTimeout(() => setClosing(true), notice.durationMs)
    return () => clearTimeout(t)
  }, [notice.durationMs])

  useEffect(() => {
    if (!closing) return
    const t = setTimeout(() => dismissNotice(notice.id), 180)
    return () => clearTimeout(t)
  }, [closing, notice.id])

  return (
    <div
      role="status"
      data-notice-tone={notice.tone}
      title="点击关闭"
      className={
        'hud-card pointer-events-auto w-full select-none rounded-[22px] bg-white/75 px-4 py-3 ring-1 ring-black/[0.07] shadow-[0_10px_36px_-10px_rgb(0_0_0/0.22),0_2px_10px_-4px_rgb(0_0_0/0.08)] backdrop-blur-2xl backdrop-saturate-150 transition-[opacity,transform] duration-150 ease-out will-change-transform dark:bg-zinc-900/70 dark:ring-white/10 '
        + (closing ? 'cursor-default translate-y-[-6px] scale-[0.98] opacity-0' : 'hud-enter cursor-pointer')
      }
      onClick={() => setClosing(true)}
    >
      <div className="flex items-start gap-3">
        <span className={`hud-icon-pop grid size-7 shrink-0 place-items-center rounded-full text-white ${badge}`}>
          <Icon className="size-3.5" strokeWidth={2.5} />
        </span>
        <div className="min-w-0 flex-1 pt-px">
          <p className="truncate text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            {notice.title}
          </p>
          {notice.description && (
            <p className="mt-0.5 line-clamp-2 break-words text-xs leading-4 text-zinc-500 dark:text-zinc-400">
              {notice.description}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

/** 确认卡（居中 Alert，iOS 提示画风）：模态——盖住下层界面与弹窗，焦点落在
 *  「知道了」；受控 open 且不接 onOpenChange，遮罩点击与 Esc 关不掉 */
function AckAlert({ notice }: { notice: HudNotice }) {
  const [closing, setClosing] = useState(false)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const { icon: Icon, badge } = TONE_META[notice.tone]

  useEffect(() => {
    if (!closing) return
    const t = setTimeout(() => dismissNotice(notice.id), ACK_EXIT_MS)
    return () => clearTimeout(t)
  }, [closing, notice.id])

  return (
    <DialogPrimitive.Root open modal>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop
          data-slot="notice-ack-backdrop"
          className={`fixed inset-0 z-[80] bg-black/25 dark:bg-black/45 ${closing ? 'notice-ack-backdrop-exit' : 'notice-ack-backdrop-enter'}`}
        />
        <DialogPrimitive.Popup
          role="alertdialog"
          data-slot="notice-ack"
          data-notice-ack=""
          data-notice-tone={notice.tone}
          initialFocus={confirmRef}
          className={`fixed top-1/2 left-1/2 z-[80] w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[24px] bg-white/85 p-5 text-center shadow-[0_24px_70px_-18px_rgb(0_0_0/0.45),0_6px_22px_-10px_rgb(0_0_0/0.25)] ring-1 ring-black/[0.06] outline-none backdrop-blur-2xl backdrop-saturate-150 dark:bg-zinc-900/85 dark:ring-white/10 ${closing ? 'notice-ack-exit' : 'notice-ack-enter'}`}
        >
          <span className={`hud-icon-pop mx-auto grid size-10 place-items-center rounded-full text-white ${badge}`}>
            <Icon className="size-5" strokeWidth={2.5} />
          </span>
          <DialogPrimitive.Title className="mt-3 text-[15px] leading-5 font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            {notice.title}
            <CountBadge count={notice.count} />
          </DialogPrimitive.Title>
          {notice.description && (
            <DialogPrimitive.Description className="mt-1 text-[13px] leading-5 break-words text-zinc-500 dark:text-zinc-400">
              {notice.description}
            </DialogPrimitive.Description>
          )}
          {notice.detail && <NoticeDetail label={notice.detailLabel} text={notice.detail} />}
          <div className="-mx-5 mt-4 border-t border-black/[0.08] dark:border-white/10">
            <button
              ref={confirmRef}
              type="button"
              data-notice-confirm=""
              className="w-full cursor-pointer py-2.5 text-[15px] font-semibold text-blue-600 transition-colors outline-none select-none focus-visible:bg-blue-500/[0.08] active:bg-black/[0.06] dark:text-blue-400 dark:active:bg-white/10"
              onClick={() => setClosing(true)}
            >
              知道了
            </button>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
