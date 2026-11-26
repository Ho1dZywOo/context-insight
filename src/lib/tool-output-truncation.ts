// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS OR OTHER PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 工具输出截断语义单点：工具结果在到达 agent 之前被运行环境（harness）砍掉
// 一部分——agent 据以决策的不是全文。与另外两类「看着像截断」的现象严格分开：
//   · 模型输出截断（finishReason = length / max_tokens）→ tool-call-errors 的
//     modelOutputTruncated，是生成侧信号；
//   · 展示省略（界面只渲染结果前若干字符）→ 用户没看全、agent 看全了。
// 本模块只回答「这一次工具调用，agent 是否拿到了全文」，不补内容。处置建议与
// 事实分列（TruncationAdvice）：事实句永远单独成立，建议只在运行环境确有可调
// 开关时才给，口径只有这一份。
//
// 认可的两种形态（现场实测，均要求出现在 harness 写入它的固定位置）：
//   · codex：`Warning: truncated output (original token count: N)` 打在输出首行，
//     次行为 `Total output lines: M` 或 `... K bytes omitted ...`；proxy 捕获保留
//     终端元数据壳（Chunk ID / Wall time / … / Output:），横幅落在壳之后；
//   · opencode：`[showing lines A-B of B; full output saved to PATH]` 打在输出末尾，
//     agent 只看到尾部 A–B 行，全量另有落盘；命令非零退出时其后还跟一行
//     `Exited with code N`。
// 只认这两个位置：横幅出现在正文中间（agent 读到的日志、dump 里引用了别的截断
// 输出）不算——现场库 36 条流中横幅里 35 条是引用。宁缺毋假。

import { stripExecOutputHeader } from './tool-conventions';

export interface ToolOutputTruncation {
  /** 实施截断的运行环境 */
  harness: 'codex' | 'opencode';
  /** 截断前的输出规模：codex 为 token 数，opencode 未知 */
  originalTokens: number | null;
  /** 截断前的流总行数；不可判定 = null */
  totalLines: number | null;
  /** agent 实际看到的行范围（opencode 保留尾部）；codex 头尾各留一段、不连续 = null */
  shownLines: { from: number; to: number } | null;
}

const CODEX_BANNER_RE = /^Warning: truncated output \(original token count: (\d+)\)\n(?:Total output lines: (\d+)\n)?/;
const OPENCODE_TAIL_RE = /(?:^|\n)\[showing lines (\d+)-(\d+) of (\d+); full output saved to [^\n\]]+\](?:\nExited with code -?\d+)?\s*$/;

/** proxy 捕获的流式 exec：一个结果里卷回多个块，每块各带一层元数据壳——
 *  逐层剥到正文（空输出的前序块之后紧跟下一块的壳） */
function stripChunkShells(resultJson: string): string {
  let bare = resultJson;
  for (let i = 0; i < 16; i++) {
    const next = stripExecOutputHeader(bare);
    if (next === bare) break;
    bare = next;
  }
  return bare;
}

/** opencode 落盘行在结果末尾：只取尾部窗口匹配，不整段扫描大结果 */
const TAIL_WINDOW = 1024;

export function toolOutputTruncationOf(resultJson: string | null | undefined): ToolOutputTruncation | null {
  if (resultJson == null || resultJson === '') return null;
  const codex = CODEX_BANNER_RE.exec(stripChunkShells(resultJson));
  if (codex != null) {
    return {
      harness: 'codex',
      originalTokens: Number(codex[1]),
      totalLines: codex[2] != null ? Number(codex[2]) : null,
      shownLines: null,
    };
  }
  const tail = resultJson.length > TAIL_WINDOW ? resultJson.slice(-TAIL_WINDOW) : resultJson;
  const opencode = OPENCODE_TAIL_RE.exec(tail);
  if (opencode != null) {
    return {
      harness: 'opencode',
      originalTokens: null,
      totalLines: Number(opencode[3]),
      shownLines: { from: Number(opencode[1]), to: Number(opencode[2]) },
    };
  }
  return null;
}

/** 用户可读的一句事实：被截断的规模。处置建议另走 toolOutputTruncationAdvice，不混进事实句 */
export function describeToolOutputTruncation(t: ToolOutputTruncation): string {
  if (t.harness === 'opencode') {
    return `输出被截断，仅显示第 ${t.shownLines!.from}–${t.shownLines!.to} 行（共 ${t.totalLines} 行）`;
  }
  const lines = t.totalLines != null ? `、共 ${t.totalLines} 行` : '';
  return `输出被截断，原始 ${t.originalTokens} tokens${lines}`;
}

