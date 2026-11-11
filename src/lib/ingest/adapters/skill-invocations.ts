// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 技能加载信号的 wire 双形状（真机核实）→ 统一合成 skill/<name> 工具调用：
//   claude-code：Skill 展开协议——模型用 Read 工具读 <skill-dir>/SKILL.md，
//     读即调用（此前 claude-jsonl 内联实现，此处单源化）
//   codex：skills_instructions 协议——清单只给 (file: rN/<skill>/SKILL.md)
//     相对路径、由模型自行读文件；codex 工具面只有 exec_command /
//     write_stdin（0.162 真机核实，没有 Read 工具），读 SKILL.md 走
//     shell 读类命令（cat/sed/head/tail/less/more/nl）。此前只认 Read，
//     codex 会话的技能使用在 Skills 面板恒空（真机实测：模型 cat 技能
//     文件并按技能输出，面板 0 事件）
// 合成调用经 turn-split 的 isSkillToolCall（skill/ 前缀族）→ SkillEvent 计数，
// Skills 面板/覆盖卡可见；toolCallId 加 skill- 前缀（同轮多技能加载追加
// -2/-3 序号），与既有 Read 通道合成约定一致。
// 边界：Bash 类 shell 工具不认——claude-code 技能加载主通道是 Read，shell
// cat 可能只是普通查看；codex 的 exec_command 是协议主通道（没有别的读法），
// 白名单首 token + /SKILL.md 路径双条件收敛误报。
import type { ToolCallInfo } from '../../shared/types';
import { parseReadToolArgs } from '../../tool-conventions';

/** codex exec_command 的读类命令白名单（首 token） */
const READ_COMMANDS = new Set(['cat', 'sed', 'head', 'tail', 'less', 'more', 'nl']);

/** SKILL.md 路径 → 技能名（父目录名；无父目录回落去尾文件名） */
function skillNameOfPath(filePath: string): string {
  return filePath.split('/').slice(-2, -1)[0]
    || filePath.split('/SKILL.md')[0].split('/').pop()
    || '';
}

/** cmd 文本里的 SKILL.md 路径 token（引号剥离字符类内消化；按首现序去重） */
function skillMdPathsIn(cmd: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of cmd.matchAll(/[^\s'"`;|&()]+\/SKILL\.md/g)) {
    if (!seen.has(m[0])) {
      seen.add(m[0]);
      out.push(m[0]);
    }
  }
  return out;
}

/** exec_command argsJson 的 cmd 归一：字符串直取，数组拼合（防御网关/版本差异） */
function commandOf(argsJson: string | null): string | null {
  if (!argsJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const cmd = (parsed as { cmd?: unknown }).cmd;
  if (typeof cmd === 'string' && cmd) return cmd;
  if (Array.isArray(cmd)) {
    const joined = cmd.filter(s => typeof s === 'string').join(' ');
    return joined || null;
  }
  return null;
}

/**
 * 工具调用序列 → 合成技能调用（skill/<name>，state=completed）。
 * 两个通道各自独立触发；同一工具调用内多个 SKILL.md 路径逐个产出
 * （cat a/SKILL.md b/SKILL.md = 两次技能加载），toolCallId 以序号消歧。
 */
export function detectSkillInvocations(toolCalls: ToolCallInfo[]): ToolCallInfo[] {
  const out: ToolCallInfo[] = [];
  for (const tc of toolCalls) {
    if (tc.toolName === 'Read') {
      const filePath = parseReadToolArgs(tc.argsJson)?.filePath;
      if (filePath && filePath.endsWith('/SKILL.md')) {
        out.push({
          toolCallId: `skill-${tc.toolCallId}`,
          toolName: `skill/${skillNameOfPath(filePath)}`,
          argsJson: JSON.stringify({ skill: skillNameOfPath(filePath), file_path: filePath }),
          resultJson: null,
          state: 'completed',
        });
      }
    } else if (tc.toolName === 'exec_command') {
      const cmd = commandOf(tc.argsJson);
      if (!cmd) continue;
      const firstToken = cmd.trim().split(/\s+/)[0] ?? '';
      if (!READ_COMMANDS.has(firstToken)) continue;
      const paths = skillMdPathsIn(cmd);
      paths.forEach((p, i) => {
        // 重定向目标 = 写入（cat > path/SKILL.md <<EOF），不是技能加载
        const before = cmd.slice(0, cmd.indexOf(p)).trimEnd();
        if (before.endsWith('>')) return;
        const name = skillNameOfPath(p);
        if (!name) return;
        out.push({
          toolCallId: `skill-${tc.toolCallId}${i === 0 ? '' : `-${i + 1}`}`,
          toolName: `skill/${name}`,
          argsJson: JSON.stringify({ skill: name, file_path: p }),
          resultJson: null,
          state: 'completed',
        });
      });
    }
  }
  return out;
}
