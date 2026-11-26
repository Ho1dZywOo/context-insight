// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { parseReadLines, readResultHasLineNumbers } from './file-restore';
import { renderShellEntryText, restoreShellReads, type ShellRestoreEntry } from './shell-restore';
import { injectedEvidence, mergeLineMappedReads, sameDeclarationFile, coverageOfLines, formatRanges, type LineEvidence, type MergedLineRead, type ReadCoverage } from './skill-evidence';
import { toolOutputTruncationFact, toolOutputTruncationOf, type ToolOutputTruncation } from './tool-output-truncation';
import { detectSkillInvocations } from './ingest/skill-invocations';
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
  isSkillInjectionText,
  skillNameOfInjectionText,
} from './tool-conventions';

export interface SkillToolCall {
  toolName: string;
  argsJson: string | null;
  resultJson: string | null;
  startedAt?: Date | null;
}

export interface SkillContentResult {
  content: string;
  source: 'skill-tool' | 'command' | 'read' | 'shell';
  length: number;
  /** 是否判定为读取了完整 SKILL.md。skill-tool/command 注入恒为 true；read 需无 offset/limit 且无截断标记；shell 需无 head/tail/sed 行范围。 */
  fullRead: boolean;
  /** read 来源时实际读到的最大行号（文件真实行号）；其余来源为 null。 */
  maxLine: number | null;
  /** 行级证据：content 覆盖了文件的哪些行、缺哪些行、读取是否被截断。
   *  面板提示、全文校验、对账声明三条消费链共用——缺口只在这里表达，
   *  content 本身只含确实读到的行（不含任何占位/伪造行）。 */
  evidence: LineEvidence;
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

/**
 * 剥 skill 运行时注入尾部（S2 SKILL.md body 与 S3 turn0 注入共用）：
 * skill 加载器在正文后追加的说明块——`Base directory for this skill:` 行、
 * `Relative paths…` 引导行、`Note: file list is sampled.` 行、`<skill_files>` 文件
 * 清单块（~900 字路径列表）。这些是框架注入的元数据不是 SKILL.md 指令，进对账
 * 声明会产出垃圾 findings。
 *
 * 行级过滤保留其余内容：S3 turn0 尾部的用户请求（算子任务描述）与老形态
 * （opencode ≤1.4.7，规程 + 用户请求同消息、无标记）语义对齐。
 */
export function stripSkillRuntimeTail(content: string): string {
  const withoutFileList = content.replace(/<skill_files>[\s\S]*?<\/skill_files>\s*/g, "");
  const lines = withoutFileList.split("\n").filter(
    (l) =>
      !l.startsWith("Base directory for this skill:") &&
      !l.startsWith("Relative paths in this skill") &&
      !l.startsWith("Note: file list is sampled."),
  );
  // 删行遗留的 3+ 连续换行收敛为段间空行（正常 markdown 无三连空行，无标记原文不变）
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function joinReadContent(resultJson: string): string {
  const m = parseReadLines(resultJson);
  const keys = [...m.keys()].sort((a, b) => a - b);
  return keys.map(k => m.get(k)!).join('\n');
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

/** 单个工具调用承载的 SKILL.md 读取（工具调用三通道单点判定：skill-tool /
 *  Read / shell）。轮级第四通道（斜杠命令 system 注入）在 skillMdReadsOfTurn。
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
  source: 'skill-tool' | 'command' | 'read' | 'shell';
  content: string;
  fullRead: boolean;
  maxLine: number | null;
  /** 读取的声明文件路径（read/shell 通道）；同技能名不同路径的读取互不合并。 */
  filePath?: string;
  /** 行级证据（read/shell 通道）：文件行号 → 内容。跨候选按行号校准拼接、
   *  缺口诚实评分的素材；注入快照（skill-tool/command）无行号语义 → 不带。 */
  lineMap?: Map<number, string>;
  /** 该次读取能判定的文件总行数。 */
  fileLines?: number | null;
  /** 该次读取的工具输出被截断。 */
  truncated?: boolean;
  /** 读取命令自带行范围（shell：该文件的转储被 sed/head 裁行；read：offset/limit）：
   *  没读到文件尾是命令有意为之。 */
  ranged?: boolean;
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
    return [{ skillName, source: 'skill-tool', content, fullRead: true, maxLine: null, truncated: false, fileLines: null, ts: tsOf(tc) }];
  }
  if (lower === 'read' && tc.argsJson && tc.resultJson) {
    // read 参数键走词表（opencode `path` / Claude Code `file_path` 等同义键）
    const fp = parseReadToolArgs(tc.argsJson)?.filePath ?? '';
    const skillName = extractSkillNameFromReadPath(fp);
    if (!skillName) return [];
    const partial = hasReadOffsetOrLimit(tc.argsJson) || hasReadTruncation(tc.resultJson);
    // 运行环境截断以截断单点为准（Read 通道自带的 TRUNCATION_RE 不认 opencode
    // 结果尾落盘行等固定位置形态）。被截断且输出不带行号时，行号是按 offset
    // 推算的、未必对应文件行（尾部截断留下的是流的后半段）→ 不给行级证据
    const harnessTruncated = toolOutputTruncationOf(tc.resultJson) != null;
    const lineNumbersTrusted = !harnessTruncated || readResultHasLineNumbers(tc.resultJson);
    const lineMap = lineNumbersTrusted ? parseReadLines(tc.resultJson, extractOffsetOf(tc.argsJson)) : new Map<number, string>();
    const truncated = hasReadTruncation(tc.resultJson) || harnessTruncated;
    const maxLine = lineMap.size > 0 ? Math.max(...lineMap.keys()) : null;
    const fullRead = !partial && !harnessTruncated;
    return [{
      skillName,
      source: 'read',
      filePath: fp,
      content: joinReadContent(tc.resultJson),
      fullRead,
      maxLine,
      // 无 offset/limit 且无截断 = 整文件读到尾，最大行号即文件总行数
      fileLines: fullRead ? maxLine : null,
      truncated,
      ranged: hasReadOffsetOrLimit(tc.argsJson),
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
    const attributed = new Map<string, ShellRestoreEntry>();
    for (const entry of restoreShellReads(tc.argsJson, tc.resultJson)) {
      const name = skillNameOfSkillMdPath(entry.filePath);
      if (name != null && entry.lines.size > 0) attributed.set(name, entry);
    }
    const truncated = SHELL_TRUNCATED_RE.test(tc.resultJson);
    const rangeLimited = cmds.some((c) => shellReadHasRangeLimit(c));
    return detected.map(read => {
      const entry = attributed.get(read.skillName);
      if (!entry) {
        return { skillName: read.skillName, source: 'shell' as const, filePath: read.filePath, content: '', fullRead: false, maxLine: null, fileLines: null, truncated: false, ts: tsOf(tc) };
      }
      const { content, maxLine, covered } = renderShellEntryText(entry);
      return {
        skillName: read.skillName,
        source: 'shell' as const,
        filePath: entry.filePath,
        content,
        fullRead: !rangeLimited && !truncated && entry.fileLines != null && covered >= entry.fileLines,
        maxLine,
        fileLines: entry.fileLines,
        truncated,
        ranged: entry.rangeLimited,
        lineMap: entry.lines,
        ts: tsOf(tc),
      };
    });
  }
  return [];
}

/** 斜杠命令注入轮（claude-code v1 形态）：/skill 展开的全文快照由 adapter 从
 *  wire 的 user 行重分类为 system 轮入库（现场实证：5295af91 全文 19823 字符
 *  完好在库）。判定复用 isSkillInjectionText 指纹单点；正文剥前言与运行时尾部：
 *  stripSkillPreamble 剥行首 marker（C 形），stripSkillRuntimeTail 剥中部 marker 块
 *  与 <skill_files> 尾部（S3 形，opencode ≥1.17 marker 在正文后）——与 collect 路
 *  径同口径。技能名提取要求 Base directory 行，其余注入形态前言不可剥 →
 *  不产出，宁缺毋假。注入即调用时刻的权威全文，与 skill-tool 信封同族。 */
export interface SkillInjectionTurn {
  role: string;
  content: string | null;
  createdAt?: Date | null;
}

export function skillMdReadsOfTurn(turn: SkillInjectionTurn): SkillMdRead[] {
  if (turn.role !== 'system' || !turn.content) return [];
  if (!isSkillInjectionText(turn.content)) return [];
  const skillName = skillNameOfInjectionText(turn.content);
  if (!skillName) return [];
  const content = stripSkillRuntimeTail(stripSkillPreamble(turn.content));
  if (content.length === 0) return [];
  return [{
    skillName,
    source: 'command',
    content,
    fullRead: true,
    maxLine: null,
    ts: turn.createdAt ? turn.createdAt.getTime() : null,
  }];
}

function tsOf(tc: SkillToolCall): number | null {
  const ts = tc.startedAt ? tc.startedAt.getTime() : NaN;
  return Number.isFinite(ts) ? ts : null;
}

function extractOffsetOf(argsJson: string | null): number | undefined {
  return parseReadToolArgs(argsJson)?.offset ?? undefined;
}

/**
 * 行号读取合并为一份声明文本（read + shell 候选共享，root 对账候选同用）：
 * - 同技能名可能对应不同路径的文件（项目级 / 用户级同名 skill）→ 先按路径分组，
 *   各组合并，取可靠行最多的一组（并列取时间序最晚）；
 * - 组内合并口径见 mergeLineMappedReads：同号行内容一致才保留，矛盾即弃用并上报；
 * - fullRead = 文件总行数可知且 1..fileLines 每行都有可靠内容（多段读取拼齐
 *   整份文件同样成立；仅有界读 head/sed 范围无法证明文件结束）。
 * source = 贡献行占多数的通道。无任何可靠行 → null。
 */
export function mergeSkillReads(cands: SkillMdRead[]): SkillContentResult | null {
  const groups: SkillMdRead[][] = [];
  for (const c of cands) {
    if (!c.lineMap || c.lineMap.size === 0) continue;
    const group = groups.find(g => sameDeclarationFile(g[0]!.filePath ?? '', c.filePath ?? ''));
    if (group) group.push(c);
    else groups.push([c]);
  }
  let best: { merged: MergedLineRead; reads: SkillMdRead[] } | null = null;
  for (const reads of groups) {
    const merged = mergeLineMappedReads(reads.map(r => ({
      lineMap: r.lineMap!,
      ts: r.ts ?? null,
      fileLines: r.fileLines ?? null,
      truncated: r.truncated ?? false,
    })));
    if (!merged) continue;
    const lastTs = Math.max(...reads.map(r => r.ts ?? 0));
    if (!best || merged.lines.size > best.merged.lines.size
      || (merged.lines.size === best.merged.lines.size && lastTs > Math.max(...best.reads.map(r => r.ts ?? 0)))) {
      best = { merged, reads };
    }
  }
  if (!best) return null;
  const { merged, reads } = best;
  // 按读到的「行」判多数，不按读取「次数」判：1 次 Read 只读 3 行 vs 1 次 shell
  // cat 读 168 行时，次数 1:1 会把来源误判成 read。逐行以最后一个贡献者（ts 序）定归属。
  const lineSource = new Map<number, 'read' | 'shell'>();
  for (const r of [...reads].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))) {
    const src: 'read' | 'shell' = r.source === 'read' ? 'read' : 'shell';
    for (const n of r.lineMap?.keys() ?? []) {
      if (merged.lines.has(n)) lineSource.set(n, src);
    }
  }
  const readContrib = [...lineSource.values()].filter(s => s === 'read').length;
  const content = merged.evidence.lineNumbers.map(n => merged.lines.get(n)!).join('\n');
  return {
    content,
    source: readContrib >= merged.lines.size - readContrib ? 'read' : 'shell',
    length: content.length,
    fullRead: merged.complete,
    maxLine: merged.maxLine,
    evidence: merged.evidence,
  };
}

/** 一次会话里对某技能的全部读取（工具调用三通道 + 斜杠命令 system 注入轮），
 *  通道分类只跑一遍；按技能名选取见 selectFromSkillReads。 */
export function collectSkillReads(toolCalls: SkillToolCall[], turns: SkillInjectionTurn[] = []): SkillMdRead[] {
  const reads: SkillMdRead[] = [];
  for (const tc of toolCalls) reads.push(...skillMdReadsOfToolCall(tc));
  for (const turn of turns) reads.push(...skillMdReadsOfTurn(turn));
  return reads;
}

/** 从已分类的读取里恢复某技能的声明文本：① 注入快照（权威全文）> ② read+shell
 *  行号校准合并 > ③ 兜底单候选。空正文不是恢复（壳行/传输残块/归因失败）——
 *  跳过，让更高通道或 null 胜出。 */
export function selectFromSkillReads(reads: SkillMdRead[], skillName: string): SkillContentResult | null {
  const injectionCandidates: SkillMdRead[] = [];
  const lineMapped: SkillMdRead[] = [];
  const legacy: SkillMdRead[] = [];
  for (const r of reads) {
    if (r.skillName !== skillName) continue;
    if (r.content.length === 0) continue;
    if (r.source === 'skill-tool' || r.source === 'command') injectionCandidates.push(r);
    else if (r.lineMap && r.lineMap.size > 0) lineMapped.push(r);
    else legacy.push(r);
  }

  if (injectionCandidates.length > 0) {
    const best = injectionCandidates.reduce((a, b) => (b.content.length > a.content.length ? b : a));
    return { content: best.content, source: best.source, length: best.content.length, fullRead: true, maxLine: null, evidence: injectedEvidence() };
  }
  const merged = mergeSkillReads(lineMapped);
  if (merged) return merged;
  if (legacy.length > 0) {
    const best = legacy.reduce((a, b) => (b.content.length > a.content.length ? b : a));
    return {
      content: best.content,
      source: best.source,
      length: best.content.length,
      fullRead: best.fullRead,
      maxLine: best.maxLine,
      evidence: { ...injectedEvidence(), truncated: best.truncated ?? false },
    };
  }
  return null;
}

export function selectSkillContent(
  toolCalls: SkillToolCall[],
  skillName: string,
  turns: SkillInjectionTurn[] = [],
): SkillContentResult | null {
  return selectFromSkillReads(collectSkillReads(toolCalls, turns), skillName);
}

// ── 逐次调用级：一次技能调用 agent 拿到了多少 SKILL.md ──────────────────────────
// 两个展示面共用一套归因与结论：Skills 页的「逐次调用」一行 = 一个技能事件
// (turnId, skillName)；turn 详情 Tool Calls 的一行 = 一个工具调用。两个正交事实，
// 各自有单点，这里只做对位与合成：
//   · 工具输出截断 —— tool-output-truncation（运行环境砍了输出）。哪个调用读了
//     哪个技能，与摄取侧创建 SkillEvent 用同一检测（detectSkillInvocations），
//     事件与调用天然对得上；
//   · 读取覆盖面 —— 上面 skillMdReadsOfToolCall 的行级证据 → skill-evidence 的
//     coverageOfLines 三态（full / partial / unproven）。文件总行数在同一份文件的
//     各次读取间共享（有界读自身判不出文件多长）。
// 合成规则（skillReadMarkOf）只在可证时下结论：拿到全文 → 不标；输出被截断 →
// 标截断（能定行号时写 agent 实际读到的行，否则写输出规模）；命令自带行范围而
// 没读全 → 标部分读取；证明不了 → 不标。
/** 参与归因的工具调用行（读 SKILL.md 的候选 + 命中截断超集的调用） */
export interface SkillReadCall {
  turnId: string;
  toolCallId: string;
  toolName: string;
  argsJson: string | null;
  resultJson: string | null;
  startedAt?: Date | null;
}

/** 技能事件的对位键：事件 = (turnId, skillName) */
export function skillReadEventKey(turnId: string, skillName: string): string {
  return `${turnId}\n${skillName}`;
}

/** 截断的工具调用 → 它们读取的技能，键见 skillReadEventKey。同一技能在一轮内被
 *  多次读取时任一次被截即记为截断。 */
export function skillReadTruncationsOf(calls: SkillReadCall[]): Map<string, ToolOutputTruncation> {
  const out = new Map<string, ToolOutputTruncation>();
  for (const tc of calls) {
    const truncation = toolOutputTruncationOf(tc.resultJson);
    if (truncation == null) continue;
    for (const inv of detectSkillInvocations([
      { toolCallId: tc.toolCallId, toolName: tc.toolName, argsJson: tc.argsJson, resultJson: null, state: 'ok' },
    ])) {
      out.set(skillReadEventKey(tc.turnId, inv.skillName), truncation);
    }
  }
  return out;
}

/** 时间序最晚的可判定文件总行数（有界读 / 转储未抵达流尾的读取判不出 → null） */
function latestFileLines(reads: SkillMdRead[]): number | null {
  let best: { ts: number; fileLines: number } | null = null;
  for (const r of reads) {
    if (r.fileLines == null || r.fileLines <= 0) continue;
    const ts = r.ts ?? 0;
    if (!best || ts >= best.ts) best = { ts, fileLines: r.fileLines };
  }
  return best?.fileLines ?? null;
}

/** 一组工具调用的技能读取归因：引擎只跑一遍，事件级与调用级共用 */
export interface SkillReadAttribution {
  /** 与入参 calls 下标对齐：该调用读到的 SKILL.md（不是技能读取 = 空数组） */
  reads: SkillMdRead[][];
  /** 同一份文件（字面相同或互为路径后缀）在入参范围内时间序最晚的可判定总行数 */
  fileLinesOf: (filePath: string) => number | null;
}

export function attributeSkillReads(calls: SkillToolCall[]): SkillReadAttribution {
  const fileGroups: Array<{ path: string; reads: SkillMdRead[] }> = [];
  const reads = calls.map(tc => {
    const own = skillMdReadsOfToolCall({
      toolName: tc.toolName,
      argsJson: tc.argsJson,
      resultJson: tc.resultJson,
      startedAt: tc.startedAt ?? null,
    });
    for (const read of own) {
      if (!read.filePath) continue;
      const group = fileGroups.find(g => sameDeclarationFile(g.path, read.filePath!));
      if (group) group.reads.push(read);
      else fileGroups.push({ path: read.filePath, reads: [read] });
    }
    return own;
  });
  return {
    reads,
    fileLinesOf: filePath => {
      const group = fileGroups.find(g => sameDeclarationFile(g.path, filePath));
      return group ? latestFileLines(group.reads) : null;
    },
  };
}

/** 一组读取（一次调用 / 一个技能事件）的覆盖面：注入快照即全文；否则这组读取
 *  自己判出的文件总行数优先，判不出才借同一份文件其他读取的。 */
export function coverageOfReads(
  reads: SkillMdRead[],
  sharedFileLines: (filePath: string) => number | null,
): ReadCoverage | null {
  if (reads.some(r => r.source === 'skill-tool' || r.source === 'command')) {
    return { kind: 'full', lines: [], fileLines: null };
  }
  const path = reads.find(r => r.filePath)?.filePath;
  return coverageOfLines(
    reads.flatMap(r => [...(r.lineMap?.keys() ?? [])]),
    latestFileLines(reads) ?? (path == null ? null : sharedFileLines(path)),
    reads.some(r => r.ranged === true),
  );
}

/** 技能事件 → 这次调用的读取覆盖面。只给确有读取证据的事件产出（无从判定
 *  的事件不出现在结果里）。events = 需要判定的技能事件（非 dispatch）。 */
export function skillReadCoveragesOf(
  calls: SkillReadCall[],
  events: Iterable<{ turnId: string; skillName: string }>,
): Map<string, ReadCoverage> {
  const eventKeys = new Set([...events].map(e => skillReadEventKey(e.turnId, e.skillName)));
  const attribution = attributeSkillReads(calls);
  const readsByKey = new Map<string, SkillMdRead[]>();
  calls.forEach((tc, i) => {
    for (const read of attribution.reads[i]) {
      const key = skillReadEventKey(tc.turnId, read.skillName);
      if (!eventKeys.has(key)) continue;
      const list = readsByKey.get(key);
      if (list) list.push(read);
      else readsByKey.set(key, [read]);
    }
  });

  const out = new Map<string, ReadCoverage>();
  for (const [key, reads] of readsByKey) {
    const coverage = coverageOfReads(reads, attribution.fileLinesOf);
    if (coverage != null) out.set(key, coverage);
  }
  return out;
}

/** 单个工具调用的读取标记（turn 详情 Tool Calls 行）：这次调用自己读到了多少
 *  SKILL.md，与技能事件行同一套合成规则——总行数在本组调用范围内共享。返回值
 *  与入参下标对齐；输出被截断的调用恒有标记（拿全文的极端情形退回输出规模）。 */
export function skillReadMarksOfCalls(calls: SkillToolCall[]): Array<SkillReadMark | null> {
  const attribution = attributeSkillReads(calls);
  return calls.map((tc, i) => {
    const truncation = toolOutputTruncationOf(tc.resultJson);
    const coverage = coverageOfReads(attribution.reads[i], attribution.fileLinesOf);
    return skillReadMarkOf(truncation, coverage)
      ?? (truncation != null ? { kind: 'truncated' as const, fact: toolOutputTruncationFact(truncation) } : null);
  });
}

/** 逐次调用行的展示结论：标什么、说明写什么 */
export type SkillReadMark =
  | { kind: 'truncated'; fact: string }
  | { kind: 'partial'; fact: string };

export function skillReadMarkOf(
  truncation: ToolOutputTruncation | null | undefined,
  coverage: ReadCoverage | null | undefined,
): SkillReadMark | null {
  // 这次调用拿到了全文：不标（被截断的调用，缺的部分由同一轮的另一次读取补齐）
  if (coverage?.kind === 'full') return null;
  const readLines = coverage != null && coverage.lines.length > 0 ? formatRanges(coverage.lines) : null;
  const fileTotal = coverage?.fileLines != null ? `SKILL.md 共 ${coverage.fileLines} 行` : null;
  if (truncation != null) {
    if (readLines == null) return { kind: 'truncated', fact: toolOutputTruncationFact(truncation) };
    const read = fileTotal != null
      ? `${fileTotal}，agent 读到第 ${readLines} 行`
      : `agent 读到 SKILL.md 的第 ${readLines} 行`;
    return { kind: 'truncated', fact: `输出被截断，${read}。` };
  }
  if (coverage?.kind !== 'partial' || readLines == null) return null;
  const read = fileTotal != null
    ? `agent 只读取了第 ${readLines} 行（${fileTotal}）`
    : `agent 只读取了 SKILL.md 的第 ${readLines} 行`;
  return { kind: 'partial', fact: `${read}。` };
}
