// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// run-first 刀H IT（design: docs/design/run-first-architecture/design.md §3，
// solo 合成层）：真实 prisma 种无主 session → 锁：①solo:<taskId> 详情端点
// （kind=solo + 退化图 viewModel 单节点 + 成员会话 join）；②观测端点对 solo
// 作用域可用（turns 合并投影 + member 归因 = 短 taskId 回落）；③同 sid 双行
// framework 精确消歧；④member 端点 solo 分支；⑤DELETE 护栏 + 404 语义。

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { GET as runDetailGET, DELETE as runDetailDELETE } from '@/app/api/observe/run/[runId]/route';
import { GET as runMemberGET } from '@/app/api/observe/run/[runId]/member/route';
import { GET as runTurnsGET } from '@/app/api/observe/run/[runId]/turns/route';
import { isSoloRunId, soloRunIdOf, soloTaskIdOf } from '@/lib/run/identity';

const SID = 'rfsolo-ses-a';
const SID_LONG = 'rfsolo-session-with-a-very-long-id';
const SID_DUAL = 'rfsolo-dual-sid';
const SIDS = [SID, SID_LONG, SID_DUAL];
const MODEL = 'volc-gateway/glm-4.7';

beforeAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: { in: SIDS } } });
  await prisma.session.createMany({
    data: [
      {
        taskId: SID, framework: 'opencode', label: 'rfsolo 会话A', model: MODEL,
        totalTokens: 300, startTime: new Date('2026-10-13T02:00:00Z'), endTime: new Date('2026-10-13T02:10:00Z'),
      },
      {
        taskId: SID_LONG, framework: 'opencode', label: 'rfsolo 长会话', model: MODEL,
        totalTokens: 100, startTime: new Date('2026-10-13T03:00:00Z'), endTime: new Date('2026-10-13T03:05:00Z'),
      },
      {
        taskId: SID_DUAL, framework: 'opencode', label: 'rfsolo 双行原生', model: MODEL,
        totalTokens: 100, startTime: new Date('2026-10-13T04:00:00Z'), endTime: new Date('2026-10-13T04:05:00Z'),
      },
      {
        taskId: SID_DUAL, framework: 'opencode-proxy', label: 'rfsolo 双行代理', model: MODEL,
        totalTokens: 200, startTime: new Date('2026-10-13T04:00:00Z'), endTime: new Date('2026-10-13T04:06:00Z'),
      },
    ],
  });
  const rows = await prisma.session.findMany({ where: { taskId: { in: SIDS } }, select: { id: true, taskId: true, framework: true } });
  const idOf = (sid: string, framework?: string) =>
    rows.find(r => r.taskId === sid && (framework == null || r.framework === framework))!.id;
  // SID 两条轮次（含上下文水位）；长 sid 一条；双行 sid 按 framework 精确消歧各一条
  const mkTurn = (sessionId: string, turnIndex: number, at: string) => ({
    sessionId, turnIndex, role: 'assistant', content: `rfsolo-turn-${turnIndex}`,
    createdAt_ts: new Date(at), contextWindowPct: 40, model: MODEL, totalTokens: 100, latencyMs: 800,
  });
  await prisma.turn.createMany({
    data: [
      mkTurn(idOf(SID), 0, '2026-10-13T02:00:10Z'),
      mkTurn(idOf(SID), 1, '2026-10-13T02:00:40Z'),
      mkTurn(idOf(SID_LONG), 0, '2026-10-13T03:00:10Z'),
      mkTurn(idOf(SID_DUAL, 'opencode'), 0, '2026-10-13T04:00:10Z'),
      mkTurn(idOf(SID_DUAL, 'opencode-proxy'), 0, '2026-10-13T04:00:20Z'),
    ],
  });
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: { in: SIDS } } });
});

const detail = (runId: string, query = '') =>
  runDetailGET(new NextRequest(`http://localhost/api/observe/run/${runId}${query}`), {
    params: Promise.resolve({ runId }),
  }) as Promise<Response>;

