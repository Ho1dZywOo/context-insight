// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { describe, it, expect } from 'vitest';
import {
  summarizeToolCallErrors,
  classifyToolCallError,
  extractErrorEvidence,
  codexExecFailureOf,
  terminalErrorReasonOf,
  toolCallErrorKind,
  toolCallErrorMessage,
} from '../../src/lib/tool-call-errors.ts';

describe('classifyToolCallError: 中性分类学（持久层兜底单点）', () => {
  it('成功态无证据 → null（零误报锚点）', () => {
    expect(classifyToolCallError('completed', null)).toBeNull();
    expect(classifyToolCallError('ok', '')).toBeNull();
  });

  it('失败态无证据 → unknown（诚实兜底）', () => {
    expect(classifyToolCallError('error', null)).toBe('unknown');
  });

  it('退出码证据 → exec_failed（claude 与 codex 两种说法同桶）', () => {
    expect(classifyToolCallError('error', 'Command failed: Exit code 1\n...')).toBe('exec_failed');
    expect(classifyToolCallError('error', 'Process exited with code 3')).toBe('exec_failed');
    // ok 态结果带错（claude <tool_use_error> 历史语义）同样按证据升级
    expect(classifyToolCallError('completed', 'Command failed: Exit code 1\n...')).toBe('exec_failed');
  });

  it('codex 派生失败形态证据 → sandbox_rejected / bad_args', () => {
    expect(classifyToolCallError('error', 'sandbox rejected: rm -f style commands are not permitted')).toBe('sandbox_rejected');
    expect(classifyToolCallError('error', 'failed to parse function arguments: EOF while parsing a string at line 1 column 187')).toBe('bad_args');
  });

  it('shell 语法形态 → shell_syntax', () => {
    expect(classifyToolCallError('error', 'Command failed: Exit code 2\nSyntaxError: unexpected EOF while parsing')).toBe('shell_syntax');
    expect(classifyToolCallError('error', 'bash: foo: command not found')).toBe('shell_syntax');
  });

  it('标记细化桶保留：timeout / permission / format / server_error', () => {
    expect(classifyToolCallError('error', 'Request timed out after 30000ms')).toBe('timeout');
    expect(classifyToolCallError('error', 'Permission denied: /root/.ssh')).toBe('permission');
    expect(classifyToolCallError('error', 'Invalid format: expected JSON')).toBe('format');
    expect(classifyToolCallError('error', 'HTTP 503 Service Unavailable')).toBe('server_error');
  });

  it('ok 态证据无桶匹配 → tool_error（历史语义保留）', () => {
    expect(classifyToolCallError('ok', 'File not found: /src/missing.ts')).toBe('tool_error');
  });

  it('失败态证据无桶匹配 → exec_failed（兜底由 server_error 改判的口径变化锁）', () => {
    // 现场对账：112/112 失败里 server_error 语义错位（多为命令失败退出）
    expect(classifyToolCallError('error', 'some opaque failure text')).toBe('exec_failed');
  });

  it('退出码优先于 server 标记：Exit code 502 是命令退出，不是网关错', () => {
    expect(classifyToolCallError('error', 'Process exited with code 502')).toBe('exec_failed');
  });
});

describe('extractErrorEvidence: 跨框架失败证据提取', () => {
  it('claude 壳：<tool_use_error> 原文 / Exit code 加 Command failed 前缀', () => {
    expect(extractErrorEvidence('<tool_use_error>File not found</tool_use_error>')).toContain('<tool_use_error>');
    expect(extractErrorEvidence('Exit code 1\nboom')).toContain('Command failed: Exit code 1');
  });

  it('codex 派生失败形态：starts-with 精确匹配，理由提取', () => {
    expect(extractErrorEvidence('failed to parse function arguments: EOF while parsing a string at line 1 column 187')).toContain('failed to parse function arguments');
    const ev = extractErrorEvidence('exec_command failed: CreateProcess { message: "Rejected(\\"...rejected: rm -f style commands are not permitted. Use a safer approach\\")" }');
    expect(ev).toContain('rm -f style commands are not permitted');
  });

  it('无证据 → null，不编造', () => {
    expect(extractErrorEvidence(null)).toBeNull();
    expect(extractErrorEvidence('')).toBeNull();
    expect(extractErrorEvidence('OK\nREADME.md')).toBeNull();
  });

  it('证据截断 ≤ 200 字符', () => {
    const ev = extractErrorEvidence(`<tool_use_error>${'x'.repeat(500)}</tool_use_error>`)!;
    expect(ev.length).toBeLessThanOrEqual(201);
  });
});

