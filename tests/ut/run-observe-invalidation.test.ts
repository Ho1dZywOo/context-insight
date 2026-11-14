// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See the License for the specific language governing permissions and limitations under the License.

// IT（数据驱动）：run 级摄取突变 → 观测缓存失效（observe/invalidation 单点）。
// 锁的根因 bug：run 观测作用域缓存持有成员行 id，bundle 导入与 run 删除两条
// 改写会话行的路径漏了失效——删除 run → 60s（scope TTL）内重导同一 run →
// turns 端点按死行 id IN(死行) 静默查空（HTTP 200 + 空列表、零报错）。
// 判别点：删除 → 重导后**立即**查询必须非空；无失效实现下作用域 LRU 仍捂着
// 旧行 id，本断言失败。
// 会话 sid 用本文件专属前缀（ses_runinv_*），避免与并行 test.db 共享下其他
// 夹具（如 run-import-service 的 ses_mini_*）撞 taskId。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prisma } from '../setup';
import { runImportJob, type ImportJobState } from '@/lib/run/import-service';
import { parseManifest } from '@/lib/run/reader';
import { resolveRunScope, invalidateRunScopeCache } from '@/lib/run/observe/scope';
import { DELETE as runDeleteDELETE } from '@/app/api/observe/run/[runId]/route';
import { GET as turnsGET } from '@/app/api/observe/run/[runId]/turns/route';

const RUN_ID = 'runinv01';
const SID = 'ses_runinv_a';

const JSONL = [
  '{"type":"user","message":{"role":"user","content":"run the fix"}}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"fix applied"}],"model":"claude-haiku-3-20250415","usage":{"input_tokens":10,"output_tokens":5}},"duration_ms":1000}',
  '{"type":"result","subtype":"success","result":"ok","cost_usd":0.001,"duration_ms":2000}',
].join('\n');

let tmpHome: string;
let bundleDir: string;
const ORIG_HOME = process.env.CONTEXT_INSIGHT_HOME;

function freshState(runId: string, dirPath: string): ImportJobState {
  return {
    jobId: 'test-job',
    dirPath,
    runId,
    step: 'validate',
    total: 0,
    imported: 0,
    existing: 0,
    missingFile: 0,
    failed: 0,
    currentSid: null,
    error: null,
    warnings: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
}

/** 自建最小 bundle（1 会话成员 + 1 turn）：run 落盘 + 会话行导入全链路可跑。 */
function makeBundle(dir: string): void {
  const sessionDir = path.join(dir, 'sessions', `${SID}.native`);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, `${SID}.jsonl`), JSONL);
  fs.writeFileSync(
    path.join(dir, 'workflow.json'),
    JSON.stringify({
      schema: 'workflow-bundle',
      version: 1,
      id: RUN_ID,
      kind: 'workflow',
      name: 'run-invalidation',
      startedAt: null,
      finishedAt: null,
      data: {
        exportDataComplete: true,
        members: [
          {
            id: 'S_A',
            kind: 'session',
            name: '失效会话',
            startedAt: null,
            finishedAt: null,
            sessionId: SID,
            location: `sessions/${SID}.native`,
            annotation: { graph: { role: 'execute', nodeId: 'n', generation: 0, attempt: 1 } },
          },
        ],
        relations: [],
      },
    }),
  );
}

function manifestOf(): ReturnType<typeof parseManifest> {
  return parseManifest(JSON.parse(fs.readFileSync(path.join(bundleDir, 'workflow.json'), 'utf-8')));
}

function runsRoot(): string {
  return path.join(tmpHome, 'runs');
}

function observeReq(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/observe/run/${RUN_ID}${query}`, { method: 'GET' });
}

function deleteReq(): NextRequest {
  return new NextRequest(`http://localhost/api/observe/run/${RUN_ID}`, { method: 'DELETE' });
}

const routeCtx = { params: Promise.resolve({ runId: RUN_ID }) };

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-run-inval-'));
  bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-run-inval-bundle-'));
  makeBundle(bundleDir);
  process.env.CONTEXT_INSIGHT_HOME = tmpHome;
  // scopeCache 是模块级单例：逐用例清场，避免前用例命中的旧作用域串场
  invalidateRunScopeCache();
});

afterEach(async () => {
  await prisma.session.deleteMany({ where: { taskId: SID } }).catch(() => {});
  if (ORIG_HOME === undefined) delete process.env.CONTEXT_INSIGHT_HOME;
  else process.env.CONTEXT_INSIGHT_HOME = ORIG_HOME;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(bundleDir, { recursive: true, force: true });
});

describe('run 级摄取突变 → 观测缓存失效（删除/重导不得按死行 id 静默查空）', () => {
  it('bundle run 删除 → 重导后立即查询：turns 按新行解析（200 + 空即根因复发）', async () => {
    const manifest = manifestOf();

    // ① 首导 → 会话行（rowIds v1），run 落盘 runs/runinv01
    await runImportJob(freshState(RUN_ID, bundleDir), bundleDir, manifest, { prisma, root: runsRoot() });

    // ② 观察端点预热作用域缓存（此刻持有 v1 行 id）
    const t1 = await (await turnsGET(observeReq('?page=1&pageSize=50'), routeCtx)).json();
    expect(t1.items.length).toBeGreaterThan(0);

    // ③ 删除 run（级联删 owned 会话行 + 删 run 目录）
    const del = await runDeleteDELETE(deleteReq(), routeCtx);
    expect(del.status).toBe(200);

    // ④ 重导同一 bundle（新行 rowIds v2；同 sid、同 run 目录重建）
    await runImportJob(freshState(RUN_ID, bundleDir), bundleDir, manifest, { prisma, root: runsRoot() });

    // ⑤ 立即再查 turns：必须按 v2 行解析出数据
    const t2 = await (await turnsGET(observeReq('?page=1&pageSize=50'), routeCtx)).json();
    expect(t2.items.length).toBeGreaterThan(0);
  });

  it('删除 run 后作用域缓存即时失效：resolveRunScope 返回 null 而非旧行作用域', async () => {
    const manifest = manifestOf();

    // ① 首导 + 预热作用域缓存
    await runImportJob(freshState(RUN_ID, bundleDir), bundleDir, manifest, { prisma, root: runsRoot() });
    const warm = await resolveRunScope(RUN_ID, prisma);
    expect(warm).not.toBeNull();
    expect(warm!.members.length).toBeGreaterThan(0);

    // ② 删除 run（会话行 + 目录一并清理）
    const del = await runDeleteDELETE(deleteReq(), routeCtx);
    expect(del.status).toBe(200);

    // ③ 再解析：缓存已失效，run 目录已删 → 必须 null（旧行作用域 = 缓存未失效的复发）
    const after = await resolveRunScope(RUN_ID, prisma);
    expect(after).toBeNull();
  });
});