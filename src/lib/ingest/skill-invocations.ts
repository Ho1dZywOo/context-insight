// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 技能加载信号（B 形：读文件即技能）的 wire 双形状（真机核实）：
//   claude-code：Skill 展开协议——模型用 Read 工具读 <skill-dir>/SKILL.md，
//     读即调用（工具面自带 read 类工具）
//   codex：skills_instructions 协议——清单只给 (file: rN/<skill>/SKILL.md)
//     相对路径、由模型自行读文件；codex 工具面只有 exec_command /
//     write_stdin（0.162 真机核实，没有 Read 工具），读 SKILL.md 走
//     shell 读类命令（cat/sed/head/tail/less/more/nl）
//   opencode：read 工具 / bash·shell 同信号兼容（解析单源，不做框架分支）
// 产出 SkillInvocationInfo（关联真实工具调用），由 turn-split 单点转成
// SkillEvent——不合成 skill/<name> 工具调用行（历史缺陷：合成行混进
// 工具统计直方图、resultJson 恒空断原文恢复链、无时间戳 durationMs=0）。
// 命令解析（链式分段/白名单/重定向排除/路径切名）上收 tool-conventions，
// 读侧 skill-content 原文恢复共用同一解析。
import type { ToolCallInfo } from '../shared/types';
import {
  parseReadToolArgs,
  detectSkillMdReads,
  isShellToolCall,
  shellReadCommandOf,
  skillNameOfSkillMdPath,
} from '../tool-conventions';

/** B 形技能加载信号（一次 = 真实工具调用 + 技能名 + 文件路径） */
export interface SkillInvocationInfo {
  skillName: string;
  filePath: string;
  /** 承载读取的真实工具调用（Read/read/exec_command/bash/…）wire id */
  sourceToolCallId: string;
}

/** read 类工具名（小写归一后比较） */
const READ_TOOL_NAMES = new Set(['read']);

/**
 * 工具调用序列 → B 形技能加载信号。两个通道各自独立触发；同一 shell 命令
 * 内多个 SKILL.md 路径逐个产出（cat a/SKILL.md b/SKILL.md = 两次加载）。
 */
export function detectSkillInvocations(toolCalls: ToolCallInfo[]): SkillInvocationInfo[] {
  const out: SkillInvocationInfo[] = [];
  for (const tc of toolCalls) {
    const lower = tc.toolName.toLowerCase();
    if (READ_TOOL_NAMES.has(lower)) {
      const filePath = parseReadToolArgs(tc.argsJson)?.filePath ?? '';
      const skillName = filePath ? skillNameOfSkillMdPath(filePath) : null;
      if (skillName) {
        out.push({ skillName, filePath, sourceToolCallId: tc.toolCallId });
      }
    } else if (isShellToolCall(lower)) {
      const cmd = shellReadCommandOf(tc.argsJson);
      if (!cmd) continue;
      for (const read of detectSkillMdReads(cmd)) {
        out.push({ skillName: read.skillName, filePath: read.filePath, sourceToolCallId: tc.toolCallId });
      }
    }
  }
  return out;
}
