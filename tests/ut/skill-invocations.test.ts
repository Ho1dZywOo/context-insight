// skill-invocations 模块单测：技能加载信号的双 wire 形状（真机核实）——
//   claude-code：Read 工具读 <skill-dir>/SKILL.md（协议主通道）
//   codex：exec_command 读类命令（cat/sed/head/tail/less/more/nl）读
//     <skill>/SKILL.md（skills_instructions 协议让模型自行读文件，codex
//     0.162 工具面无 Read，真机实测读法 = exec_command {"cmd":"cat ..."}）
// 排除面：非读类首 token（find/grep/ls）、重定向写入（cat > path）、Bash
// 工具（claude-code 技能加载主通道是 Read，shell cat 只是普通查看）。
import { describe, it, expect } from 'vitest';
import { detectSkillInvocations } from '../../src/lib/ingest/adapters/skill-invocations';
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

describe('detectSkillInvocations — claude-code Read 通道', () => {
  it('Read 读 SKILL.md → skill/<父目录名>', () => {
    const out = detectSkillInvocations([
      tc('Read', { file_path: '/home/u/.claude/skills/pdf-tools/SKILL.md' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].toolName).toBe('skill/pdf-tools');
    expect(out[0].toolCallId).toBe('skill-call_1');
    expect(JSON.parse(out[0].argsJson!)).toEqual({
      skill: 'pdf-tools',
      file_path: '/home/u/.claude/skills/pdf-tools/SKILL.md',
    });
  });

  it('Read 变体路径键（filePath/path）同样识别', () => {
    expect(detectSkillInvocations([tc('Read', { filePath: '/a/b/skill-x/SKILL.md' })])).toHaveLength(1);
    expect(detectSkillInvocations([tc('Read', { path: '/a/b/skill-y/SKILL.md' })])).toHaveLength(1);
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

  it('Bash cat SKILL.md 不认（claude-code 主通道是 Read，避免双计/误报）', () => {
    expect(detectSkillInvocations([
      tc('Bash', { command: 'cat /home/u/.claude/skills/pdf-tools/SKILL.md' }),
    ])).toHaveLength(0);
  });
});

describe('detectSkillInvocations — codex exec_command 通道', () => {
  it('cat 读 SKILL.md（真机形态）→ skill/<名>', () => {
    const out = detectSkillInvocations([
      tc('exec_command', {
        cmd: 'cat /home/duanbingzhe/.codex/skills/cannbay-report/SKILL.md',
        workdir: '/tmp/x',
        yield_time_ms: 10000,
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].toolName).toBe('skill/cannbay-report');
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
    expect(out[0].toolName).toBe('skill/cannbay-report');
  });

  it('一次调用读多个 SKILL.md → 多技能、序号消歧、同路径去重', () => {
    const out = detectSkillInvocations([
      tc('exec_command', { cmd: 'cat /s/a/SKILL.md /s/b/SKILL.md /s/a/SKILL.md' }),
    ]);
    expect(out.map(o => o.toolName)).toEqual(['skill/a', 'skill/b']);
    expect(out[0].toolCallId).toBe('skill-call_1');
    expect(out[1].toolCallId).toBe('skill-call_1-2');
  });

  it('write_stdin（无 cmd 字段，真机形态）与其他工具不认', () => {
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
    expect(out[0].toolName).toBe('skill/cannbay-report');
  });
});
