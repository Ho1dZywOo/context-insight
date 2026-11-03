// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// run auto-refresh 探针端点 IT（刀J2 删除的 session 探针以平移层处理器复活）：
// 真实 prisma 种 claude 格式会话 + 真实 jsonl 源文件 → 锁：①settled 会话探针
// 形状（maxTimeUpdated = mtime、settled=true）；②源追加 user 行 → pendingInput
// （settled 翻转，客户端不应在此态触发同步）；③无 sourcePath 会话 →
// changed:false（探针短路）；④run 不存在 404。

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { GET as runAutoRefreshGET } from '@/app/api/observe/run/[runId]/auto-refresh/route';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-run-auto-refresh-'));
const ORIG_HOME = process.env.CONTEXT_INSIGHT_HOME;
const SID = 'ar-ses-claude';
const NO_SRC_SID = 'ar-ses-nosrc';
const ALL_SIDS = [SID, NO_SRC_SID];
const MODEL = 'volc-gateway/glm-4.7';
const SRC = path.join(tmpHome, `${SID}.jsonl`);

const assistantLine = JSON.stringify({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
});
const userLine = JSON.stringify({
  type: 'user',
  message: { role: 'user', content: '继续' },
});

beforeAll(async () => {
  process.env.CONTEXT_INSIGHT_HOME = tmpHome;
  fs.writeFileSync(SRC, `${assistantLine}\n`);
  await prisma.session.deleteMany({ where: { taskId: { in: ALL_SIDS } } });
  await prisma.session.createMany({
    data: [
      {
        taskId: SID, framework: 'claude-code', label: 'ar 有源会话', model: MODEL, sourcePath: SRC,
        totalTokens: 10, startTime: new Date('2026-10-20T02:00:00Z'), endTime: new Date('2026-10-20T02:10:00Z'),
      },
      {
        taskId: NO_SRC_SID, framework: 'opencode', label: 'ar 无源会话', model: MODEL,
        totalTokens: 10, startTime: new Date('2026-10-20T03:00:00Z'), endTime: new Date('2026-10-20T03:01:00Z'),
      },
    ],
  });
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: { in: ALL_SIDS } } });
  if (ORIG_HOME === undefined) delete process.env.CONTEXT_INSIGHT_HOME;
  else process.env.CONTEXT_INSIGHT_HOME = ORIG_HOME;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const call = (runId: string, query = '') =>
  runAutoRefreshGET(
    new NextRequest(`http://localhost/api/observe/run/${runId}/auto-refresh${query}`),
    { params: Promise.resolve({ runId }) },
  );

describe('run 成员视图 auto-refresh（源变化探针，session 刷新能力对偶）', () => {
  it('settled 会话：探针形状（mtime 基线 + settled）', async () => {
    const res = await call(`solo:${SID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.maxTimeUpdated).toBeGreaterThan(0);
    expect(body.settled).toBe(true);
    expect(body.streaming).toBe(false);
    expect(body.pendingInput).toBe(false);
  });

  it('源追加 user 行 → pendingInput（settled 翻转，不触发同步窗口）', async () => {
    fs.appendFileSync(SRC, `${userLine}\n`);
    const res = await call(`solo:${SID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pendingInput).toBe(true);
    expect(body.settled).toBe(false);
  });

  it('无 sourcePath 会话：changed 短路（不抛错）', async () => {
    const res = await call(`solo:${NO_SRC_SID}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ changed: false });
  });

  it('run 不存在：404 run-not-found', async () => {
    const res = await call('solo:ar-no-such-session');
    expect(res.status).toBe(404);
    expect((await res.json()).reason).toBe('run-not-found');
  });
});
