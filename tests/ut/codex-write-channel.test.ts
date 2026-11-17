// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// A copy of the License is located in the "LICENSE" file at the root of the source tree.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
// EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY,
// OR FITNESS FOR A PARTICULAR PURPOSE. See the License for the full text of the License.

// codex apply_patch 写通道回归（现场形态回放，数据驱动）。
// 事故：codex 没有 Write/Edit 工具——文件创建与修改全走 apply_patch，且
// argsJson 是裸 patch 文本（非 JSON）；恢复层与全部写词表按 claude/opencode
// 形态假设 → 写操作全家失明（复卷写素材为零、评分「写入」零计、自清理
// 误判高危删除、验证窗口判定全错）。本用例锁根因修复后的完整数据流：
//   ① Add File 全文可知 → 复卷写素材（source=write）
//   ② Update File hunk 无行号（codex 态 `@@` 不带位置）→ 不产出行（宁缺毋假），
//      复卷由 shell 读承担（改前 cat + 改后 sed 的读写时间序合并，后到覆盖）
//   ③ 一份 patch 多文件段（Add + Update + Delete）逐文件产出：Add 入恢复、
//      其余动作不产行
//   ④ 解析器形态归一：裸 patch / JSON 字符串化 / {input} 包装
//   ⑤ extractFilePath patch 回退（多文件取首个）
//   ⑥ isCodeWrite 口径：patch 改 .py 算改代码、.md 不算（验证窗口不被文档写推移）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { GET as runFileRestoreGET } from '@/app/api/observe/run/[runId]/file-restore/route';
import { GET as runDirRestoreGET } from '@/app/api/observe/run/[runId]/dir-restore/route';
import { parseApplyPatch, isApplyPatchArgs } from '@/lib/apply-patch';
import { extractFilePath } from '@/lib/file-restore';
import { isCodeWrite } from '@/lib/scoring/core/test-parser';

const FIXTURE = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/codex-write-channel.json'), 'utf8')) as {
  session: { taskId: string; framework: string; label: string };
  files: Record<string, string[]>;
  calls: Array<{ id: string; tool: string; cmd?: string; result: string; args?: Record<string, unknown> }>;
  expect: Record<string, { lines: string[]; opsUsed: number; source: string }>;
};

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-write-channel-'));
const ORIG_HOME = process.env.CONTEXT_INSIGHT_HOME;
const SID = FIXTURE.session.taskId;
const RUN_ID = `solo:${SID}`;
const BASE_TS = new Date('2026-11-17T10:00:00Z').getTime();

beforeAll(async () => {
  process.env.CONTEXT_INSIGHT_HOME = tmpHome;
  await prisma.session.deleteMany({ where: { taskId: SID } });
  await prisma.session.create({
    data: {
      taskId: SID, framework: FIXTURE.session.framework, label: FIXTURE.session.label, model: 'codex-test',
      totalTokens: 10, startTime: new Date(BASE_TS), endTime: new Date(BASE_TS + 60_000),
    },
  });
  const session = await prisma.session.findFirst({ where: { taskId: SID } });
  expect(session).not.toBeNull();

  for (let i = 0; i < FIXTURE.calls.length; i++) {
    const call = FIXTURE.calls[i];
    const turn = await prisma.turn.create({
      data: { sessionId: session!.id, turnIndex: i, role: 'assistant', createdAt: new Date(BASE_TS + i * 1_000) },
    });
    const argsJson = call.tool === 'exec_command'
      ? JSON.stringify({ cmd: call.cmd, workdir: '/repo' })
      : (call.args as unknown as string);
    await prisma.toolCall.create({
      data: {
        turnId: turn.id, toolCallId: call.id, toolName: call.tool, state: 'ok',
        argsJson, resultJson: call.result,
        startedAt: new Date(BASE_TS + i * 1_000), completedAt: new Date(BASE_TS + i * 1_000 + 500),
      },
    });
  }
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: SID } });
  if (ORIG_HOME === undefined) delete process.env.CONTEXT_INSIGHT_HOME;
  else process.env.CONTEXT_INSIGHT_HOME = ORIG_HOME;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function get(runId: string, seg: 'file-restore' | 'dir-restore', query = '') {
  const handlers = { 'file-restore': runFileRestoreGET, 'dir-restore': runDirRestoreGET } as const;
  return handlers[seg](
    new NextRequest(`http://localhost/api/observe/run/${runId}/${seg}${query}`),
    { params: Promise.resolve({ runId }) },
  );
}

