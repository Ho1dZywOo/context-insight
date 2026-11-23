// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 后台派发（Async agent launched）建桥 IT——孤儿根因的消费端闭环。
//
// 现场（solo:8ae4a944）：cpx 捕获的 claude 后台派发回执只有 claude 逻辑成员
// id（agentId: <hex>），meta 三字段全空（旧版捕获，跨进程内存态失守）。
// 旧建桥链 arg/meta/result 三路全空 + resultJson 非空 → 直接跳过 → 孤儿
// 泳道（2 个子代理 $244 / 1300 turns 无归属）。
// 修复后两条新链路各归其位：
//   claudeAgentId 链——新捕获 meta.claudeAgentId 落盘，回执 agentId 精确解析
//   task 链——派发 prompt ↔ 子文件首条任务文本精确匹配（旧捕获重导自愈）
// 失败派发守卫保持：五路全空 + resultJson 非空 → 仍不建桥。

import { describe, it, expect, beforeEach } from 'vitest';
import { buildBridges, resetIdCounter } from '../../src/lib/ingest/bridge-builder.ts';
import { splitIntoTurns, resetIdCounter as resetTurnIdCounter } from '../../src/lib/ingest/turn-split.ts';
import { normalize } from '../../src/lib/ingest/normalize.ts';
import type { RawInteraction, SubagentLinkageMaps } from '../../src/lib/shared/types.ts';

const T0 = 1772275201000; // 2026-03-01T00:00:01Z，与同族用例同基
const TASK = '当前的阶段是：Stage 1 Golden 基线（跑起来）';
const CLAUDE_AGENT_ID = 'a98641f58960793f1';
const SUB_ID = 'sub-35b1bc79e92b'; // cpx 铸的规范 id（md5(task) 前 12 位）
const RECEIPT = `Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)
agentId: ${CLAUDE_AGENT_ID} (internal ID - do not mention to user. Use SendMessage with to: '${CLAUDE_AGENT_ID}', summary: '<5-10 word recap>' to continue this agent.)
The agent is working in the background. You will be notified automatically when it completes.`;

function mainDispatch(prompt: string, receipt: string): RawInteraction {
  return {
    role: 'assistant',
    content: '派发后台子代理。',
    timestamp: new Date(T0).toISOString(),
    timeInfo: { created: T0, completed: T0 + 1000 },
    agent: 'build',
    subagent_name: null,
    subagent_session_id: null,
    subagent_type: null,
    tool_calls: [{
      toolCallId: 'toolu_orphan_1',
      toolName: 'Agent',
      argsJson: JSON.stringify({ description: 'Stage 1 golden design', subagent_type: 'general-purpose', prompt }),
      resultJson: receipt,
      state: 'ok',
    }],
    usage: { total: 500, input: 400, output: 100, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.005, inputMessagesTokens: 400 },
    model: 'glm-5.2',
    modelID: null,
    providerID: null,
    latency: 1000,
    finish_reason: 'tool-calls',
  };
}

function subTurn(createdMs: number, sid: string, tokens: number): RawInteraction {
  return {
    role: 'subagent',
    content: '阶段产物。',
    timestamp: new Date(createdMs).toISOString(),
    timeInfo: { created: createdMs, completed: createdMs + 3000 },
    agent: null,
    subagent_name: null,
    subagent_session_id: sid,
    subagent_type: null,
    tool_calls: null,
    usage: { total: tokens, input: 100, output: 100, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.002, inputMessagesTokens: 100 },
    model: 'glm-5.2',
    modelID: null,
    providerID: null,
    latency: 3000,
    finish_reason: 'stop',
  };
}

function emptyMaps(): SubagentLinkageMaps {
  return { toolUseIdToSessionId: new Map(), claudeAgentIdToSessionId: new Map(), taskToSessionId: new Map() };
}

function bridgesFor(interactions: RawInteraction[], maps: SubagentLinkageMaps) {
  const normalized = normalize(interactions, 'claude-jsonl');
  const split = splitIntoTurns(normalized, 'session-async-orphan');
  return buildBridges(normalized, split.toolCalls, split.turns, 'session-async-orphan', 'root-exec', maps);
}

describe('bridge-builder：后台派发回执（agentId: <hex>）建桥', () => {
  beforeEach(() => {
    resetIdCounter();
    resetTurnIdCounter();
  });

  it('claudeAgentId 链：回执 agentId 经 meta.claudeAgentId 映射解析为规范 id', () => {
    const maps = emptyMaps();
    maps.claudeAgentIdToSessionId.set(CLAUDE_AGENT_ID, SUB_ID);
    const bs = bridgesFor(
      [mainDispatch(TASK, RECEIPT), subTurn(T0 + 5_000, SUB_ID, 300)],
      maps,
    );
    expect(bs).toHaveLength(1);
    expect(bs[0]!.subagentSessionId).toBe(SUB_ID);
    expect(bs[0]!.subagentTokens).toBe(300); // 归属成立 → turn/tokens 计入
    expect(bs[0]!.status).toBe('completed');
  });

  it('task 链：meta 全空的旧捕获，prompt↔首条任务文本精确匹配硬链', () => {
    const maps = emptyMaps();
    maps.taskToSessionId.set(TASK, SUB_ID);
    const bs = bridgesFor(
      [mainDispatch(TASK, RECEIPT), subTurn(T0 + 5_000, SUB_ID, 300)],
      maps,
    );
    expect(bs).toHaveLength(1);
    expect(bs[0]!.subagentSessionId).toBe(SUB_ID);
    expect(bs[0]!.subagentTokens).toBe(300);
  });

  it('链序：toolUseId（meta 直锚）优先于 claudeAgentId/task 兜底', () => {
    const maps = emptyMaps();
    maps.toolUseIdToSessionId.set('toolu_orphan_1', 'sub-meta-anchored');
    maps.claudeAgentIdToSessionId.set(CLAUDE_AGENT_ID, SUB_ID);
    maps.taskToSessionId.set(TASK, SUB_ID);
    const bs = bridgesFor(
      [mainDispatch(TASK, RECEIPT), subTurn(T0 + 5_000, 'sub-meta-anchored', 300)],
      maps,
    );
    expect(bs).toHaveLength(1);
    expect(bs[0]!.subagentSessionId).toBe('sub-meta-anchored');
  });

  it('五路全空 + resultJson 非空：失败派发守卫保持（不建桥、不落时间邻近）', () => {
    const bs = bridgesFor(
      [mainDispatch(TASK, 'Error: invalid parameters rejected'),
        subTurn(T0 + 5_000, 'sub-unrelated', 300)],
      emptyMaps(),
    );
    expect(bs).toHaveLength(0);
  });

  it('agentId 映射缺位（映射无此键）不误链：守卫仍然兜住', () => {
    const maps = emptyMaps();
    maps.claudeAgentIdToSessionId.set('another-agent-id', SUB_ID);
    const bs = bridgesFor(
      [mainDispatch(TASK, RECEIPT), subTurn(T0 + 5_000, SUB_ID, 300)],
      maps,
    );
    expect(bs).toHaveLength(0);
  });
});
