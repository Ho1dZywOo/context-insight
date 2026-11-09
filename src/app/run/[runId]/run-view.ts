// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Run 详情页视图状态层（state 权威 + URL 镜像）。回退语义的单一真相 =
// 「条目栈」，按宿主双实现：
// - live 页面（Next 宿主）：条目栈 = 浏览器历史。navigate 每个工作台动作
//   pushState 一个真实条目（Next ≥14.1 官方集成：改 URL 不触发导航/重渲，
//   useSearchParams 照常同步），条目 state 携带 runNavSeq（序号，0 = 进入
//   本页的首个条目）与 runView（完整视图态——结构化克隆安全，刷新后仍在）。
//   鼠标侧键 / 浏览器返回钮 / 工作台 chrome 返回钮（history.back）三键
//   同一出口：popstate 读条目 state 恢复视图，逐步回退工作台动作；前进键
//   同理重放（此前内存栈无前进概念）。URL 是可分享的镜像（?tab=/?member=/
//   ?turn=/?q=），恢复不依赖 URL 解析（仅无标条目兜底）——避免任何环境
//   的 location 时序差。
// - 离线导出（file:// 宿主）：pushState 对 origin null 抛 SecurityError——
//   mount 探测落空即降级内存栈（navigate 前值入栈 / goBack 弹出恢复，
//   离线返回钮的现状语义原样保留；离线无真实地址栏，URL 本就不镜像）。
// 两种模式下 select（tab 内调整）恒不入栈；同值 navigate 是 no-op 不产生
// 条目。维度差异：run 有 member（成员钻取）与 turn 深链（turnId 全局
// 唯一）。KNOWN_RUN_TABS 是全量 tab 键值域（深链/恢复合法值），页面渲染
// 表按刀次长全——未交付的 tab 键合法但不渲染。

import { useCallback, useEffect, useRef, useState } from "react"
import { useSearchParams } from "next/navigation"

export type RunTabKey =
  | "overview"
  | "graph"
  | "turns"
  | "context"
  | "audit"
  | "perf"
  | "skills"
  | "files"
  | "wire"
  | "replay"
  | "score"

export const KNOWN_RUN_TABS: readonly RunTabKey[] = [
  "overview",
  "graph",
  "turns",
  "context",
  "audit",
  "perf",
  "skills",
  "files",
  "wire",
  "replay",
  "score",
]

export const DEFAULT_RUN_TAB: RunTabKey = "overview"

export function isKnownRunTab(v: string | null | undefined): v is RunTabKey {
  return v != null && (KNOWN_RUN_TABS as readonly string[]).includes(v)
}

/** 退役 tab 深链别名：Trace 已并入 Turns（跨成员搜索驻留 Turns 左列）——
 *  旧链接落到等价视图，不落默认页 */
const RETIRED_TAB_ALIAS: Record<string, RunTabKey> = { trace: "turns" };

function normalizeTabParam(v: string | null): RunTabKey | null {
  if (v == null) return null;
  if (RETIRED_TAB_ALIAS[v]) return RETIRED_TAB_ALIAS[v];
  return isKnownRunTab(v) ? v : null;
}

/** 视图状态。tab / member / turn / q 进 URL 镜像（?tab= / ?member= / ?turn= / ?q=） */
export type RunView = {
  tab: RunTabKey
  /** 成员钻取态（刀G：观测 tab 恒为全成员融合无过滤，member 仅 Audit 的
   *  skill 审计执行目标——审计正文须从具体成员会话源文件恢复；URL ?member= 镜像源） */
  member: string | null
  /** 选中轮次（TurnDetail 深钻；URL ?turn= 的镜像源，turnId 全局唯一） */
  turnId: string | null
  /** Turns 搜索预填（一次性深链令牌：Perf 工具耗时卡等下钻入口用搜索语法
   *  直达命中索引——Turns 消费即驻留自身搜索态，view.q 保留原值仅作 URL
   *  ?q= 的镜像源，刷新/分享重开同链重放；URL ?q= 镜像源） */
  q: string | null
}

/** 跳转补丁：「去某处看」。真变更时入条目栈（live = pushState 真实历史
 *  条目 / 离线 = 内存栈）。字段语义：undefined = 不动；显式 null = 清态 */
export type RunNavigatePatch = {
  tab?: RunTabKey
  member?: string | null
  turnId?: string | null
  q?: string | null
}

/** 选中补丁：「tab 内调整」。纯 state，URL 不动、不入条目栈 */
export type RunSelectPatch = {
  member?: string | null
  turnId?: string | null
  q?: string | null
}

