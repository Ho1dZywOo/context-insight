// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// the CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// run 域 turns 搜索 IT（真库 + 路由层，PR #7 审查意见回归锁）：
// ① 显式轻投影——findMany 不得物化 TurnSearchRow 契约之外的重列
// （contentJson / inputMessagesJson 等 35MB 级全文字段）；
// ② 关键词候选下推——可安全下推时 where.OR 五路（content / summary /
// args / result / error）推到 SQL，DB 命中集 ⊇ 内存精确命中集；
// ③ 下推安全门——带大小写的非 ASCII 关键词（西里尔等，SQLite LIKE 按字节
// 比较会丢命中）不下推，退回轻投影全量扫描，匹配语义（Unicode 不区分大
// 小写）不变；total 恒为全量命中数，limit 只截 items 不动 total。
// 存储走真实 test.db（seed 唯一 taskId 会话 + run manifest 指到它们），
// 经 @/lib/db 单例 spy 断言查询形状（路由与测试进程内同一单例）。

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { prisma } from '../setup';
import { prisma as dbSingleton } from '@/lib/db';
import { GET } from '@/app/api/observe/run/[runId]/turns/search/route';
import { saveRun } from '@/lib/run/run-store';
import { parseManifest } from '@/lib/run/reader';

// 唯一后缀：与其它测试文件的 ses_mini_* 真库种子并行共存时 join 不串线，
// 也容忍中断残留（test.db 未重建时直接跑本文件）
const RUN_SUFFIX = `${Date.now().toString(36)}`;
const RUN_ID = `srchit${RUN_SUFFIX}`;
const SID_A = `srch_a_${RUN_SUFFIX}`; // 成员 A：framework opencode
const SID_B = `srch_b_${RUN_SUFFIX}`; // 成员 B：framework claude-code

/** 克隆 mini bundle manifest，把两个带 sessionId 的成员指到本文件唯一会话。 */
function buildManifest(): unknown {
  const mini = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, './data/run/mini-bundle/workflow.json'), 'utf-8'),
  );
  const sids = [SID_A, SID_B];
  let i = 0;
  const rewrite = (members: Array<Record<string, unknown>>): void => {
    for (const m of members) {
      if (typeof m.sessionId === 'string' && m.sessionId.startsWith('ses_mini_') && i < sids.length) {
        m.sessionId = sids[i++];
      }
      if (Array.isArray(m.workflow?.members)) rewrite(m.workflow.members as Array<Record<string, unknown>>);
    }
  };
  rewrite(mini.data.members as Array<Record<string, unknown>>);
  mini.id = RUN_ID;
  mini.name = 'run-turns-search-it';
  return mini;
}

let tmpHome: string;
const manifest = parseManifest(buildManifest());
const createdSessionIds: string[] = [];
const createdTurnIds: string[] = [];
// spy 路由实际使用的 @/lib/db 单例（显式委派原实现——Prisma 委托方法上
// vi.spyOn 默认不穿透返回值，且 mockRestore 会把方法删成 undefined——故
// beforeAll 挂一次、用例间只 mockClear、afterAll 手工回填原函数）
const originalTurnFindMany = dbSingleton.turn.findMany;
const findManySpy = vi
  .spyOn(dbSingleton.turn, 'findMany')
  .mockImplementation(((args: never) => originalTurnFindMany(args)) as never);

async function seedTurn(opts: {
  taskId: string;
  turnIndex: number;
  content?: string | null;
  contentSummary?: string | null;
  toolCalls?: Array<{ argsJson?: string | null; resultJson?: string | null; errorMessage?: string | null }>;
}) {
  const session = await prisma.session.findFirstOrThrow({ where: { taskId: opts.taskId } });
  const turn = await prisma.turn.create({
    data: {
      sessionId: session.id,
      turnIndex: opts.turnIndex,
      role: 'assistant',
      content: opts.content ?? null,
      contentSummary: opts.contentSummary ?? null,
    },
  });
  createdTurnIds.push(turn.id);
  for (const tc of opts.toolCalls ?? []) {
    await prisma.toolCall.create({
      data: {
        turnId: turn.id,
        toolCallId: `call-${turn.id}-${Math.random().toString(36).slice(2, 8)}`,
        toolName: 'Bash',
        argsJson: tc.argsJson ?? null,
        resultJson: tc.resultJson ?? null,
        errorMessage: tc.errorMessage ?? null,
      },
    });
  }
  return turn;
}

function makeRequest(keyword: string, limit?: number): NextRequest {
  const q = new URLSearchParams({ keyword });
  if (limit != null) q.set('limit', String(limit));
  return new NextRequest(`http://localhost/api/observe/run/${RUN_ID}/turns/search?${q.toString()}`);
}

const routeParams = async (): Promise<never> =>
  ({ params: Promise.resolve({ runId: RUN_ID }) }) as never;

async function callGet(keyword: string, limit?: number) {
  return GET(makeRequest(keyword, limit), await routeParams());
}

beforeAll(async () => {
  const a = await prisma.session.create({ data: { taskId: SID_A, framework: 'opencode' } });
  const b = await prisma.session.create({ data: { taskId: SID_B, framework: 'claude-code' } });
  createdSessionIds.push(a.id, b.id);
});

