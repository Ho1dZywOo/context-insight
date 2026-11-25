// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software and is distributed under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may not use this file except in compliance with the License.
// A copy of the License is located in the "LICENSE" file at the root of the source tree.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
// EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY,
// OR FITNESS FOR A PARTICULAR PURPOSE. See the License for the full text of the License.

// shell 命令族隐式读的原文恢复引擎（Files 循迹复卷的 codex/bash 通道）。
//
// 背景：codex 没有独立 Read 工具——文件读取内嵌在 exec_command 的 shell
// 脚本里（cat / sed -n 'a,bp' / head -n K）。文件分析层（file-reads）早已
// 纳入命令族，但恢复层（file-restore / files.ts loadRestoreOps）只认
// read/Read/write/Write——codex 会话的 Files 页「列表有文件、复卷零素材」。
// 本引擎补齐恢复侧：把命令输出按段归因回各 dump 段的文件行。
//
// 采集期截断的诚实模型（现场形态实测）：
//   resultJson = "Warning: truncated output (original token count: N)\n
//                Total output lines: M\n\n" + 头段 + "…K chars|tokens truncated…" + 尾段
//   · 截断是行内内联：标记嵌在行中间，头段末行/尾段首行是残行（内容
//     不可信，保守丢弃，行号仍可定位）；中缝标记按字符或 token 计数，两形态同构
//   · M 是截断前的流总行数 → 尾段行号从 M 倒数精确重建（样例验证：1 pwd
//     + 2 printf + 3 ls + 2 printf + 162 sed = 170 = M），头段行号从 1 正数。
//     被丢中段 = 行号已知但内容缺失 → 交给恢复层渲染为 gap 行
//
// 归因纪律（保守、可判定，宁可少恢复不误恢复）：
//   · 段分类：DUMP（纯单文件 cat/sed -n 'a,bp'/head -n K，无管道重定向）、
//     NUMBERED（自带绝对行号的转储：nl/cat -n，可后接一级 sed -n/head/tail——
//     行号写在输出里，不依赖游标推算，截断后头尾两段各自自定位）、
//     LITERAL（printf/echo 字面量，可求值）、SILENT（cd/export/set 等零输出）、
//     UNKNOWN（过滤管道/heredoc/python/ls 等不可预知输出——一切不可判形的段）
//   · 游标从流头消耗：LITERAL 按预期文本精确匹配（失配即流被污染）；
//     UNKNOWN 后游标迷失，直到下一个 LITERAL 锚（在流中唯一出现）恢复对齐
//   · dump 区域 = [游标, 下一锚前] 或 [游标, 游标+行数上限]，行数上限校验
//     （sed a,bp = b-a+1 行；超限 = 污染，拒绝归因）
//   · cat 只在区域可界定时归因（后随锚或流尾），行号从 1 起
//   · dump 是末个输出段且区域抵达流尾（未被截断切掉尾部）→ 文件总行数可判定
//     （随条目返回 fileLines；行范围读满上限 = 文件可能更长，不判）
//   · tail 无文件起点，不归因（分析层照常计读取）
//   · 多文件 dump、sed -i、过滤管道段一律不归因
import { shellCommandArgsOf, shellExecInputCommandsOf, stripExecOutputHeader } from './tool-conventions';
import { isFilePathLike } from './file-reads';
import { injectedEvidence, mergeLineMappedReads, type LineEvidence } from './skill-evidence';

export interface ShellRestoreEntry {
  filePath: string;
  /** 文件行号 → 内容。缺口（截断丢弃/残行/未对齐段）不出现——由恢复层
   * 按 gap 语义渲染（与 Read/Write 通道同构：缺即未知）。 */
  lines: Map<number, string>;
  /** 该次读取能判定的文件总行数（整文件转储抵达流尾）；不可判定 = null。 */
  fileLines: number | null;
  /** 工具输出被 harness 截断（banner 命中）。 */
  truncated: boolean;
}

interface PositionedLine {
  /** 截断前流内行号（1 起；尾段从 M 倒数） */
  pos: number;
  text: string;
  /** 截断边界残行——内容不可信，丢弃 */
  partial: boolean;
  /** 位于截断缝之前（头段）还是之后（尾段）；无截断恒 head。 */
  half: 'head' | 'tail';
}

