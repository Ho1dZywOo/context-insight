// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// MessageRow 提到模块级 + memo 的回归锁：修复前 MessageRow 定义在 TurnInputCard
// render 内部，每次重渲染都是新组件 type，React 把 type 变化当作「换组件」——
// 任意 setExpandedMessages/setNewOpen 都让整棵 MessageRow 子树卸载重挂，
// ExpandableText 的「展开全文」内部状态被重置（用户刚展开的长消息瞬间弹回折叠）。
// 复现：展开消息 A 全文 → 展开消息 B（触发 setExpandedMessages 重渲染）→ A 的
// 展开态必须保持（修复前：A 弹回折叠态，DOM 里「收起」消失、「展开全文」多一份）。

import { describe, it, expect } from "vitest"
import { createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { act } from "react"
import { TurnInputCard } from "@/components/observe/TurnInputCard"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// 超过 AUTO_EXPAND_MAX_CHARS(1200) → 不默认展开正文；超过 ExpandableText 字符
// 启发阈值(700) → 展开正文后出现「⋯ 展开全文 ▾」按钮。前缀标记用于定位行。
const LONG_A = "MSG_ZERO_".padEnd(1500, "x")
const LONG_B = "MSG_ONE_".padEnd(1500, "y")

function renderCard(): { container: HTMLElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      createElement(TurnInputCard, {
        inputMessagesJson: JSON.stringify([
          { role: "user", content: LONG_A },
          { role: "user", content: LONG_B },
        ]),
        inputMessagesCount: 2,
        inputMessagesTokens: 2000,
        contextWindowPct: null,
        systemOverheadTokens: 0,
        systemPrompt: null,
        fullContext: null,
      })
    )
  })
  return { container, root }
}

function click(container: HTMLElement, text: string): void {
  const el = [...container.querySelectorAll('[role="button"]')].find(e => e.textContent?.includes(text))
  expect(el, `[role=button] containing "${text}"`).toBeTruthy()
  act(() => { el!.dispatchEvent(new MouseEvent("click", { bubbles: true })) })
}

function findTriangle(container: HTMLElement, marker: string): HTMLElement {
  const tri = [...container.querySelectorAll('[role="button"]')]
    .filter(el => el.textContent?.trim() === "▶" || el.textContent?.trim() === "▼")
    .find(el => el.closest("div")?.textContent?.includes(marker))
  expect(tri, `triangle toggle in row containing "${marker}"`).toBeTruthy()
  return tri as HTMLElement
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

describe("TurnInputCard 消息行 memo：展开态不因他行 toggle 而丢失", () => {
  it("展开 A 全文后 toggle B，A 的「收起」态保持不变", () => {
    const { container, root } = renderCard()

    // 打开「本轮新增」收纳段，露出两条消息行
    click(container, "本轮新增")

    // 展开消息 A（MSG_ZERO_）正文，再点开其「展开全文」
    act(() => { findTriangle(container, "MSG_ZERO_").dispatchEvent(new MouseEvent("click", { bubbles: true })) })
    click(container, "展开全文")
    // A 已全展开：出现「收起 ▴」，B 仍折叠无「展开全文」
    expect(countOccurrences(container.textContent ?? "", "收起 ▴")).toBe(1)
    expect(countOccurrences(container.textContent ?? "", "展开全文")).toBe(0)

    // toggle 消息 B（MSG_ONE_）→ 触发 setExpandedMessages 重渲染
    act(() => { findTriangle(container, "MSG_ONE_").dispatchEvent(new MouseEvent("click", { bubbles: true })) })

    // 修复后：A 的展开态保留（1 份「收起」），B 刚展开、正文仍折叠（1 份「展开全文」）
    // 修复前：整树重挂，A 弹回折叠 →「收起」0 份、「展开全文」2 份
    expect(countOccurrences(container.textContent ?? "", "收起 ▴")).toBe(1)
    expect(countOccurrences(container.textContent ?? "", "展开全文")).toBe(1)

    root.unmount()
    container.remove()
  })
})
