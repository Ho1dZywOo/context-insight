// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Turns 搜索查询词法（单点）：一框全能语法，UI（提示/高亮）、run 端点（SQL
// 下推）、导出查看器（离线同语义）三方共用，词法不复制。
//
// 语法（空格分隔，全部 AND）：
//   裸词           多关键词 AND——每词须在六路载体（正文/摘要/工具参数/
//                  结果/错误/工具名）任一路命中；单词退化 = 原单关键词语义
//   "短语"         引号内作整体原子（中文引号 "" 同样接受——输入法免切换）
//   -词 / -"短语"  排除词：任一载体命中即整轮排除
//   role:x         角色子串（user / assistant / system / tool_result…）
//   member:x       run 合并视图成员标签或 taskId 子串（session 侧行源无
//                  member 归因时该算子不可满足——诚实排除而非静默忽略）
//   agent:x        agentName / subagentName 子串（子代理场景）
//   tool:x         该轮「用过」名字含 x 的工具（与文本路工具名命中互补：
//                  不要求名字里含关键词，而按名筛轮，可与文本词组合）
//   error:true     工具错误有无（true/false/1/0/yes/no）
//   thinking:>N    思维链 token 阈值；dur:>Ns 单轮耗时（ms/s/m/h 后缀）；
//   tokens:>N      轮 token 总量阈值——比较符 > >= < <=，裸数值按 >=；
//                  数值支持 k/m 后缀（5k = 5000）
//   after:/before: 时间窗：HH:mm[:ss] 按轮自身日期取当日时刻（跨天工作
//                  时段类过滤）；MM-DD HH:mm、YYYY-MM-DD[ HH:mm[:ss]] 绝
//                  对时刻（含空格须引号：after:"11-04 15:30"）
//   未知 key:value 回落为文本词——「12:30」「http://x」这类带冒号文本不被
//   劫持；负号前缀对一切算子取非（-tool:x = 没用过该工具的轮）
//
// 纯算子/纯排除词查询是一等查询（error:true 列出全部出错轮——不知道错误
// 文本也要能排查）；无文本正词时命中条目以摘要为上下文。
import type { TurnSearchRow } from "./search";

export interface TurnsTextTerm {
  /** 原词（引号内保留空格；用于高亮与上下文截取） */
  text: string;
  lower: string;
  negated: boolean;
}

export type TurnsQueryFilter =
  | { op: "role" | "member" | "agent" | "tool"; value: string; lower: string; negated: boolean }
  | { op: "error"; value: boolean; negated: boolean }
  | { op: "thinking" | "dur" | "tokens"; cmp: ">=" | ">" | "<" | "<="; value: number; negated: boolean }
  | { op: "after" | "before"; mode: "time-of-day"; h: number; m: number; s: number; negated: boolean }
  | { op: "after" | "before"; mode: "absolute"; ts: number; negated: boolean };

export interface ParsedTurnsQuery {
  terms: TurnsTextTerm[];
  filters: TurnsQueryFilter[];
  /** 正文本词（原串）——高亮/详情展开定位用；负词与算子不参与 */
  positiveTerms: string[];
  /** 语法成分是否为空（全空白或无法成词） */
  empty: boolean;
}

const SUBSTRING_OPS = new Set(["role", "member", "agent", "tool"]);
const COMPARE_OPS = new Set(["thinking", "dur", "tokens"]);
const TIME_OPS = new Set(["after", "before"]);

/** 数值解析：裸数与 k/m 后缀（dur 的 ms/s/m/h 时长后缀在调用方先剥） */
function parseNumber(raw: string): number | null {
  const m = /^(\d+(?:\.\d+)?)([km]?)$/i.exec(raw.trim());
  if (!m) return null;
  const base = Number(m[1]);
  const mult = m[2].toLowerCase() === "k" ? 1e3 : m[2].toLowerCase() === "m" ? 1e6 : 1;
  return Number.isFinite(base) ? base * mult : null;
}

/** 比较算子值：>N / >=N / <N / <=N（裸 N 按 >=）；数值后缀——dur 为时长
 * 单位 ms/s/m/h（缺省 ms），thinking/tokens 为千分位 k/m（5k = 5000） */
function parseCompareValue(raw: string, op: string): { value: number } | null {
  const m = /^(\d+(?:\.\d+)?)\s*([a-zA-Z]*)$/.exec(raw.trim());
  if (!m) return null;
  const base = Number(m[1]);
  if (!Number.isFinite(base)) return null;
  const unit = m[2].toLowerCase();
  let value = base;
  if (op === "dur") {
    if (unit === "" || unit === "ms") value = base;
    else if (unit === "s") value = base * 1e3;
    else if (unit === "m") value = base * 60_000;
    else if (unit === "h") value = base * 3_600_000;
    else return null;
  } else if (unit === "") {
    value = base;
  } else if (unit === "k") {
    value = base * 1e3;
  } else if (unit === "m") {
    value = base * 1e6;
  } else {
    return null;
  }
  return { value };
}

