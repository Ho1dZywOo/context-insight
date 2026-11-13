// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License");
// Please refer to the License for details. Do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// codex 流式 shell 卷回（adapter 单点）IT：exec_command 是流式终端协议（1 个
// exec + N 个 write_stdin 轮询块，session_id 关联、块间输出增量）。1:1 映射
// wire 形状的历史缺陷：技能正文恢复恒空（正文在轮询块）、Turns 展示全是传输
// 噪音、Perf 时长只算首块 yield。修复：适配器把流式会话卷回单一逻辑工具调用
// （完整输出/真实时长/末块终态），读侧零流式协议知识。数据形状取自客户现场
// 01a1c5d6（codex 0.167.0）。
import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import path from 'node:path';
import { prisma } from '../setup';
import { readSession } from '@/lib/ingest/adapters/codex-jsonl';
import { POST as importFilePOST } from '@/app/api/ingest/import-file/route';
import { GET as skillContentGET } from '@/lib/observe/session-handlers/skill-content';
import {
  codexStreamSessionIdOf,
  codexChunkExitCodeOf,
  writeStdinSessionIdOf,
  writeStdinCharsOf,
} from '@/lib/tool-conventions';

const DATA = path.join(__dirname, './data/codex-streaming');
const MAIN = '55555555-eeee-4b04-8f7e-abcdef000055';
const mainFile = path.join(DATA, `rollout-2026-11-10T22-22-21-${MAIN}.jsonl`);

function importReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/ingest/import-file', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
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

const RUNNING_CHUNK =
  'Chunk ID: bfa475\nWall time: 10.0018 seconds\nProcess running with session ID 70953\nOriginal token count: 0\nOutput:\n';
const EXITED_CHUNK =
  'Chunk ID: cac74b\nWall time: 6.7876 seconds\nProcess exited with code 0\nOriginal token count: 9164\nOutput:\nbody\n';

describe('codex 流式 shell wire 语义助手（tool-conventions 单点）', () => {
  it('codexStreamSessionIdOf：running 块取会话号；exited 单块（无会话号）→ null', () => {
    expect(codexStreamSessionIdOf(RUNNING_CHUNK)).toBe(70953);
    expect(codexStreamSessionIdOf(EXITED_CHUNK)).toBeNull();
    expect(codexStreamSessionIdOf('')).toBeNull();
  });

  it('codexChunkExitCodeOf：exited 块取退出码（含负值）；running 块 → null', () => {
    expect(codexChunkExitCodeOf(EXITED_CHUNK)).toBe(0);
    expect(codexChunkExitCodeOf(RUNNING_CHUNK)).toBeNull();
    expect(codexChunkExitCodeOf('Chunk ID: x\nWall time: 1s\nProcess exited with code 3\nOriginal token count: 0\nOutput:\n')).toBe(3);
  });

  it('writeStdinSessionIdOf / writeStdinCharsOf：参数解析，缺损/坏 JSON → null', () => {
    expect(writeStdinSessionIdOf('{"session_id": 70953, "chars": ""}')).toBe(70953);
    expect(writeStdinSessionIdOf('{"chars": ""}')).toBeNull();
    expect(writeStdinSessionIdOf('{"session_id": "70953"}')).toBeNull();
    expect(writeStdinSessionIdOf('{oops')).toBeNull();
    expect(writeStdinSessionIdOf(null)).toBeNull();
    expect(writeStdinCharsOf('{"session_id": 88888, "chars": "y\\n"}')).toBe('y\n');
    expect(writeStdinCharsOf('{"chars": ""}')).toBe('');
    expect(writeStdinCharsOf('{"session_id": 1}')).toBeNull();
    expect(writeStdinCharsOf(null)).toBeNull();
  });
});

