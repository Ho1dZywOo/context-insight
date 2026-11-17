// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 原生 Codex Files 全链 IT：rollout JSONL 的 exec_command 使用 `cmd` 参数，
// 经 import-file 落库后，run file-reads API 必须识别 sed 范围读与 cat 全文读。

import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { POST as importFilePOST } from '@/app/api/ingest/import-file/route';
import { GET as fileReadsGET } from '@/app/api/observe/run/[runId]/file-reads/route';
import { prisma } from '../setup';

const SID = '55555555-eeee-4b04-8f7e-abcdef000055';
const FIXTURE = path.join(__dirname, 'data/codex-file-reads', `rollout-2026-11-17T09-00-00-${SID}.jsonl`);

function req(body: unknown, url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function getReq(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`);
}

afterEach(async () => {
  await prisma.session.deleteMany({ where: { taskId: SID } });
});

describe('codex-jsonl Files API', () => {
  it('原生 exec_command 的 cmd 参数进入文件读取分析', async () => {
    const imported = await importFilePOST(req(
      { source: 'codex-jsonl', sessionId: SID, filePath: FIXTURE },
      '/api/ingest/import-file',
    ));
    expect(imported.status).toBe(200);
    expect((await imported.json()).imported).toBe(true);

    const toolCall = await prisma.toolCall.findFirstOrThrow({
      where: { turn: { session: { taskId: SID } }, toolName: 'exec_command' },
    });
    expect(JSON.parse(toolCall.argsJson ?? '{}')).toMatchObject({
      cmd: expect.stringContaining("sed -n '10,20p'"),
    });

    const runId = `solo:${SID}`;
    const res = await fileReadsGET(
      getReq(`/api/observe/run/${runId}/file-reads`),
      { params: Promise.resolve({ runId }) },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.summary).toMatchObject({ totalFiles: 2, totalReads: 2 });

    const app = data.files.find((file: { path: string }) => file.path === '/home/user/project/src/app.ts');
    const readme = data.files.find((file: { path: string }) => file.path === '/home/user/project/README.md');
    expect(app.reads[0].range).toEqual({ type: 'partial', start: 10, end: 20 });
    expect(readme.reads[0].range).toEqual({ type: 'full', start: 0, end: null });
  });
});
