// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { parseReadLines } from './file-restore';
import {
  isSkillToolCall,
  extractSkillName,
  parseReadToolArgs,
  unwrapSkillContent,
  isShellToolCall,
  shellReadCommandOf,
  detectSkillMdReads,
  shellReadHasRangeLimit,
  stripExecOutputHeader,
  stripSkillMdBanner,
} from './tool-conventions';

export interface SkillToolCall {
  toolName: string;
  argsJson: string | null;
  resultJson: string | null;
  startedAt?: Date | null;
}

export interface SkillContentResult {
  content: string;
  source: 'skill-tool' | 'read' | 'shell';
  length: number;
  /** 是否判定为读取了完整 SKILL.md。skill-tool 注入恒为 true；read 需无 offset/limit 且无截断标记；shell 需无 head/tail/sed 行范围。 */
  fullRead: boolean;
  /** read 来源时实际读到的最大行号（文件真实行号）；其余来源为 null。 */
  maxLine: number | null;
}

export function extractSkillNameFromReadPath(filePath: string): string | null {
  if (!filePath) return null;
  const norm = filePath.replace(/\\/g, '/');
  if (!norm.toLowerCase().endsWith('/skill.md')) return null;
  const parts = norm.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return parts[parts.length - 2];
}

export function stripSkillPreamble(content: string): string {
  if (content.startsWith('Base directory for this skill:')) {
    const nl = content.indexOf('\n');
    if (nl === -1) return '';
    const rest = content.slice(nl + 1);
    return rest.startsWith('\n') ? rest.slice(1) : rest;
  }
  return content;
}

function joinReadContent(resultJson: string): string {
  const m = parseReadLines(resultJson);
  const keys = [...m.keys()].sort((a, b) => a - b);
  return keys.map(k => m.get(k)!).join('\n');
}

function readMaxLine(resultJson: string): number | null {
  const m = parseReadLines(resultJson);
  if (m.size === 0) return null;
  let max = 0;
  for (const n of m.keys()) if (n > max) max = n;
  return max;
}

function hasReadOffsetOrLimit(argsJson: string | null): boolean {
  const args = parseReadToolArgs(argsJson);
  if (!args) return false;
  return (args.offset != null && args.offset > 0) || args.limit != null;
}

const TRUNCATION_RE = /(?:only\s+showing\s+(?:the\s+)?first\s+\d+\s+lines)|(?:lines?\s+(?:hidden|omitted|not\s+shown|truncated))|(?:content\s+(?:was\s+)?truncat)|(?:file\s+is\s+(?:large|too\s+large))/i;

function hasReadTruncation(resultJson: string | null): boolean {
  if (!resultJson) return false;
  return TRUNCATION_RE.test(resultJson);
}

// codex 终端截断标记（Output 超出 max_output_tokens 时打在输出首行——保留在
// 正文里，模型看得到、 acted upon，是「读到的是截断版」的诚实信号）：
// shell 通道据此把 fullRead 如实降级
const SHELL_TRUNCATED_RE = /Warning: truncated output/i;

/** 单个工具调用承载的 SKILL.md 读取（三通道单点判定：skill-tool / Read / shell）。
 *  摄取侧检测（skill-invocations）与读侧恢复（Skills 面板、Audit 对账、LLM 声明
 *  提取）共用通道词表——通道扩展只改这里。
 *  shell 通道一次命令可读多个 SKILL.md（`cat a/SKILL.md b/SKILL.md`）→ 逐技能
 *  产出；各条 content 均为整段输出（无回显横幅时不拆段，多技能混读是已知精度极限）。
 *  流式 shell（codex exec_command + write_stdin 轮询块）已由 codex-jsonl 适配器
 *  在摄取时卷回完整输出——本层零流式协议知识。 */
export interface SkillMdRead {
  skillName: string;
  source: 'skill-tool' | 'read' | 'shell';
  content: string;
  fullRead: boolean;
  maxLine: number | null;
}

