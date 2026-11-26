// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See the License in the root of the software repository for the full text of the License.

// 声明文件的行级证据模型（纯函数、零依赖：恢复层产出，API/对账链/前端共用）。
//
// 会话里 agent 读一份声明文件（SKILL.md 等）时，工具输出可能被 harness 截断、
// 命令本身带行范围、或分多次读。恢复层能拿回的是「确实读到过的那些行」——
// 证据对象把这份覆盖面如实表达：哪些行有正文、文件共多少行（可知时）、
// 哪些行没读到、读取过程中是否出现过截断。未读到的行不补、不猜。

/** 未读到可靠内容的行区间（闭区间）。 */
export interface LineGap {
  from: number;
  to: number;
}

/** 一份声明文本的行级证据。 */
export interface LineEvidence {
  /** 与文本逐行对齐的文件行号。 */
  lineNumbers: number[];
  /** 文件总行数；无法判定时为 null（尾部是否读完未知）。 */
  fileLines: number | null;
  /** 未读到可靠内容的行区间；fileLines 已知时含文件尾部。 */
  gaps: LineGap[];
  /** 会话中读取该文件的工具输出出现过截断。 */
  truncated: boolean;
  /** 多次读取内容不一致、无法判定哪次可信而整体弃用的行。 */
  conflictLines: number[];
  /** 参与合并的读取次数。 */
  readCount: number;
}

/** 一次带行号的读取（Read 通道 / shell 归因引擎产出的行表）。 */
export interface LineMappedRead {
  lineMap: Map<number, string>;
  /** 时间序（毫秒）；缺 ts 保序。 */
  ts: number | null;
  /** 该次读取能判定的文件总行数。 */
  fileLines?: number | null;
  /** 该次读取的工具输出被截断。 */
  truncated?: boolean;
}

export interface MergedLineRead {
  /** 文件行号 → 内容；只含从未被矛盾过的行。 */
  lines: Map<number, string>;
  maxLine: number;
  /** 1..fileLines 全部有可靠内容。 */
  complete: boolean;
  evidence: LineEvidence;
}

export function toRanges(nums: number[]): LineGap[] {
  const sorted = [...nums].sort((a, b) => a - b);
  const out: LineGap[] = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (last && last.to === n - 1) last.to = n;
    else out.push({ from: n, to: n });
  }
  return out;
}

/**
 * 多次行号读取合并为一份文本（宁缺毋假）：
 * - 同一行多次读取内容一致 → 保留；不一致 → 无法判定哪次可信，该行整体弃用并如实上报；
 * - 文件总行数取时间序最晚的可判定值；
 * - complete 当且仅当文件总行数可知且 1..fileLines 每行都有可靠内容。
 * 无任何可靠行 → null。
 */
export function mergeLineMappedReads(reads: LineMappedRead[]): MergedLineRead | null {
  const sorted = [...reads].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  const seen = new Map<number, Set<string>>();
  let fileLines: number | null = null;
  let truncated = false;
  let readCount = 0;
  for (const r of sorted) {
    if (r.lineMap.size === 0) continue;
    readCount += 1;
    if (r.truncated) truncated = true;
    if (r.fileLines != null && r.fileLines > 0) fileLines = r.fileLines;
    for (const [n, text] of r.lineMap) {
      if (!Number.isInteger(n) || n < 1) continue;
      const set = seen.get(n) ?? new Set<string>();
      set.add(text);
      seen.set(n, set);
    }
  }
  if (readCount === 0) return null;

  const lines = new Map<number, string>();
  const conflictLines: number[] = [];
  for (const [n, set] of seen) {
    if (set.size === 1) lines.set(n, [...set][0]!);
    else conflictLines.push(n);
  }
  if (lines.size === 0) return null;

  const lineNumbers = [...lines.keys()].sort((a, b) => a - b);
  const maxLine = lineNumbers[lineNumbers.length - 1]!;
  const limit = Math.max(fileLines ?? 0, maxLine);
  const missing: number[] = [];
  for (let n = 1; n <= limit; n++) if (!lines.has(n)) missing.push(n);
  return {
    lines,
    maxLine,
    complete: fileLines != null && missing.length === 0,
    evidence: {
      lineNumbers,
      fileLines,
      gaps: toRanges(missing),
      truncated,
      conflictLines: conflictLines.sort((a, b) => a - b),
      readCount,
    },
  };
}

/** 注入通道（Skill 工具 / 斜杠命令）的全文快照：行号语义不存在，覆盖面即全文。 */
export function injectedEvidence(): LineEvidence {
  return { lineNumbers: [], fileLines: null, gaps: [], truncated: false, conflictLines: [], readCount: 1 };
}

