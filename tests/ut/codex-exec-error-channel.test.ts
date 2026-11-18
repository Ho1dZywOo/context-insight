// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may not use this file except in compliance with the License.
// A copy of the License is located in the "LICENSE" file at the root of the source tree.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
// EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY,
// OR FITNESS FOR A PARTICULAR PURPOSE. See the License for the full text of the License.

// codex 错误通道（适配器解析 → 语义通道 → 持久化 → 读侧判定）全链路 IT。
// 事故（01a1e584 会话全量对账诊断）：codex exec_command 的失败证据全部活在
// 传输壳层——退出码在壳头 `Process exited with code N`、派生失败形态占整个
// output（`exec_command failed: CreateProcess Rejected(...)`、
// `failed to parse function arguments`）。卷回只写 state、证据随剥壳丢弃 →
// classifyError 词表只认 claude/bash 壳 → errorType 恒 unknown（112 条真失败）
// 且无退出码的派生失败被误标 completed（10 条漏报）。
// 修复后的架构（错误通道三段式）：形态识别（tool-conventions）→ 分类学映射
// （tool-call-errors 单点）在卷回处剥壳前解析成最终 state/errorType/errorMessage，
// 经 ToolCallInfo 语义通道由 turn-split passthrough-first 持久化。本用例锁
// 四类失败形态 + 成功不回归（零误报）+ 读侧存量行兼容。
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { readSession } from '@/lib/ingest/adapters/codex-jsonl';
import { splitIntoTurns, resetIdCounter } from '../../src/lib/ingest/turn-split.ts';
import { toolCallErrorKind, toolCallErrorMessage } from '@/lib/tool-call-errors';

const DATA = path.join(__dirname, './data/codex-exec-error');
const SID = '77777777-aaaa-4b04-8f7e-abcdef000077';
const mainFile = path.join(DATA, `rollout-2026-11-11T08-30-00-${SID}.jsonl`);

const adapterToolCalls = () => readSession(mainFile, SID).flatMap(ri => ri.tool_calls ?? []);

describe('codex 错误通道：适配器卷回解析（剥壳前定语义）', () => {
  it('流式 exec 末块非零退出 → error/exec_failed，证据透传退出码 + 终端错误原因行（此前 unknown）', () => {
    const exec = adapterToolCalls().find(tc => tc.toolCallId === 'call_exec_a');
    expect(exec).toBeTruthy();
    expect(exec!.state).toBe('error');
    expect(exec!.errorType).toBe('exec_failed');
    // 退出码只说失败不说为何：错误原因行（尾部扫描）附加到证据
    expect(exec!.errorMessage).toBe('Process exited with code 1: FAIL src/lib/legacy.test.ts');
    // 壳剥净、终端原文保留（卷回行为不回归）
    expect(exec!.resultJson).not.toContain('Chunk ID:');
    expect(exec!.resultJson).toContain('FAIL src/lib/legacy.test.ts');
  });

  it('流式 exec 零退出 → completed、无错误语义（零误报锚点）', () => {
    const exec = adapterToolCalls().find(tc => tc.toolCallId === 'call_exec_b');
    expect(exec).toBeTruthy();
    expect(exec!.state).toBe('completed');
    expect(exec!.errorType ?? null).toBeNull();
    expect(exec!.errorMessage ?? null).toBeNull();
    expect(exec!.resultJson).toContain('tmp-a.log');
  });

  it('单块直败非零退出 → error/exec_failed + 退出码证据', () => {
    const exec = adapterToolCalls().find(tc => tc.toolCallId === 'call_exec_c');
    expect(exec).toBeTruthy();
    expect(exec!.state).toBe('error');
    expect(exec!.errorType).toBe('exec_failed');
    expect(exec!.errorMessage).toBe('Process exited with code 3');
  });

  it('派生拒绝（CreateProcess Rejected）→ error/sandbox_rejected，拒绝理由入证据（此前漏报为 completed）', () => {
    const exec = adapterToolCalls().find(tc => tc.toolCallId === 'call_exec_d');
    expect(exec).toBeTruthy();
    expect(exec!.state).toBe('error');
    expect(exec!.errorType).toBe('sandbox_rejected');
    expect(exec!.errorMessage).toContain('rm -f style commands are not permitted');
    // 失败原文（非 chunk 壳形态）不剥、证据留痕
    expect(exec!.resultJson).toContain('exec_command failed:');
  });

  it('参数畸形（failed to parse function arguments）→ error/bad_args（此前漏报为 completed）', () => {
    const exec = adapterToolCalls().find(tc => tc.toolCallId === 'call_exec_e');
    expect(exec).toBeTruthy();
    expect(exec!.state).toBe('error');
    expect(exec!.errorType).toBe('bad_args');
    expect(exec!.errorMessage).toContain('failed to parse function arguments');
    expect(exec!.errorMessage).toContain('EOF while parsing a string');
  });

  it('轮询块吸收不回归：无 write_stdin 残留工具调用', () => {
    const stdin = adapterToolCalls().filter(tc => tc.toolName === 'write_stdin');
    expect(stdin).toHaveLength(0);
  });
});

