// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details on what you can and cannot do with this software.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, EITHER EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See the License for the specific language governing permissions and limitations under the License.

// IT（数据驱动）：摄取突变 → 观测缓存失效（observe/invalidation 单点）。
// 锁的根因 bug：run 观测作用域缓存持有成员行 id，删除重导后行 id 换新；
// 缓存若不在突变处失效，turns / executions / skills 端点会按死行 id 静默
// 查空——HTTP 200 + 空列表、零报错，Overview 的 skills / tool calls 归零。
// 判别点：删除 → 重导后**立即**查询必须非空。无失效实现下作用域 LRU（60s）
// 仍捂着旧行 id，本断言失败。
import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import path from 'node:path';
import { prisma } from '../setup';
import { POST as importFilePOST } from '@/app/api/ingest/import-file/route';
import { DELETE as deleteSessionDELETE } from '@/app/api/ingest/delete-session/route';
import { GET as turnsGET } from '@/app/api/observe/run/[runId]/turns/route';
import { GET as executionsGET } from '@/app/api/observe/run/[runId]/executions/route';
import { GET as skillsGET } from '@/app/api/observe/run/[runId]/skills/route';

const DATA = path.join(__dirname, './data/codex-streaming');
const MAIN = '55555555-eeee-4b04-8f7e-abcdef000055';
const mainFile = path.join(DATA, `rollout-2026-11-10T22-22-21-${MAIN}.jsonl`);
const RUN_ID = `solo:${MAIN}`;
// 作用域缓存键是 runId（solo:<taskId>）——观察端点第一次调用即预热
const routeCtx = { params: Promise.resolve({ runId: RUN_ID }) };

function importReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/ingest/import-file', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function deleteReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/ingest/delete-session', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function observeReq(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/observe/run/${RUN_ID}${query}`, { method: 'GET' });
}

const createdTaskIds: string[] = [];

afterEach(async () => {
  for (const taskId of createdTaskIds.splice(0)) {
    const rows = await prisma.session.findMany({ where: { taskId } });
    for (const row of rows) {
      await prisma.session.delete({ where: { id: row.id } }).catch(() => { /* ignore */ });
    }
  }
});

describe('摄取突变 → 观测缓存失效（重导换行不得按死行 id 静默查空）', () => {
  it('删除重导后立即查询：turns / executions / skills 全部按新行解析', async () => {
    // ① 首次导入 → 行₁
    const res1 = await importFilePOST(importReq({ source: 'codex-jsonl', filePath: mainFile }));
    expect(res1.status).toBe(200);
    expect((await res1.json()).imported).toBe(true);
    createdTaskIds.push(MAIN);

    // ② 观察端点预热作用域缓存（此刻持有行₁ 的 rowId）
    const t1 = await (await turnsGET(observeReq('?page=1&pageSize=50'), routeCtx)).json();
    expect(t1.items.length).toBeGreaterThan(0);

    // ③ 删除（行₁ 消失）→ 重导（行₂；同 taskId、新 rowId）
    const del = await deleteSessionDELETE(deleteReq({ taskId: MAIN }));
    expect(del.status).toBe(200);
    const res2 = await importFilePOST(importReq({ source: 'codex-jsonl', filePath: mainFile }));
    expect((await res2.json()).imported).toBe(true);

    // ④ 立即再查三个观测端点：必须按行₂ 解析出数据（200 + 空即根因复发）
    const t2 = await (await turnsGET(observeReq('?page=1&pageSize=50'), routeCtx)).json();
    expect(t2.items.length).toBeGreaterThan(0);
    const e2 = await (await executionsGET(observeReq(''), routeCtx)).json();
    expect(e2.items.length).toBeGreaterThan(0);
    const s2 = await (await skillsGET(observeReq(''), routeCtx)).json();
    expect(Array.isArray(s2.skills) && s2.skills.length).toBeGreaterThan(0);
  });
});
