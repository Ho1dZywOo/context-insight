// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 派发 SkillEvent 全链 IT（真机核实的 wire 形状，修复回归锁）：
//   codex spawn_agent（真机现场：3 次派发、Audit agent 域恒 0）：
//     1. turn-split 经 dispatch-tools 注册表产出 dispatch 事件——历史缺陷：
//        turn-split 内联白名单缺 spawn_agent → codex 派发零事件、
//        deriveAgentTargetsFromDispatches 无目标
//     2. 事件名 = codex 返回的 nickname（与 Execution/泳道一致）；
//        无 nickname 时回落任务书「角色名」
//     3. claude Agent / opencode task 派发路径不回归（subagent_type /
//        prompt 角色名 / description 兜底）
//     4. 派发事件时间戳继承派发工具调用（非轮时间）
import { describe, it, expect, beforeAll } from 'vitest';
import { splitIntoTurns, resetIdCounter, type ToolCallRow } from '../../src/lib/ingest/turn-split.ts';
import { dispatchEventOf, resolveDispatchToolCall } from '../../src/lib/ingest/dispatch-tools.ts';
import { deriveAgentTargetsFromDispatches } from '../../src/lib/run/audit-registry.ts';
import type { RawInteraction, ToolCallInfo } from '../../src/lib/shared/types';
import type { SkillEventRow } from '../../src/lib/ingest/turn-split.ts';

function spawnAgentCall(
  toolCallId: string,
  message: string,
  nickname: string | null,
  startedAt = 1794380000000,
): ToolCallInfo {
  return {
    toolCallId,
    toolName: 'spawn_agent',
    argsJson: JSON.stringify({ message, fork_context: false }),
    resultJson: nickname ? JSON.stringify({ agent_id: `01a1c9-${toolCallId}`, nickname }) : null,
    state: 'completed',
    startedAt,
    completedAt: startedAt + 1200,
  };
}

function interactionWith(toolCalls: ToolCallInfo[]): RawInteraction {
  return {
    role: 'assistant',
    content: '派发子代理',
    timestamp: new Date(1794380000000).toISOString(),
    tool_calls: toolCalls,
    usage: null,
    agent: null,
    subagent_name: null,
    subagent_session_id: null,
    subagent_type: null,
    modelID: null,
    providerID: null,
    latency: null,
    finish_reason: null,
  } as unknown as RawInteraction;
}

const SPAWN_MESSAGES = [
  { nickname: 'Noether', message: '你是「数据分析员」子代理。请先 cat 读取技能文件：/home/u/.agents/skills/data-analysis/SKILL.md' },
  { nickname: 'Cicero', message: '你是「会议纪要员」子代理。请先 cat 读取技能文件：/home/u/.agents/skills/meeting-notes/SKILL.md' },
  { nickname: 'Halley', message: '你是「周报员」子代理。请先 cat 读取技能文件：/home/u/.agents/skills/weekly-report/SKILL.md' },
];

