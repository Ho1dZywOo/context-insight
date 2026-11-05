// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 轮次关键词搜索纯函数（design: docs/design/run-observe-parity/design.md §3.2）。
// 从 /api/observe/session/turns/search 原位抽取：content / contentSummary /
// 工具调用 args / result / error / 工具名 六路匹配 + 「同 turn 先命中正文则
// 不再出工具条目」去重 + 上下文截取。session 与 run 两个端点共用（run 侧
// 跨成员全域搜索、按 sessionId 归因 member），匹配语义单点不复制。
// 工具名路：Overview 的 Tool Calls 面板把 toolName 当第一性标签展示（尤其
// MCP 工具，名字不出现在 args/result 里），搜工具名必须可命中——否则面板
// 展示的标签在搜索里零命中（跨页签可发现性断裂）。
// 全能语法（词法单点 turns-query.ts，与本文件同一 collector 层）：空格多词
// AND、引号短语、-排除、结构化算子（role/member/agent/tool/error/thinking/
// dur/tokens/after/before）；纯算子查询（如 error:true）无文本词时以摘要为
// 命中上下文。单词法零变化兼容（单词 = 原单关键词语义）。
import { parseTurnsQuery, rowPassesFilters, type TurnsTextTerm } from "./turns-query";

export interface TurnSearchRow {
  id: string;
  sessionId: string;
  turnIndex: number;
  role: string;
  content: string | null;
  contentSummary: string | null;
  agentName: string | null;
  isSubagent: boolean;
  subagentName: string | null;
  subagentSessionId: string | null;
  createdAt_ts: Date | null;
  createdAt: Date;
  /** 命中轮的思维链 token 数（可选——命中索引的 thinking 过滤面；行源缺省则该面不可用） */
  reasoningTokens?: number | null;
  /** 单轮耗时（可选——dur: 阈值算子；与 Turns 左列同口径，行源缺省则该算子不可满足） */
  turnMs?: number | null;
  /** 轮 token 总量（可选——tokens: 阈值算子） */
  totalTokens?: number | null;
  toolCalls: Array<{
    toolCallId: string;
    toolName: string;
    dispatchBridgeId: string | null;
    argsJson: string | null;
    resultJson: string | null;
    errorMessage: string | null;
  }>;
}

export interface TurnSearchItem {
  turnId: string;
  turnIndex: number;
  role: string;
  agentName: string | null;
  isSubagent: boolean;
  subagentName: string | null;
  subagentSessionId: string | null;
  contentSummary: string | null;
  matchContext: string;
  matchField: 'content' | 'contentSummary' | 'toolResult' | 'toolError' | 'toolArgs' | 'toolName';
  toolName?: string;
  createdAt: string;
  hasDispatchBridge: boolean;
  /** 命中轮的思维链 token 数（可选——thinking 过滤面） */
  reasoningTokens?: number | null;
  /** 命中轮用过的工具名全集（小写去重，可选——工具过滤面） */
  toolNames?: string[];
  /** run 作用域归因（session 端点不传 memberOf 时不出现，响应字节不变） */
  member?: { taskId: string; label: string | null } | null;
}

function extractMatchContext(text: string, keyword: string, contextRadius: number = 60): string {
  const lowerText = text.toLowerCase();
  const lowerKeyword = keyword.toLowerCase();
  const idx = lowerText.indexOf(lowerKeyword);
  if (idx === -1) return text.substring(0, contextRadius * 2);
  const start = Math.max(0, idx - contextRadius);
  const end = Math.min(text.length, idx + keyword.length + contextRadius);
  let context = text.substring(start, end);
  if (start > 0) context = '...' + context;
  if (end < text.length) context = context + '...';
  return context;
}

export interface MatchTurnSearchOptions {
  /** sessionId → 成员归因（run 作用域）；缺省不附 member */
  memberOf?: (sessionId: string) => { taskId: string; label: string | null } | null;
}

/** 六路载体命中定位：词在其首个命中载体（content > 摘要 > 逐工具调用的
 * args > result > error > 名——与条目去重/上下文优先级同序）；未命中 null */
function locateTermCarrier(
  term: TurnsTextTerm,
  t: TurnSearchRow,
  contentLower: string,
  summaryLower: string,
): { field: "content" | "contentSummary" | "toolArgs" | "toolResult" | "toolError" | "toolName"; text: string } | null {
  if (contentLower.includes(term.lower)) return { field: "content", text: t.content ?? "" };
  if (summaryLower.includes(term.lower)) return { field: "contentSummary", text: t.contentSummary ?? "" };
  for (const tc of t.toolCalls) {
    if ((tc.argsJson ?? "").toLowerCase().includes(term.lower)) return { field: "toolArgs", text: tc.argsJson ?? "" };
    if ((tc.resultJson ?? "").toLowerCase().includes(term.lower)) return { field: "toolResult", text: tc.resultJson ?? "" };
    if ((tc.errorMessage ?? "").toLowerCase().includes(term.lower)) return { field: "toolError", text: tc.errorMessage ?? "" };
    if (tc.toolName.toLowerCase().includes(term.lower)) return { field: "toolName", text: tc.argsJson ?? tc.resultJson ?? "" };
  }
  return null;
}

