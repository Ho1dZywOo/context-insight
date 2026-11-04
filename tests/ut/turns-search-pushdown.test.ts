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
// 轻投影不物化重列、可下推正词逐词 AND 下推（单词退化 = 单块六路 OR，含
// 第六路 toolName）、纯算子查询不下推、含带大小写非 ASCII 文字的关键词不
// 下推（回退全量扫描保 Unicode 语义）。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const captured = vi.hoisted(() => {
  const findManyCalls: Array<{ where?: Record<string, unknown>; select?: Record<string, unknown> }> = [];
  const sessionFindManyCalls: Array<{ where?: Record<string, unknown>; select?: Record<string, unknown> }> = [];
  return {
    findManyCalls,
    sessionFindManyCalls,
    findMany: vi.fn(async (args: { where?: Record<string, unknown>; select?: Record<string, unknown> }) => {
      findManyCalls.push(args);
      return [];
    }),
    // 单轮耗时（dur:）按框架时序语义计算——session 侧 framework/version 取数
    sessionFindMany: vi.fn(async (args: { where?: Record<string, unknown>; select?: Record<string, unknown> }) => {
      sessionFindManyCalls.push(args);
      return [{ id: 'row-1', framework: 'claude-code', version: '1.0.0' }];
    }),
    reset() {
      findManyCalls.length = 0;
      sessionFindManyCalls.length = 0;
    },
  };
});

vi.mock('@/lib/db', () => ({ prisma: { turn: { findMany: captured.findMany }, session: { findMany: captured.sessionFindMany } } }));

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

  it('findMany 带显式轻投影：不物化 contentJson / inputMessagesJson 重列；dur/tokens 算子列进契约', async () => {
    const res = await callSearch('hello');
    expect(res.status).toBe(200);
    const args = captured.findManyCalls[0];
    expect(args).toBeDefined();
    expect(args.select).toBeDefined();
    // 轻投影：TurnSearchRow 契约之外的重列不得物化
    expect(args.select).not.toHaveProperty('contentJson');
    expect(args.select).not.toHaveProperty('inputMessagesJson');
    // 契约内列与嵌套 toolCalls 投影保留；dur:/tokens: 算子所需列随语法进契约
    expect(args.select).toHaveProperty('content');
    expect(args.select).toHaveProperty('reasoningTokens');
    expect(args.select).toHaveProperty('latencyMs');
    expect(args.select).toHaveProperty('totalTokens');
    expect(args.select).toHaveProperty('toolCalls');
    expect(((args.select!.toolCalls as { select: Record<string, unknown> }).select).durationMs).toBe(true);
  });

  it('可下推单词：AND 单块 OR 覆盖六路（含第六路 toolName）——单词法零变化兼容', async () => {
    const res = await callSearch('hello');
    expect(res.status).toBe(200);
    const args = captured.findManyCalls[0];
    const and = (args.where?.AND ?? []) as Array<Record<string, unknown>>;
    expect(and.length).toBe(1);
    const or = (and[0]?.OR ?? []) as Array<Record<string, unknown>>;
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

  it('多词 AND 下推：每个正词一块六路 OR（负词与算子不下推）', async () => {
    const res = await callSearch('hello world -noise tool:Bash');
    expect(res.status).toBe(200);
    const args = captured.findManyCalls[0];
    const and = (args.where?.AND ?? []) as Array<Record<string, unknown>>;
    expect(and.length).toBe(2);
    for (const block of and) {
      const or = (block.OR ?? []) as Array<Record<string, unknown>>;
      expect(or.length).toBeGreaterThan(0);
      expect(or.some(c => 'content' in c)).toBe(true);
      expect(or.some(c => 'toolCalls' in c)).toBe(true);
    }
  });

  it('纯算子查询不下推：where 无 AND（全量轻投影扫描——算子谓词在内存精滤）', async () => {
    const res = await callSearch('error:true dur:>10s');
    expect(res.status).toBe(200);
    const args = captured.findManyCalls[0];
    expect(args.where).toBeDefined();
    expect(args.where!.AND).toBeUndefined();
    expect(args.where!.sessionId).toBeDefined();
  });

  it('带大小写非 ASCII 关键词不下推：where 无 AND（回退全量扫描保 Unicode 语义）', async () => {
    // 西里尔「Москва」含大小写对——SQLite LIKE 仅 ASCII 不区分大小写，
    // 下推会丢命中，须回退（任一正词非 ASCII 安全则整体退回）
    const res = await callSearch('Москва');
    expect(res.status).toBe(200);
    const args = captured.findManyCalls[0];
    expect(args.where).toBeDefined();
    expect(args.where!.AND).toBeUndefined();
    // 作用域过滤仍在（sessionId IN）
    expect(args.where!.sessionId).toBeDefined();
  });
});
