// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { parseReadToolArgs } from './tool-conventions';
import { parseApplyPatch } from './apply-patch';

export interface RestoreOp {
  kind: 'read' | 'write';
  argsJson: string | null;
  resultJson: string | null;
  ts: Date | null;
}

/** 已解析行表通道：由专用引擎（shell-restore / apply-patch 解析器）预先
 *  归因好的行——shell 命令族隐式读（cat/sed/head）与 apply_patch 新建文件
 *  全文。缺口（采集期截断丢弃段/残行）不出现，由行号空洞表达（与
 *  Read/Write 通道的 gap 渲染同构）。ts 参与读写时间序合并。 */
export interface ResolvedRestoreOp {
  kind: 'resolved';
  source: 'read' | 'write';
  filePath: string;
  lines: Map<number, string>;
  ts: Date | null;
}

export interface RestoreLine {
  n: number;
  content: string | null;
  source: 'read' | 'write' | 'gap';
}

export interface RestoreResult {
  lines: RestoreLine[];
  maxLine: number;
  opsUsed: number;
}

/** read/write 路径键走词表（opencode `path` / Claude Code `file_path` 等同义键）；
 *  JSON 解析失败时回退 apply_patch 裸 patch 文本（codex 写通道）——多文件
 *  patch 取首个文件（逐文件明细走 parseApplyPatch）。 */
export function extractFilePath(argsJson: string | null): string | null {
  const viaJson = parseReadToolArgs(argsJson)?.filePath ?? null;
  if (viaJson != null) return viaJson;
  const patch = parseApplyPatch(argsJson);
  return patch != null ? patch[0].file : null;
}

export function extractOffset(argsJson: string | null): number | undefined {
  if (!argsJson) return undefined;
  try {
    const p = JSON.parse(argsJson);
    return p.offset ?? undefined;
  } catch {
    return undefined;
  }
}

const NUMBERED_TAB = /^\s*(\d+)\t(.*)$/;
const NUMBERED_COLON = /^\s*(\d+): (.*)$/;
const CONTENT_OPEN = /<content>\s*$/;
const CONTENT_CLOSE = /<\/content>/;

/** 剥掉 opencode / Claude 信封（<path>/<type>/<content> 不得混进恢复的文件正文），
 *  只留 <content> 与 </content> 之间的行 */
function envelopeLinesOf(raw: string): string[] {
  let lines = raw.split('\n');
  const openIdx = lines.findIndex(l => CONTENT_OPEN.test(l) || l.trim() === '<content>');
  if (openIdx >= 0) {
    const closeIdx = lines.findIndex(l => CONTENT_CLOSE.test(l));
    lines = lines.slice(openIdx + 1, closeIdx < 0 ? undefined : closeIdx);
  }
  return lines;
}

/** 读取结果里的行是否自带文件行号（claude `N\t` / opencode `N: `）。不带时行号是
 *  按调用参数 offset 推算的——输出一旦被运行环境截断（保留下来的未必是文件开头），
 *  推算的行号就不是文件行号，不能当行级证据用。 */
export function readResultHasLineNumbers(resultJson: string | null): boolean {
  if (!resultJson) return false;
  return envelopeLinesOf(resultJson).some(l => NUMBERED_TAB.test(l) || NUMBERED_COLON.test(l));
}

export function parseReadLines(resultJson: string | null, offset?: number): Map<number, string> {
  const out = new Map<number, string>();
  if (!resultJson) return out;

  const raw = typeof resultJson === 'string' ? resultJson : String(resultJson);
  const lines = envelopeLinesOf(raw);
  if (lines.length === 0) return out;

  // Numbered parse: claude uses `N\tcontent`, opencode uses `N: content`.
  // Both carry the file's real line numbers, so trust them.
  let matchedAny = false;
  for (const line of lines) {
    const mt = line.match(NUMBERED_TAB);
    if (mt) { out.set(parseInt(mt[1], 10), mt[2]); matchedAny = true; continue; }
    const mc = line.match(NUMBERED_COLON);
    if (mc) { out.set(parseInt(mc[1], 10), mc[2]); matchedAny = true; continue; }
  }
  if (matchedAny) return out;

  // Fallback: plain content with no line-number prefix — number from offset.
  const start = offset && offset > 0 ? offset : 1;
  for (let i = 0; i < lines.length; i++) {
    out.set(start + i, lines[i]);
  }
  return out;
}

export function parseWriteLines(argsJson: string | null): Map<number, string> | null {
  if (!argsJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const content = (parsed as { content?: unknown }).content;
  if (typeof content !== 'string') return null;

  const body = content.endsWith('\n') ? content.slice(0, -1) : content;
  const parts = body.split('\n');
  const out = new Map<number, string>();
  parts.forEach((line, i) => out.set(i + 1, line));
  return out;
}

export function restoreFile(ops: Array<RestoreOp | ResolvedRestoreOp>): RestoreResult {
  const sorted = [...ops].sort((a, b) => {
    const ta = a.ts?.getTime() ?? -Infinity;
    const tb = b.ts?.getTime() ?? -Infinity;
    return ta - tb;
  });

  const lineMap = new Map<number, { content: string; source: 'read' | 'write' }>();
  let opsUsed = 0;

  for (const op of sorted) {
    let lines: Map<number, string> | null = null;
    let lineSource: 'read' | 'write' = 'read';
    if (op.kind === 'read') {
      lines = parseReadLines(op.resultJson, extractOffset(op.argsJson));
    } else if (op.kind === 'write') {
      lines = parseWriteLines(op.argsJson);
      lineSource = 'write';
    } else if (op.kind === 'resolved') {
      lines = op.lines.size > 0 ? op.lines : null;
      lineSource = op.source;
    }
    if (!lines || lines.size === 0) continue;
    opsUsed++;
    for (const [n, content] of lines) {
      lineMap.set(n, { content, source: lineSource });
    }
  }

  let maxLine = 0;
  for (const n of lineMap.keys()) if (n > maxLine) maxLine = n;

  const result: RestoreLine[] = [];
  for (let n = 1; n <= maxLine; n++) {
    const hit = lineMap.get(n);
    if (hit) result.push({ n, content: hit.content, source: hit.source });
    else result.push({ n, content: null, source: 'gap' });
  }

  return { lines: result, maxLine, opsUsed };
}

export function renderRestoredText(lines: RestoreLine[]): string {
  return lines
    .map(l => (l.content === null ? `--line ${l.n} not found --` : l.content))
    .join('\n');
}
