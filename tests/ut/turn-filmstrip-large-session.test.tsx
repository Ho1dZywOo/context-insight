// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// TurnFilmstrip 峰值计算的回归锁：大会话（数千轮）柱高归一要用 turns 峰值
// token。修复前 `Math.max(...turns.map(t => t.totalTokens), 1)` 把整组 turns
// 展开成调用实参——V8 展开实参有栈深上限（本机实测 20 万级即 RangeError），
// 且这行在聚桶之前执行，规避不掉。改为 reduce 后无限深、也无临时 token 数组。

import { describe, it, expect } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { createElement } from "react"
import { TurnFilmstrip, type FilmstripTurn } from "@/components/observe/TurnFilmstrip"

function makeTurns(n: number): FilmstripTurn[] {
  const out: FilmstripTurn[] = new Array(n)
  for (let i = 0; i < n; i++) {
    out[i] = {
      turnId: `t-${i}`,
      turnIndex: i,
      role: i % 2 === 0 ? "user" : "assistant",
      isSubagent: false,
      totalTokens: i + 1, // 递增，峰值 = n
      latencyMs: 0,
      contextWindowPct: null,
    }
  }
  return out
}

describe("TurnFilmstrip 大会话峰值计算", () => {
  it("20 万轮不因展开实参抛 RangeError，且聚桶后渲染有限根柱", () => {
    const n = 200_000
    const turns = makeTurns(n)

    // 修复前 Math.max(...200k) 在 render 期抛 RangeError：renderToStaticMarkup 直接炸
    let html = ""
    expect(() => {
      html = renderToStaticMarkup(
        createElement(TurnFilmstrip, { turns, selectedTurnId: "", onSelect: () => {} })
      )
    }).not.toThrow()

    // 超容量聚桶：默认容量 240 → 200k/240 ≈ 834 根柱（而非 20 万根）
    const barCount = html.split("filmstrip-turn-").length - 1
    expect(barCount).toBeGreaterThan(0)
    expect(barCount).toBeLessThan(n)
    // 首桶柱锚点存在（turnIndex 0）
    expect(html).toContain("filmstrip-turn-0")
  })

  it("峰值归一仍正确：奇偶 token 已知时柱高随峰值缩放", () => {
    const turns = makeTurns(100) // 峰值 totalTokens = 100
    const html = renderToStaticMarkup(
      createElement(TurnFilmstrip, { turns, selectedTurnId: "", onSelect: () => {} })
    )
    // 100 轮 < 默认容量 240 → 不聚桶，逐柱渲染 100 根
    expect(html.split("filmstrip-turn-").length - 1).toBe(100)
    // 峰值桶拿到最高高度（heightPct 100%）
    expect(html).toContain('style="height:100%"')
  })
})