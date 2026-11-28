// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of CANN Open Software License Agreement Version 2.0.
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See the License in the root of the software repository for the full text of the License.

// Turns 时间线选中层的几何与配色（纯函数，无 DOM）：iOS 风格的选中态——只用
// 条子本色的填充，不用描边；位移走 transform。

/** 所属条子上选中段的最小宽度（px）——零宽轮也是一颗看得见的胶囊 */
export const MIN_SEGMENT_PX = 6;
/** 轴上时刻胶囊的宽度（HH:MM:SS 等宽数字 + 留白） */
export const PILL_W = 64;
/** 选中段比条子上下各高出这么多：选中即「浮起」 */
export const SELECTION_LIFT = 1;
/** 柔光在选中段两侧各渐隐的宽度（px） */
export const BEAM_FEATHER_PX = 16;

/** 选中段：选中轮的时间窗落在所属条子上的范围（相对轨道左缘的 px） */
export interface SelectionSegment {
  /** 条子本色 */
  color: string;
  x: number;
  w: number;
}

export interface SelectionGeometry {
  /** 条子本色 */
  color: string;
  /** 时刻胶囊的左缘（相对轨道左缘，px） */
  pillX: number;
  /** 柔光的左缘与总宽（含两侧渐隐，px） */
  x: number;
  w: number;
  /** 柔光背景（横向渐变） */
  background: string;
}

/** 柔光色：本色淡化 */
export function tintOf(color: string): string {
  return `color-mix(in oklab, ${color} 21%, transparent)`;
}

/** 选中段的柔影色：本色半透明 */
export function glowOf(color: string): string {
  return `color-mix(in oklab, ${color} 45%, transparent)`;
}

/**
 * 柔光包着选中段：实心核 = 选中段的范围（两者必然重合——光效为主，选中段是
 * 它的核），两侧各渐隐固定像素。渐隐落在选中段之外，不会把邻段也染亮。
 */
export function beamOf(segment: SelectionSegment): { x: number; w: number; background: string } {
  const half = BEAM_FEATHER_PX / 2;
  const tint = tintOf(segment.color);
  return {
    x: segment.x - half,
    w: segment.w + BEAM_FEATHER_PX,
    background: `linear-gradient(90deg, transparent 0, ${tint} ${half}px, ${tint} calc(100% - ${half}px), transparent 100%)`,
  };
}
