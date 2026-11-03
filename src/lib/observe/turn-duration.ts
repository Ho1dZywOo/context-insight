// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. Do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 单轮耗时（Turns 行展示语义）：一轮从开始到自身工作完成的墙钟时长。
// 框架时序语义分两类（依据各源适配器的时长推导口径）：
// - claude 格式会话（全部 proxy wire 捕获 + claude-code 原生）与 codex 原生：
//   轮 latency = 模型生成跨度，工具执行发生在其后（wire：请求→响应→工具
//   完成；native：工具结果在后续轮）→ 单轮 = 生成 + 最慢并行工具（同轮
//   多工具并行，取 max）。判定信号与 wire 时长增补同门（isClaudeFormatSession）。
// - opencode 原生：消息时长（time.completed − time.created）已覆盖 part
//   （工具）执行 → 原值（再相加会双计）。其余未知源同样保守取原值。
// 生成时长缺失但工具有时长时回落工具时长（有信号好过零）。消费方：
// run turns collector 与 session turns 处理器（两投影面同口径）。
import { agentFrameworkOf, isClaudeFormatSession } from '@/lib/shared/session-format';

export function turnWallMs(
  framework: string | null,
  version: string | null,
  latencyMs: number,
  toolDurations: number[],
): number {
  let maxTool = 0;
  for (const d of toolDurations) if (d > maxTool) maxTool = d;
  if (latencyMs <= 0) return maxTool;
  if (maxTool <= 0) return latencyMs;
  if (isClaudeFormatSession(framework, version) || agentFrameworkOf(framework) === 'codex') {
    return latencyMs + maxTool;
  }
  return latencyMs;
}