export function matchTurnSearch(rows: TurnSearchRow[], query: string, options: MatchTurnSearchOptions = {}): TurnSearchItem[] {
  const parsed = parseTurnsQuery(query);
  if (parsed.empty) return [];
  const memberOf = options.memberOf;
  const positive = parsed.terms.filter(x => !x.negated);
  const negative = parsed.terms.filter(x => x.negated);
  const items: TurnSearchItem[] = [];

  for (const t of rows) {
    const contentLower = (t.content ?? "").toLowerCase();
    const summaryLower = (t.contentSummary ?? "").toLowerCase();
    // 排除词：任一载体命中即整轮出局（优先于正词与算子）
    let excluded = false;
    for (const nt of negative) {
      if (locateTermCarrier(nt, t, contentLower, summaryLower)) { excluded = true; break; }
    }
    if (excluded) continue;

    const member = memberOf ? memberOf(t.sessionId) : undefined;
    if (!rowPassesFilters(t, parsed.filters, member?.label ?? null, member?.taskId ?? null)) continue;

    // 正词逐词定位：任一词无载体 → 整轮不命中（多词 AND）
    const carriers = positive.map(pt => locateTermCarrier(pt, t, contentLower, summaryLower));
    if (positive.length > 0 && carriers.some(c => c == null)) continue;

    // 过滤面数据（同轮各路命中共用）：工具名全集（小写去重）+ 思维链 token 数
    const toolNames = [...new Set(t.toolCalls.map(tc => tc.toolName.toLowerCase()))];
    const reasoningTokens = t.reasoningTokens ?? null;
    const createdAt = t.createdAt_ts?.toISOString() ?? t.createdAt.toISOString();
    const contentSummary = t.contentSummary ?? t.content?.substring(0, 200) ?? null;
    const hasDispatchBridge = t.toolCalls.some(tc => tc.dispatchBridgeId !== null && tc.dispatchBridgeId !== undefined);
    const base = {
      turnId: t.id,
      turnIndex: t.turnIndex,
      role: t.role,
      agentName: t.agentName,
      isSubagent: t.isSubagent,
      subagentName: t.subagentName,
      subagentSessionId: t.subagentSessionId,
      contentSummary,
      createdAt,
      reasoningTokens,
      toolNames,
      ...(member !== undefined ? { member } : {}),
    };

    // 正文/摘要级命中（任一正词落在正文或摘要）→ 轮级单条目（沿用「先命中
    // 正文则不再出工具条目」去重；上下文取首个命中正文/摘要的词）
    const contentIdx = carriers.findIndex(c => c?.field === "content");
    const summaryIdx = contentIdx === -1 ? carriers.findIndex(c => c?.field === "contentSummary") : -1;
    const bodyIdx = contentIdx !== -1 ? contentIdx : summaryIdx;
    if (bodyIdx !== -1) {
      const c = carriers[bodyIdx]!;
      items.push({
        ...base,
        matchContext: extractMatchContext(c.text, positive[bodyIdx].text),
        matchField: c.field,
        hasDispatchBridge,
      });
      continue;
    }

    if (positive.length > 0) {
      // 工具载体命中：每个命中正词的工具调用各出一条目；词序优先，词内按
      // args > result > error > 名（载体优先级：关键词真出现在载体里的路
      // 上下文更具体；纯名字命中时载体只作调用内容预览）
      for (const tc of t.toolCalls) {
        const argsL = (tc.argsJson ?? "").toLowerCase();
        const resultL = (tc.resultJson ?? "").toLowerCase();
        const errorL = (tc.errorMessage ?? "").toLowerCase();
        const nameL = tc.toolName.toLowerCase();
        let field: "toolArgs" | "toolResult" | "toolError" | "toolName" | null = null;
        let matchText = "";
        let hitTerm: TurnsTextTerm | null = null;
        for (let i = 0; i < positive.length && hitTerm == null; i++) {
          const lower = positive[i].lower;
          if (argsL.includes(lower)) { hitTerm = positive[i]; field = "toolArgs"; matchText = tc.argsJson ?? ""; }
          else if (resultL.includes(lower)) { hitTerm = positive[i]; field = "toolResult"; matchText = tc.resultJson ?? ""; }
          else if (errorL.includes(lower)) { hitTerm = positive[i]; field = "toolError"; matchText = tc.errorMessage ?? ""; }
          else if (nameL.includes(lower)) { hitTerm = positive[i]; field = "toolName"; matchText = tc.argsJson ?? tc.resultJson ?? ""; }
        }
        if (field != null && hitTerm != null) {
          items.push({
            ...base,
            matchContext: matchText
              ? `🔧 ${tc.toolName}: ${extractMatchContext(matchText, hitTerm.text)}`
              : `🔧 ${tc.toolName}`,
            matchField: field,
            toolName: tc.toolName,
            hasDispatchBridge: tc.dispatchBridgeId !== null && tc.dispatchBridgeId !== undefined,
          });
        }
      }
    } else {
      // 纯算子/纯排除词查询（无文本正词）：摘要为命中上下文的轮级条目——
      // error:true 这类「不知道错误文本也要能排查」的走查形态
      const head = t.contentSummary ?? t.content?.substring(0, 200) ?? "";
      items.push({
        ...base,
        matchContext: head.length > 160 ? `${head.slice(0, 160)}…` : head,
        matchField: "content",
        hasDispatchBridge,
      });
    }
  }

  return items;
}
