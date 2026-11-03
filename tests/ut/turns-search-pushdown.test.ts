// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// run turns 搜索端点的取数两级瘦身回归锁（PR #7 审查意见的持久化）：此前
// 一次重构删掉了①显式轻投影（不带顶层 select，Prisma 物化 Turn 全部标量
// 列，含 contentJson / inputMessagesJson 这类 35MB 级全文字段）与②关键词
// 候选下推（canPushDownKeyword + keywordFilter），关键词过滤全退回内存
// matchTurnSearch 全量扫描。本锁用 mock prisma 断言 findMany 查询形状：
// 轻投影不物化重列、可下推关键词的 where.OR 覆盖六路（含第六路 toolName）、
// 含带大小写非 ASCII 文字的关键词不下推（回退全量扫描保 Unicode 语义）。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const captured = vi.hoisted(() => {
  const findManyCalls: Array<{ where?: Record<string, unknown>; select?: Record<string, unknown> }> = [];
  return {
    findManyCalls,
    findMany: vi.fn(async (args: { where?: Record<string, unknown>; select?: Record<string, unknown> }) => {
      findManyCalls.push(args);
      return [];
    }),
    reset() {
      findManyCalls.length = 0;
    },
  };
});

vi.mock('@/lib/db', () => ({ prisma: { turn: { findMany: captured.findMany } } }));

vi.mock('@/lib/run/observe/scope', () => ({
  resolveRunScope: vi.fn(async () => ({
    kind: 'run',
    runId: 'solo:t-x',
    members: [{ rowId: 'row-1', taskId: 't-x', framework: 'claude-code', label: 't-x', structure: null }],
  })),
}));

import { GET } from '@/app/api/observe/run/[runId]/turns/search/route';

const callSearch = (keyword: string) =>
  GET(
    new NextRequest(`http://localhost/api/observe/run/solo:t-x/turns/search?keyword=${encodeURIComponent(keyword)}`),
    { params: Promise.resolve({ runId: 'solo:t-x' }) },
  );

describe('run turns 搜索 —— SQL 下推 + 轻投影（查询形状回归锁）', () => {
  beforeEach(() => captured.reset());

  it('findMany 带显式轻投影：不物化 contentJson / inputMessagesJson 重列', async () => {
    const res = await callSearch('hello');
    expect(res.status).toBe(200);
    const args = captured.findManyCalls[0];
    expect(args).toBeDefined();
    expect(args.select).toBeDefined();
    // 轻投影：TurnSearchRow 契约之外的重列不得物化
    expect(args.select).not.toHaveProperty('contentJson');
    expect(args.select).not.toHaveProperty('inputMessagesJson');
    // 契约内列与嵌套 toolCalls 投影保留
    expect(args.select).toHaveProperty('content');
    expect(args.select).toHaveProperty('reasoningTokens');
    expect(args.select).toHaveProperty('toolCalls');
  });

  it('可下推关键词：where.OR 覆盖六路（含第六路 toolName）', async () => {
    const res = await callSearch('hello');
    expect(res.status).toBe(200);
    const args = captured.findManyCalls[0];
    const or = (args.where?.OR ?? []) as Array<Record<string, unknown>>;
    expect(or.length).toBeGreaterThan(0);
    expect(or.some(c => 'content' in c)).toBe(true);
    expect(or.some(c => 'contentSummary' in c)).toBe(true);
    const toolCallBranch = or.find(c => 'toolCalls' in c) as Record<string, { some: { OR?: unknown[] } }> | undefined;
    expect(toolCallBranch).toBeDefined();
    const innerOR = (toolCallBranch!.toolCalls.some.OR ?? []) as Array<Record<string, unknown>>;
    expect(innerOR.some(c => 'argsJson' in c)).toBe(true);
    expect(innerOR.some(c => 'resultJson' in c)).toBe(true);
    expect(innerOR.some(c => 'errorMessage' in c)).toBe(true);
    // 第六路 toolName 必须进下推——否则纯工具名命中会被 DB 候选过滤掉
    expect(innerOR.some(c => 'toolName' in c)).toBe(true);
  });

  it('带大小写非 ASCII 关键词不下推：where 无 OR（回退全量扫描保 Unicode 语义）', async () => {
    // 西里尔「Москва」含大小写对——SQLite LIKE 仅 ASCII 不区分大小写，
    // 下推会丢命中，须回退
    const res = await callSearch('Москва');
    expect(res.status).toBe(200);
    const args = captured.findManyCalls[0];
    expect(args.where).toBeDefined();
    expect(args.where!.OR).toBeUndefined();
    // 作用域过滤仍在（sessionId IN）
    expect(args.where!.sessionId).toBeDefined();
  });
});
