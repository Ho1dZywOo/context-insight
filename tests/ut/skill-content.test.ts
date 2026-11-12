// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { describe, it, expect } from 'vitest';
import {
  extractSkillNameFromReadPath,
  stripSkillPreamble,
  selectSkillContent,
  skillMdReadsOfToolCall,
  type SkillToolCall,
} from '../../src/lib/skill-content.ts';

const t = (n: number) => new Date(n);

describe('skillMdReadsOfToolCall（三通道单点分类器）', () => {
  it('shell 通道：剥 codex 终端元数据壳 + 模型自印横幅 → SKILL.md 原文', () => {
    const tc: SkillToolCall = {
      toolName: 'exec_command',
      argsJson: JSON.stringify({ cmd: "echo '======== cannbay-report/SKILL.md ========'; cat /home/u/.codex/skills/cannbay-report/SKILL.md" }),
      resultJson: 'Chunk ID: 9014f0\nWall time: 0.0000 seconds\nProcess exited with code 0\nOriginal token count: 410\nOutput:\n======== cannbay-report/SKILL.md ========\n---\nname: "cannbay-report"\n---\n\n# 规范\n',
      startedAt: t(1),
    };
    const reads = skillMdReadsOfToolCall(tc);
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ skillName: 'cannbay-report', source: 'shell', fullRead: true });
    expect(reads[0].content.startsWith('---\nname: "cannbay-report"')).toBe(true);
    expect(reads[0].content).not.toContain('Chunk ID');
    expect(reads[0].content).not.toContain('========');
  });

  it('shell 通道：head/tail/sed 行范围截断 → fullRead=false', () => {
    const tc: SkillToolCall = {
      toolName: 'exec_command',
      argsJson: JSON.stringify({ cmd: 'head -n 5 /a/foo/SKILL.md' }),
      resultJson: 'Output:\n# Foo\nbody',
      startedAt: t(1),
    };
    expect(skillMdReadsOfToolCall(tc)[0].fullRead).toBe(false);
  });

  it('shell 通道：一条命令读多个 SKILL.md → 逐技能产出', () => {
    const tc: SkillToolCall = {
      toolName: 'bash',
      argsJson: JSON.stringify({ cmd: 'cat /a/foo/SKILL.md /b/bar/SKILL.md' }),
      resultJson: 'OUT',
      startedAt: t(1),
    };
    const reads = skillMdReadsOfToolCall(tc);
    expect(reads.map(r => r.skillName)).toEqual(['foo', 'bar']);
  });

  it('非读类 shell 命令（grep/ls/find）→ 空数组', () => {
    const tc: SkillToolCall = {
      toolName: 'exec_command',
      argsJson: JSON.stringify({ cmd: 'grep -r foo /a' }),
      resultJson: 'OUT',
      startedAt: t(1),
    };
    expect(skillMdReadsOfToolCall(tc)).toEqual([]);
  });

  it('skill-tool / read 通道：单条产出；无关工具 → 空数组', () => {
    const skill: SkillToolCall = {
      toolName: 'skill',
      argsJson: '{"name":"foo"}',
      resultJson: '<skill_content name="foo">BODY</skill_content>',
      startedAt: t(1),
    };
    expect(skillMdReadsOfToolCall(skill)).toEqual([
      { skillName: 'foo', source: 'skill-tool', content: 'BODY', fullRead: true, maxLine: null },
    ]);
    const read: SkillToolCall = {
      toolName: 'read',
      argsJson: '{"file_path":"/a/foo/SKILL.md"}',
      resultJson: '<content>\n1: # Foo\n</content>',
      startedAt: t(1),
    };
    expect(skillMdReadsOfToolCall(read).map(r => r.skillName)).toEqual(['foo']);
    const other: SkillToolCall = {
      toolName: 'write',
      argsJson: '{"file_path":"/a/foo/SKILL.md"}',
      resultJson: null,
      startedAt: t(1),
    };
    expect(skillMdReadsOfToolCall(other)).toEqual([]);
  });
});

