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
    if (Number.isFinite(start)) starts.push(start);
    if (Number.isFinite(end)) ends.push(end);
  }
  if (!starts.length || !ends.length) return null;
  const dispatch = dispatchTimestamp ? new Date(dispatchTimestamp).getTime() : NaN;
  const start = Math.min(...starts, ...(Number.isFinite(dispatch) ? [dispatch] : []));
  const end = Math.max(...ends);
  // 列已升 BigInt（64 位）：早期「起点塌成 epoch 0、时延=完整毫秒时间戳
  // 1.78e12」的脏数据曾撑破 Int32 列，当时以 INT32_MAX 钳制保列不炸——
  // 根因修复后（schema BigInt + bigint-json 序列化垫片）真实跨度原样入列，
  // 长活会话（实测 44 天墙钟跨度）不再被静默截断成 24.8 天。
  const latencyMs = Math.max(end - start, 0);
  return { responseTimestamp: new Date(end).toISOString(), latencyMs };
}
