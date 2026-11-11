// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.
// codex 会话双路径集成测试（真机核实的 wire 形状，修复回归锁）：
//   捕获路径（cpx codex-emitter → claude 布局 → claude-jsonl adapter）：
//     1. exec_command cat SKILL.md → SkillEvent（此前 codex 无 Read 工具、
//        检测只认 Read → Skills 面板恒空，真机实测模型真实调用技能但 0 事件）
//     2. tool_use 行 ts < tool_result 行 ts → 工具时长非 0（此前
//        completedAt 含 dump I/O 尾段开销，与下一轮 receivedAt 倒挂 →
//        durationMs 被 clamp 成 0，真机实测 31ms 倒挂）
//     3. cc-wire-round.reasoningTokens 信封 → Turn reasoningTokens（此前
//        信封缺字段 → deepseek 系思考模型 reasoning 恒 0，真机实测 197 → 0）
//     4. usage.reasoning_tokens 读侧兜底（旧版捕获件没有信封字段）
//   原生路径（rollout → codex-jsonl adapter）：
//     5. function_call 行 ts → startedAt、function_call_output 行 ts →
//        completedAt（此前两字段恒缺 → 工具时长恒 0）
//     6. 同一技能检测通道在原生路径生效
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSession as readClaudeSession } from '../../src/lib/ingest/adapters/claude-jsonl.ts';
import { readSession as readCodexSession } from '../../src/lib/ingest/adapters/codex-jsonl.ts';
import { splitIntoTurns, resetIdCounter } from '../../src/lib/ingest/turn-split.ts';

const CAPTURE_FIXTURE = path.resolve(__dirname, './data/claude-sessions/codex-skill-capture.jsonl');
const ROLLOUT_FIXTURE = path.resolve(__dirname, './data/codex-skill-sessions/rollout-2026-11-11T09-30-01-55555555-eeee-4b04-8f7e-abcdef000005.jsonl');

describe('codex 捕获路径（cpx → claude-jsonl → turn-split）', () => {
  let turns: ReturnType<typeof splitIntoTurns>['turns'];
  let toolCalls: ReturnType<typeof splitIntoTurns>['toolCalls'];
  let skillEvents: ReturnType<typeof splitIntoTurns>['skillEvents'];

  beforeAll(() => {
    resetIdCounter();
    const interactions = readClaudeSession(CAPTURE_FIXTURE, 'codex-skill-capture');
    const result = splitIntoTurns(interactions, 'session-codex-skill-capture-test');
    turns = result.turns;
    toolCalls = result.toolCalls;
    skillEvents = result.skillEvents;
  });

  it('exec_command cat SKILL.md 产出技能 load 事件（此前 codex 恒空）', () => {
    const loads = skillEvents.filter(se => se.skillName === 'cannbay-report');
    expect(loads.length).toBeGreaterThanOrEqual(1);
    expect(loads.every(se => se.success)).toBe(true);
  });

  it('exec_command 工具时长 = tool_result 行时刻 − tool_use 行时刻（非 0、非倒挂）', () => {
    const exec = toolCalls.find(tc => tc.toolName === 'exec_command');
    expect(exec).toBeDefined();
    // fixture: tool_use 行 02:11:09.400Z，tool_result 行 02:11:09.450Z → 50ms
    expect(exec!.durationMs).toBe(50);
  });

  it('合成 skill/cannbay-report 调用与 exec_command 并存于工具行', () => {
    const synth = toolCalls.find(tc => tc.toolName === 'skill/cannbay-report');
    expect(synth).toBeDefined();
    expect(synth!.toolCallId).toBe('skill-call_2b53ddcaabbe43af90b76645');
  });

  it('cc-wire-round.reasoningTokens 信封 → assistant turn reasoning 非零', () => {
    const t = turns.find(x => x.role === 'assistant');
    expect(t).toBeDefined();
    expect(t!.reasoningTokens).toBe(197);
  });
});

describe('codex 原生 rollout 路径（codex-jsonl → turn-split）', () => {
  let turns: ReturnType<typeof splitIntoTurns>['turns'];
  let toolCalls: ReturnType<typeof splitIntoTurns>['toolCalls'];
  let skillEvents: ReturnType<typeof splitIntoTurns>['skillEvents'];

  beforeAll(() => {
    resetIdCounter();
    const interactions = readCodexSession(ROLLOUT_FIXTURE, '55555555-eeee-4b04-8f7e-abcdef000005');
    const result = splitIntoTurns(interactions, 'session-codex-rollout-skill-test');
    turns = result.turns;
    toolCalls = result.toolCalls;
    skillEvents = result.skillEvents;
  });

  it('function_call 行 ts → startedAt、function_call_output 行 ts → completedAt（时长 4s）', () => {
    const exec = toolCalls.find(tc => tc.toolName === 'exec_command');
    expect(exec).toBeDefined();
    // fixture: function_call 09:30:10.000Z → output 09:30:14.000Z
    expect(exec!.durationMs).toBe(4000);
    expect(exec!.startedAt).not.toBeNull();
    expect(exec!.completedAt).not.toBeNull();
  });

  it('exec_command cat SKILL.md 在原生路径同样产出技能事件', () => {
    expect(skillEvents.filter(se => se.skillName === 'cannbay-report').length).toBeGreaterThanOrEqual(1);
  });

  it('reasoning token 从 token_usage_record 正确落 turn（15）', () => {
    const t = turns.find(x => x.role === 'assistant');
    expect(t).toBeDefined();
    expect(t!.reasoningTokens).toBe(15);
  });
});

describe('usage.reasoning_tokens 读侧兜底（旧版捕获件：信封缺 reasoningTokens）', () => {
  it('信封字段被抹去时仍从 usage 块恢复 reasoning（197）', () => {
    const tmp = path.join(os.tmpdir(), `codex-old-capture-${Date.now()}.jsonl`);
    const raw = fs.readFileSync(CAPTURE_FIXTURE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => {
        const j = JSON.parse(l);
        // 模拟 0.1.14 捕获件：cc-wire-round 信封没有 reasoningTokens 字段
        if (j.x_lake?.schema === 'cc-wire-round' && j.x_lake.data) {
          delete j.x_lake.data.reasoningTokens;
        }
        return JSON.stringify(j);
      })
      .join('\n') + '\n';
    fs.writeFileSync(tmp, raw);
    try {
      const interactions = readClaudeSession(tmp, 'codex-skill-capture');
      const assistant = interactions.find(i => i.role === 'assistant' && i.usage != null);
      expect(assistant).toBeDefined();
      expect(assistant!.usage!.reasoning).toBe(197);
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});