describe('codexExecFailureOf: 卷回失败语义解析（形态 → 桶映射单点）', () => {
  it('派生拒绝 → sandbox_rejected；参数畸形 → bad_args', () => {
    const rejected = codexExecFailureOf('exec_command failed: CreateProcess { message: "Rejected(\\"...rejected: rm -f style commands are not permitted\\")" }', null);
    expect(rejected).toEqual({ kind: 'sandbox_rejected', evidence: expect.stringContaining('not permitted') });
    const badArgs = codexExecFailureOf('failed to parse function arguments: EOF while parsing a string', null);
    expect(badArgs?.kind).toBe('bad_args');
  });

  it('非零退出 → exec_failed + 退出码证据（无原因可提取时退回纯退出码）；零退出/无形态 → null', () => {
    expect(codexExecFailureOf('Chunk ID: x\n...\nOutput:\ndone\n', 1))
      .toEqual({ kind: 'exec_failed', evidence: 'Process exited with code 1' });
    expect(codexExecFailureOf('Chunk ID: x\n...\nOutput:\nmake: *** [all] Error 2\n', 2, 'make: *** [all] Error 2'))
      .toEqual({ kind: 'exec_failed', evidence: 'Process exited with code 2: make: *** [all] Error 2' });
    expect(codexExecFailureOf('Chunk ID: x\n...\nOutput:\ndone\n', 0)).toBeNull();
    expect(codexExecFailureOf('plain output', null)).toBeNull();
  });
});

