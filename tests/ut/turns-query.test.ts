// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Turns 搜索查询词法单测（turns-query.ts 单点）：空格多词 AND 分词 / 引号
// 短语（ASCII 与中文弯引号）/ -排除 / 结构化算子解析（role/member/agent/
// tool/error/thinking/dur/tokens/after/before）/ 未知 key:value 回落文本 /
// rowPassesFilters 谓词（含缺数诚实排除与 HH:mm 按轮自身日期取时刻）。

import { describe, it, expect } from 'vitest';
import { parseTurnsQuery, rowPassesFilters } from '@/lib/observe/collectors/turns-query';
import type { TurnSearchRow } from '@/lib/observe/collectors/search';

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

describe('parseTurnsQuery 词法', () => {
  it('空格多词分词：裸词各自成词（AND 语义由匹配层保证），正负词分流', () => {
    const q = parseTurnsQuery('prisma migrate -timeout');
    expect(q.terms.map(t => t.text)).toEqual(['prisma', 'migrate', 'timeout']);
    expect(q.terms.map(t => t.negated)).toEqual([false, false, true]);
    expect(q.positiveTerms).toEqual(['prisma', 'migrate']);
    expect(q.filters).toHaveLength(0);
    expect(q.empty).toBe(false);
  });

  it('引号短语：ASCII 与中文弯引号都作整体原子（引号内空格保留）', () => {
    const a = parseTurnsQuery('"connection refused"');
    const b = parseTurnsQuery('“连接 超时”');
    expect(a.terms).toHaveLength(1);
    expect(a.terms[0].text).toBe('connection refused');
    expect(b.terms).toHaveLength(1);
    expect(b.terms[0].text).toBe('连接 超时');
    // 引号词也可排除
    const c = parseTurnsQuery('-"connection refused"');
    expect(c.terms[0].text).toBe('connection refused');
    expect(c.terms[0].negated).toBe(true);
  });

  it('结构化算子解析：role/member/agent/tool 子串、error 布尔、阈值比较、时间窗', () => {
    const q = parseTurnsQuery('role:assistant member:alice agent:design tool:Bash error:true thinking:>5k dur:>10s tokens:>=10000 after:15:30 before:"11-04 16:00"');
    expect(q.terms).toHaveLength(0);
    expect(q.filters.map(f => f.op)).toEqual(['role', 'member', 'agent', 'tool', 'error', 'thinking', 'dur', 'tokens', 'after', 'before']);
    expect(q.filters[0]).toMatchObject({ op: 'role', value: 'assistant' });
    expect(q.filters[1]).toMatchObject({ op: 'member', value: 'alice' });
    expect(q.filters[2]).toMatchObject({ op: 'agent', value: 'design' });
    expect(q.filters[3]).toMatchObject({ op: 'tool', value: 'Bash' });
    expect(q.filters[4]).toMatchObject({ op: 'error', value: true });
    expect(q.filters[5]).toMatchObject({ op: 'thinking', cmp: '>', value: 5000 });
    expect(q.filters[6]).toMatchObject({ op: 'dur', cmp: '>', value: 10_000 });
    expect(q.filters[7]).toMatchObject({ op: 'tokens', cmp: '>=', value: 10_000 });
    expect(q.filters[8]).toMatchObject({ op: 'after', mode: 'time-of-day', h: 15, m: 30 });
    expect(q.filters[9]).toMatchObject({ op: 'before', mode: 'absolute' });
  });

  it('未知 key:value 回落文本词——带冒号文本（12:30 / URL）不被算子劫持', () => {
    const q = parseTurnsQuery('12:30 http://example.com foo:bar');
    expect(q.filters).toHaveLength(0);
    expect(q.terms.map(t => t.text)).toEqual(['12:30', 'http://example.com', 'foo:bar']);
  });

  it('错误算子值回落文本词：error:maybe / dur:abc / after:99:99 不劫持', () => {
    const q = parseTurnsQuery('error:maybe dur:abc after:99:99');
    expect(q.filters).toHaveLength(0);
    expect(q.terms.map(t => t.text)).toEqual(['error:maybe', 'dur:abc', 'after:99:99']);
  });

  it('负号算子取非：-tool:Bash = 没用过该工具；空查询与纯空白为空', () => {
    const q = parseTurnsQuery('-tool:Bash');
    expect(q.filters).toHaveLength(1);
    expect(q.filters[0]).toMatchObject({ op: 'tool', value: 'Bash', negated: true });
    expect(parseTurnsQuery('   ').empty).toBe(true);
    expect(parseTurnsQuery('').empty).toBe(true);
  });
});