/** 一次调用读到了多少声明文件（逐次调用级；技能级合并见 mergeLineMappedReads）。
 *  只在可证时下结论——三种结论互斥：
 *   full      拿到了文件全文（文件总行数可知且每行都读到；或注入快照）；
 *   partial   确定只拿到一部分：文件总行数可知而有缺口，或读取命令自带行范围
 *             （没读到文件尾是命令有意为之）；
 *   unproven  既不能证明读完、也不能证明没读完（行号可定，但文件总行数未知、
 *             命令又未限范围——如 cat 之后还跟着别的输出段）。 */
export type ReadCoverage =
  | { kind: 'full'; lines: LineGap[]; fileLines: number | null }
  | { kind: 'partial'; lines: LineGap[]; fileLines: number | null }
  | { kind: 'unproven'; lines: LineGap[]; fileLines: null };

/** 读到的文件行号 → 覆盖面结论。fileLines 已知时越界行号（其他输出段被误归因）
 *  不计入；无任何有效行号 = 无从判定 → null。 */
export function coverageOfLines(lineNumbers: Iterable<number>, fileLines: number | null, ranged: boolean): ReadCoverage | null {
  const nums = [...new Set(
    [...lineNumbers].filter(n => Number.isInteger(n) && n >= 1 && (fileLines == null || n <= fileLines)),
  )].sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const lines = toRanges(nums);
  if (fileLines != null && nums.length >= fileLines) return { kind: 'full', lines, fileLines };
  if (fileLines != null || ranged) return { kind: 'partial', lines, fileLines };
  return { kind: 'unproven', lines, fileLines: null };
}

/** 两个路径是否指向同一份声明文件：字面相同，或一方是另一方的路径后缀
 *  （相对路径 `.agents/skills/x/SKILL.md` 与其绝对形态）。 */
export function sameDeclarationFile(a: string, b: string): boolean {
  const x = a.replace(/\\/g, '/');
  const y = b.replace(/\\/g, '/');
  if (x === y) return true;
  const xa = x.startsWith('/');
  const ya = y.startsWith('/');
  if (xa === ya) return false;
  return xa ? x.endsWith(`/${y}`) : y.endsWith(`/${x}`);
}

export function formatRanges(ranges: LineGap[]): string {
  return ranges.map(g => (g.from === g.to ? `${g.from}` : `${g.from}–${g.to}`)).join('、');
}

/** 一段缺失的文件行（闭区间）。kind：没读到 / 多次读取内容不一致而整体弃用；
 *  tail：一直缺到文件末尾（文件总行数可知时才有定论）。 */
export interface SourceGap extends LineGap {
  kind: 'unread' | 'conflict';
  tail: boolean;
}

/** 声明文本的展示行序：正文行（n = 文件行号，行号不可定时为 null）、缺失行段、
 *  文件尾部是否还有内容未知（文件总行数判不出时收在末尾）。 */
export type SourceRow =
  | { kind: 'line'; n: number | null; text: string }
  | { kind: 'gap'; gap: SourceGap }
  | { kind: 'tail-unknown'; after: number };

/** 证据里的缺失行段，按行号升序；同一段里成因不同的行拆开（冲突弃用的行与
 *  未读到的行分开说）。 */
export function sourceGapsOf(evidence: Pick<LineEvidence, 'gaps' | 'fileLines' | 'conflictLines'>): SourceGap[] {
  const conflicts = new Set(evidence.conflictLines);
  const out: SourceGap[] = [];
  for (const g of [...evidence.gaps].sort((a, b) => a.from - b.from)) {
    let from = g.from;
    let kind: SourceGap['kind'] = conflicts.has(g.from) ? 'conflict' : 'unread';
    const flush = (to: number) => out.push({ from, to, kind, tail: evidence.fileLines != null && to >= evidence.fileLines });
    for (let n = g.from + 1; n <= g.to; n++) {
      const k: SourceGap['kind'] = conflicts.has(n) ? 'conflict' : 'unread';
      if (k === kind) continue;
      flush(n - 1);
      from = n;
      kind = k;
    }
    flush(g.to);
  }
  return out;
}

/** 正文行号与证据是否逐行对齐（对齐才能指出缺在哪一行；兜底通道与注入快照不对齐）。 */
export function sourceLinesAligned(content: string, evidence: LineEvidence | null | undefined): boolean {
  return (evidence?.lineNumbers.length ?? 0) === (content.length > 0 ? content.split('\n').length : 0) && (evidence?.lineNumbers.length ?? 0) > 0;
}

/** 声明文本 + 行级证据 → 展示行序：缺失行段按行号位置插在对应行之前（到文件
 *  末尾的段标 tail）。行号不可对齐时只有正文行（n = null），不插任何段——
 *  缺在哪判不出就不标。 */
