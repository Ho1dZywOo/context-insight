// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 无桥子代理兜底 lane IT：上游 meta 登记为空 / 异步派发回执无子会话 id 时
// 建桥三路全断，子代理 turns 此前在轮次列表整组不可见（能搜到、看不到）。
// 兜底：无桥子代理按启动时刻就近挂到主链最近轮下，slate「未关联」徽标区分
// 桥驱动精确 lane；自引用桥（派发端落在子代理自身 turn）被剔除后同样由
// 兜底接管，且不再递归渲染。
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionBlock, type TurnsBlockTurn, type TurnsBridge, type TurnsNodeSession } from '@/components/run/RunTurnsNodes';

function makeTurn(turnIndex: number, role: string, over: Partial<TurnsBlockTurn> = {}): TurnsBlockTurn {
  return {
    turnId: `t-${turnIndex}`,
    turnIndex,
    role,
    contentSummary: `turn ${turnIndex}`,
    agentName: null,
    isSubagent: false,
    subagentName: null,
    subagentSessionId: null,
    subagentType: null,
    totalTokens: 10,
    inputTokens: 0,
    inputMessagesCount: 0,
    createdAt: null,
    contextWindowPct: null,
    latencyMs: 0,
    toolCalls: [],
    finishReason: null,
    ...over,
  };
}

const session: TurnsNodeSession = {
  taskId: 'task-1',
  label: null,
  role: 'execute',
  attemptOrdinal: 1,
  ref: {
    taskId: 'task-1',
    framework: '',
    rowId: '',
    turns: 0,
    totalTokens: 0,
    durationMs: null,
    label: 'task-1',
    startTime: null,
    endTime: null,
    cacheReadTokens: null,
  },
};

function render(turns: TurnsBlockTurn[], bridges: TurnsBridge[] = [], selectedTurnId: string | null = null) {
  return renderToStaticMarkup(
    createElement(SessionBlock, {
      session,
      state: { turns, total: turns.length, loading: false },
      bridges,
      selectedTurnId,
      onSelectTurn: () => {},
      onLoadMore: () => {},
    }),
  );
}

describe('无桥子代理兜底 lane', () => {
  it('无任何桥时：孤儿子代理挂到主链最近轮下，带「未关联」徽标与轮数', () => {
    const html = render([
      makeTurn(0, 'user', { contentSummary: '开始任务' }),
      makeTurn(1, 'assistant'),
      makeTurn(2, 'user', { isSubagent: true, subagentSessionId: 'sub-orphan-1', subagentName: 'probe', contentSummary: '探查开始' }),
      makeTurn(3, 'assistant', { isSubagent: true, subagentSessionId: 'sub-orphan-1' }),
    ]);
    expect(html).toContain('未关联');
    expect(html).toContain('2t');
  });

  it('时间锚定：孤儿挂到「启动时刻主链所在轮」，而非主链末轮', () => {
    const html = render([
      makeTurn(0, 'user', { contentSummary: 'turn-0', createdAt: '2026-10-22T12:00:00Z' }),
      makeTurn(1, 'assistant', { contentSummary: 'turn-1', createdAt: '2026-10-22T13:00:00Z' }),
      makeTurn(2, 'assistant', { contentSummary: 'turn-2', createdAt: '2026-10-22T15:38:00Z' }),
      makeTurn(3, 'user', { isSubagent: true, subagentSessionId: 'sub-orphan-1', contentSummary: '孤儿启动', createdAt: '2026-10-22T13:18:00Z' }),
    ]);
    const laneIdx = html.indexOf('未关联');
    const i1 = html.indexOf('turn-1');
    const i2 = html.indexOf('turn-2');
    expect(laneIdx).toBeGreaterThan(i1);
    expect(laneIdx).toBeLessThan(i2);
  });

  it('桥驱动子代理不落兜底：有桥挂载的 sid 不产生「未关联」lane', () => {
    const html = render(
      [
        makeTurn(0, 'user'),
        makeTurn(1, 'assistant'),
        makeTurn(2, 'user', { isSubagent: true, subagentSessionId: 'sub-br-1', contentSummary: '桥内子代理' }),
      ],
      [{
        bridgeId: 'br-1',
        dispatchTurnId: 't-1',
        dispatchContent: null,
        subagentSessionId: 'sub-br-1',
        subagentType: null,
        subagentName: 'agent',
        agentName: null,
        status: 'completed',
        subagentTokens: 0,
        subagentLatencyMs: 0,
      }],
    );
    expect(html).not.toContain('未关联');
    // 桥驱动精确 lane 头渲染（名字 + 1 轮计数），未落兜底
    expect(html).toContain('>agent</span>');
    expect(html).toContain('1t');
  });

  it('自引用桥被剔除：其子会话走兜底 lane，不嵌进自身展开区', () => {
    const html = render(
      [
        makeTurn(0, 'user', { contentSummary: 'turn-0' }),
        makeTurn(1, 'assistant'),
        makeTurn(2, 'user', { isSubagent: true, subagentSessionId: 'sub-self', contentSummary: '自引子代理' }),
      ],
      [{
        bridgeId: 'br-self',
        dispatchTurnId: 't-2',
        dispatchContent: null,
        subagentSessionId: 'sub-self',
        subagentType: null,
        subagentName: 'agent',
        agentName: null,
        status: 'completed',
        subagentTokens: 0,
        subagentLatencyMs: 0,
      }],
    );
    expect(html).toContain('未关联');
    // 自引用桥不再作为精确 lane 渲染（兜底接管，无桥名 lane 头）
    expect(html).not.toContain('>agent</span>');
  });
});