describe('codex-jsonl 流式 shell 卷回（readSession 适配器单点）', () => {
  const toolCallsOf = () =>
    readSession(mainFile, MAIN).flatMap(ri => ri.tool_calls ?? []);

  it('exec_command 吸收全部轮询块：输出增量按到达序拼接、传输壳剥净', () => {
    const exec1 = toolCallsOf().find(tc => tc.toolCallId === 'call_exec1');
    expect(exec1).toBeTruthy();
    expect(exec1!.resultJson).not.toContain('Chunk ID:');
    expect(exec1!.resultJson).toContain('== day0 skill ==');
    expect(exec1!.resultJson).toContain('name: day0-inference');
    expect(exec1!.resultJson).toContain('Stage 1 Golden');
    // 增量顺序：轮询块 1 的 frontmatter 在前、轮询块 2 的正文在后
    expect(exec1!.resultJson!.indexOf('name: day0-inference')).toBeLessThan(
      exec1!.resultJson!.indexOf('Stage 1 Golden')
    );
    // 模型可见的终端截断标记保留在正文里（fullRead 降级的诚实信号）
    expect(exec1!.resultJson).toContain('Warning: truncated output');
    expect(exec1!.state).toBe('completed');
  });

  it('轮询块不再作为工具调用出现；孤儿 write_stdin（属主不在本文件）原样保留', () => {
    const stdin = toolCallsOf().filter(tc => tc.toolName === 'write_stdin');
    expect(stdin.map(tc => tc.toolCallId)).toEqual(['call_orphan']);
    expect(stdin[0].resultJson).toContain('^C');
  });

  it('真实时长：completedAt = 会话末块到达时刻（不再是首块 yield 时刻）', () => {
    const exec1 = toolCallsOf().find(tc => tc.toolCallId === 'call_exec1')!;
    expect(exec1.startedAt).toBe(Date.parse('2026-11-10T22:22:26.000Z'));
    expect(exec1.completedAt).toBe(Date.parse('2026-11-10T22:22:40.000Z'));
  });

  it('单块完结 exec 同样剥传输壳；非零退出 → state=error', () => {
    const tcs = toolCallsOf();
    const exec2 = tcs.find(tc => tc.toolCallId === 'call_exec2')!;
    expect(exec2.resultJson).toBe('README.md\nsrc\n');
    expect(exec2.state).toBe('completed');
    expect(tcs.find(tc => tc.toolCallId === 'call_exec3')!.state).toBe('error');
  });

  it('交互输入（write_stdin chars 非空）以 [stdin] 行留痕，信息不丢', () => {
    const exec4 = toolCallsOf().find(tc => tc.toolCallId === 'call_exec4')!;
    expect(exec4.resultJson).toContain("rm: remove regular file 'draft.txt'?");
    expect(exec4.resultJson).toContain('[stdin] y\n');
    expect(exec4.state).toBe('completed');
  });

  it('轮级卷回：纯传输轮并入属主轮成节拍，usage 字段分治（水位取末轮/消耗求和）', () => {
    const assistant = readSession(mainFile, MAIN).filter(ri => ri.role === 'assistant');
    // 5 个节拍轮：exec1(+poll1+poll2)、exec2、exec3、orphan、exec4(+input)
    // ——wire 的 8 个模型往返里 3 个是纯传输轮（write_stdin 轮询/交互输入）
    expect(assistant).toHaveLength(5);
    // exec1 节拍：水位取末次轮询读数（input=120）、消耗求和（output=50+20+15、
    // reasoning=10）、total 按恒等式重建（120+85+10）
    const beat1 = assistant.find(ri => ri.tool_calls?.some(tc => tc.toolCallId === 'call_exec1'));
    expect(beat1).toBeTruthy();
    expect(beat1!.usage).toMatchObject({ input: 120, output: 85, reasoning: 10, total: 215 });
    // 等待期延伸到末次轮询的 usage 时刻（不再是属主轮自己的冲刷时刻）
    expect(beat1!.timeInfo?.completed).toBeGreaterThan(beat1!.timeInfo!.created);
    // exec4 节拍吸收交互输入轮：output=10+5、水位取末轮
    const beat4 = assistant.find(ri => ri.tool_calls?.some(tc => tc.toolCallId === 'call_exec4'));
    expect(beat4!.usage).toMatchObject({ input: 60, output: 15, total: 75 });
    // 孤儿轮询轮（属主不在本文件）不参与合并：自带 write_stdin 工具行原样保留
    const orphan = assistant.find(ri => ri.tool_calls?.some(tc => tc.toolCallId === 'call_orphan'));
    expect(orphan).toBeTruthy();
    expect(orphan!.usage?.total).toBe(60);
  });
});

