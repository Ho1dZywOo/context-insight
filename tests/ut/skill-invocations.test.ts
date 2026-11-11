// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// skill-invocations 模块单测：B 形技能加载信号（读文件即技能）的 wire 形状
// （真机核实）——产出 SkillInvocationInfo（关联真实工具调用），由 turn-split
// 单点转 SkillEvent，不再合成 skill/<name> 工具行。
//   read 类工具（claude-code Read / opencode read）：读 <skill-dir>/SKILL.md
//   shell 族（codex exec_command / opencode bash·shell / claude Bash）：读类
//     命令（cat/sed/head/tail/less/more/nl）读 <skill>/SKILL.md
// 排除面：非读类首 token（find/grep/ls）、重定向写入（cat > path）。
// 链式命令（echo '…'; cat …）按段独立判定——真机漏检现场：codex 主代理
// `echo '=== x ==='; cat …/SKILL.md` 首 token 是 echo，整段漏检。
import { describe, it, expect } from 'vitest';
import { detectSkillInvocations } from '../../src/lib/ingest/skill-invocations';
import type { ToolCallInfo } from '../../src/lib/shared/types';

function tc(toolName: string, args: unknown, toolCallId = 'call_1'): ToolCallInfo {
  return {
    toolCallId,
    toolName,
    argsJson: JSON.stringify(args),
    resultJson: null,
    state: 'completed',
  };
}