describe('terminalErrorReasonOf: 终端错误原因行提取（尾部扫描 + 保守词表）', () => {
  it('构建/测试/运行时形态：make / npm / Traceback 末行异常 / FAILED / fatal / command not found', () => {
    expect(terminalErrorReasonOf('cc -c main.c\nmake: *** [Makefile:20: all] Error 2')).toBe('make: *** [Makefile:20: all] Error 2');
    expect(terminalErrorReasonOf('npm ERR! code ELIFECYCLE')).toBe('npm ERR! code ELIFECYCLE');
    expect(terminalErrorReasonOf('Traceback (most recent call last):\n  File "a.py", line 1\nValueError: invalid literal')).toBe('ValueError: invalid literal');
    expect(terminalErrorReasonOf('ok\nFAILED tests/x.test.ts::test_y - assert 1 == 2')).toBe('FAILED tests/x.test.ts::test_y - assert 1 == 2');
    expect(terminalErrorReasonOf('fatal: not a git repository')).toBe('fatal: not a git repository');
    expect(terminalErrorReasonOf('sh: 1: foo: command not found')).toBe('sh: 1: foo: command not found');
  });

  it('现场审计漏网形态：行中 FAIL / shell 经典错误行 / 探针 status JSON / 中断 / 中文错误行', () => {
    expect(terminalErrorReasonOf('合规 8 项\n合计 8 项：PASS 7 / FAIL 1 / UNKNOWN 0')).toBe('合计 8 项：PASS 7 / FAIL 1 / UNKNOWN 0');
    expect(terminalErrorReasonOf('cat tracker.md\ngrep: /path/x.md: No such file or directory')).toBe('grep: /path/x.md: No such file or directory');
    expect(terminalErrorReasonOf('/bin/bash: line 1: run.py: Permission denied')).toBe('/bin/bash: line 1: run.py: Permission denied');
    expect(terminalErrorReasonOf('{"status": "UNKNOWN", "reason": "NO_FREE_DEVICES", "detail": "available=0 required=1"}')).toBe('{"status": "UNKNOWN", "reason": "NO_FREE_DEVICES", "detail": "available=0 required=1"}');
    expect(terminalErrorReasonOf('运行 16.0s\naborted by user after 16.0s')).toBe('aborted by user after 16.0s');
    expect(terminalErrorReasonOf('检查完成\n校验失败：契约字段缺失')).toBe('校验失败：契约字段缺失');
    // could not / cannot（无 error 关键词的 MCP 加载失败）
    expect(terminalErrorReasonOf('启动中\ncodebase-memory-mcp: could not load saved runtime settings')).toBe('codebase-memory-mcp: could not load saved runtime settings');
    // 中文 usage 错误（argparse 风格 exit 2）
    expect(terminalErrorReasonOf('写入模式必须给 --step / --set-env / --append-ledger 之一（只读稽核用 --check）')).toBe('写入模式必须给 --step / --set-env / --append-ledger 之一（只读稽核用 --check）');
    // AVAILABLE/RELEASED 状态不误伤（成功探针回显）
    expect(terminalErrorReasonOf('{"status": "RELEASED", "checks": {"leader": "GONE"}}\nRELEASED')).toBeNull();
    // 中文否定行排除
    expect(terminalErrorReasonOf('检查通过：无错误')).toBeNull();
    // 计数清零总结行不是原因（FAIL 0 = 通过态，现场曾误提取）
    expect(terminalErrorReasonOf('探针跑完\n图谱健康探针：OK（8 项检查，FAIL 0 / UNKNOWN 0 / WARN 0）')).toBeNull();
    expect(terminalErrorReasonOf('pytest summary\n0 failed, 10 passed')).toBeNull();
  });

  it('干净输出 / 否定行 → null（宁缺毋假，不编造）', () => {
    expect(terminalErrorReasonOf('README.md\nsrc\n')).toBeNull();
    expect(terminalErrorReasonOf('all checks passed: no errors found')).toBeNull();
    expect(terminalErrorReasonOf('')).toBeNull();
    expect(terminalErrorReasonOf(null)).toBeNull();
  });

  it('尾部窗口：只扫末 4KB（18MB 级输出不整段扫），远离尾部的历史错误行不捞取', () => {
    const big = `${'x'.repeat(3000)}\nerror: old failure in history\n${'y'.repeat(6000)}`;
    expect(terminalErrorReasonOf(big)).toBeNull();
    const tailHit = `${'x'.repeat(5000)}\nmake: *** [all] Error 1`;
    expect(terminalErrorReasonOf(tailHit)).toBe('make: *** [all] Error 1');
  });

  it('超长原因行截断 ≤ 120 字符', () => {
    const reason = terminalErrorReasonOf(`fatal: ${'z'.repeat(300)}`);
    expect(reason!.length).toBeLessThanOrEqual(121);
  });
});

describe('toolCallErrorKind: 退出码证据精判（头部 + 非零定性）', () => {
  it('头部非零退出码 → failed（claude Bash / cpx 捕获壳形态，含带冒号变体）', () => {
    expect(toolCallErrorKind({ state: 'completed', errorType: null, resultJson: 'Exit code 1\nboom' })).toBe('failed');
    expect(toolCallErrorKind({ state: 'completed', errorType: null, resultJson: 'Exit code: 143\nWall time: 3 seconds\nOutput:\nkilled' })).toBe('failed');
  });

  it('Exit code: 0 是成功回显 → null，并撤销旧词表毒化的 errorType（存量 89 行修复）', () => {
    expect(toolCallErrorKind({ state: 'completed', errorType: null, resultJson: 'Exit code: 0\nOutput:\nSuccess. Updated the following file' })).toBeNull();
    expect(toolCallErrorKind({ state: 'completed', errorType: 'tool_error', resultJson: 'Exit code: 0\nOutput:\nSuccess' })).toBeNull();
    // 命令自打的 EXIT CODE 大写横幅（Prisma LIKE 大小写不敏感会混进超集）不误判
    expect(toolCallErrorKind({ state: 'completed', errorType: null, resultJson: 'EXIT CODE: 1\nSTATUS: PASS' })).toBeNull();
  });

  it('正文引用不误伤：mid-text 的 Exit code 字样不算证据（现场 167 行误伤修复）', () => {
    expect(toolCallErrorKind({ state: 'completed', errorType: null, resultJson: '576-        if reason != "AVAILABLE":\n577-            print("Exit code mismatch")' })).toBeNull();
  });

  it('线缆 isError 优先于文本：state=error 不被 exit 0 头部撤销', () => {
    expect(toolCallErrorKind({ state: 'error', errorType: null, resultJson: 'Exit code: 0\nimpossible?' })).toBe('failed');
  });
});