describe('复用会话 lane 窗口配对（首发 + 返工同 sid）', () => {
  // 同 sid 两次派发：首发 10:00 / 返工 20:00；子会话 4 条 turn 分落两窗。
  // 不配对则两根 lane 都带全会话 4 轮（两窗互相包含）；配对后各 2 轮。
  const SUB = 'ses-reuse-lane';
  const W1 = '2026-10-13T10:00:00.000Z';
  const W2 = '2026-10-13T20:00:00.000Z';
  const subTurn = (turnIndex: number, at: string): TurnsBlockTurn => makeTurn(turnIndex, 'assistant', {
    isSubagent: true, subagentSessionId: SUB, subagentName: 'design',
    createdAt: at,
  });
  const turns = [
    makeTurn(0, 'user', { contentSummary: '编排' }),
    makeTurn(1, 'assistant', { createdAt: W1 }),
    makeTurn(2, 'user', { contentSummary: '返工' }),
    makeTurn(3, 'assistant', { createdAt: W2 }),
    subTurn(10, '2026-10-13T10:30:00.000Z'),
    subTurn(11, '2026-10-13T11:00:00.000Z'),
    subTurn(12, '2026-10-13T20:30:00.000Z'),
    subTurn(13, '2026-10-13T21:00:00.000Z'),
  ];
  const bridges: TurnsBridge[] = [
    {
      bridgeId: 'br-first', dispatchTurnId: 't-1', dispatchContent: 'P1 需求分析',
      dispatchTimestamp: W1, subagentSessionId: SUB, subagentType: 'design',
      subagentName: 'design', agentName: 'design', status: 'completed',
      subagentTokens: 0, subagentLatencyMs: 0,
    },
    {
      bridgeId: 'br-rework', dispatchTurnId: 't-3', dispatchContent: 'P1 返工 r1',
      dispatchTimestamp: W2, subagentSessionId: SUB, subagentType: 'design',
      subagentName: 'design', agentName: 'design', status: 'completed',
      subagentTokens: 0, subagentLatencyMs: 0,
    },
  ];

  it('每根 lane 只展示自己窗口内的轮次（各 2t，不再互相包含成 4t）', () => {
    const html = render(turns, bridges);
    // 两根 lane 各 2 轮；「4t」只在未配对（互相包含）时出现
    expect(html.match(/2t/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).not.toContain('4t');
  });

  it('桥缺 dispatchTimestamp（旧数据/兼容面）：lane 保持全会话轮次兜底', () => {
    const html = render(turns, bridges.map(b => ({ ...b, dispatchTimestamp: undefined })));
    expect(html).toContain('4t');
  });
});