describe('codex 流式 shell 全链路：import 落库 → 技能原文恢复', () => {
  it('import-file 落库（工具面无传输轮询块/时长真实/技能事件在）→ skill-content 原文恢复', async () => {
    const res = await importFilePOST(importReq({ source: 'codex-jsonl', filePath: mainFile }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.imported).toBe(true);
    createdTaskIds.push(MAIN);

    const session = await prisma.session.findFirst({ where: { taskId: MAIN, framework: 'codex' } });
    expect(session).toBeTruthy();

    const toolCalls = await prisma.toolCall.findMany({ where: { turn: { sessionId: session!.id } } });
    // 逻辑工具面：4 个 exec + 1 个孤儿轮询块
    expect(toolCalls.map(tc => tc.toolCallId).sort()).toEqual(
      ['call_exec1', 'call_exec2', 'call_exec3', 'call_exec4', 'call_orphan'].sort()
    );
    const exec1 = toolCalls.find(tc => tc.toolCallId === 'call_exec1')!;
    expect(exec1.durationMs).toBe(14000);
    expect(exec1.state).toBe('completed');
    expect(exec1.isSkillRelated).toBe(true);
    expect(toolCalls.find(tc => tc.toolCallId === 'call_exec3')!.state).toBe('error');

    const events = await prisma.skillEvent.findMany({ where: { turn: { sessionId: session!.id } } });
    expect(events.some(e => e.skillName === 'day0-inference' && e.eventType === 'use')).toBe(true);

    // Skills 面板同路径：正文从卷回后的完整 exec 输出恢复
    const contentReq = new NextRequest(
      `http://localhost/api/observe/session/skill-content?taskId=${MAIN}&skillName=day0-inference`
    );
    const contentRes = await skillContentGET(contentReq);
    expect(contentRes.status).toBe(200);
    const body = await contentRes.json();
    expect(body.source).toBe('shell');
    expect(body.content).toContain('name: day0-inference');
    expect(body.content).toContain('Stage 1 Golden');
    // sed 行范围 + 终端截断标记 → 部分读取
    expect(body.fullRead).toBe(false);
  });
});

describe('codex 流式 shell 轮级卷回：交错双流 + 思考合并（节拍 = 动作 + 等待期）', () => {
  const INTERLEAVE = '66666666-ffff-4b04-8f7e-abcdef000066';
  const interleaveFile = path.join(DATA, `rollout-2026-11-10T23-00-00-${INTERLEAVE}.jsonl`);

  it('交错双流（execA → execB → pollA1 → pollB → pollA2）：轮按 session 关联合并而非位置相邻', () => {
    const assistant = readSession(interleaveFile, INTERLEAVE).filter(ri => ri.role === 'assistant');
    // 5 个 wire 模型往返 → 2 个节拍轮（A 吸收 pollA1/pollA2，B 吸收 pollB）
    expect(assistant).toHaveLength(2);
    const beatA = assistant.find(ri => ri.tool_calls?.some(tc => tc.toolCallId === 'call_execA'))!;
    const beatB = assistant.find(ri => ri.tool_calls?.some(tc => tc.toolCallId === 'call_execB'))!;
    expect(beatA).toBeTruthy();
    expect(beatB).toBeTruthy();
    // 工具面：各流增量拼到各自属主，末块退出码定终态（A 失败 → error，B 成功）
    expect(beatA.tool_calls![0].resultJson).toContain('A 中间输出');
    expect(beatA.tool_calls![0].resultJson).toContain('A 失败');
    expect(beatA.tool_calls![0].resultJson).not.toContain('B 完成');
    expect(beatA.tool_calls![0].state).toBe('error');
    expect(beatB.tool_calls![0].resultJson).toContain('B 完成');
    expect(beatB.tool_calls![0].state).toBe('completed');
  });

  it('思考按到达序并入属主轮（轮询期间的思考属于这个节拍）', () => {
    const assistant = readSession(interleaveFile, INTERLEAVE).filter(ri => ri.role === 'assistant');
    const beatA = assistant.find(ri => ri.tool_calls?.some(tc => tc.toolCallId === 'call_execA'))!;
    const beatB = assistant.find(ri => ri.tool_calls?.some(tc => tc.toolCallId === 'call_execB'))!;
    // 属主思考在前，轮询思考按到达序随后；跨流思考不得串台
    expect(beatA.content).toBe('<thinking>先启动 A</thinking>\n<thinking>A 怎么还没完</thinking>');
    expect(beatB.content).toBe('<thinking>再启动 B</thinking>\n<thinking>B 出结果了</thinking>');
  });

  it('usage 字段分治：水位族取本流末次轮询读数（与文件位置无关）、消耗族求和、total 恒等式重建', () => {
    const assistant = readSession(interleaveFile, INTERLEAVE).filter(ri => ri.role === 'assistant');
    const beatA = assistant.find(ri => ri.tool_calls?.some(tc => tc.toolCallId === 'call_execA'))!;
    const beatB = assistant.find(ri => ri.tool_calls?.some(tc => tc.toolCallId === 'call_execB'))!;
    // A 的末次轮询 pollA2 在文件里晚于 pollB 到达——水位取 190 而非位置相邻值；
    // pollA2 原始输入 290 = 新输入 190 + 缓存读 100，total 重建基数是原始输入
    // 水位（含缓存）——错用拆桶后新输入会得 270
    expect(beatA.usage).toMatchObject({ input: 190, cacheRead: 100, output: 50 + 15 + 5, reasoning: 10, total: 290 + 70 + 10 });
    expect(beatB.usage).toMatchObject({ input: 200, output: 40 + 10, reasoning: 0, total: 200 + 50 });
    // completed 延伸到本流末次轮询的冲刷时刻；latency 保持属主轮模型跨度（等待不双计）
    expect(beatA.timeInfo?.completed).toBe(new Date('2026-11-10T23:01:07.500Z').getTime());
    expect(beatA.latency).toBe(new Date('2026-11-10T23:00:15.500Z').getTime() - new Date('2026-11-10T23:00:04.000Z').getTime());
  });
});
