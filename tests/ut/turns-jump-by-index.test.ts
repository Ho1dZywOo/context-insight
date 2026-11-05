// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// #N 轮次直达的 run 级解析端点回归锁：真相源必须是服务端（客户端只见已
// 加载分页——#25 误报「未找到」的根因）；跨成员找出所有拥有该轮次号的会
// 话，items 按 run 成员序排列（确定性首位候选）并附成员归因；非法 index
// 400、run 不存在 404。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const captured = vi.hoisted(() => {
  const findManyCalls: Array<{ where?: Record<string, unknown>; select?: Record<string, unknown> }> = [];
  return {
    findManyCalls,
    scopeExists: { current: true },
    scopeEmpty: { current: false },
    findMany: vi.fn(async (args: { where?: Record<string, unknown>; select?: Record<string, unknown> }) => {
      findManyCalls.push(args);
      // 两成员都有第 25 轮（rowId 乱序返回——成员序由端点排，不靠 DB 序）
      return [
        { id: 't-b25', sessionId: 'row_b', turnIndex: 25, contentSummary: '成员B第25轮摘要' },
        { id: 't-a25', sessionId: 'row_a', turnIndex: 25, contentSummary: '成员A第25轮摘要' },
      ];
    }),
    reset() {
      findManyCalls.length = 0;
      captured.scopeExists.current = true;
      captured.scopeEmpty.current = false;
    },
  };
});

vi.mock('@/lib/db', () => ({ prisma: { turn: { findMany: captured.findMany } } }));

vi.mock('@/lib/run/observe/scope', () => ({
  resolveRunScope: vi.fn(async () =>
    !captured.scopeExists.current
      ? null
      : {
          kind: 'run',
          runId: 'minidemo01',
          members: captured.scopeEmpty.current
            ? []
            : [
                { rowId: 'row_a', taskId: 'ses_a', framework: 'opencode', label: '成员A', structure: null },
                { rowId: 'row_b', taskId: 'ses_b', framework: 'opencode', label: '成员B', structure: null },
              ],
        }),
}));

import { GET } from '@/app/api/observe/run/[runId]/turns/by-index/route';

const callIndex = (index: string | null) =>
  GET(
    new NextRequest(`http://localhost/api/observe/run/minidemo01/turns/by-index${index != null ? `?index=${index}` : ''}`),
    { params: Promise.resolve({ runId: 'minidemo01' }) },
  );

describe('run turns by-index —— #N 轮次直达的 run 级解析', () => {
  beforeEach(() => captured.reset());

  it('跨成员解析：DB 命中按 run 成员序排列 + 成员归因（确定性首位候选）', async () => {
    const res = await callIndex('25');
    expect(res.status).toBe(200);
    const d = await res.json();
    // 成员序 = scope.members 顺序（row_a 在前），不透传 DB 返回序
    expect(d.items).toEqual([
      { turnId: 't-a25', memberTaskId: 'ses_a', memberLabel: '成员A', contentSummary: '成员A第25轮摘要' },
      { turnId: 't-b25', memberTaskId: 'ses_b', memberLabel: '成员B', contentSummary: '成员B第25轮摘要' },
    ]);
    // 轻投影：跳转与下钻行预览所需四列
    const args = captured.findManyCalls[0];
    expect(args.where).toMatchObject({ turnIndex: 25 });
    expect(args.select).toEqual({ id: true, sessionId: true, turnIndex: true, contentSummary: true });
  });

  it('同会话同号多行取首现（轮次号本应会话内唯一——异常数据不翻倍出候选）', async () => {
    captured.findMany.mockImplementationOnce(async () => [
      { id: 't-dup-1', sessionId: 'row_a', turnIndex: 3, contentSummary: '重复行1' },
      { id: 't-dup-2', sessionId: 'row_a', turnIndex: 3, contentSummary: '重复行2' },
      { id: 't-b3', sessionId: 'row_b', turnIndex: 3, contentSummary: '成员B第3轮' },
    ]);
    const res = await callIndex('3');
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.items).toHaveLength(2);
    expect(d.items[0].turnId).toBe('t-dup-1');
  });

  it('非法 index 400：缺失 / 负数 / 非整数不触查询', async () => {
    for (const bad of [null, '-1', '2.5', 'abc']) {
      const res = await callIndex(bad);
      expect(res.status).toBe(400);
    }
    expect(captured.findManyCalls).toHaveLength(0);
  });

  it('run 不存在 404', async () => {
    captured.scopeExists.current = false;
    const res = await callIndex('25');
    expect(res.status).toBe(404);
  });

  it('无成员 run 空集（零查询）', async () => {
    captured.scopeEmpty.current = true;
    const res = await callIndex('25');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
    expect(captured.findManyCalls).toHaveLength(0);
  });
});
