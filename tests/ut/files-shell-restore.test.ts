// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software and is distributed under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may not use this file except in compliance with the License.
// A copy of the License is located in the "LICENSE" file at the root of the source tree.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
// EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY,
// OR FITNESS FOR A PARTICULAR PURPOSE. See the License for the full text of the License.

// Files 循迹复卷 shell 通道回归（现场事故形态回放，数据驱动）。
// 事故：codex 会话没有 Read 工具——文件读取内嵌在 exec_command 的 shell
// 脚本里；恢复层只认 read/Write 词表 → Files 页「列表有文件、复卷零素材」。
// 本用例从 file-restore / dir-restore 两个路由级验证根因修复后的完整数据流：
//   ① 纯 sed 转储原样恢复（无截断）
//   ② 采集期截断（banner + 内联字符级标记）：头段正数定位、尾段从
//      Total output lines 倒数定位，被丢中段与残行如实成 gap——行号不错位
//   ③ 确定性命令链（wc + sed + printf 字面量 + sed）：多段归因互不串味
//   ④ UNKNOWN 段（ls/管道）后凭 printf 字面量锚恢复对齐
//   ⑤ cat 全读被后随字面量锚界定
//   ⑥ 管道段（grep | sed）永不归因（分析层照常计读，复卷不采内容）
//   ⑦ Read 工具与 shell 通道在同一文件上合流（读写时间序合并）
//   ⑧ 背靠背双 sed + 截断丢弃横跨段边界：位置空间封顶不吞后段尾行、
//      跨段起点不可判定时跳过归因——行号永不污染（13-17 保持 gap）
//   ⑨ 无编号 dump 被截断、后随别的输出段且锚点落在丢弃段：缝之后的保留行
//      行号未经校验（是后随段的输出）→ 不归因，只留头段（guide.md 1-2；
//      紧贴缝的 G03 是残行，同样不归因）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { GET as runFileRestoreGET } from '@/app/api/observe/run/[runId]/file-restore/route';
import { GET as runDirRestoreGET } from '@/app/api/observe/run/[runId]/dir-restore/route';

const FIXTURE = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/files-shell-restore.json'), 'utf8')) as {
  session: { taskId: string; framework: string; label: string };
  files: Record<string, string[]>;
  calls: Array<{ id: string; tool: string; cmd?: string; result: string; args?: Record<string, unknown> }>;
  expect: Record<string, { covered: Array<[number, number]>; maxLine: number; opsUsed: number; source: string }>;
};

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-files-shell-'));
const ORIG_HOME = process.env.CONTEXT_INSIGHT_HOME;
const SID = FIXTURE.session.taskId;
const RUN_ID = `solo:${SID}`;
const BASE_TS = new Date('2026-11-17T08:00:00Z').getTime();

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
      : JSON.stringify(call.args ?? {});
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

