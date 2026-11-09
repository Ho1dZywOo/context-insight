// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 离线内核合成器回归锁（API 层面）：createOfflineFetch 即离线查看器的
// 「服务端」——按 run 工作台同一 URL 取数应答。锁死轮详情输入窗口重建的
// compaction 计数口径（与 turn-detail.ts:346 同源，见 offline-kernel.ts）。

import { describe, it, expect } from 'vitest';
import { createOfflineFetch, type OfflineMemberTurns, type MemberTurnItem } from '@/export-view/offline-kernel';

function turn(partial: Partial<MemberTurnItem> & { turnId: string; turnIndex: number; role: string }): MemberTurnItem {
  return {
    content: null,
    contentJson: null,
    contentSummary: null,
    agentName: null,
    isSubagent: false,
    subagentName: null,
    subagentSessionId: null,
    subagentType: null,
    dispatchStep: null,
    parentExecutionId: null,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    inputMessagesCount: 0,
    inputMessagesTokens: 0,
    contextWindowPct: null,
    systemOverheadTokens: 0,
    latencyMs: 0,
    turnMs: 0,
    createdAt: new Date(0).toISOString(),
    completedAt: null,
    model: null,
    ttftMs: null,
    modelId: null,
    providerId: null,
    contextWindowLimit: null,
    finishReason: null,
    toolCalls: [],
    skillEvents: [],
    ...partial,
  };
}

function detailOf(members: OfflineMemberTurns[], turnId: string): Promise<Record<string, unknown>> {
  const fetch = createOfflineFetch(members, {}, 'run:exp', globalThis.fetch);
  return fetch(`/api/observe/turn/${turnId}`).then(r => r.json() as Promise<Record<string, unknown>>);
}

describe('离线内核轮详情：输入窗口重建计数口径', () => {
  it('compaction 轮 inputMessagesCount 优先取重建长度（对齐 turn-detail.ts:346）', async () => {
    const members: OfflineMemberTurns[] = [{
      member: { taskId: 'exp-t1', label: 'L1' },
      sessionId: 'row-1',
      framework: 'claude-code',
      items: [
        turn({ turnId: 'u0', turnIndex: 0, role: 'user', content: 'hello', inputMessagesCount: 1 }),
        // compaction assistant 轮：存量计数设为哨兵 777，重建长度应为 1
        turn({ turnId: 'c1', turnIndex: 1, role: 'assistant', content: 'summarized', agentName: 'compaction', inputMessagesCount: 777, totalTokens: 10 }),
      ],
    }];

    const detail = await detailOf(members, 'c1');

    // 输入窗口已重建（assistant 轮），且计数 = 重建列表长度，而非存量哨兵值
    expect(detail.inputMessagesJson).toBeTruthy();
    const reconstructed = JSON.parse(detail.inputMessagesJson as string) as unknown[];
    expect(reconstructed.length).toBeGreaterThan(0);
    expect(detail.inputMessagesCount).toBe(reconstructed.length);
    expect(detail.inputMessagesCount).not.toBe(777);
  });

  it('普通 assistant 轮仍取重建长度（非 compaction 路径不回退到存量计数）', async () => {
    const members: OfflineMemberTurns[] = [{
      member: { taskId: 'exp-t1', label: 'L1' },
      sessionId: 'row-1',
      framework: 'claude-code',
      items: [
        turn({ turnId: 'u0', turnIndex: 0, role: 'user', content: 'hello', inputMessagesCount: 1 }),
        turn({ turnId: 'a1', turnIndex: 1, role: 'assistant', content: 'answer', inputMessagesCount: 555, totalTokens: 5 }),
      ],
    }];

    const detail = await detailOf(members, 'a1');

    expect(detail.inputMessagesJson).toBeTruthy();
    const reconstructed = JSON.parse(detail.inputMessagesJson as string) as unknown[];
    expect(detail.inputMessagesCount).toBe(reconstructed.length);
    expect(detail.inputMessagesCount).not.toBe(555);
  });
});