export function skillMdReadsOfToolCall(tc: SkillToolCall): SkillMdRead[] {
  const lower = tc.toolName.toLowerCase();
  if (isSkillToolCall(tc.toolName)) {
    if (!tc.resultJson) return [];
    const skillName = extractSkillName(tc.toolName, tc.argsJson);
    if (!skillName) return [];
    // v2 `<skill_content>` 协议壳优先剥除；v1 纯文本形态回落前言剥离
    const content = unwrapSkillContent(tc.resultJson) ?? stripSkillPreamble(tc.resultJson);
    return [{ skillName, source: 'skill-tool', content, fullRead: true, maxLine: null }];
  }
  if (lower === 'read' && tc.argsJson && tc.resultJson) {
    // read 参数键走词表（opencode `path` / Claude Code `file_path` 等同义键）
    const fp = parseReadToolArgs(tc.argsJson)?.filePath ?? '';
    const skillName = extractSkillNameFromReadPath(fp);
    if (!skillName) return [];
    const partial = hasReadOffsetOrLimit(tc.argsJson) || hasReadTruncation(tc.resultJson);
    return [{
      skillName,
      source: 'read',
      content: joinReadContent(tc.resultJson),
      fullRead: !partial,
      maxLine: readMaxLine(tc.resultJson),
    }];
  }
  if (isShellToolCall(lower) && tc.argsJson && tc.resultJson) {
    // shell 读类命令（codex 无 read 工具，读 SKILL.md 走 exec_command 的
    // cat/sed/…——命令解析与摄取侧 detectSkillMdReads 同源）：resultJson 即
    // 终端输出原文，剥 codex 元数据壳 + 模型自印横幅后即 SKILL.md 原文
    const cmd = shellReadCommandOf(tc.argsJson);
    if (!cmd) return [];
    const output = stripExecOutputHeader(tc.resultJson);
    return detectSkillMdReads(cmd).map(read => ({
      skillName: read.skillName,
      source: 'shell' as const,
      content: stripSkillMdBanner(output),
      fullRead: !shellReadHasRangeLimit(cmd) && !SHELL_TRUNCATED_RE.test(output),
      maxLine: null,
    }));
  }
  return [];
}

export function selectSkillContent(
  toolCalls: SkillToolCall[],
  skillName: string
): SkillContentResult | null {
  const want = (n: string) => n === skillName;

  const skillToolCandidates: SkillMdRead[] = [];
  const readCandidates: SkillMdRead[] = [];
  const shellCandidates: SkillMdRead[] = [];

  for (const tc of toolCalls) {
    for (const r of skillMdReadsOfToolCall(tc)) {
      if (!want(r.skillName)) continue;
      // 空正文不是恢复（壳行/传输残块）——跳过，让更诚实的高通道或 null 胜出
      if (r.content.length === 0) continue;
      if (r.source === 'skill-tool') skillToolCandidates.push(r);
      else if (r.source === 'read') readCandidates.push(r);
      else shellCandidates.push(r);
    }
  }

  const bestOf = (arr: SkillMdRead[]) =>
    arr.reduce((a, b) => (b.content.length > a.content.length ? b : a));

  if (skillToolCandidates.length > 0) {
    const best = bestOf(skillToolCandidates);
    return { content: best.content, source: 'skill-tool', length: best.content.length, fullRead: true, maxLine: null };
  }
  if (readCandidates.length > 0) {
    const best = bestOf(readCandidates);
    return {
      content: best.content,
      source: 'read',
      length: best.content.length,
      fullRead: best.fullRead,
      maxLine: best.maxLine,
    };
  }
  if (shellCandidates.length > 0) {
    const best = bestOf(shellCandidates);
    return {
      content: best.content,
      source: 'shell',
      length: best.content.length,
      fullRead: best.fullRead,
      maxLine: null,
    };
  }

  return null;
}
