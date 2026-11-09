// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { isContinuationTurn } from '@/lib/shared/command-parser';

export interface ContextTurn {
  id: string;
  turnIndex: number;
  role: string;
  content: string | null;
  agentName?: string | null;
  isSubagent?: boolean;
  subagentSessionId?: string | null;
}

// A real local-command turn (command/caveat/stdout) STARTS with its tag.
// A /compact continuation summary may CONTAIN those tags mid-text (it
// summarizes a conversation that used commands), so an anywhere-match would
// wrongly drop the summary itself — hence the start-anchored check.
export function isLocalCommandNoise(text: string | null): boolean {
  if (!text) return false;
  return text.startsWith('<command-name>')
    || text.startsWith('<local-command-caveat>')
    || text.startsWith('<local-command-stdout>');
}

// Select the context turns that form the LLM input for the assistant turn at
// `targetTurnIndex`. A /compact continuation replaces the prior conversation
// history with a summary, so the window starts at the most recent continuation
// before the target — not at session start. Handles multiple compactions: each
// continuation truncates the window again. Local CLI command noise (command,
// caveat, stdout) is excluded since it is not sent to the LLM.
export function selectInputContextTurns(
  contextTurns: ContextTurn[],
  targetTurnIndex: number,
  targetAgentName?: string | null,
): ContextTurn[] {
  const isCompactionTurn = targetAgentName === 'compaction';

  let startTurnIndex = 0;
  for (const ct of contextTurns) {
    if (ct.turnIndex < targetTurnIndex) {
      if (ct.content && isContinuationTurn(ct.content)) {
        startTurnIndex = Math.max(startTurnIndex, ct.turnIndex);
      }
      if (ct.agentName === 'compaction' && !isCompactionTurn) {
        startTurnIndex = Math.max(startTurnIndex, ct.turnIndex);
      }
      if (ct.agentName === 'compaction-boundary' && !isCompactionTurn) {
        startTurnIndex = Math.max(startTurnIndex, ct.turnIndex + 1);
      }
    }
  }
  return contextTurns.filter(ct =>
    ct.turnIndex < targetTurnIndex &&
    ct.turnIndex >= startTurnIndex &&
    ['user', 'assistant', 'system', 'tool_result'].includes(ct.role) &&
    !isLocalCommandNoise(ct.content) &&
    ct.agentName !== 'compaction-boundary',
  );
}

export interface PriorToolCallRef {
  toolName: string;
  argsJson: string | null;
  resultJson: string | null;
  isSkillRelated?: boolean | null;
}

export interface PriorTurnRef extends ContextTurn {
  toolCalls?: ReadonlyArray<PriorToolCallRef>;
}

export interface InputWindowTarget {
  agentName: string | null;
  inputMessagesTokens: number;
  outputTokens: number;
}

export interface WireMessage {
  role: string;
  content: string | null;
  tokenCount: number;
  agentName?: string;
  tool_calls?: Array<{ name: string; args: string | null; result: string | null; isSkillRelated?: boolean }>;
}

/** 重建目标轮的 LLM 输入窗口消息列表（wire 序）。输入须先经
 *  selectInputContextTurns + toWireOrder（窗口选择与 reminder 折叠）；
 *  compactionTotals 提供窗口内压缩轮的 totalTokens（continuation 消息的
 *  精确 token 数）。服务端 turn-detail 与离线导出内核共用本单点——两侧
 *  重建语义不可能分裂。 */
export function buildInputMessages(
  prior: ReadonlyArray<PriorTurnRef>,
  target: InputWindowTarget,
  compactionTotals: ReadonlyMap<string, number>,
): string {
  const targetInputTokens = target.agentName === 'compaction'
    ? (target.inputMessagesTokens > 0 ? target.inputMessagesTokens : 0)
    : (target.inputMessagesTokens > 0 ? Math.max(0, target.inputMessagesTokens - target.outputTokens) : 0);
  const messages: WireMessage[] = [];
  for (const ct of prior) {
    const contentLen = ct.content?.length ?? 0;
    const baseTokens = Math.round(contentLen / 3.5);
    const isCompaction = ct.agentName === 'compaction';
    const isContinuation = isCompaction || (ct.role === 'user' && ct.content && isContinuationTurn(ct.content));
    const effectiveRole = isContinuation ? 'user' : ct.role;
    if (ct.role === 'assistant') {
      const tcs = ct.toolCalls ?? [];
      const argsTokens = tcs.reduce((s, tc) => s + Math.round((tc.argsJson?.length ?? 0) / 3.5), 0);
      const compactionTotal = compactionTotals.get(ct.id) ?? 0;
      const continuationTokens = isCompaction && compactionTotal > 0
        ? compactionTotal
        : (isContinuation && targetInputTokens > 0 ? targetInputTokens : baseTokens + argsTokens);
      const msg: WireMessage = {
        role: effectiveRole,
        content: ct.content ?? null,
        tokenCount: continuationTokens,
      };
      if (isContinuation) msg.agentName = 'continuation';
      if (tcs.length > 0 && !isCompaction) {
        msg.tool_calls = tcs.map(tc => {
          const isSkill = tc.isSkillRelated;
          const argsMax = isSkill ? 2000 : 1500;
          const resultMax = isSkill ? 5000 : 3000;
          return {
            name: tc.toolName,
            args: tc.argsJson ? (tc.argsJson.length > argsMax ? tc.argsJson.substring(0, argsMax) + '...' : tc.argsJson) : null,
            result: tc.resultJson ? (tc.resultJson.length > resultMax ? tc.resultJson.substring(0, resultMax) + '...' : tc.resultJson) : null,
            isSkillRelated: isSkill ? true : undefined,
          };
        });
      }
      messages.push(msg);
    } else {
      const isContinuationUser = isContinuation && ct.role === 'user';
      const continuationTokens = isContinuationUser && targetInputTokens > 0 ? targetInputTokens : baseTokens;
      const msg: WireMessage = {
        role: effectiveRole,
        content: ct.content ?? null,
        tokenCount: continuationTokens,
      };
      if (isContinuation) msg.agentName = 'continuation';
      messages.push(msg);
    }
  }
  return JSON.stringify(messages);
}

// Wire-fidelity pass for LLM Input reconstruction. On the wire, a
// <system-reminder> context block rides INSIDE a user message as a text block
// (reminder block + prompt block); the claude-jsonl adapter splits it into a
// system turn + user turn for the conversation view. Merge it back here so the
// reconstructed message list mirrors the original request: a reminder-split
// system turn directly before a user turn folds into that user message, and a
// standalone reminder turn (pure context injection, no prompt) becomes a user
// message — exactly what was sent. Registry / skill system turns (no reminder
// wrapper) pass through unchanged.
export function toWireOrder(contextTurns: ContextTurn[]): ContextTurn[] {
  const out: ContextTurn[] = [];
  for (let i = 0; i < contextTurns.length; i++) {
    const ct = contextTurns[i];
    const isReminder = ct.role === 'system' && (ct.content ?? '').startsWith('<system-reminder>');
    if (isReminder) {
      const next = contextTurns[i + 1];
      if (next?.role === 'user') {
        // the reminder turn preserves the original trailing whitespace, so
        // plain concatenation reproduces the exact wire message text
        out.push({ ...next, content: `${ct.content}${next.content ?? ''}` });
        i++;
        continue;
      }
      out.push({ ...ct, role: 'user' });
      continue;
    }
    out.push(ct);
  }
  return out;
}
