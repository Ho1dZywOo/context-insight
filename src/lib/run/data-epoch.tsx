"use client";
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { createContext, useContext } from "react";

/**
 * run 数据纪元（run 工作台刷新契约）。
 *
 * 页面在数据重载（自动同步 / 手动刷新）后把纪元 +1；tab 不再以纪元当身份
 * key 重挂——那是「数据版本」被误当「视图身份」用：重挂即抛阅读态（滚动/
 * 展开/搜索/详情仓/Graph 相机），用户正在读的轮被重置。改为 tab 保持挂载，
 * 取数 effect 订阅本纪元（加入 deps）原地重取——数据更新与视图身份解耦。
 *
 * 语义约定：
 * - 纪元 0 = 首装基线（消费方跳过，避免挂载即双取）
 * - 纪元 +1 = 软刷新：数据增量变化（新轮次追加 / 指标更新），身份不变
 * - 身份重挂（源回溯全量重建等破坏性变化）由页面另行换 identity key，
 *   不走本纪元
 *
 * 提供者挂在 run 页 tab 面板容器上（页面局部，无跨页泄漏）。
 */
export const RunDataEpochContext = createContext<number>(0);

/** 取当前 run 数据纪元（取数 effect 依赖；变化 = 数据已重载，原地重取） */
export function useRunDataEpoch(): number {
  return useContext(RunDataEpochContext);
}
