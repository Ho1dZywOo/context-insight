// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Turn 详情页统一文本块语法：正文 / thinking / 工具调用（含 skill 派发）/
// 输入消息共用同一套容器与行样式。块 = 圆角灰底容器（靠底色对比立足，
// 不靠描边），块内分节用发丝线，状态与类型只用字色表达——三种构成在
// 同屏永远同口径。LlmOutputView / ToolCallList / TurnInputCard 三处同源
// 引用，改语法只改这里。
export const BLOCK = "rounded-xl bg-muted/60 overflow-hidden"
export const BLOCK_ROW = "flex items-center gap-2 px-3 py-1.5"
export const BLOCK_SUB = "border-t border-foreground/[0.06] px-3 py-2"
export const BLOCK_TRI = "shrink-0 px-2 py-1 -mr-2 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 cursor-pointer select-none"