interface PositionedStream {
  lines: PositionedLine[];
  /** banner 的 Total output lines（截断前流总行数）；无 banner = null */
  totalLines: number | null;
  /** 存在截断丢弃段（内联标记命中）：跨段归因需门控 */
  dropped: boolean;
  /** 输出带截断 banner（工具实际拿到的不是完整输出） */
  truncated: boolean;
}

// 截断 banner 位于某个输出的行首：单块输出在流头；流式 exec 的多块轮询卷回后，
// 后续块自带的 banner 落在流中（其前是前序块已到达的整行）
const TRUNC_BANNER = /(?:^|\n)Warning: truncated output \(original token count: \d+\)\nTotal output lines: (\d+)\n\n/;
// 中缝丢弃标记：字节预算形态按字符计、token 预算形态按 token 计，结构相同
const TRUNC_MARKER = /…(\d+) (?:chars|tokens) truncated…/g;

function splitLines(s: string): string[] {
  if (s.length === 0) return [];
  return (s.endsWith('\n') ? s.slice(0, -1) : s).split('\n');
}

/** resultJson → 定位流：先剥 codex 终端元数据壳（Chunk ID/Wall time/…/Output:
 *  ——proxy 捕获形态保留此壳，原生导入已剥，无壳原样），再剥截断 banner，
 *  按内联标记切头尾；尾段从 M 倒数定位。banner 在流中时（流式 exec 多块轮询
 *  卷回），其前的整行是前序块已到达的输出（顺编 1..offset），M 相对 banner 所在块。 */
function buildPositionedStream(resultJson: string): PositionedStream {
  const bare = stripExecOutputHeader(resultJson);
  const m = bare.match(TRUNC_BANNER);
  if (!m) {
    return { lines: splitLines(bare).map((text, i) => ({ pos: i + 1, text, partial: false, half: 'head' as const })), totalLines: null, dropped: false, truncated: false };
  }
  const bannerStart = m.index! + (m[0].startsWith('\n') ? 1 : 0);
  const prefix = splitLines(bare.slice(0, bannerStart));
  const offset = prefix.length;
  const content = bare.slice(m.index! + m[0].length);
  const total = Number(m[1]);

  TRUNC_MARKER.lastIndex = 0;
  const markers = [...content.matchAll(TRUNC_MARKER)];
  if (markers.length === 0) {
    // banner 无中缝标记：顺序定位；流头的 banner 保留 M 供调用方判流尾，
    // 流中的 banner 无法定位 → 流不可信（totalLines = null）
    const lines = [...prefix, ...splitLines(content)]
      .map((text, i) => ({ pos: i + 1, text, partial: false, half: 'head' as const }));
    return { lines, totalLines: offset === 0 ? total : null, dropped: false, truncated: true };
  }
  const first = markers[0].index!;
  const last = markers[markers.length - 1];
  const headRaw = content.slice(0, first);
  const tailRaw = content.slice((last.index ?? first) + last[0].length);

  const out: PositionedLine[] = prefix
    .map((text, i) => ({ pos: i + 1, text, partial: false, half: 'head' as const }));
  // 头段：正数定位；末行若非行边界（标记内联嵌在行中间）= 残行
  const headLines = splitLines(headRaw);
  headLines.forEach((text, i) => {
    out.push({ pos: offset + i + 1, text, partial: i === headLines.length - 1 && !headRaw.endsWith('\n'), half: 'head' });
  });
  // 尾段：从 M 倒数定位；首行保守按残行处理（行内截断的终点无法判定
  // 是否行边界——错把半行当全行的代价是内容污染，丢一行的代价只是 gap）
  const tailLines = splitLines(tailRaw);
  if (total >= tailLines.length && headLines.length + tailLines.length <= total) {
    tailLines.forEach((text, i) => {
      out.push({ pos: offset + total - tailLines.length + 1 + i, text, partial: i === 0, half: 'tail' });
    });
  }
  // 倒数不一致（M 与头尾行数矛盾）= 形态不明：只保留头段，尾段不采信
  return { lines: out, totalLines: offset + total, dropped: true, truncated: true };
}

// ── 命令分段（引号感知：sed -n '1,10p;20,30p' 的分号在引号内不切）────
function splitSegments(cmd: string): string[] {
  const segs: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '\n' || ch === ';') {
      segs.push(cur);
      cur = '';
      continue;
    }
    if (ch === '&' && cmd[i + 1] === '&') {
      segs.push(cur);
      cur = '';
      i++;
      continue;
    }
    if (ch === '|' && cmd[i + 1] === '|') {
      segs.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += ch;
  }
  segs.push(cur);
  return segs.map(s => s.trim()).filter(Boolean);
}