describe('codex 错误通道：turn-split passthrough-first 持久化', () => {
  let toolCalls: ReturnType<typeof splitIntoTurns>['toolCalls'];

  beforeAll(() => {
    resetIdCounter();
    const interactions = readSession(mainFile, SID);
    toolCalls = splitIntoTurns(interactions, 'session-codex-exec-error-test').toolCalls;
  });

  const rowOf = (id: string) => {
    const row = toolCalls.find(tc => tc.toolCallId === id);
    expect(row).toBeTruthy();
    return row!;
  };

  it('适配器语义原样落库：五类行的 state/errorType/errorMessage', () => {
    expect(rowOf('call_exec_a')).toMatchObject({
      state: 'error', errorType: 'exec_failed', errorMessage: 'Process exited with code 1: FAIL src/lib/legacy.test.ts',
    });
    expect(rowOf('call_exec_b')).toMatchObject({
      state: 'completed', errorType: null, errorMessage: null,
    });
    expect(rowOf('call_exec_c')).toMatchObject({
      state: 'error', errorType: 'exec_failed', errorMessage: 'Process exited with code 3',
    });
    expect(rowOf('call_exec_d').errorType).toBe('sandbox_rejected');
    expect(rowOf('call_exec_e').errorType).toBe('bad_args');
  });

  it('读侧判定：四类失败行 kind=failed，成功行 kind=null（零误报）', () => {
    const rows = ['call_exec_a', 'call_exec_b', 'call_exec_c', 'call_exec_d', 'call_exec_e']
      .map(rowOf);
    const kinds = rows.map(tc => toolCallErrorKind(tc));
    expect(kinds[0]).toBe('failed');
    expect(kinds[1]).toBeNull();
    expect(kinds[2]).toBe('failed');
    expect(kinds[3]).toBe('failed');
    expect(kinds[4]).toBe('failed');
  });

  it('读侧消息：持久化 errorMessage 优先做退出码 + 原因行精炼', () => {
    expect(toolCallErrorMessage(rowOf('call_exec_a'))).toBe('exit 1: FAIL src/lib/legacy.test.ts');
    // 无原因可提取（空输出）→ 纯退出码
    expect(toolCallErrorMessage(rowOf('call_exec_c'))).toBe('exit 3');
    expect(toolCallErrorMessage(rowOf('call_exec_d'))).toContain('not permitted');
    expect(toolCallErrorMessage(rowOf('call_exec_e'))).toContain('failed to parse function arguments');
    expect(toolCallErrorMessage(rowOf('call_exec_b'))).toBe('');
  });

  it('存量行兼容（修复前导入的行 state 仍 completed）：resultJson 里的 codex 失败原文可判 failed', () => {
    // 修复前的 DB 行形态：state=completed、errorType/errorMessage 均空、
    // 失败原文留在 resultJson——读侧 kind/消息仍能认出（TOOL_CALL_ERROR_QUERY_OR
    // 的 contains 分支同款词表，本用例锁行级判定口径）
    expect(toolCallErrorKind({
      state: 'completed',
      errorType: null,
      resultJson: 'exec_command failed: CreateProcess { message: "Rejected(\\"… rm -f style commands are not permitted\\")" }',
    })).toBe('failed');
    expect(toolCallErrorKind({
      state: 'completed',
      errorType: null,
      resultJson: 'failed to parse function arguments: EOF while parsing a string at line 1 column 187',
    })).toBe('failed');
  });
});