/** 工作台盖在 history.state 上的标记（spread 保留 Next 自己的 state 键）：
 *  runNavSeq = 条目序号（0 = 进入本页的首个条目，canBack 的可达性真相）；
 *  runView = 该条目的完整视图态（四字段纯 string|null，结构化克隆安全，
 *  刷新后仍在——popstate 恢复不依赖 URL 解析） */
interface RunNavState {
  runNavSeq?: number
  runView?: RunView
}

/** 条目栈实现模式：history（live 浏览器历史）| memory（离线降级栈） */
type StackMode = "history" | "memory"

const OWNED_URL_KEYS = ["tab", "member", "turn", "q"] as const

function readNavState(): RunNavState {
  return (window.history.state ?? {}) as RunNavState
}

function readSeq(): number {
  const seq = readNavState().runNavSeq
  return typeof seq === "number" ? seq : 0
}

function sameView(a: RunView, b: RunView): boolean {
  return a.tab === b.tab && a.member === b.member && a.turnId === b.turnId && a.q === b.q
}

/** 从视图态构造工作台 URL：基底取真实当前地址（保留 ?a= 等外来参数、剥离
 *  自有四键——state 权威，URL 是投影，select 造成的漂移不再进地址栏） */
function workbenchUrl(view: RunView): string {
  const p = new URLSearchParams(window.location.search)
  for (const k of OWNED_URL_KEYS) p.delete(k)
  p.set("tab", view.tab)
  if (view.member != null) p.set("member", view.member)
  if (view.turnId != null) p.set("turn", view.turnId)
  if (view.q != null) p.set("q", view.q)
  return `?${p.toString()}`
}

/** 无标条目兜底：从地址栏解析视图态（跨页条目/极端丢态时使用） */
function viewFromLocation(): RunView {
  const p = new URLSearchParams(window.location.search)
  return {
    tab: normalizeTabParam(p.get("tab")) ?? DEFAULT_RUN_TAB,
    member: p.get("member"),
    turnId: p.get("turn"),
    q: p.get("q"),
  }
}

export type RunViewHandle = {
  view: RunView
  navigate: (patch: RunNavigatePatch) => void
  select: (patch: RunSelectPatch) => void
  /** 工作台内回退一步：live = history.back()（与鼠标侧键/浏览器返回钮同
   *  一出口，恢复交给 popstate）；离线 = 内存栈弹出恢复。返回 false =
   *  条目栈空，没有更早的工作台视图可回（离页去向由页面决定） */
  goBack: () => boolean
  /** 工作台内还有可回退动作（当前条目序 > 0 / 内存栈非空——返回钮残影反馈） */
  canBack: boolean
}