function tokenize(seg: string): string[] {
  return seg.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
}

function unquote(t: string): string {
  return t.replace(/^['"]|['"]$/g, '');
}

// ── printf/echo 字面量求值（求值失败 → null → 段降级 UNKNOWN）──────────
function unescapeLiteral(s: string): string {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\\\/g, '\\');
}

function evalPrintf(tokens: string[]): string[] | null {
  const rest = tokens.slice(1);
  if (rest.length === 0) return null;
  const format = unescapeLiteral(unquote(rest[0]));
  const args = rest.slice(1).map(unquote);
  let out = '';
  let ai = 0;
  for (let i = 0; i < format.length; i++) {
    if (format[i] !== '%') {
      out += format[i];
      continue;
    }
    const spec = format[i + 1];
    if (spec === '%') {
      out += '%';
      i++;
    } else if (spec === 's') {
      if (ai >= args.length) return null;
      out += args[ai++];
      i++;
    } else {
      return null; // %d/%x/宽度修饰等保守放弃
    }
  }
  return splitLines(out);
}

function evalEcho(tokens: string[]): string[] | null {
  const rest = tokens.slice(1);
  let newline = true;
  let unescape = false;
  let i = 0;
  for (; i < rest.length; i++) {
    if (rest[i] === '-n') newline = false;
    else if (rest[i] === '-e') unescape = true;
    else if (rest[i] === '-E') unescape = false;
    else break;
  }
  const text = rest.slice(i).map(unquote).join(' ') + (newline ? '\n' : '');
  return splitLines(unescape ? unescapeLiteral(text) : text);
}

// ── dump 段解析（归因专用：比分析层的读取提取更严——单文件、无过滤管道、
//    行数可判；多文件/带非编号标志的 cat/无 -n 的 sed 一律不归因）─────────
interface DumpSpec {
  /** numbered = 自带绝对行号的转储（nl / cat -n，可后接一级行范围过滤）。 */
  cmd: 'cat' | 'head' | 'sed' | 'numbered';
  file: string;
  /** 输出行数上限（sed a,bp = b-a+1；head -n K = K；cat = null 即到界标/流尾） */
  count: number | null;
  /** 文件起始行号 */
  start: number;
  /** 仅 numbered：命令声明的文件行号范围 [a, b]（闭区间）——输出里的行号须落在其内 */
  lineRange: { a: number; b: number } | null;
}

/** dump 段的文件操作数判定：路径谓词（与分析层单点共享）+ 命令替换/
 *  通配元字符拒绝（$(…)、`…`、*.md 展开后不是这个字面路径——归因到它
 *  就是伪造键）。 */
const DUMP_FILE_META = /[*?\[\]{}$`()\\]/;

function dumpFilePath(t: string): string | null {
  if (!isFilePathLike(t)) return null;
  if (DUMP_FILE_META.test(t)) return null;
  return t;
}

function lineCountArg(t: string): number | null {
  const m = t.match(/^(?:-n\s*(\d+)|-(\d+)|(\d+))$/);
  return m ? Number(m[1] ?? m[2] ?? m[3]) : null;
}

/** 编号转储解析：`nl [-flags] FILE` / `cat -n FILE`，可后接**一级**只裁行不改号
 *  的过滤（`| sed -n 'a,bp'` / `| head -n K` / `| tail -n K`）。输出行自带文件
 *  绝对行号，归因不依赖游标。其余任何管道（过滤/加工内容）→ null → UNKNOWN。 */
function parseNumbered(seg: string): DumpSpec | null {
  const tokens = tokenize(seg);
  const pipeAt = tokens.indexOf('|');
  const lhs = pipeAt >= 0 ? tokens.slice(0, pipeAt) : tokens;
  const rhs = pipeAt >= 0 ? tokens.slice(pipeAt + 1).map(unquote) : [];
  if (lhs.length < 2) return null;
  const rest = lhs.slice(1).map(unquote);
  let operands: string[];
  if (lhs[0] === 'nl') {
    operands = rest.filter(t => !t.startsWith('-'));
  } else if (lhs[0] === 'cat' && rest[0] === '-n') {
    operands = rest.slice(1);
  } else {
    return null;
  }
  const files = operands.map(dumpFilePath).filter((f): f is string => f != null);
  if (files.length !== 1) return null;

  let count: number | null = null;
  let range = { a: 1, b: Number.MAX_SAFE_INTEGER };
  if (rhs.length > 0) {
    if (rhs[0] === 'sed' && rhs.length === 3 && rhs[1] === '-n') {
      const rm = rhs[2]!.match(/^(\d+),(\d+)p$/);
      if (!rm) return null;
      range = { a: Number(rm[1]), b: Number(rm[2]) };
    } else if (rhs[0] === 'head' || rhs[0] === 'tail') {
      // head -n K / head -K / head -nK / tail 同形（-n 与 K 之间可有空格）
      const n = rhs.length === 2 ? lineCountArg(rhs[1]!)
        : rhs.length === 3 && rhs[1] === '-n' && /^\d+$/.test(rhs[2]!) ? Number(rhs[2]) : null;
      if (n == null || n <= 0) return null;
      count = n;
    } else {
      return null;
    }
  }
  if (range.b < range.a) return null;
  return { cmd: 'numbered', file: files[0]!, count, start: range.a, lineRange: range };
}

/** 编号转储的输出行：`<右对齐行号>\t<原文>`（nl / cat -n 同形）。原文含制表符不受影响。 */
const NUMBERED_LINE_RE = /^ *(\d+)\t(.*)$/;

function parseNumberedLine(text: string): { n: number; text: string } | null {
  const m = text.match(NUMBERED_LINE_RE);
  return m ? { n: Number(m[1]), text: m[2]! } : null;
}

function parseDump(tokens: string[]): DumpSpec | null {
  const head = tokens[0];
  const rest = tokens.slice(1).map(unquote);
  if (head === 'sed') {
    if (!rest.includes('-n')) return null;
    let range: { a: number; b: number } | null = null;
    const files: string[] = [];
    for (const t of rest) {
      if (t === '-n') continue;
      const rm = t.match(/^(\d+)(?:,(\d+))?p$/);
      if (rm) {
        range = { a: Number(rm[1]), b: rm[2] ? Number(rm[2]) : Number(rm[1]) };
        continue;
      }
      if (t.startsWith('-') || /^[aic]$/.test(t) || /^(s|y)\//.test(t)) continue;
      const fp = dumpFilePath(t);
      if (fp) files.push(fp);
    }
    if (!range || files.length !== 1 || range.b < range.a) return null;
    return { cmd: 'sed', file: files[0], count: range.b - range.a + 1, start: range.a, lineRange: null };
  }
  if (head === 'head' || head === 'tail') {
    if (head === 'tail') return null; // 文件起点未知（末 K 行），不归因
    let n: number | null = null;
    const files: string[] = [];
    for (const t of rest) {
      if (t === '-n') continue;
      if (/^\d+$/.test(t)) {
        n = Number(t);
        continue;
      }
      if (/^-n\d+$/.test(t)) {
        n = Number(t.slice(2));
        continue;
      }
      if (/^-\d+$/.test(t)) {
        n = Number(t.slice(1));
        continue;
      }
      if (t.startsWith('-')) return null;
      const fp = dumpFilePath(t);
      if (fp) files.push(fp);
    }
    if (n == null || n <= 0 || files.length !== 1) return null;
    return { cmd: 'head', file: files[0], count: n, start: 1, lineRange: null };
  }
  if (head === 'cat') {
    const files: string[] = [];
    for (const t of rest) {
      if (t.startsWith('-')) return null; // cat -n 走编号转储通道（parseNumbered）
      const fp = dumpFilePath(t);
      if (fp) files.push(fp);
    }
    if (files.length !== 1) return null;
    return { cmd: 'cat', file: files[0], count: null, start: 1, lineRange: null };
  }
  return null;
}

const SILENT_HEADS = new Set([
  'cd', 'export', 'set', 'unset', 'test', '[', '[[', 'true', 'false', 'exit',
  'wait', 'sleep', 'umask', 'ulimit', 'source', 'pushd', 'popd', 'return', 'shift',
]);
const ONE_LINE_HEADS = new Set(['pwd', 'wc', 'command', 'which', 'type', 'hostname', 'whoami']);

type Seg =
  | { kind: 'silent' }
  | { kind: 'one-line' }
  | { kind: 'literal'; lines: string[] }
  | { kind: 'dump'; spec: DumpSpec }
  | { kind: 'unknown' };

function classifySeg(seg: string): Seg | null {
  // 重定向段：输出形态不可判，归因面一律 UNKNOWN
  if (/[<>]/.test(seg)) return { kind: 'unknown' };
  // 管道段：只有「编号转储 + 一级行范围过滤」可判形，其余（过滤/加工）UNKNOWN
  if (seg.includes('|')) {
    const spec = parseNumbered(seg);
    return spec ? { kind: 'dump', spec } : { kind: 'unknown' };
  }
  const tokens = tokenize(seg);
  if (tokens.length === 0) return null;
  const head = tokens[0];
  if (head === 'nl' || (head === 'cat' && tokens[1] === '-n')) {
    const spec = parseNumbered(seg);
    return spec ? { kind: 'dump', spec } : { kind: 'unknown' };
  }
  if (head === 'printf') {
    const lines = evalPrintf(tokens);
    return lines ? { kind: 'literal', lines } : { kind: 'unknown' };
  }
  if (head === 'echo') {
    const lines = evalEcho(tokens);
    return lines ? { kind: 'literal', lines } : { kind: 'unknown' };
  }
  if (head === 'cat' || head === 'head' || head === 'tail' || head === 'sed') {
    const spec = parseDump(tokens);
    if (spec) return { kind: 'dump', spec };
    return { kind: 'unknown' };
  }
  if (SILENT_HEADS.has(head)) return { kind: 'silent' };
  if (ONE_LINE_HEADS.has(head)) return { kind: 'one-line' };
  return { kind: 'unknown' };
}

/** 归因游标：lost = 当前位置对应的段不可知（UNKNOWN 输出之后） */
interface Cursor {
  idx: number;
  lost: boolean;
}

/** 流中找字面量文本锚：从 from 起的全部命中（按出现序） */
function findLiteralHits(stream: PositionedLine[], expected: string[], from: number): number[] {
  const hits: number[] = [];
  if (expected.length === 0) return hits;
  for (let i = from; i + expected.length <= stream.length; i++) {
    let ok = true;
    for (let j = 0; j < expected.length; j++) {
      if (stream[i + j].text !== expected[j] || stream[i + j].partial) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

/** 游标处流是否与预期文本精确匹配（确定性校验） */
function matchAt(stream: PositionedLine[], idx: number, expected: string[]): boolean {
  if (idx + expected.length > stream.length) return false;
  for (let j = 0; j < expected.length; j++) {
    if (stream[idx + j].text !== expected[j] || stream[idx + j].partial) return false;
  }
  return true;
}

/**
 * 单条命令 → 逐文件行表。
 * 返回 null = 该命令无任何可归因 dump（常见：纯过滤管道/查找命令）。
 */
function attributeCommand(cmd: string, stream: PositionedStream): ShellRestoreEntry[] | null {
  const segs = splitSegments(cmd)
    .map(classifySeg)
    .filter((s): s is Seg => s != null);
  if (!segs.some(s => s.kind === 'dump')) return null;

  const lines = stream.lines;
  const cursor: Cursor = { idx: 0, lost: false };
  const entries = new Map<string, { lines: Map<number, string>; fileLines: number | null }>();
  // 前一个 dump 的区域预期终点（位置空间，开区间；Infinity = 该段输出被截断缝
  // 切开、终点不可知）。丢弃段横跨两段 dump 边界时，后段的起点无法从保留行
  // 推导——用它判定并跳过归因。编号转储自定位，不受此门控。
  let prevRegionEnd: number | null = null;

  const accOf = (file: string) => {
    let acc = entries.get(file);
    if (!acc) {
      acc = { lines: new Map(), fileLines: null };
      entries.set(file, acc);
    }
    return acc;
  };
  const isLastOutputSeg = (si: number) => !segs.slice(si + 1).some(s => s.kind !== 'silent');
  // 流尾完好：无截断，或末行位置抵达截断前总行数（尾段被整个切掉 / banner 无法
  // 定位 / 与行数矛盾时不成立——此时不能断言「输出到文件尾为止」）
  const streamEndIntact = !stream.truncated
    || (stream.totalLines != null && lines[lines.length - 1]!.pos === stream.totalLines);

  /** 把 dump 区域 [startIdx, endIdx) 归因到文件行；regionStartPos = 区域在
   *  位置空间的应有起点（调用方算好：丢弃段跨界时调不动它，由门控跳过） */
  function emit(spec: DumpSpec, startIdx: number, endIdx: number, regionStartPos: number): void {
    if (startIdx >= endIdx || startIdx >= lines.length) return;
    const fileMap = accOf(spec.file).lines;
    for (let i = startIdx; i < endIdx && i < lines.length; i++) {
      const l = lines[i];
      const fileLine = spec.start + (l.pos - regionStartPos);
      if (fileLine < spec.start) continue; // 防御：位置倒挂不采
      // 区域终点误越界（锚定到同名内容/丢弃重排）时不越出 dump 的文件域
      if (spec.count != null && fileLine >= spec.start + spec.count) continue;
      if (l.partial) continue; // 残行：位置保留（周围行定位），内容丢弃
      if (!fileMap.has(fileLine)) fileMap.set(fileLine, l.text); // 先到先得：同一命令内重复 dump 不互相覆盖
    }
  }

  /** 游标处起取一段编号行：连续、行号严格递增、全部落在段范围内。skipPartial =
   *  越过截断缝残行（自定位模式）；对齐模式下残行即终点。 */
  function numberedRun(
    spec: DumpSpec,
    from: number,
    skipPartial: boolean,
    minLines: number,
  ): { start: number; end: number; first: number; last: number } | null {
    const range = spec.lineRange!;
    let i = from;
    if (skipPartial) while (i < lines.length && lines[i].partial) i++;
    const firstLine = lines[i];
    if (!firstLine || firstLine.partial) return null;
    const first = parseNumberedLine(firstLine.text);
    if (!first || first.n < range.a || first.n > range.b) return null;
    let j = i + 1;
    let last = first.n;
    for (; j < lines.length; j++) {
      if (lines[j].partial) break;
      const p = parseNumberedLine(lines[j].text);
      if (!p || p.n <= last || p.n < range.a || p.n > range.b) break;
      last = p.n;
    }
    if (j - i < minLines) return null;
    if (spec.count != null && j - i > spec.count) return null;
    return { start: i, end: j, first: first.n, last };
  }

  function emitNumbered(spec: DumpSpec, run: { start: number; end: number }): void {
    const fileMap = accOf(spec.file).lines;
    for (let i = run.start; i < run.end; i++) {
      const p = parseNumberedLine(lines[i].text)!;
      if (!fileMap.has(p.n)) fileMap.set(p.n, p.text);
    }
  }

  for (let si = 0; si < segs.length; si++) {
    const seg = segs[si];
    if (seg.kind === 'silent') continue;

    if (seg.kind === 'one-line') {
      if (!cursor.lost) cursor.idx += 1;
      prevRegionEnd = null;
      continue;
    }

    if (seg.kind === 'literal') {
      if (!cursor.lost && matchAt(lines, cursor.idx, seg.lines)) {
        cursor.idx += seg.lines.length;
        prevRegionEnd = null;
        continue;
      }
      // 失配/迷失：锚恢复——找该文本在流中的最后命中（agent 的标记是
      // 最新一次打印；更早命中属于已消耗区）。命中即恢复对齐。
      const hits = findLiteralHits(lines, seg.lines, 0);
      if (hits.length > 0) {
        cursor.idx = hits[hits.length - 1] + seg.lines.length;
        cursor.lost = false;
        prevRegionEnd = null;
      } else {
        cursor.lost = true;
      }
      continue;
    }

    if (seg.kind === 'unknown') {
      // 游标迷失，等下一个 literal 锚（编号转储自带行号，可自行恢复）
      cursor.lost = true;
      continue;
    }

    if (seg.spec.lineRange) {
      // ── 编号转储：行号写在输出里，头尾两段各自自定位 ──
      const spec = seg.spec;
      const range = spec.lineRange!;
      const lostAtEntry = cursor.lost;
      if (!lostAtEntry) {
        // ① 对齐消耗：游标处起的连续编号行（截断缝前的头段）
        const head = numberedRun(spec, cursor.idx, false, 1);
        if (head) {
          emitNumbered(spec, head);
          cursor.idx = head.end;
          // 头段未到范围上界即中断 = 该段输出被缝切开，终点不可知
          prevRegionEnd = stream.dropped && head.last < range.b ? Number.POSITIVE_INFINITY : null;
          if (isLastOutputSeg(si) && head.end === lines.length && streamEndIntact
            && head.last < range.b && (spec.count == null || head.end - head.start < spec.count)) {
            accOf(spec.file).fileLines = head.last;
          }
        }
      }
      // ② 自定位消耗：越过缝残行 / 迷失区，取首个落在范围内的编号行段（尾段）
      const tail = numberedRun(spec, cursor.idx, true, lostAtEntry ? 2 : 1);
      if (!tail) continue;
      // 行号同样落在后续编号段范围内的行段让给后续段——流的尾部属于最后一个
      // 编号段的输出，先到者不抢（迷失游标时归属不可判，宁缺毋假）
      const laterOwner = segs.slice(si + 1).some(s =>
        s.kind === 'dump' && s.spec.lineRange != null && s.spec.file === spec.file
        && s.spec.start <= tail.first && tail.last <= s.spec.lineRange!.b);
      if (laterOwner) continue;
      emitNumbered(spec, tail);
      cursor.idx = tail.end;
      cursor.lost = false;
      prevRegionEnd = null;
      // 行段抵达流尾、末行行号严格小于范围上界、且未读满输出行数上限
      // （范围读满 / head -n K 取满 K 行 = 文件可能更长）= 文件到此为止
      if (isLastOutputSeg(si) && tail.end === lines.length && streamEndIntact
        && tail.last < range.b && (spec.count == null || tail.end - tail.start < spec.count)) {
        accOf(spec.file).fileLines = tail.last;
      }
      continue;
    }

    // ── 无编号 dump（cat / sed -n / head）：游标推算行号 ──
    if (cursor.lost) continue; // 无锚不对齐，宁缺毋假
    const startIdx = cursor.idx;
    if (startIdx >= lines.length) {
      prevRegionEnd = null;
      continue;
    }
    // 区域在位置空间的应有起点 = 前一已消耗行 pos + 1（流首 = 1）。区域
    // 头部落进截断丢弃段时 lines[startIdx].pos 比它大——差值即丢弃的
    // 文件行区间（不 emit，渲染为 gap），后续行按应有位置对齐。
    const regionStartPos = startIdx > 0 ? lines[startIdx - 1].pos + 1 : 1;
    // 跨段丢弃门控：截断丢弃段横跨前段 dump 的预期终点时，本段起点从
    // 保留行推导会把前段丢的行错记到本段头上（行号整体错位）——位置
    // 不可判定，跳过归因（宁缺毋假）
    if (stream.dropped && prevRegionEnd != null && regionStartPos < prevRegionEnd) {
      prevRegionEnd = null;
      continue;
    }
    // 区域终点：下一字面量锚（可定位）优先——cat/短文件（实际行数 <
    // sed 区间）都以「下一锚前」为真实终点；无锚则在位置空间按行数
    // 上限封顶（丢弃段不在行数组里，数组下标封顶会把后段尾行吞进来）
    let endIdx = lines.length;
    let boundedByAnchor = false;
    for (let ni = si + 1; ni < segs.length; ni++) {
      const next = segs[ni];
      if (next.kind === 'silent') continue;
      if (next.kind === 'literal') {
        const hits = findLiteralHits(lines, next.lines, startIdx + 1);
        if (hits.length > 0) {
          endIdx = hits[hits.length - 1];
          boundedByAnchor = true;
        }
        break;
      }
      break; // dump/one-line/unknown 紧随：无锚可依
    }
    if (!boundedByAnchor && seg.spec.count != null) {
      const regionEndPos = regionStartPos + seg.spec.count;
      let i = startIdx;
      while (i < lines.length && lines[i].pos < regionEndPos) i++;
      endIdx = i;
    }
    // 行数上限校验（cat 无上限）：区域超限 = 流被污染（锚定位到了同名
    // 内容或命令结构误判），拒绝归因
    if (seg.spec.count != null && endIdx - startIdx > seg.spec.count) continue;
    emit(seg.spec, startIdx, endIdx, regionStartPos);
    if (!boundedByAnchor) {
      cursor.idx = endIdx;
      // count 封顶段的预期终点（含被丢弃部分）——后段用它判跨段丢弃
      prevRegionEnd = seg.spec.count != null ? regionStartPos + seg.spec.count : null;
    } else {
      prevRegionEnd = null;
    }
    // 锚定区域后游标位置由该锚自己的 literal 分支恢复（其 matchAt 大概率
    // 失配——区域终点即锚起点，故锚分支会消耗它；这里不推进游标，避免
    // 双重消耗）。锚定但 literal 分支又去流尾找 last hit 的情况：锚文本
    // 唯一，last hit == 本区域终点，消耗正确。
    if (boundedByAnchor && seg.spec.count == null) cursor.idx = endIdx;
    // 文件总行数可判定：末个输出段、区域抵达流尾、且区域末行严格小于范围上界
    // （末行压在范围上界 = 范围读满，文件可能更长，不判；按位置而非行数判——
    // 截断丢弃段不占行数组，行数会偏少）
    const lastFileLine = startIdx < endIdx ? seg.spec.start + (lines[endIdx - 1]!.pos - regionStartPos) : NaN;
    if (
      isLastOutputSeg(si) && !boundedByAnchor && startIdx < endIdx && endIdx === lines.length && streamEndIntact
      && (seg.spec.count == null || lastFileLine < seg.spec.start + seg.spec.count - 1)
    ) {
      accOf(seg.spec.file).fileLines = lastFileLine;
    }
  }

  if (entries.size === 0) return null;
  return [...entries].map(([filePath, e]) => ({ filePath, lines: e.lines, fileLines: e.fileLines, truncated: stream.truncated }));
}

/** argsJson → 参与归因的命令文本序列（command/cmd 键 + codex input 内嵌
 *  exec_command({cmd:"…"})——与分析层 extractShellFileReads 同源域） */
function commandTextsOf(argsJson: string | null): string[] {
  const texts: string[] = [];
  const parts = shellCommandArgsOf(argsJson);
  if (parts.length > 0) texts.push(parts.join('\n'));
  const inner = shellExecInputCommandsOf(argsJson);
  if (inner.length > 0) texts.push(inner.join('\n'));
  return texts;
}

/**
 * 一次 shell 工具调用 → 逐文件可恢复行表。
 * argsJson 是命令（command/cmd 键或 codex input 内嵌），resultJson 是输出
 * （可含采集期截断 banner/内联标记）。
 */
export function restoreShellReads(argsJson: string | null, resultJson: string | null): ShellRestoreEntry[] {
  if (!argsJson || !resultJson) return [];
  let stream: PositionedStream;
  try {
    stream = buildPositionedStream(resultJson);
  } catch {
    return [];
  }
  if (stream.lines.length === 0) return [];
  const merged = new Map<string, ShellRestoreEntry>();
  for (const cmd of commandTextsOf(argsJson)) {
    const entries = attributeCommand(cmd, stream);
    if (!entries) continue;
    for (const e of entries) {
      const m = merged.get(e.filePath);
      if (!m) {
        merged.set(e.filePath, { ...e, lines: new Map(e.lines) });
        continue;
      }
      for (const [n, text] of e.lines) {
        if (!m.lines.has(n)) m.lines.set(n, text); // 单工具调用内先到先得
      }
      if (m.fileLines == null) m.fileLines = e.fileLines;
    }
  }
  return [...merged.values()];
}

/** 恢复条目 → 声明文本（行序拼接）：缺口行**跳过**而非渲染 gap 标记——
 *  声明消费方（sift 对账/计划恢复）要的是可对账指令文本，未观测到的行
 *  不可知、不参与对账；行号空洞由 maxLine/covered 如实表达。 */
export function renderShellEntryText(entry: ShellRestoreEntry): { content: string; maxLine: number; covered: number } {
  const nums = [...entry.lines.keys()].sort((a, b) => a - b);
  const content = nums.map(n => entry.lines.get(n)!).join('\n');
  const maxLine = nums.length > 0 ? nums[nums.length - 1] : 0;
  return { content, maxLine, covered: nums.length };
}

/** 恢复条目的覆盖面（行级合并单点）：complete 当且仅当文件总行数可知且每行都有
 *  可靠内容。只有头段的截断片段（maxLine == covered）不是完整声明。 */
export function shellEntryCoverage(entry: ShellRestoreEntry): { content: string; evidence: LineEvidence; complete: boolean } {
  const merged = mergeLineMappedReads([{ lineMap: entry.lines, ts: null, fileLines: entry.fileLines, truncated: entry.truncated }]);
  return {
    content: renderShellEntryText(entry).content,
    evidence: merged?.evidence ?? injectedEvidence(),
    complete: merged?.complete ?? false,
  };
}
