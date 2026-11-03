// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 工作流范围声明（workflowScope）→ D1.goalCoverage 验收口径 IT：
//   ① prompt 层——有声明时注入范围声明与裁定规则正文；无声明不注入
//   ② 判分层——out-of-scope 不进覆盖分母（1✓/1）；无声明会话 LLM 违规输出
//      该状态按 missing 计，分母不被静默剔出
//   ③ 全部目标点范围外 → not-applicable（无范围内目标可评，不拉低均值）

import { describe, it, expect } from 'vitest';
import type { AssembledInput, LlmClient } from '../../src/lib/scoring/core/assembler/types';
import { loadRegistry } from '../../src/lib/scoring/registry';

function input(partial: Partial<AssembledInput>): AssembledInput {
  return {
    trajectoryDigest: '#0 👤 "task"',
    memoryDigest: '',
    userMessages: [{ turnIndex: 0, text: '完成设计文档，并开发完整版本、跑通端到端测试', at: null }],
    toolCalls: [],
    turns: [],
    measures: { totalTokens: 100000, toolTimeMs: 60000, llmTimeMs: 120000, inputTokens: 50000 },
    taskType: 'general',
    workflowDecl: null,
    finishReason: 'unknown',
    interrupts: [],
    wire: null,
    redactionEvents: [],
    executions: [],
    ...partial,
  };
}

const scope = { skillName: 'design-wf', source: 'skill', regulation: '本工作流仅交付设计文档 DESIGN.md，不含编码实现。' };

function llmReturning(goals: Array<{ goal: string; status: string }>, captured: { user: string }[]) {
  const llm: LlmClient = {
    model: 'stub',
    complete: async (_system, user) => {
      captured.push({ user });
      return { content: JSON.stringify({ goals }), promptTokens: 1, completionTokens: 1 };
    },
  };
  return llm;
}

async function runGoalCoverage(inp: AssembledInput, llm: LlmClient) {
  const registry = await loadRegistry();
  const def = registry.defs.flatMap(d => d.items).find(i => i.id === 'D1.goalCoverage')!;
  const scorer = registry.scorerOf.get('D1.goalCoverage')!;
  return scorer.run({ input: inp, def, llm, samples: 1 });
}

describe('D1.goalCoverage 工作流范围声明', () => {
  it('有声明：prompt 注入范围声明与裁定规则，out-of-scope 不进分母（1✓/1）', async () => {
    const captured: { user: string }[] = [];
    const r = await runGoalCoverage(
      input({ workflowScope: scope }),
      llmReturning([
        { goal: '交付设计文档', status: 'covered' },
        { goal: '开发完整版本', status: 'out-of-scope' },
      ], captured),
    );
    expect(captured[0].user).toContain('工作流范围声明');
    expect(captured[0].user).toContain('skill：design-wf');
    expect(captured[0].user).toContain(scope.regulation);
    expect(captured[0].user).toContain('范围裁定规则');
    expect(r.status).toBe('ok');
    expect(r.value).toBe('1✓/1');
    expect(r.formula).toContain('范围外 1');
  });

  it('无声明：prompt 不注入裁定规则，LLM 违规输出 out-of-scope 按 missing 计', async () => {
    const captured: { user: string }[] = [];
    const r = await runGoalCoverage(
      input({ workflowScope: null }),
      llmReturning([
        { goal: '交付设计文档', status: 'covered' },
        { goal: '开发完整版本', status: 'out-of-scope' },
      ], captured),
    );
    expect(captured[0].user).not.toContain('范围裁定规则');
    expect(r.value).toBe('1✓/2');
  });

  it('全部目标点范围外 → not-applicable，不落 partial+0 分', async () => {
    const r = await runGoalCoverage(
      input({ workflowScope: scope }),
      llmReturning([{ goal: '开发完整版本', status: 'out-of-scope' }], []),
    );
    expect(r.status).toBe('not-applicable');
    expect(r.note).toContain('范围外');
  });
});