describe('toolCallErrorKind: codex 形态兼容（存量行 state 仍 completed）', () => {
  it('派生失败原文在 resultJson → failed（修复前导入的 10 条漏报行认回）', () => {
    expect(toolCallErrorKind({ state: 'completed', errorType: null, resultJson: 'exec_command failed: CreateProcess { message: "Rejected(\\"...\\")" }' })).toBe('failed');
    expect(toolCallErrorKind({ state: 'completed', errorType: null, resultJson: 'failed to parse function arguments: EOF while parsing a string' })).toBe('failed');
  });
});

describe('toolCallErrorMessage: 消息提取（持久化 errorMessage 优先）', () => {
  it('持久化退出码证据精炼为 exit N', () => {
    expect(toolCallErrorMessage({ errorMessage: 'Process exited with code 1', resultJson: 'stripped terminal text' })).toBe('exit 1');
    expect(toolCallErrorMessage({ errorMessage: 'Command failed: Exit code 3\n...', resultJson: null })).toBe('exit 3');
  });

  it('resultJson 里的 codex 失败原文（存量行）→ 理由/首行', () => {
    expect(toolCallErrorMessage({ resultJson: 'exec_command failed: CreateProcess { message: "Rejected(\\"...rejected: rm -f style commands are not permitted\\")" }' })).toContain('not permitted');
    expect(toolCallErrorMessage({ resultJson: 'failed to parse function arguments: EOF while parsing a string' })).toContain('failed to parse function arguments');
  });

  it('claude 壳与无证据行为不回归；退出码证据附原因行', () => {
    expect(toolCallErrorMessage({ resultJson: '<tool_use_error>File not found</tool_use_error>' })).toBe('File not found');
    expect(toolCallErrorMessage({ resultJson: 'Exit code 1\nboom' })).toBe('exit 1');
    expect(toolCallErrorMessage({ resultJson: 'Exit code: 2\nmake: *** [all] Error 2' })).toBe('exit 2: make: *** [all] Error 2');
    expect(toolCallErrorMessage({ resultJson: 'Exit code: 0\nSuccess' })).toBe('');
    expect(toolCallErrorMessage({ resultJson: 'OK' })).toBe('');
    expect(toolCallErrorMessage({ errorMessage: 'sandbox rejected: rm -f not permitted', resultJson: null })).toContain('not permitted');
    // 持久化证据（错误语义通道）里的原因行透出到 digest 速览
    expect(toolCallErrorMessage({ errorMessage: 'Process exited with code 1: FAIL src/lib/legacy.test.ts', resultJson: '' })).toBe('exit 1: FAIL src/lib/legacy.test.ts');
  });

  it('extractErrorEvidence：头部非零退出 + 可提取原因 → 蒸馏证据（退出码 + 原因）', () => {
    expect(extractErrorEvidence('Exit code 2\nmake: *** [all] Error 2')).toBe('Command failed: Exit code 2: make: *** [all] Error 2');
    // 无原因可提取 → 保留原文截断老口径
    expect(extractErrorEvidence('Exit code 1\nboom')).toContain('Command failed: Exit code 1');
  });
});

