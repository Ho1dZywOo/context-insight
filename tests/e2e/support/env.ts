// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

/** UI 显式等待预算：慢机/CI 用 E2E_UI_TIMEOUT_MS 放宽（默认与 Playwright
 *  expect 超时同刻度 10s；导入类长动作在用例内单独给大预算）。 */
export function uiTimeout(defaultMs = 10_000): number {
  const v = Number(process.env.E2E_UI_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : defaultMs;
}
