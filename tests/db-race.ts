// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 共享测试库的并行文件竞态重试（历史层）。2026-11-25 起测试库按 worker 分片
// （tests/worker-db.ts）：vitest isolate 默认下每测试文件独立分片库，跨文件
// 互撞的根因已从基础设施层根治；进程复用形态下同进程文件串行共享，仍可能
// 出现「上一文件泄漏的行与本文件 merge update 赛跑」（e2e-import-observe /
// lake 等用同一 opencode fixture 场景，P2025 瞬时消失）——对这类保留重试
// 一次即可通过，本助手降级为纵深防御。
export async function withDbRaceRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : '';
    if (msg.includes('No record was found') || msg.includes('Session not found')) return await fn();
    throw e;
  }
}