describe('codex spawn_agent 派发事件（真机现场：3 次派发、Audit agent 域恒 0）', () => {
  let toolCalls: ToolCallRow[];
  let skillEvents: SkillEventRow[];

  beforeAll(() => {
    resetIdCounter();
    const result = splitIntoTurns(
      [interactionWith(SPAWN_MESSAGES.map((m, i) => spawnAgentCall(`call_sp${i}`, m.message, m.nickname, 1794380000000 + i * 10000)))],
      'session-spawn-dispatch-test',
    );
    toolCalls = result.toolCalls;
    skillEvents = result.skillEvents;
  });

  it('三次 spawn_agent → 三个 dispatch 事件，名字 = nickname（与 Execution/泳道一致）', () => {
    const dispatches = skillEvents.filter(se => se.eventType === 'dispatch');
    expect(dispatches.map(se => se.skillName)).toEqual(['Noether', 'Cicero', 'Halley']);
    expect(dispatches.every(se => se.success)).toBe(true);
  });

  it('spawn_agent 工具行打 isSkillRelated；事件时间戳继承派发工具（durationMs=1200）', () => {
    const rows = toolCalls.filter(tc => tc.toolName === 'spawn_agent');
    expect(rows).toHaveLength(3);
    expect(rows.every(tc => tc.isSkillRelated)).toBe(true);
    const ev = skillEvents.find(se => se.skillName === 'Noether')!;
    const src = rows.find(tc => tc.toolCallId === 'call_sp0')!;
    expect(ev.durationMs).toBe(1200);
    expect(ev.startedAt).toBe(src.startedAt);
    expect(ev.completedAt).toBe(src.completedAt);
  });

  it('Audit agent 域从派发事件推导出 3 个对账目标（此前恒 0）', () => {
    const dispatches = skillEvents
      .filter(se => se.eventType === 'dispatch')
      .map(se => ({
        name: se.skillName,
        member: { taskId: 't1', label: '主会话' },
        source: 'event' as const,
      }));
    const targets = deriveAgentTargetsFromDispatches(dispatches);
    expect(targets.map(t => t.name).sort()).toEqual(['Cicero', 'Halley', 'Noether']);
    expect(targets.every(t => t.eventCount === 1)).toBe(true);
  });

  it('无 nickname 时回落任务书「角色名」提取', () => {
    const rec = resolveDispatchToolCall(spawnAgentCall('c9', '你是「质检员」子代理，请分析数据', null));
    expect(rec).not.toBeNull();
    expect(dispatchEventOf(rec!)).toEqual({ skillName: '质检员' });
  });
});

describe('既有派发框架不回归（dispatch-tools 注册表单源）', () => {
  it('claude Agent（subagent_type 非泛型）→ 事件名 = subagent_type', () => {
    const tc: ToolCallInfo = {
      toolCallId: 'c_agent',
      toolName: 'Agent',
      argsJson: JSON.stringify({ description: '审代码', prompt: 'review the code', subagent_type: 'code-reviewer' }),
      resultJson: 'task_id: ses_abc',
      state: 'completed',
      startedAt: 1794380000000,
      completedAt: 1794380009000,
    };
    const result = splitIntoTurns([interactionWith([tc])], 'session-claude-dispatch-test');
    const dispatches = result.skillEvents.filter(se => se.eventType === 'dispatch');
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]!.skillName).toBe('code-reviewer');
  });

  it('opencode task（泛型 subagent_type + prompt 角色名）→ 事件名 = 角色名', () => {
    const tc: ToolCallInfo = {
      toolCallId: 'c_task',
      toolName: 'task',
      argsJson: JSON.stringify({
        description: '干活',
        prompt: '你在此任务中扮演 工作流中的 "developer" agent，负责实现',
        subagent_type: 'general',
      }),
      resultJson: '<task id="ses_x" state="completed">',
      state: 'completed',
      startedAt: 1794380000000,
      completedAt: 1794380009000,
    };
    const result = splitIntoTurns([interactionWith([tc])], 'session-opencode-dispatch-test');
    const dispatches = result.skillEvents.filter(se => se.eventType === 'dispatch');
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]!.skillName).toBe('developer');
  });

  it('泛型派发无任何可提取名 → 不产事件也不打技能关联（历史口径：纯杂项派发不造噪声目标；bridge 走注册表不受影响）', () => {
    const tc: ToolCallInfo = {
      toolCallId: 'c_generic',
      toolName: 'agent',
      argsJson: JSON.stringify({ prompt: 'just do things', subagent_type: 'general-purpose' }),
      resultJson: 'task_id: ses_g',
      state: 'completed',
      startedAt: 1794380000000,
      completedAt: 1794380009000,
    };
    const result = splitIntoTurns([interactionWith([tc])], 'session-generic-dispatch-test');
    expect(result.skillEvents.filter(se => se.eventType === 'dispatch')).toHaveLength(0);
    expect(result.toolCalls.find(t => t.toolCallId === 'c_generic')!.isSkillRelated).toBe(false);
  });
});
