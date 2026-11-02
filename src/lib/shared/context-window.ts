// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 未知模型/缺数据时的上下文窗口兜底大小：GLM-5 系等新一代模型普遍 1M
// 上下文，旧 200k 兜底会把上下文水位普遍高估成濒满（饼图/水位条失真）。
// 在线会话页与离线导出查看器共用本常量估算水位，避免两处魔法数各自漂移；
// 服务端逐模型解析的兜底同源（见 context-window-config.ts 的
// FALLBACK_DEFAULT，二者保持一致）。本模块须保持无 node 依赖（浏览器侧可用）。
export const DEFAULT_CONTEXT_WINDOW_LIMIT = 1_000_000;
