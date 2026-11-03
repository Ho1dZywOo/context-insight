// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

'use client'

// 上传结果 HUD（顶置瞬态确认，毛玻璃 + 弹簧弹入）：
// 上传到远端后的结果时刻——成功（绿勾）/警示（琥珀，有缺正文等软告警）/
// 失败（红叉，驻留更长可读）统一经 notifyUploadResult 弹出，任何上传面
// （上传弹窗 / 列表行 / 导出查看器）单点触发、全路径一致，不再依赖调用方
// 各自接反馈。动画只走 transform/opacity（合成器友好），prefers-reduced-motion
// 下退化为无位移淡入淡出；点击卡片即关。

import { useEffect, useState, useSyncExternalStore } from 'react'
import { CheckIcon, TriangleAlertIcon, XIcon } from 'lucide-react'

export type UploadHudTone = 'success' | 'warning' | 'error'

export interface NotifyUploadResultInput {
  ok: boolean
  title: string
  /** 副文（白话详情）：错误原因 / 原生会话同步结果 / 缺正文告警摘要 */
  description?: string | null
  /** 显式覆盖色调（默认按 ok 推导：成功绿 / 失败红） */
  tone?: UploadHudTone
  /** 显式覆盖驻留时长（默认按色调） */
  durationMs?: number
}

interface UploadHudNotice {
  id: number
  tone: UploadHudTone
  title: string
  description: string | null
  durationMs: number
}

// 驻留时长：成功一瞥即走；警示/失败留足阅读（可点击提前关）
const TONE_DURATION: Record<UploadHudTone, number> = {
  success: 3200,
  warning: 6400,
  error: 5600,
}

// 同屏最多 3 张：更早的让位（连续上传/批量失败也不会堆墙）
const MAX_VISIBLE = 3

let nextId = 1
let notices: UploadHudNotice[] = []
const listeners = new Set<() => void>()

function emit(): void {
  for (const fn of listeners) fn()
}

/** 弹出一张上传结果 HUD（唯一入口）：返回 id 供主动收回 */
export function notifyUploadResult(input: NotifyUploadResultInput): number {
  const tone = input.tone ?? (input.ok ? 'success' : 'error')
  const notice: UploadHudNotice = {
    id: nextId++,
    tone,
    title: input.title,
    description: input.description ?? null,
    durationMs: input.durationMs ?? TONE_DURATION[tone],
  }
  notices = [...notices, notice].slice(-MAX_VISIBLE)
  emit()
  return notice.id
}

/** 收回一张（退场动画由卡片自完成，这里只做落删） */
export function dismissUploadHud(id: number): void {
  if (!notices.some(n => n.id === id)) return
  notices = notices.filter(n => n.id !== id)
  emit()
}

/** 清空全部（测试隔离 / 路由切换收尾用） */
export function dismissAllUploadHuds(): void {
  if (notices.length === 0) return
  notices = []
  emit()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

function getSnapshot(): UploadHudNotice[] {
  return notices
}

// SSR/水合首帧快照：服务端无弹出态，恒空数组（引用稳定，水合与客户端首帧一致）
const EMPTY_NOTICES: UploadHudNotice[] = []

/** HUD 挂载点：一个表面挂一次（app layout + 导出 bundle entry 各一） */
export function UploadHudHost() {
  const current = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_NOTICES)
  if (current.length === 0) return null
  return (
    <div className="pointer-events-none fixed inset-x-0 top-4 z-[70] flex flex-col items-center gap-2">
      {current.map(n => <UploadHudCard key={n.id} notice={n} />)}
    </div>
  )
}

const TONE_META: Record<UploadHudTone, { icon: typeof CheckIcon; badge: string }> = {
  success: { icon: CheckIcon, badge: 'bg-emerald-500' },
  warning: { icon: TriangleAlertIcon, badge: 'bg-amber-500' },
  error: { icon: XIcon, badge: 'bg-red-500' },
}

function UploadHudCard({ notice }: { notice: UploadHudNotice }) {
  const [closing, setClosing] = useState(false)
  const { icon: Icon, badge } = TONE_META[notice.tone]

  // 到点先转退场态（transition 播出），再真删——删早了退场动画会被掐
  useEffect(() => {
    const t = setTimeout(() => setClosing(true), notice.durationMs)
    return () => clearTimeout(t)
  }, [notice.durationMs])
  useEffect(() => {
    if (!closing) return
    const t = setTimeout(() => dismissUploadHud(notice.id), 180)
    return () => clearTimeout(t)
  }, [closing, notice.id])

  return (
    <div
      role="status"
      title="点击关闭"
      className={
        'hud-card pointer-events-auto flex w-[min(26rem,calc(100vw-2rem))] cursor-pointer select-none items-start gap-3 rounded-[22px] bg-white/75 px-4 py-3 ring-1 ring-black/[0.07] shadow-[0_10px_36px_-10px_rgb(0_0_0/0.22),0_2px_10px_-4px_rgb(0_0_0/0.08)] backdrop-blur-2xl backdrop-saturate-150 transition-[opacity,transform] duration-150 ease-out will-change-transform dark:bg-zinc-900/70 dark:ring-white/10 ' +
        (closing ? 'translate-y-[-6px] scale-[0.98] opacity-0' : 'hud-enter')
      }
      onClick={() => setClosing(true)}
    >
      <span className={`hud-icon-pop grid size-7 shrink-0 place-items-center rounded-full text-white ${badge}`}>
        <Icon className="size-3.5" strokeWidth={2.5} />
      </span>
      <div className="min-w-0 flex-1 pt-px">
        <p className="truncate text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">{notice.title}</p>
        {notice.description && (
          <p className="mt-0.5 line-clamp-2 break-words text-xs leading-4 text-zinc-500 dark:text-zinc-400">{notice.description}</p>
        )}
      </div>
    </div>
  )
}
