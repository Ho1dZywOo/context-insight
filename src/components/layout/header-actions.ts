// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 页头动作胶囊基类：主页（Import 触发器 / Viewer / Settings / 返回）共用同一
// 结构类——高度/圆角/字号/内距单点 + 按压缩放微动效（纯 CSS transform，
// GPU 合成零开销）；变体只叠表面类，永不漂移。
export const HEADER_PILL =
  'inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-sm font-medium transition-[background-color,color,box-shadow,transform] duration-200 ease-out active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40';

// 淡色玻璃变体（页头动作统一形态）：中性淡底 + 发丝环 + 轻投影——层级靠
// 形态不靠色，无按钮突出；悬浮微深，按键语义聚焦环
export const HEADER_PILL_TINTED = `${HEADER_PILL} bg-foreground/[0.04] text-foreground/75 ring-1 ring-inset ring-foreground/[0.05] shadow-[0_1px_2px_rgba(0,0,0,0.04)] hover:bg-foreground/[0.075] hover:text-foreground`;