export function layOutSource(content: string, evidence: LineEvidence | null | undefined): SourceRow[] {
  const texts = content.length > 0 ? content.split('\n') : [];
  if (!sourceLinesAligned(content, evidence)) return texts.map((text) => ({ kind: 'line', n: null, text }));
  const gaps = sourceGapsOf(evidence!);
  const rows: SourceRow[] = [];
  let gi = 0;
  texts.forEach((text, i) => {
    const n = evidence!.lineNumbers[i]!;
    while (gi < gaps.length && gaps[gi]!.from < n) rows.push({ kind: 'gap', gap: gaps[gi++]! });
    rows.push({ kind: 'line', n, text });
  });
  for (; gi < gaps.length; gi++) rows.push({ kind: 'gap', gap: gaps[gi]! });
  if (evidence!.fileLines == null) rows.push({ kind: 'tail-unknown', after: evidence!.lineNumbers[texts.length - 1]! });
  return rows;
}

export function formatGap(gap: LineGap & Partial<Pick<SourceGap, 'kind'>>): string {
  const where = `第 ${formatRanges([gap])} 行`;
  return gap.kind === 'conflict' ? `${where}多次读取内容不一致，已弃用` : `${where}未读到`;
}

export interface MissingLinesNotice {
  /** 文本不是完整声明（有缺失、读取被截断、或文件尾部未知）。 */
  partial: boolean;
  /** 正文行号与证据逐行对齐，缺失行能定位到行号。 */
  located: boolean;
  /** 一句话覆盖面，如「已读 146/168 行」。 */
  summary: string;
  /** 缺失的行段（located = false 时为空）。 */
  gaps: SourceGap[];
  /** 缺失行数（gaps 的行数合计）。 */
  missing: number;
  /** 文件总行数判不出：最后一个读到的行之后是否还有内容未知。 */
  tailUnknown: boolean;
  truncated: boolean;
}

/** 证据 → 「缺了哪些行」的结构化结论（恢复正文的展示面共用；文案不在展示层拼）。 */
export function describeMissingLines(
  content: string,
  evidence: LineEvidence | null | undefined,
  fullRead: boolean,
): MissingLinesNotice {
  const located = sourceLinesAligned(content, evidence);
  const none = { partial: false, located, summary: '', gaps: [], missing: 0, tailUnknown: false, truncated: false };
  if (!evidence) return none;
  const covered = evidence.lineNumbers.length;
  // 注入快照没有文件行号语义（lineNumbers 为空）：不报行数，覆盖面即全文
  const summary = covered === 0 ? '' : evidence.fileLines != null ? `已读 ${covered}/${evidence.fileLines} 行` : `已读 ${covered} 行`;
  const gaps = located ? sourceGapsOf(evidence) : [];
  const missing = gaps.reduce((sum, g) => sum + g.to - g.from + 1, 0);
  return {
    partial: !fullRead,
    located,
    summary,
    gaps,
    missing,
    tailUnknown: located && !fullRead && evidence.fileLines == null,
    truncated: !fullRead && evidence.truncated,
  };
}

export interface LineEvidenceNotice {
  /** 文本不是完整声明（有缺口或读取被截断）。 */
  partial: boolean;
  /** 一句话覆盖面，如「已读 146/168 行」。 */
  summary: string;
  /** 缺口成因与处置说明；完整时为空串。 */
  detail: string;
}

/** 证据 → 用户可读的覆盖面说明（Skills 面板与对账报告共用同一口径）。
 *  advice：读取被截断时附在句尾的处置说明（口径见 tool-output-truncation 的
 *  toolOutputTruncationAdvice；本模块零依赖，只接收文本）。 */
export function describeLineEvidence(
  evidence: LineEvidence | null | undefined,
  fullRead: boolean,
  advice = '',
): LineEvidenceNotice {
  if (!evidence || fullRead) {
    return { partial: false, summary: evidence && evidence.lineNumbers.length > 0 ? `已读 ${evidence.lineNumbers.length} 行` : '', detail: '' };
  }
  const covered = evidence.lineNumbers.length;
  const summary = evidence.fileLines != null
    ? `已读 ${covered}/${evidence.fileLines} 行`
    : `已读 ${covered} 行（文件总行数未知）`;
  const reasons: string[] = [];
  if (evidence.truncated) reasons.push('读取该文件的工具输出被截断');
  if (evidence.gaps.length > 0) reasons.push(`第 ${formatRanges(evidence.gaps)} 行未读到`);
  if (evidence.conflictLines.length > 0) reasons.push(`第 ${formatRanges(toRanges(evidence.conflictLines))} 行多次读取内容不一致，已弃用`);
  const hint = advice && evidence.truncated ? `${advice}。` : '';
  return {
    partial: true,
    summary,
    detail: `${reasons.join('；')}。以下内容只含会话中确实读到的行，未读部分的指令不参与对账。${hint}`,
  };
}
