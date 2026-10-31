// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 图表几何单一源（趋势曲线的渲染管线）：
// ①LTTB（Largest-Triangle-Three-Buckets，Steinarsson 2013）：按桶选「对视觉
//   形状贡献最大」的点，保首尾与局部极值。Uber M3 / TimescaleDB / ClickHouse
//   / Grafana 生态的标准降采样（IEEE VIS 2023 实证评估）。数千轮的 agent
//   会话曲线降采样到 ~1点/2px 后与全量绘制视觉不可分辨，SVG 节点数从
//   O(轮次) 降到 O(像素)——高频锯齿（逐轮 token 振荡）随之消除。
// ②monotonePath（Fritsch-Carlson 单调三次 Hermite → Bézier，d3
//   curveMonotoneX 同族）：切线经单调钳制，曲线不越过相邻数据点（无伪峰/
//   伪谷），x 向控制点严格落在段内（时间轴不可能回拐）。替代 Catmull-Rom——
//   后者在急变数据上必然产生过冲伪影，正是「吱吱扭扭」线条的来源。

export interface ChartPoint { x: number; y: number }

/** LTTB 降采样：points 须按 x 非降序；threshold 为目标点数（含首尾，<3 或
 *  ≥n 时原样返回）。返回原数组子集——点负载（轮次数据）随选中点保留。 */
export function lttb<T extends ChartPoint>(points: T[], threshold: number): T[] {
  const n = points.length
  if (threshold >= n || threshold < 3) return points
  const sampled: T[] = [points[0]]
  const every = (n - 2) / (threshold - 2)
  let a = 0
  for (let i = 0; i < threshold - 2; i++) {
    // 下一桶均值点（LTTB 的「第三桶」锚）
    const avgStart = Math.floor((i + 1) * every) + 1
    const avgEnd = Math.min(Math.floor((i + 2) * every) + 1, n)
    let avgX = 0
    let avgY = 0
    const avgLen = Math.max(1, avgEnd - avgStart)
    for (let j = avgStart; j < avgEnd; j++) { avgX += points[j].x; avgY += points[j].y }
    avgX /= avgLen
    avgY /= avgLen
    // 当前桶内取三角形面积最大的点
    const rangeOff = Math.min(Math.floor(i * every) + 1, n - 1)
    const rangeTo = Math.min(Math.floor((i + 1) * every) + 1, n)
    const ax = points[a].x
    const ay = points[a].y
    let maxArea = -1
    let nextIdx = rangeOff
    for (let j = rangeOff; j < rangeTo; j++) {
      const area = Math.abs((ax - avgX) * (points[j].y - ay) - (ax - points[j].x) * (avgY - ay)) / 2
      if (area > maxArea) { maxArea = area; nextIdx = j }
    }
    sampled.push(points[nextIdx])
    a = nextIdx
  }
  sampled.push(points[n - 1])
  return sampled
}

/** Fritsch-Carlson 单调三次插值 → SVG path。切线单调钳制（相邻段斜率异号
 *  或零宽段 → 0），段内 Bézier 控制点：cx = x ± dx/3 严格段内。 */
export function monotonePath(pts: ChartPoint[]): string {
  const n = pts.length
  if (n === 0) return ""
  if (n === 1) return `M ${pts[0].x},${pts[0].y}`
  if (n === 2) return `M ${pts[0].x},${pts[0].y} L ${pts[1].x},${pts[1].y}`
  const d: number[] = []
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x
    d.push(dx > 0 ? (pts[i + 1].y - pts[i].y) / dx : 0)
  }
  const m: number[] = new Array(n).fill(0)
  m[0] = d[0]
  m[n - 1] = d[n - 2]
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) continue
    const dxPrev = pts[i].x - pts[i - 1].x
    const dxNext = pts[i + 1].x - pts[i].x
    if (dxPrev <= 0 || dxNext <= 0) continue
    m[i] = 3 * (dxPrev + dxNext) / ((2 * dxNext + dxPrev) / d[i - 1] + (dxNext + 2 * dxPrev) / d[i])
  }
  // 段级 Fritsch-Carlson 钳制：切线与段斜率同号且 |m| ≤ 3|d|（充分单调条件，
  // 保证 Bézier 控制点不越出段值域——无伪峰/伪谷；邻陡本缓的加权均值会被拉飞）
  for (let i = 0; i < n - 1; i++) {
    const span = pts[i + 1].x - pts[i].x
    if (span <= 0) { m[i] = 0; m[i + 1] = 0; continue }
    const dSeg = (pts[i + 1].y - pts[i].y) / span
    if (dSeg === 0) { m[i] = 0; m[i + 1] = 0; continue }
    if (m[i] * dSeg <= 0) m[i] = 0
    else if (Math.abs(m[i]) > 3 * Math.abs(dSeg)) m[i] = 3 * dSeg
    if (m[i + 1] * dSeg <= 0) m[i + 1] = 0
    else if (Math.abs(m[i + 1]) > 3 * Math.abs(dSeg)) m[i + 1] = 3 * dSeg
  }
  let path = `M ${pts[0].x},${pts[0].y}`
  for (let i = 0; i < n - 1; i++) {
    const span = pts[i + 1].x - pts[i].x
    if (span <= 0) {
      // 零宽段（同刻多轮）：直线跳至下一点，避免零长 Bézier 奇异
      path += ` L ${pts[i + 1].x},${pts[i + 1].y}`
      continue
    }
    const dx = span / 3
    path += ` C ${pts[i].x + dx},${pts[i].y + m[i] * dx} ${pts[i + 1].x - dx},${pts[i + 1].y - m[i + 1] * dx} ${pts[i + 1].x},${pts[i + 1].y}`
  }
  return path
}
