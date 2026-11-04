// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 轮次搜索全能语法匹配语义单测（matchTurnSearch × turns-query 词法单点）：
// 多词 AND（跨载体分布命中）/ 排除词 / 算子组合筛轮（tool:error:dur:role:
// member:）/ 纯算子一等命中（无文本词以摘要为上下文）/ 纯排除词 / 单词法
// 零变化兼容（单词 = 原单关键词语义回归锁）。

import { describe, it, expect } from 'vitest';
import { matchTurnSearch, type TurnSearchRow } from '@/lib/observe/collectors/search';

function row(partial: Partial<TurnSearchRow> & Pick<TurnSearchRow, 'id'>): TurnSearchRow {
  return {
    sessionId: 'ses_x',
    turnIndex: 0,
    role: 'assistant',
    content: null,
    contentSummary: null,
    agentName: null,
    isSubagent: false,
    subagentName: null,
    subagentSessionId: null,
    createdAt_ts: new Date('2026-11-03T08:00:00Z'),
    createdAt: new Date('2026-11-03T08:00:00Z'),
    toolCalls: [],
    ...partial,
  } as TurnSearchRow;
}

const tc = (toolCallId: string, toolName: string, extra: Partial<TurnSearchRow['toolCalls'][number]> = {}) => ({
  toolCallId,
  toolName,
  dispatchBridgeId: null,
  argsJson: null,
  resultJson: null,
  errorMessage: null,
  ...extra,
});

