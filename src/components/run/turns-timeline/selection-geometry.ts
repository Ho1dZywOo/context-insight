// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of CANN Open Software License Agreement Version 2.0.
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See the License in the root of the software repository for the full text of the License.

// Turns 时间线选中层的几何与配色（纯函数，无 DOM）：iOS 风格的选中态——只用
// 条子本色的填充，不用描边；位移走 transform。

/** 选中柔光的最小宽度（px）：零宽 / 极短的轮也是一束看得见的柔光 */
export const MIN_SELECTION_PX = 24;
/** 所属条子上选中段的最小宽度（px） */
export const MIN_SEGMENT_PX = 6;
/** 轴上时刻胶囊的宽度（HH:MM:SS 等宽数字 + 留白） */
export const PILL_W = 64;
/** 选中段比条子上下各高出这么多：选中即「浮起」 */
export const SELECTION_LIFT = 1;
/** 柔光两端渐隐的宽度（px） */
const FEATHER_PX = 16;

export interface SelectionGeometry {
  /** 条子本色 */
  color: string;
  /** 时刻胶囊的左缘（相对轨道左缘，px） */
  pillX: number;
  /** 柔光的左缘（相对轨道左缘，px） */
  x: number;
  /** 柔光宽度（px，已保底） */
  w: number;
  /** 柔光背景（横向渐变） */
  background: string;
}

/** 柔光色：本色淡化 */
export function tintOf(color: string): string {
  return `color-mix(in oklab, ${color} 15%, transparent)`;
}

/** 选中段的柔影色：本色半透明 */
export function glowOf(color: string): string {
  return `color-mix(in oklab, ${color} 45%, transparent)`;
}

/** 柔光背景：宽时两端各渐隐固定像素；窄于两段渐隐时对称渐入渐出（一束光） */
export function bandGradient(tint: string, w: number): string {
  if (w < FEATHER_PX * 2) return `linear-gradient(90deg, transparent, ${tint} 50%, transparent)`;
  return `linear-gradient(90deg, transparent 0, ${tint} ${FEATHER_PX}px, ${tint} calc(100% - ${FEATHER_PX}px), transparent 100%)`;
}
