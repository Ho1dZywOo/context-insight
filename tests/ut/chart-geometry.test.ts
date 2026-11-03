// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 图表几何 IT（趋势曲线渲染管线：LTTB 降采样 + Fritsch-Carlson 单调三次）：
// ①时间轴不回拐——x 轴是真实时间、点距极不均匀（相邻段 6 秒 vs 17 小时），
//   曲线在任意点距形态下控制点都落在段内（实测 ses_f5b4a2b58ffe design #17
//   #134→#135 段曾因 Catmull-Rom 远邻拉扯回拐）；
// ②值域不过冲——急变/振荡数据下控制点不越出相邻数据点值域（无伪峰伪谷，
//   Catmull-Rom 过冲即「吱吱扭扭」来源）；
// ③LTTB 保首尾、保子集、按阈值收敛（数千轮曲线降采样到像素级）。

import { describe, it, expect } from 'vitest';
import { lttb, monotonePath } from '@/components/observe/chart-geometry';

interface Pt { x: number; y: number }

// 解析 path 字符串：M x,y 后跟若干段 C cp1 cp2 p2
function parseSegments(d: string): Array<{ p1: Pt; cp1: Pt; cp2: Pt; p2: Pt }> {
  const nums = (d.match(/-?[\d.]+/g) ?? []).map(Number);
  const segs: Array<{ p1: Pt; cp1: Pt; cp2: Pt; p2: Pt }> = [];
  let p1 = { x: nums[0], y: nums[1] };
  for (let i = 2; i + 5 <= nums.length; i += 6) {
    segs.push({
      p1,
      cp1: { x: nums[i], y: nums[i + 1] },
      cp2: { x: nums[i + 2], y: nums[i + 3] },
      p2: { x: nums[i + 4], y: nums[i + 5] },
    });
    p1 = { x: nums[i + 4], y: nums[i + 5] };
  }
  return segs;
}

// 真实回拐形态（ses_f5b4a2b58ffe design #17 的 #133~#137，x=时间戳 ms）：
// #129→#130 761s，#133→#134 18s，#134→#135 6.4s，#135→#137 17 小时
function realWorldBackBendPts(): Pt[] {
  const t = (h: number, m: number, s: number) => Date.UTC(2026, 8, 16, h, m, s);
  return [
    { x: t(8, 2, 37), y: 99616 },   // #129
    { x: t(8, 15, 18), y: 131538 }, // #130（前邻段 761s）
    { x: t(8, 29, 33), y: 170730 }, // #133
    { x: t(8, 29, 51), y: 170899 }, // #134
    { x: t(8, 29, 58), y: 182918 }, // #135
    { x: t(1, 29, 58) + 17 * 3600_000, y: 220306 }, // #137（17 小时远邻段）
  ];
}

// 振荡序列（邻段陡、本段缓的混合形态——过冲高发区）
function oscillatingPts(): Pt[] {
  return [
    { x: 0, y: 100 }, { x: 10, y: 1000 }, { x: 20, y: 950 }, { x: 30, y: 300 },
    { x: 40, y: 305 }, { x: 50, y: 310 }, { x: 60, y: 1200 }, { x: 70, y: 200 },
    { x: 80, y: 205 }, { x: 90, y: 900 },
  ];
}

describe('monotonePath（单调三次：不回拐、不过冲）', () => {
  it('真实回拐序列：每段控制点 x 都落在段内（时间轴不折回）', () => {
    const d = monotonePath(realWorldBackBendPts());
    const segs = parseSegments(d);
    expect(segs.length).toBe(5);
    for (const s of segs) {
      const minX = Math.min(s.p1.x, s.p2.x);
      const maxX = Math.max(s.p1.x, s.p2.x);
      expect(s.cp1.x).toBeGreaterThanOrEqual(minX);
      expect(s.cp1.x).toBeLessThanOrEqual(maxX);
      expect(s.cp2.x).toBeGreaterThanOrEqual(minX);
      expect(s.cp2.x).toBeLessThanOrEqual(maxX);
    }
  });

  it('振荡/陡缓混合序列：控制点 y 不越出段值域（无伪峰伪谷）', () => {
    const segs = parseSegments(monotonePath(oscillatingPts()));
    expect(segs.length).toBe(9);
    for (const s of segs) {
      const minY = Math.min(s.p1.y, s.p2.y);
      const maxY = Math.max(s.p1.y, s.p2.y);
      expect(s.cp1.y).toBeGreaterThanOrEqual(minY);
      expect(s.cp1.y).toBeLessThanOrEqual(maxY);
      expect(s.cp2.y).toBeGreaterThanOrEqual(minY);
      expect(s.cp2.y).toBeLessThanOrEqual(maxY);
    }
  });

  it('退化形态：空/单点/两点/同刻多轮（零宽段走直线）', () => {
    expect(monotonePath([])).toBe('');
    expect(monotonePath([{ x: 1, y: 1 }])).toBe('M 1,1');
    expect(monotonePath([{ x: 0, y: 0 }, { x: 10, y: 10 }])).toBe('M 0,0 L 10,10');
    // 同 x 两点：不产生零宽 Bézier，直线跳变
    expect(monotonePath([{ x: 0, y: 0 }, { x: 0, y: 5 }, { x: 10, y: 8 }])).toContain(' L 0,5');
  });
});

describe('lttb（降采样：保首尾、保子集、按阈值收敛）', () => {
  const dense = Array.from({ length: 2000 }, (_, i) => ({
    x: i, y: Math.sin(i / 40) * 500 + i / 4 + (i % 7) * 3,
  }));

  it('超阈值序列收敛到阈值，首尾保留，且是原序列子集', () => {
    const out = lttb(dense, 550);
    expect(out.length).toBeLessThanOrEqual(550);
    expect(out.length).toBeGreaterThan(100);
    expect(out[0]).toBe(dense[0]);
    expect(out[out.length - 1]).toBe(dense[dense.length - 1]);
    const orig = new Set(dense);
    for (const p of out) expect(orig.has(p)).toBe(true);
    // 局部极值形态保留（正弦 ±500 振幅不被抹平）
    const ys = out.map(p => p.y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(900);
  });

  it('阈值 ≥ n 原样返回；阈值 < 3 原样返回（护栏）', () => {
    expect(ltbIdentityGuard()).toBe(true);
  });

  it('极值点被保留：全局峰/谷不出现在采样盲区', () => {
    // 单一尖峰序列：峰点必须被选中（LTTB 的三角形面积机制）
    const peak = Array.from({ length: 100 }, (_, i) => ({ x: i, y: i === 57 ? 9999 : i }));
    const out = lttb(peak, 10);
    expect(out.some(p => p.y === 9999)).toBe(true);
  });
});

function ltbIdentityGuard(): boolean {
  const small = Array.from({ length: 5 }, (_, i) => ({ x: i, y: i * 2 }));
  if (lttb(small, 10) !== small) return false;
  if (lttb(small, 2) !== small) return false;
  return true;
}
