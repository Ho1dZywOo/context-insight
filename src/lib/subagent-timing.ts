// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

type Timestamp = string | Date | null;

export function subagentTiming(
  turns: Array<{ createdAt_ts: Timestamp; completedAt: Timestamp; latencyMs: number }>,
  dispatchTimestamp: Timestamp,
): { responseTimestamp: string; latencyMs: number } | null {
  const starts: number[] = [];
  const ends: number[] = [];
  for (const turn of turns) {
    const start = turn.createdAt_ts ? new Date(turn.createdAt_ts).getTime() : NaN;
    const end = turn.completedAt
      ? new Date(turn.completedAt).getTime()
      : start + Math.max(turn.latencyMs, 0);
    // epoch 0（1970-01-01）是「起点塌陷」脏数据标记：语义同「缺失」而非真实
    // 时刻，参与 min 聚合会把时延放大成完整毫秒时间戳（1.78e12 ms ≈ 56 年）。
    // 与 NaN 同路剔除（> 0 才视为真实事件时间），长活会话（44 天墙钟跨度）不受影响。
    if (Number.isFinite(start) && start > 0) starts.push(start);
    if (Number.isFinite(end) && end > 0) ends.push(end);
  }
  if (!starts.length || !ends.length) return null;
  const dispatch = dispatchTimestamp ? new Date(dispatchTimestamp).getTime() : NaN;
  const start = Math.min(...starts, ...(Number.isFinite(dispatch) ? [dispatch] : []));
  const end = Math.max(...ends);
  // 列已升 BigInt（64 位）：epoch 0 脏数据在聚合层即被剔除（见上），不再需要
  // INT32_MAX 钳制保列不炸——真实跨度原样入列，长活会话（实测 44 天墙钟跨度）
  // 不再被静默截断成 24.8 天。
  const latencyMs = Math.max(end - start, 0);
  return { responseTimestamp: new Date(end).toISOString(), latencyMs };
}