export function useRunView(): RunViewHandle {
  const searchParams = useSearchParams()
  const tabParam = searchParams.get("tab")
  const memberParam = searchParams.get("member")
  const turnParam = searchParams.get("turn")
  const qParam = searchParams.get("q")

  const [view, setView] = useState<RunView>(() => ({
    tab: normalizeTabParam(tabParam) ?? DEFAULT_RUN_TAB,
    member: memberParam ?? null,
    turnId: turnParam ?? null,
    q: qParam ?? null,
  }))

  // 条目栈模式 + 离线降级内存栈 + 事件时点的最新视图闭锁（navigate 在事件
  // 内直写，同 tick 连续跳转不读旧值；渲染后的提交经 effect 回同步）
  const modeRef = useRef<StackMode>("history")
  const memoryStack = useRef<RunView[]>([])
  const viewRef = useRef(view)
  useEffect(() => { viewRef.current = view })
  const [canBack, setCanBack] = useState(false)

  // —— 条目栈底座：进入本页的首个条目盖序号标（runNavSeq = 0 + 初始视图）。
  //    受限宿主（file:// 离线导出——replaceState/pushState 对 origin null 抛
  //    SecurityError）落空 → 本页起降级内存栈。刷新/软导航回页重挂载时条目
  //    已带标则不重盖（序号与视图沿用真实历史）。canBack 不在此同步回填
  //    （effect 内 setState 会级联渲染）——初始 false，事件路径
  //    （navigate/goBack/popstate）点亮；刷新重挂载后残影回到熄灭基线，
  //    goBack 仍按条目序真实可用
  useEffect(() => {
    try {
      if (readNavState().runNavSeq == null) {
        window.history.replaceState(
          { ...(window.history.state as object | null ?? {}), runNavSeq: 0, runView: viewRef.current },
          "",
        )
      }
    } catch {
      modeRef.current = "memory"
    }
  }, [])

  // —— 写路径①：跳转（state 合并 + 入条目栈）——
  const navigate = useCallback((patch: RunNavigatePatch) => {
    const cur = viewRef.current
    const next: RunView = {
      tab: patch.tab ?? cur.tab,
      member: patch.member !== undefined ? patch.member : cur.member,
      turnId: patch.turnId !== undefined ? patch.turnId : cur.turnId,
      q: patch.q !== undefined ? patch.q : cur.q,
    }
    // 视图态真变了才入条目栈（同值跳转是 no-op，不产生历史）
    if (sameView(cur, next)) return
    if (modeRef.current === "history") {
      try {
        // 视图态随条目走（刷新后 popstate 恢复依然精确）；URL 是可分享镜像
        window.history.pushState(
          { ...(window.history.state as object | null ?? {}), runNavSeq: readSeq() + 1, runView: next },
          "",
          workbenchUrl(next),
        )
        setCanBack(true)
      } catch {
        // 受限宿主运行途中失能（罕见）：本步起降级内存栈，不丢这一步
        modeRef.current = "memory"
        memoryStack.current.push(cur)
        setCanBack(memoryStack.current.length > 0)
      }
    } else {
      memoryStack.current.push(cur)
      setCanBack(memoryStack.current.length > 0)
    }
    viewRef.current = next
    setView(next)
  }, [])

  // —— 写路径②：tab 内选中（纯 state，URL 不动、不入条目栈）——
  const select = useCallback((patch: RunSelectPatch) => {
    setView(v => ({
      ...v,
      member: patch.member !== undefined ? patch.member : v.member,
      turnId: patch.turnId !== undefined ? patch.turnId : v.turnId,
      q: patch.q !== undefined ? patch.q : v.q,
    }))
  }, [])

  // —— 写路径③：工作台内回退（live 与侧键/浏览器返回同一出口；离线内存栈）——
  const goBack = useCallback(() => {
    if (modeRef.current === "history") {
      if (readSeq() <= 0) return false
      // 恢复交给 popstate（条目 state 直读，无 URL 解析时序差）
      window.history.back()
      return true
    }
    const prev = memoryStack.current.pop()
    if (!prev) return false
    viewRef.current = prev
    setView(prev)
    setCanBack(memoryStack.current.length > 0)
    return true
  }, [])

  // —— 读路径①：浏览器历史回退/前进（鼠标侧键、浏览器与 chrome 返回钮、
  //    前进键重放）→ 条目 state 的视图态恢复 + 可达性重估。跨出本页的条目
  //    （无 runView 标）回落地址栏解析——页面正在被切走，恢复值不构成语义
  useEffect(() => {
    const onPopState = () => {
      if (modeRef.current !== "history") return
      const next = readNavState().runView ?? viewFromLocation()
      viewRef.current = next
      setView(v => (sameView(v, next) ? v : next))
      setCanBack(readSeq() > 0)
    }
    window.addEventListener("popstate", onPopState)
    return () => window.removeEventListener("popstate", onPopState)
  }, [])

  // —— 读路径②：tab/member/turn/q 随 URL 恢复（Next 内部换参兜底；非法 tab
  //    回落 overview，member/turn 空值清态）。渲染期前值比较——React 认可的
  //    「URL 变化即调 state」形态；navigate/popstate 写入的 state 与 URL 同值，
  //    重放为 no-op ——
  const [prevTabParam, setPrevTabParam] = useState(tabParam)
  if (tabParam !== prevTabParam) {
    setPrevTabParam(tabParam)
    const next = normalizeTabParam(tabParam) ?? DEFAULT_RUN_TAB
    setView(v => (v.tab === next ? v : { ...v, tab: next }))
  }
  const [prevMemberParam, setPrevMemberParam] = useState(memberParam)
  if (memberParam !== prevMemberParam) {
    setPrevMemberParam(memberParam)
    setView(v => (v.member === memberParam ? v : { ...v, member: memberParam ?? null }))
  }
  const [prevTurnParam, setPrevTurnParam] = useState(turnParam)
  if (turnParam !== prevTurnParam) {
    setPrevTurnParam(turnParam)
    setView(v => (v.turnId === turnParam ? v : { ...v, turnId: turnParam ?? null }))
  }
  const [prevQParam, setPrevQParam] = useState(qParam)
  if (qParam !== prevQParam) {
    setPrevQParam(qParam)
    setView(v => (v.q === qParam ? v : { ...v, q: qParam ?? null }))
  }

  return { view, navigate, select, goBack, canBack }
}