describe('Files 复卷 codex apply_patch 写通道', () => {
  for (const [filePath, exp] of Object.entries(FIXTURE.expect)) {
    it(`file-restore：${filePath} —— ${exp.source} 素材 ${exp.lines.length} 行、Update 段不产行`, async () => {
      const res = await get(RUN_ID, 'file-restore', `?filePath=${encodeURIComponent(filePath)}`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.path).toBe(filePath);
      expect(data.maxLine).toBe(exp.lines.length);
      expect(data.opsUsed).toBe(exp.opsUsed);
      expect(data.lines.map((l: { content: string | null }) => l.content)).toEqual(exp.lines);
      for (const l of data.lines) expect(l.source).toBe(exp.source);
    });
  }

  it('hello.py 读写时间序：改后 sed 覆盖改前 cat，patch Update 零行贡献', async () => {
    const res = await get(RUN_ID, 'file-restore', '?filePath=hello.py');
    const data = await res.json();
    // wc-a cat（v1-b）→ wc-b patch（无行）→ wc-c sed（v2-b）：后到者胜
    expect(data.lines[1].content).toBe("print('v2-b')");
    expect(data.lines[1].source).toBe('read');
    expect(data.opsUsed).toBe(2);
  });

  it('dir-restore：patch 新建文件全进 zip（3 文件 / 7 行 / 0 缺口）', async () => {
    const res = await get(RUN_ID, 'dir-restore');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/zip');
    expect(Number(res.headers.get('X-Restored-Count'))).toBe(3);
    expect(Number(res.headers.get('X-Restored-Total-Lines'))).toBe(3 + 2 + 2);
    expect(Number(res.headers.get('X-Restored-Gap-Lines'))).toBe(0);
  });
});

describe('apply-patch 解析器（单点）', () => {
  const PATCH = '*** Begin Patch\n*** Update File: /repo/a.py\n@@\n-old\n+new\n*** End Patch\n';

  it('裸 patch 文本 / JSON 字符串化 / {input} 包装 三形态同解析', () => {
    const expected = [{ action: 'update', file: '/repo/a.py', addLines: null }];
    expect(parseApplyPatch(PATCH)).toEqual(expected);
    expect(parseApplyPatch(JSON.stringify(PATCH))).toEqual(expected);
    expect(parseApplyPatch(JSON.stringify({ input: PATCH }))).toEqual(expected);
  });

  it('非 patch 载荷（JSON 工具参数 / 空串）→ null', () => {
    expect(parseApplyPatch(null)).toBeNull();
    expect(parseApplyPatch('{"file_path":"/a.py","content":"x"}')).toBeNull();
    expect(parseApplyPatch('rm -rf /')).toBeNull();
    expect(isApplyPatchArgs('{"content":"*** Begin Patch"}')).toBe(false);
  });

  it('Add File 全文行（剥 + 前缀、空行保留）；多文件段逐文件产出', () => {
    const ops = parseApplyPatch(
      '*** Begin Patch\n*** Add File: /repo/new.py\n+import os\n+\n+print(1)\n*** Update File: /repo/a.py\n@@\n-a\n+b\n*** Delete File: /repo/gone.tmp\n*** End Patch\n',
    )!;
    expect(ops).toEqual([
      { action: 'add', file: '/repo/new.py', addLines: ['import os', '', 'print(1)'] },
      { action: 'update', file: '/repo/a.py', addLines: null },
      { action: 'delete', file: '/repo/gone.tmp', addLines: null },
    ]);
  });

  it('extractFilePath patch 回退：多文件取首个；JSON 参数优先不受影响', () => {
    expect(extractFilePath(PATCH)).toBe('/repo/a.py');
    // claude/opencode JSON 形态：JSON 解析优先，patch 文本内容不劫持
    expect(extractFilePath(JSON.stringify({ file_path: '/x/y.md', content: PATCH }))).toBe('/x/y.md');
  });

  it('isCodeWrite：patch 改 .py 算改代码、改 .md 不算（D1/D3 验证窗口口径）', () => {
    const pyPatch = '*** Begin Patch\n*** Update File: /repo/src/tool.py\n@@\n-a\n+b\n*** End Patch\n';
    const mdPatch = '*** Begin Patch\n*** Update File: /repo/CHANGELOG.md\n@@\n+entry\n*** End Patch\n';
    expect(isCodeWrite('apply_patch', pyPatch)).toBe(true);
    expect(isCodeWrite('apply_patch', mdPatch)).toBe(false);
    // 原生 Write 家族口径不回归（.py 算代码、.txt 是文档口径）
    expect(isCodeWrite('Write', JSON.stringify({ file_path: '/f.py', content: 'x' }))).toBe(true);
    expect(isCodeWrite('Write', JSON.stringify({ file_path: '/f.txt', content: 'x' }))).toBe(false);
  });
});
