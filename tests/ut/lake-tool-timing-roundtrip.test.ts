// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details on how to use this file in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root directory of the software repository for the full text of the License.

// lake 导出 per-tool 时长 round-trip（不经 lake 编排层的路径面）：
// 导出件（x_lake cc-db-turn toolCalls 声明携带 startedAt/durationMs/completedAt）
// 此前只有 importLakeSession 的 patchXLakeColumns 补列一条恢复路径——直接
// 文件导入（importSession 标准 pipeline）与 refresh 增量刷新都会把声明值丢弃
// （工具结果载体行与发起行同戳，行级时间戳推导恒为 0）。修复：声明进标准
// 通道（claude-jsonl adapter 读进 ToolCallInfo.startedAt/completedAt，与
// opencode part 表同源），全路径一致。lake 编排层补列保留（errorType 等仍补）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prisma } from '../setup';
import { exportSessionToClaudeJsonl } from '@/lib/lake/export';
import { importSession, deltaRefreshSession } from '@/lib/ingest/data-service';

const SID = 'ses-lake-tool-rt-0001';
const T0 = new Date('2026-08-19T05:00:00.000Z');

let outDir: string;
let mainJsonl: string;

beforeAll(async () => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-lake-tool-rt-'));
  mainJsonl = path.join(outDir, 'sessions', SID, `${SID}.jsonl`);

  await prisma.session.deleteMany({ where: { taskId: SID } });
  const session = await prisma.session.create({
    // opencode 源：真实场景里 per-tool 时长来自 opencode v2 tool 项 time 字段
    //（v2 适配器修复），导出时经 ToolCall.startedAt/completedAt/durationMs
    // 落进 x_lake 声明
    data: { taskId: SID, framework: 'opencode', version: '2.0.28' },
  });
  const turn = await prisma.turn.create({
    data: {
      sessionId: session.id, turnIndex: 1, role: 'assistant', content: '跑诊断',
      latencyMs: 4321, createdAt_ts: new Date(T0.getTime() + 10_000),
    },
  });
  await prisma.toolCall.createMany({
    data: [
      {
        turnId: turn.id, toolCallId: 'tc_rt_shell', toolName: 'shell',
        argsJson: JSON.stringify({ command: 'npm test' }), resultJson: JSON.stringify('ok'),
        state: 'ok', durationMs: 661,
        startedAt: new Date(T0.getTime() + 10_200), completedAt: new Date(T0.getTime() + 10_861),
      },
      {
        turnId: turn.id, toolCallId: 'tc_rt_edit', toolName: 'edit',
        argsJson: JSON.stringify({ path: 'a.ts' }), resultJson: JSON.stringify('done'),
        state: 'ok', durationMs: 42,
        startedAt: new Date(T0.getTime() + 10_900), completedAt: new Date(T0.getTime() + 10_942),
      },
    ],
  });
});

afterAll(() => {
  fs.rmSync(outDir, { recursive: true, force: true });
});

describe('lake 导出 per-tool 时长 round-trip：声明进标准通道（全路径一致）', () => {
  it('导出件：x_lake cc-db-turn toolCalls 声明携带 startedAt/durationMs/completedAt', async () => {
    const written = await exportSessionToClaudeJsonl(prisma, SID, outDir);
    expect(written.some(w => w.endsWith(`${SID}.jsonl`))).toBe(true);

    const lines = fs.readFileSync(mainJsonl, 'utf8').split('\n').filter(l => l.trim());
    const assistant = lines.map(l => JSON.parse(l)).find(o => o.type === 'assistant');
    const declared = assistant.x_lake.data.toolCalls as Array<{ toolUseId: string; durationMs?: number; startedAt?: string; completedAt?: string }>;
    const byId = new Map(declared.map(d => [d.toolUseId, d]));
    expect(byId.get('tc_rt_shell')).toMatchObject({
      durationMs: 661,
      startedAt: new Date(T0.getTime() + 10_200).toISOString(),
      completedAt: new Date(T0.getTime() + 10_861).toISOString(),
    });
    expect(byId.get('tc_rt_edit')?.durationMs).toBe(42);
  });

  it('直接导入（importSession 标准 pipeline，无 lake 编排补列）：per-tool 时长不丢', async () => {
    await exportSessionToClaudeJsonl(prisma, SID, outDir);
    await prisma.session.deleteMany({ where: { taskId: SID } });
    await importSession(mainJsonl, SID, prisma, mainJsonl, 'claude-jsonl');

    const s = await prisma.session.findFirst({ where: { taskId: SID } });
    expect(s).toBeTruthy();
    // cc-session-meta 恢复导出身份（框架语义正确 → 单轮耗时不相加口径）
    expect(s!.framework).toBe('opencode');
    const tcs = await prisma.toolCall.findMany({ where: { turn: { sessionId: s!.id } } });
    const byId = new Map(tcs.map(tc => [tc.toolCallId, tc]));
    // 修复前：载体行同戳 → durationMs=0、startedAt=轮时刻（声明被丢弃）
    const shell = byId.get('tc_rt_shell')!;
    expect(shell.durationMs).toBe(661);
    expect(shell.startedAt?.toISOString()).toBe(new Date(T0.getTime() + 10_200).toISOString());
    expect(shell.completedAt?.toISOString()).toBe(new Date(T0.getTime() + 10_861).toISOString());
    expect(byId.get('tc_rt_edit')!.durationMs).toBe(42);
  });

  it('refresh 增量刷新（deltaRefreshSession）：声明值不再被打回 0', async () => {
    const s = await prisma.session.findFirst({ where: { taskId: SID } });
    expect(s).toBeTruthy();
    await deltaRefreshSession(SID, prisma, {
      id: s!.id, taskId: SID, framework: s!.framework, version: s!.version, sourcePath: mainJsonl,
    });

    const tcs = await prisma.toolCall.findMany({ where: { turn: { sessionId: s!.id } } });
    const byId = new Map(tcs.map(tc => [tc.toolCallId, tc]));
    // 修复前：refresh 走标准 pipeline 且不读声明 → 补列值被 0 覆盖（回退）
    expect(byId.get('tc_rt_shell')!.durationMs).toBe(661);
    expect(byId.get('tc_rt_edit')!.durationMs).toBe(42);
  });
});