/** 时间值：HH:mm[:ss]（当日时刻）| MM-DD[ ]HH:mm | YYYY-MM-DD[[ ]HH:mm[:ss]] */
function parseTimeValue(raw: string): { mode: "time-of-day"; h: number; m: number; s: number } | { mode: "absolute"; ts: number } | null {
  const v = raw.trim();
  let m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(v);
  if (m) {
    const h = Number(m[1]), mi = Number(m[2]), s = m[3] ? Number(m[3]) : 0;
    if (h > 23 || mi > 59 || s > 59) return null;
    return { mode: "time-of-day", h, m: mi, s };
  }
  // YYYY-MM-DD[ HH:mm[:ss]]（日期时间可带空格——带空格须整体引号）
  m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(v);
  if (m) {
    const ts = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), m[4] ? Number(m[4]) : 0, m[5] ? Number(m[5]) : 0, m[6] ? Number(m[6]) : 0).getTime();
    return Number.isFinite(ts) ? { mode: "absolute", ts } : null;
  }
  // MM-DD HH:mm（本年；含空格须整体引号）
  m = /^(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(v);
  if (m) {
    const ts = new Date(new Date().getFullYear(), Number(m[1]) - 1, Number(m[2]), Number(m[3]), Number(m[4])).getTime();
    return Number.isFinite(ts) ? { mode: "absolute", ts } : null;
  }
  return null;
}

/** 引号配对（ASCII 与中文弯引号都认——输入法免切换） */
const QUOTE_PAIRS: Array<[string, string]> = [["\"", "\""], ["\u201c", "\u201d"]];

/** 剥引号壳：成对包裹整串 → 内芯；只有开引号 → 开引号后余串（容错未闭
 * 合）；开引号后杂字（`"x"y`）→ null（不按引号词解释） */
function stripQuotes(s: string): string | null {
  for (const [open, close] of QUOTE_PAIRS) {
    if (!s.startsWith(open)) continue;
    const closeIdx = s.indexOf(close, open.length);
    if (closeIdx === -1) return s.slice(open.length).trim();
    if (closeIdx + close.length === s.length) return s.slice(open.length, closeIdx);
    return null;
  }
  return null;
}

/** 分词：空格切分；引号内空格保留——引号可在词首（"短语"）也可在算子值
 *（after:"11-04 15:30"），词内引号段不算边界；前导 - 为否定标记 */
function tokenize(q: string): Array<{ raw: string; negated: boolean }> {
  const tokens: Array<{ raw: string; negated: boolean }> = [];
  let i = 0;
  while (i < q.length) {
    const ch = q[i];
    if (/\s/.test(ch)) { i++; continue; }
    let negated = false;
    if (ch === "-" && i + 1 < q.length && !/\s/.test(q[i + 1])) { negated = true; i++; }
    let j = i;
    let closeQuote: string | null = null;
    while (j < q.length) {
      const c = q[j];
      if (closeQuote != null) {
        if (c === closeQuote) closeQuote = null;
        j++;
        continue;
      }
      const pair = QUOTE_PAIRS.find(([open]) => q.startsWith(open, j));
      if (pair) { closeQuote = pair[1]; j++; continue; }
      if (/\s/.test(c)) break;
      j++;
    }
    tokens.push({ raw: q.slice(i, j), negated });
    i = j;
  }
  return tokens;
}