describe('skill-content', () => {
  describe('extractSkillNameFromReadPath', () => {
    it('extracts parent dir of SKILL.md (forward slash)', () => {
      expect(extractSkillNameFromReadPath('/a/b/ops-spec-gen/SKILL.md')).toBe('ops-spec-gen');
    });
    it('normalizes backslashes (windows)', () => {
      expect(extractSkillNameFromReadPath('C:\\Users\\me\\skills\\a2h\\SKILL.md')).toBe('a2h');
    });
    it('returns null for non-SKILL.md paths', () => {
      expect(extractSkillNameFromReadPath('/a/b/foo.md')).toBeNull();
      expect(extractSkillNameFromReadPath('')).toBeNull();
    });
  });

  describe('stripSkillPreamble', () => {
    it('strips "Base directory for this skill:" first line', () => {
      const c = 'Base directory for this skill: /x/y/.claude/skills/foo\n\n# Foo\n\nbody';
      expect(stripSkillPreamble(c)).toBe('# Foo\n\nbody');
    });
    it('leaves content without preamble untouched', () => {
      expect(stripSkillPreamble('# Title\nbody')).toBe('# Title\nbody');
    });
    it('handles preamble-only content', () => {
      expect(stripSkillPreamble('Base directory for this skill: /x')).toBe('');
    });
  });

  describe('selectSkillContent', () => {
    it('prefers native Skill tool result (strips preamble)', () => {
      const ops: SkillToolCall[] = [
        {
          toolName: 'Skill',
          argsJson: '{"skill":"foo"}',
          resultJson: 'Base directory for this skill: /x/foo\n\n# Foo\n\nreal content',
          startedAt: t(1),
        },
      ];
      const r = selectSkillContent(ops, 'foo');
      expect(r).not.toBeNull();
      expect(r!.source).toBe('skill-tool');
      expect(r!.content).toBe('# Foo\n\nreal content');
      expect(r!.fullRead).toBe(true);
      expect(r!.maxLine).toBeNull();
    });

    it('falls back to Read of SKILL.md when no Skill tool', () => {
      const ops: SkillToolCall[] = [
        {
          toolName: 'Read',
          argsJson: '{"file_path":"/a/b/foo/SKILL.md"}',
          resultJson: '1\t# Foo\n2\t\n3\tbody',
          startedAt: t(1),
        },
      ];
      const r = selectSkillContent(ops, 'foo');
      expect(r).not.toBeNull();
      expect(r!.source).toBe('read');
      expect(r!.content).toBe('# Foo\n\nbody');
      expect(r!.fullRead).toBe(true);
      expect(r!.maxLine).toBe(3);
    });

    it('resolves Read path via opencode legacy `path` key', () => {
      // opencode 旧版 read 参数键为 `path`（新版 filePath）——词表统一识别
      const ops: SkillToolCall[] = [
        {
          toolName: 'read',
          argsJson: '{"path":"/home/u/.opencode/skills/foo/SKILL.md"}',
          resultJson: '1\t# Foo\n2\t\n3\tbody',
          startedAt: t(1),
        },
      ];
      const r = selectSkillContent(ops, 'foo');
      expect(r).not.toBeNull();
      expect(r!.source).toBe('read');
      expect(r!.content).toBe('# Foo\n\nbody');
      expect(r!.fullRead).toBe(true);
      expect(r!.maxLine).toBe(3);
    });

    it('marks Read with offset/limit as partial (not full)', () => {
      const ops: SkillToolCall[] = [
        {
          toolName: 'Read',
          argsJson: '{"file_path":"/a/b/foo/SKILL.md","offset":10,"limit":5}',
          resultJson: '10\t# Foo\n11\t\n12\tbody',
          startedAt: t(1),
        },
      ];
      const r = selectSkillContent(ops, 'foo');
      expect(r!.source).toBe('read');
      expect(r!.fullRead).toBe(false);
      expect(r!.maxLine).toBe(12);
    });

    it('marks Read with truncation marker as partial', () => {
      const ops: SkillToolCall[] = [
        {
          toolName: 'Read',
          argsJson: '{"file_path":"/a/b/foo/SKILL.md"}',
          resultJson: '1\t# Foo\n2\tbody\n<system-reminder>File is large; only showing first 2 lines.</system-reminder>',
          startedAt: t(1),
        },
      ];
      const r = selectSkillContent(ops, 'foo');
      expect(r!.source).toBe('read');
      expect(r!.fullRead).toBe(false);
    });

    it('picks the longest among multiple Skill tool candidates', () => {
      const ops: SkillToolCall[] = [
        { toolName: 'Skill', argsJson: '{"skill":"foo"}', resultJson: 'Base directory for this skill: /x\n\nshort', startedAt: t(1) },
        { toolName: 'Skill', argsJson: '{"skill":"foo"}', resultJson: 'Base directory for this skill: /x\n\nlonger content here', startedAt: t(2) },
      ];
      const r = selectSkillContent(ops, 'foo');
      expect(r!.content).toBe('longer content here');
    });

    it('matches skill via skill/<name> synthetic toolName', () => {
      const ops: SkillToolCall[] = [
        { toolName: 'skill/foo', argsJson: '{"skill":"foo","file_path":"/a/foo/SKILL.md"}', resultJson: 'Base directory for this skill: /x\n\n# Foo', startedAt: t(1) },
      ];
      const r = selectSkillContent(ops, 'foo');
      expect(r!.source).toBe('skill-tool');
    });

    it('returns null when skillName does not match', () => {
      const ops: SkillToolCall[] = [
        { toolName: 'Skill', argsJson: '{"skill":"other"}', resultJson: 'Base directory for this skill: /x\n\n# Other', startedAt: t(1) },
      ];
      expect(selectSkillContent(ops, 'foo')).toBeNull();
    });

    it('returns null when no resultJson', () => {
      const ops: SkillToolCall[] = [
        { toolName: 'Skill', argsJson: '{"skill":"foo"}', resultJson: null, startedAt: t(1) },
      ];
      expect(selectSkillContent(ops, 'foo')).toBeNull();
    });

    it('ignores Read of non-SKILL.md files', () => {
      const ops: SkillToolCall[] = [
        { toolName: 'Read', argsJson: '{"file_path":"/a/b/foo/README.md"}', resultJson: '1\tstuff', startedAt: t(1) },
      ];
      expect(selectSkillContent(ops, 'foo')).toBeNull();
    });

    it('opencode envelope read result is handled by parseReadLines', () => {
      const r = [
        '<path>/a/foo/SKILL.md</path>',
        '<type>file</type>',
        '<content>',
        '1: # Foo',
        '2: body',
        '</content>',
      ].join('\n');
      const ops: SkillToolCall[] = [
        { toolName: 'Read', argsJson: '{"file_path":"/a/foo/SKILL.md"}', resultJson: r, startedAt: t(1) },
      ];
      const out = selectSkillContent(ops, 'foo');
      expect(out!.source).toBe('read');
      expect(out!.content).toBe('# Foo\nbody');
    });
  });
});
