// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 计划候选 shell 隐式读的大小写回归（真实 DB）：Claude Code 的 shell 工具名
// 是 PascalCase `Bash`，而 toolName 按框架原样落库。计划通道用
// where.toolName.in 精确匹配——若只用小写 SHELL_TOOL_NAMES，`Bash` 会话的所有
// shell 隐式读（如 cat tracker.md）进不了候选池。本用例从 DB 层（真实 SQLite
// 的 in 过滤）锁定：Bash 读的 .md 文件必须进入计划候选。mock 级用例把
// toolCall.findMany 的 where 短路成「w.turn 即返回全部行」，不经过 in 过滤，
// 抓不住此缺陷——故须真实 DB 落库再走 collect。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@/lib/db';
import { collectWorkflowExtractCandidates } from '@/lib/llm-workflow-extract';

const SID = 'wf-shell-case-1';
const TRACKER_BODY =
  '# Day0 流程跟踪单\n\n## Stage 1\n\n- [ ] 派发 developer\n- [ ] 验收 st-verifier\n- [ ] 收尾归档\n' + 't'.repeat(120);

let sessionId = '';

beforeAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: SID } });
  const s = await prisma.session.create({ data: { taskId: SID, framework: 'claude-code' } });
  sessionId = s.id;
  const turn = await prisma.turn.create({
    data: { sessionId: s.id, turnIndex: 0, role: 'assistant', isSubagent: false },
  });
  await prisma.toolCall.create({
    data: {
      turnId: turn.id,
      toolCallId: 'bash-cat-tracker',
      toolName: 'Bash',
      argsJson: JSON.stringify({ command: 'cat /repo/tracker.md' }),
      resultJson: TRACKER_BODY,
      state: 'ok',
    },
  });
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: SID } });
});

describe('计划候选项 shell 隐式读（Claude Code PascalCase Bash）', () => {
  it('Bash 读 tracker.md（大小写精确 in）→ 计划候选', async () => {
    const c = await collectWorkflowExtractCandidates(sessionId, prisma);
    const plan = c.plan.find((p) => p.source === 'tracker.md');
    expect(plan).toBeDefined();
    expect(plan!.content).toBe(TRACKER_BODY);
    expect(plan!.readCount).toBe(1);
    expect(plan!.writeCount).toBe(0);
  });
});