describe('tool-call-errors: summarizeToolCallErrors', () => {
  describe('cancelled detection', () => {
    it('detects <tool_use_error>Cancelled from resultJson', () => {
      const result = summarizeToolCallErrors([
        { toolName: 'Bash', resultJson: '<tool_use_error>Cancelled: parallel tool call Bash errored</tool_use_error>', state: 'completed', errorType: null, errorMessage: null },
      ])
      expect(result.cancelled).toBe(1)
      expect(result.total).toBe(1)
      expect(result.details[0].type).toBe('cancelled')
    })

    it('detects multiple cancelled calls', () => {
      const result = summarizeToolCallErrors([
        { toolName: 'Bash', resultJson: '<tool_use_error>Cancelled: parallel tool call Bash(SPEC…) errored</tool_use_error>', state: 'completed', errorType: null, errorMessage: null },
        { toolName: 'Read', resultJson: '<tool_use_error>Cancelled: parallel tool call Bash(SPEC…) errored</tool_use_error>', state: 'completed', errorType: null, errorMessage: null },
      ])
      expect(result.cancelled).toBe(2)
      expect(result.total).toBe(2)
    })
  })

  describe('failed detection', () => {
    it('detects Exit code from resultJson', () => {
      const result = summarizeToolCallErrors([
        { toolName: 'Bash', resultJson: 'Exit code 1\nTraceback (most recent call last):', state: 'completed', errorType: null, errorMessage: null },
      ])
      expect(result.failed).toBe(1)
      expect(result.total).toBe(1)
      expect(result.details[0].type).toBe('failed')
    })

    it('detects error state', () => {
      const result = summarizeToolCallErrors([
        { toolName: 'Bash', resultJson: null, state: 'error', errorType: null, errorMessage: null },
      ])
      expect(result.failed).toBe(1)
    })

    it('detects failed state', () => {
      const result = summarizeToolCallErrors([
        { toolName: 'Bash', resultJson: null, state: 'failed', errorType: null, errorMessage: null },
      ])
      expect(result.failed).toBe(1)
    })

    it('detects errorType field', () => {
      const result = summarizeToolCallErrors([
        { toolName: 'Bash', resultJson: null, state: 'completed', errorType: 'permission', errorMessage: 'Permission denied' },
      ])
      expect(result.failed).toBe(1)
    })
  })

  describe('truncation detection', () => {
    it('detects max_tokens and length finish reasons', () => {
      const maxTokens = summarizeToolCallErrors([], [], 'max_tokens')
      expect(maxTokens.truncated).toBe(1)
      expect(maxTokens.total).toBe(1)
      expect(maxTokens.details[0]).toEqual({ toolName: 'stop_reason=max_tokens', type: 'truncated' })

      const length = summarizeToolCallErrors([], [], 'length')
      expect(length.truncated).toBe(1)
      expect(length.total).toBe(1)
    })

    it('ignores normal finish reasons', () => {
      const result = summarizeToolCallErrors([], [], 'end_turn')
      expect(result.truncated).toBe(0)
      expect(result.total).toBe(0)
    })
  })

  describe('skill fail detection', () => {
    it('detects SkillEvent success=false with errorMessage', () => {
      const result = summarizeToolCallErrors([], [
        { skillName: 'ops-registry-invoke-workflow', eventType: 'invoke', success: false, errorMessage: 'Skill load failed' },
      ])
      expect(result.skillFail).toBe(1)
      expect(result.total).toBe(1)
      expect(result.details[0].type).toBe('skill_fail')
    })

    it('ignores SkillEvent success=true', () => {
      const result = summarizeToolCallErrors([], [
        { skillName: 'ops-registry-invoke-workflow', eventType: 'invoke', success: true, errorMessage: null },
      ])
      expect(result.skillFail).toBe(0)
      expect(result.total).toBe(0)
    })
  })

  describe('mixed errors', () => {
    it('counts all error types together', () => {
      const result = summarizeToolCallErrors([
        { toolName: 'Bash', resultJson: 'Exit code 1\nPermissionError', state: 'completed', errorType: null, errorMessage: null },
        { toolName: 'Bash', resultJson: '<tool_use_error>Cancelled: parallel tool call Bash errored</tool_use_error>', state: 'completed', errorType: null, errorMessage: null },
        { toolName: 'Read', resultJson: '<tool_use_error>Cancelled: parallel tool call Bash errored</tool_use_error>', state: 'completed', errorType: null, errorMessage: null },
      ], [
        { skillName: 'my-skill', eventType: 'invoke', success: false, errorMessage: 'failed' },
      ])
      expect(result.failed).toBe(1)
      expect(result.cancelled).toBe(2)
      expect(result.skillFail).toBe(1)
      expect(result.total).toBe(4)
    })

    it('returns 0 for no errors', () => {
      const result = summarizeToolCallErrors([
        { toolName: 'Bash', resultJson: 'OK', state: 'completed', errorType: null, errorMessage: null },
      ])
      expect(result.total).toBe(0)
      expect(result.cancelled).toBe(0)
      expect(result.failed).toBe(0)
      expect(result.skillFail).toBe(0)
    })
  })
})