describe('matchTurnSearch 全能语法', () => {
  it('单词法零变化兼容：单词 = 原单关键词语义（正文命中单条目、无命中空集）', () => {
    const rows = [
      row({ id: 't1', content: 'prisma migrate failed', contentSummary: '迁移失败' }),
      row({ id: 't2', content: 'unrelated' }),
    ];
    const items = matchTurnSearch(rows, 'prisma');
    expect(items).toHaveLength(1);
    expect(items[0].turnId).toBe('t1');
    expect(items[0].matchField).toBe('content');
    expect(matchTurnSearch(rows, 'nomatch')).toHaveLength(0);
  });

  it('多词 AND：两词分布在不同载体（正文 + 工具 args）仍命中；任一词缺失则整轮出局', () => {
    const rows = [
      row({
        id: 't1',
        content: 'prisma schema 有问题',
        toolCalls: [tc('tc1', 'Bash', { argsJson: '{"cmd":"npx prisma migrate dev"}' })],
      }),
      row({
        id: 't2',
        content: 'prisma schema 有问题',
        toolCalls: [tc('tc2', 'Bash', { argsJson: '{"cmd":"ls -la"}' })],
      }),
      row({ id: 't3', content: '别的正文', toolCalls: [tc('tc3', 'Bash', { argsJson: '{"cmd":"npx prisma migrate dev"}' })] }),
    ];
    const items = matchTurnSearch(rows, 'schema migrate');
    expect(items).toHaveLength(1);
    expect(items[0].turnId).toBe('t1');
    // 任一正词命中正文 → 轮级单条目（沿用「先命中正文不出工具条目」去重）
    expect(items[0].matchField).toBe('content');
    // t2 缺 migrate、t3 缺 schema——AND 语义下都出局
  });

  it('多词工具载体：两词命中不同工具调用 → 各出一条目；同调用两词 → 单条目；单调用缺词 → 整轮出局', () => {
    const rows = [
      row({
        id: 't1',
        toolCalls: [
          tc('tc1', 'Bash', { argsJson: '{"cmd":"npm test"}' }),
          tc('tc2', 'Read', { resultJson: '{"content":"coverage 90%"}' }),
        ],
      }),
      // 单调用只含 npm 缺 coverage——AND 语义下整轮出局
      row({
        id: 't2',
        toolCalls: [tc('tc3', 'Grep', { argsJson: '{"q":"npm install"}' })],
      }),
      // 同一调用两词都命中 → 该调用单条目（不按词数翻倍）
      row({
        id: 't3',
        toolCalls: [tc('tc4', 'Grep', { argsJson: '{"q":"npm coverage report"}' })],
      }),
    ];
    const items = matchTurnSearch(rows, 'npm coverage');
    expect(items).toHaveLength(3);
    expect(items.filter(i => i.turnId === 't1')).toHaveLength(2);
    expect(items.filter(i => i.turnId === 't2')).toHaveLength(0);
    expect(items.filter(i => i.turnId === 't3')).toHaveLength(1);
    expect(items[2].toolName).toBe('Grep');
    const single = matchTurnSearch(rows, 'npm test');
    expect(single).toHaveLength(1);
    expect(single[0].toolName).toBe('Bash');
  });

  it('排除词：六路任一命中即整轮排除（排除优先于正词命中）', () => {
    const rows = [
      row({ id: 't1', content: 'error: connection refused', toolCalls: [] }),
      row({ id: 't2', content: 'error: timeout', toolCalls: [] }),
      row({
        id: 't3',
        content: 'error: disk full',
        toolCalls: [tc('tc1', 'Bash', { errorMessage: 'connection reset' })],
      }),
    ];
    // 搜 error 排除 connection：t1（正文命中）、t3（错误载体命中）都出局
    const items = matchTurnSearch(rows, 'error -connection');
    expect(items.map(i => i.turnId)).toEqual(['t2']);
  });

  it('纯排除词：命中一切再排除（无正词时全量轮为候选）', () => {
    const rows = [
      row({ id: 't1', content: 'normal work' }),
      row({ id: 't2', content: 'noise noise' }),
    ];
    const items = matchTurnSearch(rows, '-noise');
    expect(items.map(i => i.turnId)).toEqual(['t1']);
  });

  it('tool: 算子筛轮 + 文本词组合：用过该工具且正文含词', () => {
    const rows = [
      row({ id: 't1', content: 'run the tests', toolCalls: [tc('tc1', 'Bash')] }),
      row({ id: 't2', content: 'run the tests', toolCalls: [tc('tc2', 'Read')] }),
      row({ id: 't3', content: 'nothing here', toolCalls: [tc('tc3', 'Bash')] }),
    ];
    const items = matchTurnSearch(rows, 'tests tool:Bash');
    expect(items.map(i => i.turnId)).toEqual(['t1']);
    // tool: 不要求工具名含关键词——名字筛轮（与文本路工具名命中互补）
    expect(items[0].matchField).toBe('content');
  });

  it('error:true 纯算子一等命中：不知道错误文本也能列出出错轮，摘要为上下文', () => {
    const rows = [
      row({ id: 't1', contentSummary: '正常完成迁移', toolCalls: [tc('tc1', 'Bash', { errorMessage: 'boom' })] }),
      row({ id: 't2', contentSummary: '读取文件', toolCalls: [tc('tc2', 'Read')] }),
      row({ id: 't3', contentSummary: '再次出错', toolCalls: [tc('tc3', 'Grep', { errorMessage: 'pattern invalid' })] }),
    ];
    const items = matchTurnSearch(rows, 'error:true');
    expect(items.map(i => i.turnId)).toEqual(['t1', 't3']);
    expect(items.every(i => i.matchField === 'content')).toBe(true);
    expect(items[0].matchContext).toContain('迁移');
  });

  it('dur:/tokens:/thinking: 阈值筛轮；缺数轮不可满足（诚实排除）', () => {
    const rows = [
      row({ id: 'slow', turnMs: 45_000, contentSummary: '慢轮' }),
      row({ id: 'fast', turnMs: 1_200, contentSummary: '快轮' }),
      row({ id: 'unknown', contentSummary: '无耗时数据' }),
    ];
    expect(matchTurnSearch(rows, 'dur:>10s').map(i => i.turnId)).toEqual(['slow']);
    expect(matchTurnSearch(rows, 'dur:<2s').map(i => i.turnId)).toEqual(['fast']);
    expect(matchTurnSearch(rows, 'dur:>1ms').map(i => i.turnId)).toEqual(['slow', 'fast']);
    // thinking 与文本组合
    expect(matchTurnSearch([row({ id: 't1', reasoningTokens: 8000, content: 'deep reasoning here' })], 'deep thinking:>5k')).toHaveLength(1);
    expect(matchTurnSearch([row({ id: 't1', reasoningTokens: 8000, content: 'deep reasoning here' })], 'deep thinking:>9k')).toHaveLength(0);
  });

  it('role:/agent:/member: 归因筛轮；member 走 memberOf 归因', () => {
    const rows = [
      row({ id: 'u1', role: 'user', content: '帮我修这个 bug' }),
      row({ id: 'a1', role: 'assistant', content: '好的，先看这个 bug' }),
      row({ id: 'a2', role: 'assistant', isSubagent: true, subagentName: 'design-pro', sessionId: 'ses_sub', content: 'bug 在这里' }),
    ];
    expect(matchTurnSearch(rows, 'bug role:user').map(i => i.turnId)).toEqual(['u1']);
    expect(matchTurnSearch(rows, 'bug agent:design').map(i => i.turnId)).toEqual(['a2']);
    // run 作用域 member 归因（sessionId → 成员标签）
    const memberOf = (sessionId: string) => (sessionId === 'ses_sub' ? { taskId: 't-sub', label: '设计子代理' } : null);
    expect(matchTurnSearch(rows, 'bug member:设计', { memberOf }).map(i => i.turnId)).toEqual(['a2']);
    expect(matchTurnSearch(rows, 'bug member:不存在', { memberOf })).toHaveLength(0);
  });

  it('after:/before: 时间窗筛轮（HH:mm 按轮自身日期取当日时刻）', () => {
    const rows = [
      row({ id: 'am', createdAt: new Date('2026-11-01T09:30:00'), createdAt_ts: new Date('2026-11-01T09:30:00'), contentSummary: '上午' }),
      row({ id: 'pm', createdAt: new Date('2026-11-04T16:00:00'), createdAt_ts: new Date('2026-11-04T16:00:00'), contentSummary: '下午' }),
    ];
    expect(matchTurnSearch(rows, 'after:15:00').map(i => i.turnId)).toEqual(['pm']);
    expect(matchTurnSearch(rows, 'before:10:00').map(i => i.turnId)).toEqual(['am']);
    // 组合 = 时间窗
    expect(matchTurnSearch(rows, 'after:9:00 before:10:00').map(i => i.turnId)).toEqual(['am']);
  });

  it('短语与排除组合：引号整体原子 + 算子叠加', () => {
    const rows = [
      row({ id: 't1', content: 'connection refused when dialing', toolCalls: [tc('tc1', 'Bash')] }),
      row({ id: 't2', content: 'connection was fine', toolCalls: [tc('tc2', 'Bash')] }),
      row({ id: 't3', content: 'connection refused again', toolCalls: [tc('tc3', 'Read')] }),
    ];
    const items = matchTurnSearch(rows, '"connection refused" tool:Bash');
    expect(items.map(i => i.turnId)).toEqual(['t1']);
  });

  it('未知 key:value 回落文本：搜带冒号文本仍按子串命中', () => {
    const rows = [row({ id: 't1', content: '时间戳是 12:30 开始' })];
    expect(matchTurnSearch(rows, '12:30')).toHaveLength(1);
  });
});