describe('run-first 刀H：solo 合成 run（无主 session → solo:<taskId>）', () => {
  it('identity 命名空间单点：前缀判定 / 提取 / 合成互逆', () => {
    expect(isSoloRunId('solo:abc')).toBe(true);
    expect(isSoloRunId('solo:')).toBe(false);
    expect(isSoloRunId('abc')).toBe(false);
    expect(soloTaskIdOf('solo:abc')).toBe('abc');
    expect(soloTaskIdOf('abc')).toBeNull();
    expect(soloRunIdOf('abc')).toBe('solo:abc');
    expect(soloTaskIdOf(soloRunIdOf('x'))).toBe('x');
  });

  it('solo 详情：kind=solo + 退化图 viewModel（单节点/单视图/第 1 次运行带）+ 成员会话 join', async () => {
    const res = await detail(soloRunIdOf(SID));
    expect(res.status).toBe(200);
    const body = await res.json();
    // run 块：kind 判别 + name = 会话 label + 单例语义（import 无）
    expect(body.run.kind).toBe('solo');
    expect(body.run.name).toBe('rfsolo 会话A');
    expect(body.run.status).toBe('passed');
    expect(body.run.import).toBeNull();
    // 退化图：单节点 + 单视图 + 无回滚 + 0 代
    const vm = body.viewModel;
    expect(vm.nodes).toHaveLength(1);
    expect(vm.generations).toEqual([0]);
    expect(vm.rollbacks).toHaveLength(0);
    expect(vm.views).toHaveLength(1);
    expect(vm.views[0].nodeKeys).toHaveLength(1);
    expect(vm.views[0].edges).toHaveLength(0);
    // 节点 = 短名（taskId ≤12 不截断），attempt 1 次且成员会话已 join（turns=2）
    const node = vm.nodes[0];
    expect(node.nodeId).toBe(SID);
    expect(node.attempts).toHaveLength(1);
    expect(node.attempts[0].executeMember.sessionId).toBe(SID);
    expect(node.attempts[0].executeMember.session?.turns).toBe(2);
    // Σ成员指标可用（单成员）
    expect(body.memberStats?.joinedCount).toBe(1);
  });

  it('观测端点对 solo 作用域可用：turns 合并投影 + member 归因短 taskId 回落（>12 截断）', async () => {
    const res = await runTurnsGET(
      new NextRequest(`http://localhost/api/observe/run/${soloRunIdOf(SID_LONG)}/turns?page=1&pageSize=50`),
      { params: Promise.resolve({ runId: soloRunIdOf(SID_LONG) }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.items[0].member).toEqual({ taskId: SID_LONG, label: 'rfsolo-sessi…' });
  });

  it('同 sid 双行：缺省原生优先，framework 参数精确消歧', async () => {
    const native = await detail(soloRunIdOf(SID_DUAL));
    expect(native.status).toBe(200);
    const nativeBody = await native.json();
    expect(nativeBody.viewModel.nodes[0].attempts[0].executeMember.session.framework).toBe('opencode');
    expect(nativeBody.viewModel.nodes[0].attempts[0].executeMember.session?.turns).toBe(1);

    const proxy = await detail(soloRunIdOf(SID_DUAL), '?framework=opencode-proxy');
    expect(proxy.status).toBe(200);
    const proxyBody = await proxy.json();
    expect(proxyBody.viewModel.nodes[0].attempts[0].executeMember.session.framework).toBe('opencode-proxy');
    expect(proxyBody.viewModel.nodes[0].attempts[0].executeMember.session?.turns).toBe(1);
  });

  it('member 端点 solo 分支：节点实例按五键取（退化图无跨代 peers/回滚）', async () => {
    const res = await runMemberGET(
      new NextRequest(`http://localhost/api/observe/run/${soloRunIdOf(SID)}/member?nodeId=${SID}&generation=0`),
      { params: Promise.resolve({ runId: soloRunIdOf(SID) }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.node.nodeId).toBe(SID);
    expect(body.node.attempts[0].executeMember.session.taskId).toBe(SID);
    expect(body.peers).toEqual([]);
    expect(body.rollbacks).toEqual([]);
  });

  it('护栏：未入库 session 404（session-not-found）；solo 不可 DELETE（会话视图）', async () => {
    const missing = await detail('solo:rfsolo-nonexistent');
    expect(missing.status).toBe(404);
    expect((await missing.json()).reason).toBe('session-not-found');

    const del = await runDetailDELETE(
      new NextRequest(`http://localhost/api/observe/run/${soloRunIdOf(SID)}`),
      { params: Promise.resolve({ runId: soloRunIdOf(SID) }) },
    );
    expect(del.status).toBe(400);
    expect((await del.json()).reason).toBe('solo-not-deletable');
  });
});