export function parseTurnsQuery(query: string): ParsedTurnsQuery {
  const terms: TurnsTextTerm[] = [];
  const filters: TurnsQueryFilter[] = [];
  for (const { raw, negated } of tokenize(query)) {
    const v = raw.trim();
    if (!v) continue;
    // 整词引号：短语原子（含带冒号文本——"http://x" 不被算子劫持）
    const quoted = stripQuotes(v);
    if (quoted != null) {
      if (quoted) terms.push({ text: quoted, lower: quoted.toLowerCase(), negated });
      continue;
    }
    // 算子形 key:value（未知 key 回落文本词——带冒号文本不被劫持）
    const sep = v.indexOf(":");
    if (sep > 0) {
      const key = v.slice(0, sep).toLowerCase();
      let value = v.slice(sep + 1).trim();
      // 算子值可引号（含空格的时间值：after:"11-04 15:30"）
      if (value.startsWith("\"") || value.startsWith("\u201c")) {
        const inner = stripQuotes(value);
        if (inner != null) value = inner;
      }
      if (SUBSTRING_OPS.has(key) && value) {
        filters.push({ op: key as "role" | "member" | "agent" | "tool", value, lower: value.toLowerCase(), negated });
        continue;
      }
      if (key === "error" && value) {
        const bool = /^(true|1|yes)$/i.test(value) ? true : /^(false|0|no)$/i.test(value) ? false : null;
        if (bool != null) { filters.push({ op: "error", value: bool, negated }); continue; }
      }
      if (COMPARE_OPS.has(key)) {
        const cmpMatch = /^(>=|<=|>|<)?\s*(.+)$/.exec(value);
        const parsed = cmpMatch ? parseCompareValue(cmpMatch[2], key) : null;
        if (parsed && cmpMatch) {
          const cmp = (cmpMatch[1] ?? ">=") as ">=" | ">" | "<" | "<=";
          filters.push({ op: key as "thinking" | "dur" | "tokens", cmp, value: parsed.value, negated });
          continue;
        }
      }
      if (TIME_OPS.has(key) && value) {
        const t = parseTimeValue(value);
        if (t) {
          filters.push(t.mode === "time-of-day"
            ? { op: key as "after" | "before", mode: "time-of-day", h: t.h, m: t.m, s: t.s, negated }
            : { op: key as "after" | "before", mode: "absolute", ts: t.ts, negated });
          continue;
        }
      }
    }
    terms.push({ text: v, lower: v.toLowerCase(), negated });
  }
  return {
    terms,
    filters,
    positiveTerms: terms.filter(t => !t.negated).map(t => t.text),
    empty: terms.length === 0 && filters.length === 0,
  };
}

/** 行级谓词求值：算子全 AND；dur/tokens 依赖行源供数（缺数不可满足——
 * 诚实排除而非静默放行）；HH:mm 按轮自身日期取当日时刻 */
export function rowPassesFilters(
  row: Pick<TurnSearchRow, "role" | "agentName" | "subagentName" | "createdAt" | "reasoningTokens" | "toolCalls"> & {
    turnMs?: number | null;
    totalTokens?: number | null;
  },
  filters: TurnsQueryFilter[],
  memberLabel: string | null,
  memberTaskId: string | null = null,
): boolean {
  for (const f of filters) {
    let pass: boolean;
    switch (f.op) {
      case "role":
        pass = row.role.toLowerCase().includes(f.lower); break;
      case "member": {
        // 成员标签 **或** taskId 子串（联合命中——run 合并视图按 sessionId 归因，
        // label 与 taskId 都是成员身份，缺 label 时 taskId 仍可筛）
        const labelHit = memberLabel != null && memberLabel.toLowerCase().includes(f.lower);
        const taskHit = memberTaskId != null && memberTaskId.toLowerCase().includes(f.lower);
        pass = labelHit || taskHit;
        break;
      }
      case "agent": {
        const l = `${row.agentName ?? ""} ${row.subagentName ?? ""}`.toLowerCase();
        pass = l.includes(f.lower); break;
      }
      case "tool":
        pass = row.toolCalls.some(tc => tc.toolName.toLowerCase().includes(f.lower)); break;
      case "error":
        pass = row.toolCalls.some(tc => (tc.errorMessage ?? "").length > 0) === f.value; break;
      case "thinking":
        pass = cmpNum(row.reasoningTokens ?? null, f.cmp, f.value); break;
      case "dur":
        pass = cmpNum(row.turnMs ?? null, f.cmp, f.value); break;
      case "tokens":
        pass = cmpNum(row.totalTokens ?? null, f.cmp, f.value); break;
      case "after":
      case "before": {
        const ts = row.createdAt.getTime();
        const bound = f.mode === "absolute"
          ? f.ts
          : (() => {
              const d = new Date(row.createdAt);
              return new Date(d.getFullYear(), d.getMonth(), d.getDate(), f.h, f.m, f.s).getTime();
            })();
        pass = f.op === "after" ? ts >= bound : ts <= bound;
        break;
      }
    }
    if (f.negated) pass = !pass;
    if (!pass) return false;
  }
  return true;
}

function cmpNum(v: number | null | undefined, cmp: ">=" | ">" | "<" | "<=", threshold: number): boolean {
  if (v == null || !Number.isFinite(v)) return false;
  return cmp === ">" ? v > threshold : cmp === "<" ? v < threshold : cmp === "<=" ? v <= threshold : v >= threshold;
}