describe('Files 循迹复卷 shell 通道（codex exec_command 隐式读恢复）', () => {
  for (const [filePath, exp] of Object.entries(FIXTURE.expect)) {
    it(`file-restore：${filePath} —— 覆盖区 ${JSON.stringify(exp.covered)}、行号校准、缺口诚实 gap`, async () => {
      const res = await get(RUN_ID, 'file-restore', `?filePath=${encodeURIComponent(filePath)}`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.path).toBe(filePath);

      const covered = new Set<number>();
      for (const [a, b] of exp.covered) for (let n = a; n <= b; n++) covered.add(n);

      expect(data.maxLine).toBe(exp.maxLine);
      expect(data.opsUsed).toBe(exp.opsUsed);
      expect(data.lines.length).toBe(exp.maxLine);

      const model = FIXTURE.files[filePath];
      const got = new Map<number, { content: string | null; source: string }>();
      for (const l of data.lines) got.set(l.n, { content: l.content, source: l.source });
      for (let n = 1; n <= exp.maxLine; n++) {
        const line = got.get(n)!;
        if (covered.has(n)) {
          expect(line.content).toBe(model[n - 1]);
          expect(line.source).toBe(exp.source);
        } else {
          // 缺口（截断丢弃段/残行/管道未采）：行号在场、内容为空、source=gap
          expect(line.content).toBeNull();
          expect(line.source).toBe('gap');
        }
      }
    });
  }

  it('SKILL.md 现场形态：截断链的多段归因不串味（wc 头消耗 + 双 sed 区间 + printf 锚）', async () => {
    const res = await get(RUN_ID, 'file-restore', '?filePath=skill%2FSKILL.md');
    const data = await res.json();
    const byN = new Map<number, { content: string | null; source: string }>(data.lines.map((l: { n: number; content: string | null; source: string }) => [l.n, l]));
    // ② 截断单段：头 1-3 + 尾 19-20；残行（sr-b 的 4/18）由 ③ 的确定性链补齐
    expect(byN.get(3)!.content).toBe('S03');
    expect(byN.get(4)!.content).toBe('S04');
    expect(byN.get(18)!.content).toBe('S18');
    expect(byN.get(19)!.content).toBe('S19');
    // ③ 确定性链补 1-12 + 18-20；被丢中段 13-17 如实 gap（含 printf 消耗校验）
    expect(byN.get(12)!.content).toBe('S12');
    expect(byN.get(13)!.content).toBeNull();
    expect(byN.get(17)!.content).toBeNull();
    expect(byN.get(20)!.content).toBe('S20');
  });

  it('dir-restore：shell 通道文件全进 zip，统计头如实（3 文件 / 缺口 5 行）', async () => {
    const res = await get(RUN_ID, 'dir-restore');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/zip');
    expect(Number(res.headers.get('X-Restored-Count'))).toBe(4);
    // 全行数含 gap：SKILL.md 20（含 5 缺口行）+ flows.md 8 + req.txt 5 + guide.md 2（未校验尾段不归因，不计行）
    expect(Number(res.headers.get('X-Restored-Total-Lines'))).toBe(20 + 8 + 5 + 2);
    expect(Number(res.headers.get('X-Restored-Gap-Lines'))).toBe(5);
  });

  it('管道段永不归因：grep | sed 不产出复卷内容（分析层计读、恢复层零素材）', async () => {
    // sr-f 的管道命令读的是 SKILL.md——若误归因，opsUsed 会多 1、且
    // 13-17 缺口会被 "n:S0x" 形态污染。上面已锁 opsUsed=4 与 gap 行；
    // 此处从引擎层再锁一道：同一 argsJson 直接调 restoreShellReads 为空。
    const { restoreShellReads } = await import('@/lib/shell-restore');
    const pipeCall = FIXTURE.calls.find(c => c.id === 'sr-f')!;
    const entries = restoreShellReads(JSON.stringify({ cmd: pipeCall.cmd, workdir: '/repo' }), pipeCall.result);
    expect(entries.length).toBe(0);
  });

  it('未校验的截断尾段不归因：无编号 dump 后随别的输出段、锚点被缝切掉时，尾段行号不可判定', async () => {
    // cat guide.md 之后还有 printf 锚 + find；锚点落在被丢弃的中段 → cat 的区域
    // 无法定位终点，缝之后的保留行是 find 的输出。修复前它们按总行数倒推被记成
    // guide.md 的第 13–14 行（别的输出冒充文件内容）；现在只归因头段 1–2
    const { restoreShellReads } = await import('@/lib/shell-restore');
    const call = FIXTURE.calls.find(c => c.id === 'sr-tail-unverified')!;
    const entries = restoreShellReads(JSON.stringify({ cmd: call.cmd, workdir: '/repo' }), call.result);
    expect(entries.length).toBe(1);
    expect([...entries[0]!.lines.keys()]).toEqual([1, 2]);
    expect([...entries[0]!.lines.values()]).toEqual(['G01', 'G02']);
    expect(entries[0]!.fileLines).toBeNull();
  });
});
