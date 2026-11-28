// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of CANN Open Software License Agreement Version 2.0.
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See the License in the root of the software repository for the full text of the License.

import { describe, expect, it } from 'vitest';
import { MIN_SEGMENT_PX, MIN_SELECTION_PX, PILL_W, SELECTION_LIFT, bandGradient, glowOf, tintOf } from '@/components/run/turns-timeline/selection-geometry';

describe('selection-geometry — Turns 时间线选中层的几何与配色', () => {
  it('柔光 / 柔影取条子本色的淡化色：整个选中态只有一个色系', () => {
    expect(tintOf('#3b82f6')).toBe('color-mix(in oklab, #3b82f6 15%, transparent)');
    expect(glowOf('#3b82f6')).toBe('color-mix(in oklab, #3b82f6 45%, transparent)');
  });

  it('柔光渐变：宽于两段渐隐时两端各渐隐 16px、中段平；窄时对称渐入渐出', () => {
    const tint = tintOf('red');
    const wide = bandGradient(tint, 300);
    expect(wide).toBe(`linear-gradient(90deg, transparent 0, ${tint} 16px, ${tint} calc(100% - 16px), transparent 100%)`);
    expect(bandGradient(tint, 32)).toBe(wide);
    // 窄于 32px（含零宽轮的 24px 保底）：一束光
    expect(bandGradient(tint, MIN_SELECTION_PX)).toBe(`linear-gradient(90deg, transparent, ${tint} 50%, transparent)`);
    expect(bandGradient(tint, 31.9)).toBe(`linear-gradient(90deg, transparent, ${tint} 50%, transparent)`);
  });

  it('尺寸常量彼此自洽：柔光保底宽于选中段保底，胶囊装得下 HH:MM:SS', () => {
    expect(MIN_SELECTION_PX).toBeGreaterThan(MIN_SEGMENT_PX);
    expect(PILL_W).toBeGreaterThan(8 * 6);
    expect(SELECTION_LIFT).toBe(1);
  });
});
