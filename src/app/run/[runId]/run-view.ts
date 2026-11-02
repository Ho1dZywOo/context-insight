// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Run 详情页视图状态层：镜像 session-view 契约（state 权威 + URL 镜像，
// navigate 写 URL / select 不碰 URL，router.replace 单 history 条目——切 tab
// 不产生浏览器历史）。返回语义在工作台内闭环：navigate 的前值入内存
// 回退栈，goBack 逐步恢复上一个工作台动作（tab 切换 / turn 深链 / 成员
// 钻取；select 的 tab 内调整不入栈）；栈空时由页面决定离页去向。
// 维度差异：run 多一个 member（成员过滤）镜像与 turn 深链（turnId 全局
// 唯一，TurnDetail 经既有 session 端点取数）。KNOWN_RUN_TABS 是全量 tab
// 键值域（深链/恢复合法值），页面渲染表按刀次长全——未交付的 tab 键合法
// 但不渲染。

import { useCallback, useEffect, useRef, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"

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

/** 视图状态。tab / member / turn 进 URL 镜像（?tab= / ?member= / ?turn=） */
export type RunView = {
  tab: RunTabKey
  /** 成员钻取态（刀G：观测 tab 恒为全成员融合无过滤，member 仅 Audit 的
   *  skill 审计执行目标——审计正文须从具体成员会话源文件恢复；URL ?member= 镜像源） */
  member: string | null
  /** 选中轮次（TurnDetail 深钻；URL ?turn= 的镜像源，turnId 全局唯一） */
  turnId: string | null
}

/** 跳转补丁：「去某处看」。tab/member/turnId 写 URL 镜像（replace）。
 *  字段语义：undefined = 不动；显式 null = 清态 */
export type RunNavigatePatch = {
  tab?: RunTabKey
  member?: string | null
  turnId?: string | null
}

/** 选中补丁：「tab 内调整」。纯 state，URL 不动 */
export type RunSelectPatch = {
  member?: string | null
  turnId?: string | null
}

export type RunViewHandle = {
  view: RunView
  navigate: (patch: RunNavigatePatch) => void
  select: (patch: RunSelectPatch) => void
  /** 工作台内回退一步：恢复上一个 navigate 前的视图态（select 的 tab 内
   *  调整不入栈）。返回 false = 栈空，没有更早的工作台视图可回 */
  goBack: () => boolean
  /** 工作台内还有可回退视图（返回钮的可达性反馈） */
  canBack: boolean
}

export function useRunView(): RunViewHandle {
  const router = useRouter()
  const searchParams = useSearchParams()
  const tabParam = searchParams.get("tab")
  const memberParam = searchParams.get("member")
  const turnParam = searchParams.get("turn")

  const [view, setView] = useState<RunView>(() => ({
    tab: normalizeTabParam(tabParam) ?? DEFAULT_RUN_TAB,
    member: memberParam ?? null,
    turnId: turnParam ?? null,
  }))

  // 工作台回退栈（navigate 前值入栈；内存态，刷新/深链重开即重置）与
  // 事件时点的最新视图闭锁——navigate/goBack 在事件内直写（同 tick 连续
  // 跳转不读旧值），渲染后的提交经 effect 回同步（URL 变更只源于
  // navigate/goBack 自身，effect 延迟不构成竞态窗口）
  const backStack = useRef<RunView[]>([])
  const viewRef = useRef(view)
  useEffect(() => { viewRef.current = view })
  const [canBack, setCanBack] = useState(false)

  // —— 写路径①：跳转（state 合并 + URL replace，history 策略单点）——
  const navigate = useCallback((patch: RunNavigatePatch) => {
    const cur = viewRef.current
    const next: RunView = {
      tab: patch.tab ?? cur.tab,
      member: patch.member !== undefined ? patch.member : cur.member,
      turnId: patch.turnId !== undefined ? patch.turnId : cur.turnId,
    }
    // 视图态真变了才入回退栈（同值跳转是 no-op，不入栈）
    if (next.tab !== cur.tab || next.member !== cur.member || next.turnId !== cur.turnId) {
      backStack.current.push(cur)
      setCanBack(true)
    }
    viewRef.current = next
    setView(next)
    const p = new URLSearchParams(searchParams.toString())
    if (patch.tab != null) p.set("tab", patch.tab)
    if (patch.member !== undefined) {
      if (patch.member == null) p.delete("member")
      else p.set("member", patch.member)
    }
    if (patch.turnId !== undefined) {
      if (patch.turnId == null) p.delete("turn")
      else p.set("turn", patch.turnId)
    }
    router.replace(`?${p.toString()}`, { scroll: false })
  }, [router, searchParams])

  // —— 写路径②：tab 内选中（纯 state，URL 不动）——
  const select = useCallback((patch: RunSelectPatch) => {
    setView(v => ({
      ...v,
      member: patch.member !== undefined ? patch.member : v.member,
      turnId: patch.turnId !== undefined ? patch.turnId : v.turnId,
    }))
  }, [])

  // —— 写路径③：工作台内回退（栈顶弹出 + URL 镜像同步恢复）——
  const goBack = useCallback(() => {
    const prev = backStack.current.pop()
    if (!prev) return false
    setCanBack(backStack.current.length > 0)
    viewRef.current = prev
    setView(prev)
    const p = new URLSearchParams(searchParams.toString())
    p.set("tab", prev.tab)
    if (prev.member == null) p.delete("member")
    else p.set("member", prev.member)
    if (prev.turnId == null) p.delete("turn")
    else p.set("turn", prev.turnId)
    router.replace(`?${p.toString()}`, { scroll: false })
    return true
  }, [router, searchParams])

  // —— 读路径：tab/member/turn 随 URL 恢复（深链/popstate/换参；非法 tab 回落
  //    overview，member/turn 空值清态）。渲染期前值比较——React 认可的
  //    「URL 变化即调 state」形态（无 effect 级联渲染）；navigate 写入的
  //    state 与 URL 同值，重放为 no-op ——
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

  return { view, navigate, select, goBack, canBack }
}