describe('rowPassesFilters 行级谓词', () => {
  it('role/agent/tool 子串过滤 + 负号取非', () => {
    const r = row({
      id: 't1',
      role: 'assistant',
      agentName: 'main',
      subagentName: 'design-pro',
      toolCalls: [
        { toolCallId: 'tc1', toolName: 'Bash', dispatchBridgeId: null, argsJson: null, resultJson: null, errorMessage: null },
      ],
    });
    expect(rowPassesFilters(r, [{ op: 'role', value: 'assistant', lower: 'assistant', negated: false }], null)).toBe(true);
    expect(rowPassesFilters(r, [{ op: 'role', value: 'user', lower: 'user', negated: false }], null)).toBe(false);
    // agent 覆盖 agentName 与 subagentName 两路
    expect(rowPassesFilters(r, [{ op: 'agent', value: 'design', lower: 'design', negated: false }], null)).toBe(true);
    expect(rowPassesFilters(r, [{ op: 'tool', value: 'bash', lower: 'bash', negated: false }], null)).toBe(true);
    expect(rowPassesFilters(r, [{ op: 'tool', value: 'bash', lower: 'bash', negated: true }], null)).toBe(false);
  });

  it('member 过滤走成员归因；无归因时该算子不可满足（诚实排除）', () => {
    const r = row({ id: 't1' });
    expect(rowPassesFilters(r, [{ op: 'member', value: 'alice', lower: 'alice', negated: false }], '成员Alice')).toBe(true);
    expect(rowPassesFilters(r, [{ op: 'member', value: 'bob', lower: 'bob', negated: false }], '成员Alice')).toBe(false);
    expect(rowPassesFilters(r, [{ op: 'member', value: 'alice', lower: 'alice', negated: false }], null)).toBe(false);
  });

  it('error 有无：errorMessage 非空即有错；error:false 反向筛正常轮', () => {
    const err = row({
      id: 't1',
      toolCalls: [{ toolCallId: 'tc1', toolName: 'Bash', dispatchBridgeId: null, argsJson: null, resultJson: null, errorMessage: 'boom' }],
    });
    const ok = row({
      id: 't2',
      toolCalls: [{ toolCallId: 'tc2', toolName: 'Bash', dispatchBridgeId: null, argsJson: null, resultJson: null, errorMessage: null }],
    });
    expect(rowPassesFilters(err, [{ op: 'error', value: true, negated: false }], null)).toBe(true);
    expect(rowPassesFilters(err, [{ op: 'error', value: false, negated: false }], null)).toBe(false);
    expect(rowPassesFilters(ok, [{ op: 'error', value: false, negated: false }], null)).toBe(true);
  });

  it('thinking/dur/tokens 阈值：比较符语义 + 缺数不可满足（诚实排除）', () => {
    const r = row({ id: 't1', reasoningTokens: 5000, turnMs: 12_000, totalTokens: 8000 });
    expect(rowPassesFilters(r, [{ op: 'thinking', cmp: '>', value: 4999, negated: false }], null)).toBe(true);
    expect(rowPassesFilters(r, [{ op: 'thinking', cmp: '>', value: 5000, negated: false }], null)).toBe(false);
    expect(rowPassesFilters(r, [{ op: 'thinking', cmp: '>=', value: 5000, negated: false }], null)).toBe(true);
    expect(rowPassesFilters(r, [{ op: 'dur', cmp: '>', value: 10_000, negated: false }], null)).toBe(true);
    expect(rowPassesFilters(r, [{ op: 'tokens', cmp: '<', value: 10_000, negated: false }], null)).toBe(true);
    // 缺数（行源无该列）：任何阈值不可满足
    const bare = row({ id: 't2' });
    expect(rowPassesFilters(bare, [{ op: 'dur', cmp: '>', value: 1, negated: false }], null)).toBe(false);
    expect(rowPassesFilters(bare, [{ op: 'tokens', cmp: '<', value: 1e9, negated: false }], null)).toBe(false);
  });

  it('after/before 时间窗：HH:mm 按轮自身日期取当日时刻（跨天工作时段语义）', () => {
    const morning = row({ id: 't1', createdAt: new Date('2026-11-01T09:15:00'), createdAt_ts: new Date('2026-11-01T09:15:00') });
    const afternoon = row({ id: 't2', createdAt: new Date('2026-11-04T16:30:00'), createdAt_ts: new Date('2026-11-04T16:30:00') });
    // after:15:00 —— 每天该时刻之后（跨天）
    expect(rowPassesFilters(morning, [{ op: 'after', mode: 'time-of-day', h: 15, m: 0, s: 0, negated: false }], null)).toBe(false);
    expect(rowPassesFilters(afternoon, [{ op: 'after', mode: 'time-of-day', h: 15, m: 0, s: 0, negated: false }], null)).toBe(true);
    // before:17:00 —— 每天该时刻之前
    expect(rowPassesFilters(afternoon, [{ op: 'before', mode: 'time-of-day', h: 17, m: 0, s: 0, negated: false }], null)).toBe(true);
    expect(rowPassesFilters(afternoon, [{ op: 'before', mode: 'time-of-day', h: 16, m: 30, s: 0, negated: false }], null)).toBe(true);
    // 绝对时刻：日期级窗口
    const abs = new Date(2026, 10, 4, 0, 0, 0).getTime();
    expect(rowPassesFilters(afternoon, [{ op: 'after', mode: 'absolute', ts: abs, negated: false }], null)).toBe(true);
    expect(rowPassesFilters(morning, [{ op: 'after', mode: 'absolute', ts: abs, negated: false }], null)).toBe(false);
  });

  it('多算子全 AND：任一不满足即整轮出局', () => {
    const r = row({
      id: 't1',
      role: 'user',
      toolCalls: [{ toolCallId: 'tc1', toolName: 'Read', dispatchBridgeId: null, argsJson: null, resultJson: null, errorMessage: 'boom' }],
    });
    expect(rowPassesFilters(r, [
      { op: 'role', value: 'user', lower: 'user', negated: false },
      { op: 'error', value: true, negated: false },
    ], null)).toBe(true);
    expect(rowPassesFilters(r, [
      { op: 'role', value: 'user', lower: 'user', negated: false },
      { op: 'error', value: false, negated: false },
    ], null)).toBe(false);
  });
});