/** 截断的完整事实句（展示层共用）：规模 + agent 未看到全文 */
export function toolOutputTruncationFact(t: ToolOutputTruncation): string {
  return `${describeToolOutputTruncation(t)}，agent 未看到全文。`;
}

/** 处置建议：用户能做的那个动作。codex 0.169.0 实测（临时 CODEX_HOME 对照七例）：
 *  实际保留 = min(tool_output_token_limit, 调用请求的 max_output_tokens[默认 10000])
 *  × 4 字节；不配置时 codex 没有内置元数据的模型回落到固定 10,000 字节。该键是
 *  配置文件的顶层键，写在基础 config.toml 或启用的 profile 文件里等效。 */
export interface TruncationAdvice {
  harness: 'codex';
  /** 做什么 */
  action: string;
  /** 可直接粘贴的配置行 */
  snippet: string;
  /** 写在哪些文件（任选其一） */
  files: string[];
  /** 在文件里的位置 */
  placement: string;
  /** 生效边界：调了之后上限是多少、还差什么 */
  caveat: string;
  /** 一句话形态：嵌进别的说明句时用 */
  sentence: string;
}

const CODEX_ADVICE: TruncationAdvice = {
  harness: 'codex',
  action: '调大 codex 的单次工具输出上限',
  snippet: 'tool_output_token_limit = 100000',
  files: ['~/.codex/config.toml', '~/.codex/<name>.config.toml（启用 profile 时）'],
  placement: '写在文件顶层，不要放进任何 [xxx] 段',
  caveat: '实际保留 = min(该值, 调用请求的 max_output_tokens，默认 10000) × 4 字节：'
    + 'codex 没有内置元数据的模型默认只保留约 10KB，配置后约 40KB；'
    + '更大的输出还需 agent 在工具调用里把 max_output_tokens 一并调大。重新启动 codex 后生效。',
  sentence: '调大 codex 单次工具输出上限：在 ~/.codex/config.toml 或启用的 profile 文件'
    + '（~/.codex/<name>.config.toml）顶层设置 tool_output_token_limit',
};

/** 截断的处置建议；运行环境没有可调开关的形态（opencode 的落盘行）返回 null */
export function toolOutputTruncationAdvice(harness: ToolOutputTruncation['harness']): TruncationAdvice | null {
  return harness === 'codex' ? CODEX_ADVICE : null;
}

/** codex 建议的一句话形态：只收文本的说明句（如声明证据的覆盖面说明）由此附上 */
export const CODEX_LIMIT_ADVICE = CODEX_ADVICE.sentence;

/** 结果原文里 harness 写入的截断痕迹的分段——展示层据此把截断位置从正文里标
 *  出来：codex 的横幅与中缝丢弃标记、opencode 的落盘行。仅在
 *  toolOutputTruncationOf 判定成立的结果上调用（引用误报已在判定处排除）。 */
export interface OutputSegment {
  text: string;
  seam: boolean;
}

const SEAM_RE = /^(?:Warning: truncated output \(original token count: \d+\)\n(?:Total output lines: \d+\n|... \d+ bytes omitted ...\n)?)|…\d+ (?:chars|tokens) truncated…|\[showing lines \d+-\d+ of \d+; full output saved to [^\n\]]+\]/gm;

export function splitOutputSeams(text: string): OutputSegment[] {
  const segments: OutputSegment[] = [];
  let last = 0;
  SEAM_RE.lastIndex = 0;
  for (let m = SEAM_RE.exec(text); m != null; m = SEAM_RE.exec(text)) {
    if (m.index > last) segments.push({ text: text.slice(last, m.index), seam: false });
    segments.push({ text: m[0], seam: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last), seam: false });
  return segments;
}

/**
 * 截断调用的数据库查询超集（Prisma OR 分支）：两种形态的固定位置各一条——
 *  原生 codex 横幅在结果头、proxy 形态横幅在壳之后、opencode 落盘行。取回的行
 *  再经 toolOutputTruncationOf 精判；与错误超集（TOOL_CALL_ERROR_QUERY_OR）
 *  分列——截断不是错误，不进错误计数。 */
export type ToolOutputTruncationQueryBranch =
  | { resultJson: { startsWith: string } }
  | { resultJson: { contains: string } };

export const TOOL_OUTPUT_TRUNCATION_QUERY_OR: ToolOutputTruncationQueryBranch[] = [
  { resultJson: { startsWith: 'Warning: truncated output (original token count: ' } },
  { resultJson: { contains: '\nOutput:\nWarning: truncated output (original token count: ' } },
  { resultJson: { contains: '; full output saved to ' } },
];