afterAll(async () => {
  // session 级联删 turns/toolCalls；回填 spy 前的原实现
  for (const id of createdSessionIds.splice(0)) {
    await prisma.session.delete({ where: { id } }).catch(() => {});
  }
  (dbSingleton.turn as { findMany: typeof originalTurnFindMany }).findMany = originalTurnFindMany;
});

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-run-srch-'));
  process.env.CONTEXT_INSIGHT_HOME = tmpHome;
  saveRun(manifest, null, path.join(tmpHome, 'runs'));
});

afterEach(async () => {
  for (const id of createdTurnIds.splice(0)) {
    await prisma.turn.delete({ where: { id } }).catch(() => {});
  }
  findManySpy.mockClear();
  delete process.env.CONTEXT_INSIGHT_HOME;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('GET /api/observe/run/[runId]/turns/search', () => {
  it('跨成员五路命中 + member 归因：ASCII 关键词下推（where.OR 五路 + 轻投影 select），total=全量命中数，limit 只截 items', async () => {
    const kw = `design-doc-${RUN_SUFFIX}`;
    await seedTurn({
      taskId: SID_A, turnIndex: 0,
      content: `先读 ${kw.toUpperCase()} 再动手`, // 大写原文 + 小写关键词 → 锁 ASCII 大小写不敏感语义在下推后不变
    });
    await seedTurn({
      taskId: SID_B, turnIndex: 1,
      content: '无关正文',
      toolCalls: [{ argsJson: JSON.stringify({ path: `notes/${kw}.md` }) }],
    });
    await seedTurn({ taskId: SID_B, turnIndex: 2, content: '完全不相关' }); // 不命中

    const res = await callGet(kw, 1);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.total).toBe(2); // 全量命中数不受 limit 影响
    expect(data.items).toHaveLength(1); // limit=1 截断
    // turnIndex 升序：首条 = 成员 A 的 content 命中
    expect(data.items[0]).toMatchObject({ matchField: 'content', member: { taskId: SID_A } });

    // 查询形状锁：候选下推（五路 OR）+ 轻投影（无 contentJson/inputMessagesJson）
    const findManyArg = findManySpy.mock.calls[0][0] as {
      where: Record<string, unknown> & { OR?: unknown[] };
      select: Record<string, boolean>;
    };
    expect(findManyArg.where.OR).toHaveLength(3); // content / contentSummary / toolCalls.some
    expect(findManyArg.where.OR).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: { contains: kw } }),
        expect.objectContaining({ contentSummary: { contains: kw } }),
      ]),
    );
    expect(findManySpy.mock.calls[0][0]).toMatchObject({
      where: { sessionId: { in: expect.any(Array) }, OR: expect.any(Array) },
    });
    const selectKeys = Object.keys(findManyArg.select).sort();
    expect(selectKeys).toEqual([
      'agentName', 'content', 'contentSummary', 'createdAt', 'createdAt_ts', 'id',
      'isSubagent', 'reasoningTokens', 'role', 'sessionId', 'subagentName',
      'subagentSessionId', 'toolCalls', 'turnIndex',
    ]);
    expect(findManyArg.select).not.toHaveProperty('contentJson');
    expect(findManyArg.select).not.toHaveProperty('inputMessagesJson');
  });

  it('同 turn 正文命中优先：不再出工具条目（去重语义在下推后不变）', async () => {
    const kw = `dedup-kw-${RUN_SUFFIX}`;
    await seedTurn({
      taskId: SID_A, turnIndex: 3,
      content: `正文含 ${kw}`,
      toolCalls: [{ argsJson: JSON.stringify({ q: kw }), resultJson: 'ok' }],
    });
    const res = await callGet(kw);
    const data = await res.json();
    expect(data.total).toBe(1);
    expect(data.items[0].matchField).toBe('content');
  });

  it('下推安全门：带大小写的非 ASCII 关键词（西里尔）不下推（where 无 OR），全量轻投影扫描且 Unicode 大小写不敏感语义不丢命中', async () => {
    await seedTurn({ taskId: SID_B, turnIndex: 4, content: 'МОСКВА рынок обзор' });
    const res = await callGet('москва'); // 小写西里尔 → 内存匹配、LIKE 按字节不匹配
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.total).toBe(1);
    expect(data.items[0]).toMatchObject({ matchField: 'content', member: { taskId: SID_B } });
    // 形状锁：无 OR 下推，但仍走轻投影 select（不是全列物化）
    const findManyArg = findManySpy.mock.calls[0][0] as {
      where: Record<string, unknown>;
      select: Record<string, boolean>;
    };
    expect(findManyArg.where).not.toHaveProperty('OR');
    expect(findManyArg.where).toMatchObject({ sessionId: { in: expect.any(Array) } });
    expect(findManyArg.select).not.toHaveProperty('contentJson');
    expect(findManyArg.select).not.toHaveProperty('inputMessagesJson');
  });

  it('无命中关键词：空 items + total=0（下推路径下计数仍如实）', async () => {
    await seedTurn({ taskId: SID_A, turnIndex: 5, content: '无关内容' });
    const res = await callGet(`no-hit-${RUN_SUFFIX}`);
    const data = await res.json();
    expect(data).toEqual({ items: [], total: 0 });
  });
});
