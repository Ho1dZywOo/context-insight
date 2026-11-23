// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

export interface SessionListItem {
  id: string;
  createdAt: string;
  endedAt?: string | null;
  firstQuery: string | null;
  turnCount: number;
  modelName: string | null;
  totalTokens?: number | null;
  version?: string | null;
  /** 会话级身份声明（身份归会话、格式归文件）：容器型源（insight 导出件）
   *  必填——件内每个会话的 agent 框架可以互不相同；单框架源可缺省
   *  （文件本身就是该框架的存储，身份由源级声明兜底） */
  framework?: string | null;
}

export interface RawInteraction {
  role: string;
  content: string | null;
  timestamp: string;
  timeInfo: {
    created: number;
    completed?: number;
  } | null;
  agent: string | null;
  subagent_name: string | null;
  subagent_session_id: string | null;
  subagent_type: string | null;
  tool_calls: ToolCallInfo[] | null;
  usage: TokenUsage | null;
  model: string | null;
  modelID: string | null;
  providerID: string | null;
  latency: number | null;
  finish_reason: string | null;
}

// 子代理关联映射（claude-jsonl 适配器产出，bridge-builder 建桥消费）。
// 三条精确连接键，按可靠性排序：toolUseId（meta 直锚）> claudeAgentId
//（claude 逻辑成员身份，meta 落盘）> 任务文本（派发 prompt ↔ 子文件首条
// 用户任务，trim 归一——老版本捕获 meta 全空时的兜底硬链，与 cpx 的
// subagentTaskTextOf 语义手工对齐，两包不互相 import）。
export interface SubagentLinkageMaps {
  toolUseIdToSessionId: Map<string, string>;
  claudeAgentIdToSessionId: Map<string, string>;
  taskToSessionId: Map<string, string>;
}

export interface ToolCallInfo {  toolCallId: string;
  toolName: string;
  argsJson: string | null;
  resultJson: string | null;
  state: string;
  /** 适配器解析的错误语义通道（passthrough-first）：证据只在 adapter 可见时
   *  （codex 传输壳剥壳前、claude/codex-proxy 声明信封）解析成最终 errorType；
   *  turn-split 直采，缺失时核心管线用 classifyToolCallError 从 resultJson 兜底。 */
  errorType?: string | null;
  /** 错误证据文本（≤200 字符），与 errorType 同通道同源。 */
  errorMessage?: string | null;
  /** 工具发起时刻（ms epoch，源有则填；claude-jsonl=tool_use 行 ts，opencode=part.time_created） */
  startedAt?: number | null;
  /** 工具完成时刻（ms epoch，源有则填；claude-jsonl=tool_result 行 ts，opencode=终态 part.time_updated）。缺省 null=源无此信息，消费方降级 */
  completedAt?: number | null;
}

export interface TokenUsage {
  total: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  inputMessagesTokens: number;
}
