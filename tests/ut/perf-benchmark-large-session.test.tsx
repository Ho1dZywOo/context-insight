// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// PerfBenchmarkChart 峰值/谷值计算的回归锁：效率分布图面向数千轮大会话，
// y 轴峰值/谷值要覆盖全量 vals（主 agent 全量轮次）。修复前
// `Math.max(...vals, 1)` / `Math.min(...vals)` 把整组 vals 展开成调用实参，
// V8 展开实参有栈深上限（本机实测 20 万级即 RangeError），且这行在聚桶
// 之前执行，规避不掉。改为 reduce 后无限深、也无临时数组。

import { describe, it, expect } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { createElement } from "react"
import { PerfBenchmarkChart } from "@/components/observe/perf-shared"

function makePoints(n: number) {
  const base = Date.UTC(2026, 0, 1)
  const out = new Array(n)
  for (let i = 0; i < n; i++) {
    out[i] = { turnIndex: i, createdAt: new Date(base + i * 1000).toISOString(), tpot: i + 1, tps: i + 1 }
  }
  return out
}

describe("PerfBenchmarkChart 大会话峰值计算", () => {
  it("20 万轮不因展开实参抛 RangeError，聚桶后统计口径仍覆盖全量", () => {
    const n = 200_000
    const points = makePoints(n)

    // 修复前 Math.max(...200k) 在 render 期抛 RangeError：renderToStaticMarkup 直接炸
    let html = ""
    expect(() => {
      html = renderToStaticMarkup(createElement(PerfBenchmarkChart, { points }))
    }).not.toThrow()

    // 图 svg 渲染成功，且「轮次」统计口径 = 全量 200000（峰值/谷值取值正确）
    expect(html).toContain("data-bench")
    expect(html).toContain("200000")
  })

  it("reduce 峰值/谷值与展开实参语义一致（已知序列）", () => {
    const points = [
      { turnIndex: 0, createdAt: "2026-08-13T11:00:00Z", tpot: 5, tps: 50 },
      { turnIndex: 1, createdAt: "2026-08-13T11:01:00Z", tpot: 1, tps: 10 },
      { turnIndex: 2, createdAt: "2026-08-13T11:02:00Z", tpot: 9, tps: 90 },
    ]
    const html = renderToStaticMarkup(createElement(PerfBenchmarkChart, { points }))
    // 峰值 tps=90、谷值 tps=10（默认 metric=tps），峰值为整步上取的 yMax 覆盖
    expect(html).toContain(">90<") // 峰值点标值 fmtVal(90)="90"
    expect(html).toContain("10") // 谷值统计 fmtVal(10)="10"
    expect(html).toContain("3") // 轮次统计 String(3)
  })
})