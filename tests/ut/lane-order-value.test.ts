// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 回归锁：「顺序/SEQUENCE」排序的序值计算。
// 修复前取 `turns[0]?.turnIndex`：依赖 turns 已按 turnIndex 升序（API 顺序
// 不保证时排序即失真），且空 turns 兜底 0 会把空泳道顶到最前。修复后取
// Math.min，空 turns 兜底极大值排末位。

import { describe, it, expect } from "vitest";
import { laneOrderValue } from "@/components/observe/perf-shared";

describe("laneOrderValue（顺序排序序值）", () => {
  it("取最早一轮 turnIndex（Math.min），不依赖 turns 入序", () => {
    // turns 乱序：首元素 turnIndex=3，若取 turns[0] 会得 3，正确应为 1
    expect(laneOrderValue([{ turnIndex: 3 }, { turnIndex: 1 }, { turnIndex: 5 }])).toBe(1);
    expect(laneOrderValue([{ turnIndex: 0 }, { turnIndex: 7 }])).toBe(0);
  });

  it("单 turn 泳道返回该 turn 的序值", () => {
    expect(laneOrderValue([{ turnIndex: 42 }])).toBe(42);
  });

  it("空 turns 兜底为极大值排到末位，不再落到 0 顶到最前", () => {
    expect(laneOrderValue([])).toBe(Number.MAX_SAFE_INTEGER);
  });
});