describe('detectSkillInvocations — read 类工具通道', () => {
  it('Read 读 SKILL.md → 关联源工具调用的技能信号', () => {
    const out = detectSkillInvocations([
      tc('Read', { file_path: '/home/u/.claude/skills/pdf-tools/SKILL.md' }, 'call_r1'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      skillName: 'pdf-tools',
      filePath: '/home/u/.claude/skills/pdf-tools/SKILL.md',
      sourceToolCallId: 'call_r1',
    });
  });

  it('Read 变体路径键（filePath/path）与小写 read（opencode）同样识别', () => {
    expect(detectSkillInvocations([tc('Read', { filePath: '/a/b/skill-x/SKILL.md' })])).toHaveLength(1);
    expect(detectSkillInvocations([tc('read', { path: '/a/b/skill-y/SKILL.md' })])).toHaveLength(1);
  });

  it('Read 非 SKILL.md 路径不认', () => {
    expect(detectSkillInvocations([
      tc('Read', { file_path: '/home/u/.claude/skills/pdf-tools/README.md' }),
      tc('Read', { file_path: '/a/SKILL.md.bak' }),
    ])).toHaveLength(0);
  });

  it('Read 无参/坏 JSON 不抛', () => {
    const bad: ToolCallInfo = { ...tc('Read', {}), argsJson: '{oops' };
    expect(detectSkillInvocations([bad])).toHaveLength(0);
  });
});

describe('detectSkillInvocations — shell 读类命令通道', () => {
  it('exec_command cat 读 SKILL.md（真机形态）→ 技能信号', () => {
    const out = detectSkillInvocations([
      tc('exec_command', {
        cmd: 'cat /home/duanbingzhe/.codex/skills/cannbay-report/SKILL.md',
        workdir: '/tmp/x',
        yield_time_ms: 10000,
      }, 'call_e1'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      skillName: 'cannbay-report',
      filePath: '/home/duanbingzhe/.codex/skills/cannbay-report/SKILL.md',
      sourceToolCallId: 'call_e1',
    });
  });

  it('shell 族工具名统一识别（bash/shell/exec/exec_command/Bash）', () => {
    for (const toolName of ['exec_command', 'bash', 'shell', 'exec', 'Bash']) {
      expect(
        detectSkillInvocations([tc(toolName, { cmd: 'cat /s/cannbay-report/SKILL.md' })]),
        toolName,
      ).toHaveLength(1);
      expect(
        detectSkillInvocations([tc(toolName, { command: 'cat /s/cannbay-report/SKILL.md' })]),
        toolName,
      ).toHaveLength(1);
    }
  });

  it('sed/head/tail/less/more/nl 读类命令均识别', () => {
    for (const cmd of [
      'sed -n 1,50p /s/cannbay-report/SKILL.md',
      'head -5 /s/cannbay-report/SKILL.md',
      'tail -20 /s/cannbay-report/SKILL.md',
      'less /s/cannbay-report/SKILL.md',
      'more /s/cannbay-report/SKILL.md',
      'nl /s/cannbay-report/SKILL.md',
    ]) {
      expect(detectSkillInvocations([tc('exec_command', { cmd })]), cmd).toHaveLength(1);
    }
  });

  it('链式命令分段判定：echo 前缀段不遮挡后面的 cat（真机漏检现场）', () => {
    for (const cmd of [
      "echo '======== cannbay-report/SKILL.md ========'; cat /home/duanbingzhe/.codex/skills/cannbay-report/SKILL.md",
      "printf '=== x ===\\n' && cat /s/cannbay-report/SKILL.md",
      "true || cat '/s/cannbay-report/SKILL.md'",
      "cat /s/cannbay-report/SKILL.md | head -100",
    ]) {
      expect(detectSkillInvocations([tc('exec_command', { cmd })]), cmd).toHaveLength(1);
    }
  });

  it('链式分段不切引号内的分隔符', () => {
    expect(detectSkillInvocations([
      tc('exec_command', { cmd: "echo 'a;b|c' > /tmp/o.txt; cat /s/cannbay-report/SKILL.md" }),
    ])).toHaveLength(1);
  });

  it('find/grep/ls 等非读类首 token 不认（真机：find 搜文件系统不是技能加载）', () => {
    for (const cmd of [
      'find / -iname SKILL.md 2>/dev/null | head -100',
      'grep -r cannbay /s/SKILL.md',
      'ls /s/cannbay-report/',
      'rm /s/cannbay-report/SKILL.md',
      'echo /s/cannbay-report/SKILL.md',
    ]) {
      expect(detectSkillInvocations([tc('exec_command', { cmd })]), cmd).toHaveLength(0);
    }
  });

  it('重定向写入（cat > path <<EOF）排除', () => {
    expect(detectSkillInvocations([
      tc('exec_command', { cmd: 'cat > /s/cannbay-report/SKILL.md <<EOF\nhello\nEOF' }),
    ])).toHaveLength(0);
  });

  it('cmd 数组形态（拼合后同规则）', () => {
    const out = detectSkillInvocations([
      tc('exec_command', { cmd: ['cat', '/s/cannbay-report/SKILL.md'] }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].skillName).toBe('cannbay-report');
  });

  it('一次调用读多个 SKILL.md → 多技能信号、同路径去重', () => {
    const out = detectSkillInvocations([
      tc('exec_command', { cmd: 'cat /s/a/SKILL.md /s/b/SKILL.md /s/a/SKILL.md' }, 'call_m'),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map(o => o.skillName)).toEqual(['a', 'b']);
    expect(out.every(o => o.sourceToolCallId === 'call_m')).toBe(true);
  });

  it('write_stdin（无 cmd/command 字段，真机形态）与其他工具不认', () => {
    expect(detectSkillInvocations([
      tc('write_stdin', { session_id: 57353, yield_time_ms: 30000, max_output_to_read: 8192 }),
      tc('apply_patch', { input: '*** Begin Patch\n' }),
    ])).toHaveLength(0);
  });

  it('引号包裹的路径剥离后识别', () => {
    const out = detectSkillInvocations([
      tc('exec_command', { cmd: 'cat "/s/cannbay-report/SKILL.md"' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].skillName).toBe('cannbay-report');
  });

  it('链式多段各带 SKILL.md → 每段各产出（echo 注入 cat 大杂烩真机形态）', () => {
    const cmd = "echo '=== a ==='; cat /s/a/SKILL.md; echo '=== b ==='; cat /s/b/SKILL.md";
    const out = detectSkillInvocations([tc('exec_command', { cmd })]);
    expect(out.map(o => o.skillName)).toEqual(['a', 'b']);
  });
});
