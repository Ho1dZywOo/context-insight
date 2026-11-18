// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { parseReadLines } from './file-restore';
import { renderShellEntryText, restoreShellReads } from './shell-restore';
import {
  isSkillToolCall,
  extractSkillName,
  parseReadToolArgs,
  unwrapSkillContent,
  isShellToolCall,
  shellCommandTextsOf,
  detectSkillMdReadsOfShell,
  shellReadHasRangeLimit,
  skillNameOfSkillMdPath,
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
 *  产出；正文经 shell-restore 引擎归因（引号感知分段 → 段分类 → 行号校准），
 *  只含该 SKILL.md 自己的行——回显横幅/截断 banner/无关命令输出不再混入
 *  （此前整段输出当正文，「最长者胜」会把污染版选成声明）。
 *  归因失败（多文件混 dump、管道过滤段、无锚点截断）→ content 空串：候选骨架
 *  保留（事件级语义——技能确实被读过），正文级消费方自然跳过（宁缺毋假）。
 *  流式 shell（codex exec_command + write_stdin 轮询块）已由 codex-jsonl 适配器
 *  在摄取时卷回完整输出——本层零流式协议知识。 */
export interface SkillMdRead {
  skillName: string;
  source: 'skill-tool' | 'read' | 'shell';
  content: string;
  fullRead: boolean;
  maxLine: number | null;
  /** 行级证据（read/shell 通道）：文件行号 → 内容。跨候选按行号校准拼接、
   *  缺口诚实评分的素材；skill-tool 注入快照无行号语义 → 不带。 */
  lineMap?: Map<number, string>;
  /** 时间序（跨候选合并：ts 后到者覆盖同号行；缺 ts 保序） */
  ts?: number | null;
}

export function skillMdReadsOfToolCall(tc: SkillToolCall): SkillMdRead[] {
  const lower = tc.toolName.toLowerCase();
  if (isSkillToolCall(tc.toolName)) {
    if (!tc.resultJson) return [];
    const skillName = extractSkillName(tc.toolName, tc.argsJson);
    if (!skillName) return [];
    // v2 `<skill_content>` 协议壳优先剥除；v1 纯文本形态回落前言剥离
    const content = unwrapSkillContent(tc.resultJson) ?? stripSkillPreamble(tc.resultJson);
    return [{ skillName, source: 'skill-tool', content, fullRead: true, maxLine: null, ts: tsOf(tc) }];
  }
  if (lower === 'read' && tc.argsJson && tc.resultJson) {
    // read 参数键走词表（opencode `path` / Claude Code `file_path` 等同义键）
    const fp = parseReadToolArgs(tc.argsJson)?.filePath ?? '';
    const skillName = extractSkillNameFromReadPath(fp);
    if (!skillName) return [];
    const partial = hasReadOffsetOrLimit(tc.argsJson) || hasReadTruncation(tc.resultJson);
    const lineMap = parseReadLines(tc.resultJson, extractOffsetOf(tc.argsJson));
    return [{
      skillName,
      source: 'read',
      content: joinReadContent(tc.resultJson),
      fullRead: !partial,
      maxLine: readMaxLine(tc.resultJson),
      lineMap,
      ts: tsOf(tc),
    }];
  }
  if (isShellToolCall(lower) && tc.argsJson && tc.resultJson) {
    // shell 读类命令（codex 无 read 工具，读 SKILL.md 走 exec_command 的
    // cat/sed/…）：候选骨架走命令侧检测（与摄取侧 detectSkillMdReads 同源），
    // 正文走 shell-restore 引擎按技能名归因取行——两者按 SKILL.md 路径的
    // 父目录名对上即有正文，对不上（混 dump/管道/无锚点）即空串。
    // 检测面与归因面同源（shellCommandTextsOf）：command/cmd 键与 codex input
    // 内嵌 exec_command 两形态都参与，否则 input 形态读 SKILL.md 检测恒空。
    const cmds = shellCommandTextsOf(tc.argsJson);
    const detected = detectSkillMdReadsOfShell(tc.argsJson);
    if (detected.length === 0) return [];
    const attributed = new Map<string, ReturnType<typeof restoreShellReads>[number]>();
    for (const entry of restoreShellReads(tc.argsJson, tc.resultJson)) {
      const name = skillNameOfSkillMdPath(entry.filePath);
      if (name != null && entry.lines.size > 0) attributed.set(name, entry);
    }
    const truncated = SHELL_TRUNCATED_RE.test(tc.resultJson);
    const rangeLimited = cmds.some((c) => shellReadHasRangeLimit(c));
    return detected.map(read => {
      const entry = attributed.get(read.skillName);
      if (!entry) {
        return { skillName: read.skillName, source: 'shell' as const, content: '', fullRead: false, maxLine: null, ts: tsOf(tc) };
      }
      const { content, maxLine, covered } = renderShellEntryText(entry);
      return {
        skillName: read.skillName,
        source: 'shell' as const,
        content,
        fullRead: !rangeLimited && !truncated && covered > 0,
        maxLine,
        lineMap: entry.lines,
        ts: tsOf(tc),
      };
    });
  }
  return [];
}

function tsOf(tc: SkillToolCall): number | null {
  return tc.startedAt ? tc.startedAt.getTime() : null;
}

function extractOffsetOf(argsJson: string | null): number | undefined {
  return parseReadToolArgs(argsJson)?.offset ?? undefined;
}

/** 行号校准合并（read + shell 候选共享）：按 ts 时间序逐候选合入行表，
 *  同号行后到者覆盖（文件被改后重读 = 终态视角，与恢复引擎同构）。
 *  fullRead 的诚实口径：合并表 1..maxLine 连续 **且** 至少一个候选来自
 *  无界读（cat/无 offset 的 Read——有界读 head/sed 范围无法证明文件结束）。
 *  source = 贡献行数占多数的通道。 */
function mergeLineMapped(cands: SkillMdRead[]): Omit<SkillContentResult, 'length'> | null {
  const sorted = [...cands].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  const lines = new Map<number, string>();
  const lineSource = new Map<number, 'read' | 'shell'>();
  let unboundedAttempt = false;
  for (const c of sorted) {
    if (!c.lineMap || c.lineMap.size === 0) continue;
    if (c.fullRead) unboundedAttempt = true;
    for (const [n, text] of c.lineMap) {
      lines.set(n, text);
      lineSource.set(n, c.source as 'read' | 'shell');
    }
  }
  if (lines.size === 0) return null;

  let maxLine = 0;
  for (const n of lines.keys()) if (n > maxLine) maxLine = n;
  let contiguous = true;
  for (let n = 1; n <= maxLine; n++) {
    if (!lines.has(n)) { contiguous = false; break; }
  }
  const readContrib = [...lineSource.values()].filter(s => s === 'read').length;
  const content = [...lines.keys()].sort((a, b) => a - b).map(n => lines.get(n)!).join('\n');
  return {
    content,
    source: readContrib >= lines.size - readContrib ? 'read' : 'shell',
    fullRead: contiguous && unboundedAttempt,
    maxLine,
  };
}

export function selectSkillContent(
  toolCalls: SkillToolCall[],
  skillName: string
): SkillContentResult | null {
  const want = (n: string) => n === skillName;

  const skillToolCandidates: SkillMdRead[] = [];
  const lineMapped: SkillMdRead[] = [];
  const legacy: SkillMdRead[] = [];

  for (const tc of toolCalls) {
    for (const r of skillMdReadsOfToolCall(tc)) {
      if (!want(r.skillName)) continue;
      // 空正文不是恢复（壳行/传输残块/归因失败）——跳过，让更诚实的高通道或 null 胜出
      if (r.content.length === 0) continue;
      if (r.source === 'skill-tool') skillToolCandidates.push(r);
      else if (r.lineMap && r.lineMap.size > 0) lineMapped.push(r);
      else legacy.push(r);
    }
  }

  // ① skill-tool 注入快照（权威全文）> ② read+shell 行号校准合并 > ③ 兜底单候选
  if (skillToolCandidates.length > 0) {
    const best = skillToolCandidates.reduce((a, b) => (b.content.length > a.content.length ? b : a));
    return { content: best.content, source: 'skill-tool', length: best.content.length, fullRead: true, maxLine: null };
  }
  const merged = mergeLineMapped(lineMapped);
  if (merged) return { ...merged, length: merged.content.length };
  if (legacy.length > 0) {
    const best = legacy.reduce((a, b) => (b.content.length > a.content.length ? b : a));
    return {
      content: best.content,
      source: best.source,
      length: best.content.length,
      fullRead: best.fullRead,
      maxLine: best.maxLine,
    };
  }

  return null;
}
