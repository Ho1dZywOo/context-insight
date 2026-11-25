// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

'use client'

// 通知 HUD（顶置卡片，iOS 通知画风：毛玻璃胶囊 + 弹簧弹入 + 合成器友好
// 动效）——全站统一的结果通知面，语义按色调二分：
//   - success / warning：瞬态确认（到点自动退场、点击即收、同屏至多 3 张，
//     更早的让位——连续成功/告警不堆墙）；
//   - error：持久报错卡（不自动消失、点卡片本体不关，必须按「知道了」确认
//     后才离场——报错的原因用户必须有机会读到，不允许静默挤掉或超时蒸发；
//     同文案报错合并为一张卡 + ×N 计数，报错风暴也不刷屏；不参与同屏上限）。
// 调用方：notifyNotice / notifyError（模块级单例，任何客户端组件直接调，
// 无需 context/prop 链）。挂载：NoticeHudHost，app layout 与导出 bundle
// entry 各挂一次。动画只走 transform/opacity（合成器友好），
// prefers-reduced-motion 下退化为无位移淡入淡出（globals.css hud-* 段）。

import { useEffect, useState, useSyncExternalStore } from 'react'
import { CheckIcon, TriangleAlertIcon, XIcon } from 'lucide-react'

export type NoticeTone = 'success' | 'warning' | 'error'

export interface NoticeInput {
  tone: NoticeTone
  title: string
  /** 副文（白话详情）：错误原因 / 软告警摘要等 */
  description?: string | null
  /** 瞬态驻留时长覆写（error 恒持久，忽略本字段） */
  durationMs?: number
}

interface HudNotice {
  id: number
  tone: NoticeTone
  title: string
  description: string | null
  /** 瞬态驻留时长；error 为 Infinity 语义（不排自动退场定时器） */
  durationMs: number
  /** 同文案报错合并计数（error 专用，展示 ×N） */
  count: number
}

// 驻留时长：成功一瞥即走；警示留足阅读（均可点击提前收）；报错持久
const TONE_DURATION: Record<NoticeTone, number> = {
  success: 3200,
  warning: 6400,
  error: Number.POSITIVE_INFINITY,
}

// 瞬态同屏上限：更早的让位；error 不参与（报错只能经用户确认离场）
const MAX_TRANSIENT = 3

let nextId = 1
let notices: HudNotice[] = []
const listeners = new Set<() => void>()

function emit(): void {
  for (const fn of listeners) fn()
}

/** 弹出一张通知（语义见文件头；同文案 error 合并计数） */
export function notifyNotice(input: NoticeInput): number {
  if (input.tone === 'error') {
    // 同文案报错合并：批量失败风暴收敛为一张卡 + 计数
    const existing = notices.find(
      n => n.tone === 'error' && n.title === input.title && n.description === (input.description ?? null),
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
    description: input.description ?? null,
    durationMs: input.durationMs ?? TONE_DURATION[input.tone],
    count: 1,
  }
  if (notice.tone === 'error') {
    notices = [...notices, notice]
  } else {
    // 瞬态限流：error 全保留 + 瞬态只留最近 MAX_TRANSIENT 张
    const errors = notices.filter(n => n.tone === 'error')
    const transients = [...notices.filter(n => n.tone !== 'error'), notice]
    notices = [...errors, ...transients.slice(-MAX_TRANSIENT)]
  }
  emit()
  return notice.id
}

/** 弹出持久报错卡（error 语义词）：必须点「知道了」确认后消失 */
export function notifyError(title: string, description?: string | null): number {
  return notifyNotice({ tone: 'error', title, description })
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

/** HUD 挂载点：一个表面挂一次（app layout + 导出 bundle entry 各一） */
export function NoticeHudHost() {
  const current = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_NOTICES)
  if (current.length === 0) return null
  return (
    // 外层 pointer-events-none：整条顶带不挡页面交互；pointer-events-auto
    // 收窄到卡片区列——报错卡无同屏上限，堆超高时该列自身可滚
    <div className="pointer-events-none fixed inset-x-0 top-4 z-[70] flex justify-center">
      <div className="pointer-events-auto flex max-h-[calc(100dvh-2rem)] w-[min(26rem,calc(100vw-2rem))] flex-col gap-2 overflow-y-auto">
        {current.map(n => (
          <NoticeHudCard key={n.id} notice={n} />
        ))}
      </div>
    </div>
  )
}

const TONE_META: Record<NoticeTone, { icon: typeof CheckIcon; badge: string }> = {
  success: { icon: CheckIcon, badge: 'bg-emerald-500' },
  warning: { icon: TriangleAlertIcon, badge: 'bg-amber-500' },
  error: { icon: XIcon, badge: 'bg-red-500' },
}

function NoticeHudCard({ notice }: { notice: HudNotice }) {
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

  const cardBase =
    'hud-card pointer-events-auto w-full select-none rounded-[22px] bg-white/75 ring-1 ring-black/[0.07] shadow-[0_10px_36px_-10px_rgb(0_0_0/0.22),0_2px_10px_-4px_rgb(0_0_0/0.08)] backdrop-blur-2xl backdrop-saturate-150 transition-[opacity,transform] duration-150 ease-out will-change-transform dark:bg-zinc-900/70 dark:ring-white/10 '
  const cardState = closing ? 'translate-y-[-6px] scale-[0.98] opacity-0' : 'hud-enter'

  // error：持久报错卡——点卡片本体不关，只有「知道了」能让它离场（iOS 提示
  // 风格的通栏确认钮：发丝线分隔、按压变暗）；role=alert 触发屏幕阅读器播报
  if (notice.tone === 'error') {
    return (
      <div role="alert" data-notice-tone="error" className={cardBase + cardState}>
        <div className="flex items-start gap-3 px-4 pt-3">
          <span className={`hud-icon-pop grid size-7 shrink-0 place-items-center rounded-full text-white ${badge}`}>
            <Icon className="size-3.5" strokeWidth={2.5} />
          </span>
          <div className="min-w-0 flex-1 pt-px">
            <p className="flex items-center gap-1.5 text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              <span className="truncate">{notice.title}</span>
              {notice.count > 1 && (
                <span className="shrink-0 rounded-full bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-600 dark:text-red-400">
                  ×{notice.count}
                </span>
              )}
            </p>
            {notice.description && (
              // 报错副文不截断：持久卡就是给用户读清原因的，clamp 会丢信息
              <p className="mt-0.5 break-words text-xs leading-4 text-zinc-500 dark:text-zinc-400">{notice.description}</p>
            )}
          </div>
        </div>
        <button
          type="button"
          data-notice-confirm=""
          className="mt-2.5 w-full cursor-pointer rounded-b-[22px] border-t border-black/[0.06] py-2 text-sm font-medium text-zinc-700 active:opacity-50 dark:border-white/10 dark:text-zinc-200"
          onClick={() => setClosing(true)}
        >
          知道了
        </button>
      </div>
    )
  }

  // success / warning：瞬态确认——点击即收、到点自退
  return (
    <div
      role="status"
      data-notice-tone={notice.tone}
      title="点击关闭"
      className={cardBase + 'cursor-pointer px-4 py-3 ' + cardState}
      onClick={() => setClosing(true)}
    >
      <div className="flex items-start gap-3">
        <span className={`hud-icon-pop grid size-7 shrink-0 place-items-center rounded-full text-white ${badge}`}>
          <Icon className="size-3.5" strokeWidth={2.5} />
        </span>
        <div className="min-w-0 flex-1 pt-px">
          <p className="truncate text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">{notice.title}</p>
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
