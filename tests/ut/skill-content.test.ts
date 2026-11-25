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
  skillMdReadsOfTurn,
  type SkillToolCall,
} from '../../src/lib/skill-content.ts';

const t = (n: number) => new Date(n);

// ── C 根治回归：shell 通道声明恢复污染（现场 01a1c5d6 形态回放）──────
// 事故：shell 通道把整段命令输出当 SKILL.md 正文——pwd/ls 噪声、截断
// banner、printf 分隔符全进声明，再被「最长者胜」选成污染版（46 条指令
// 含 34 条多余）。根治：正文经 shell-restore 引擎归因（行号校准），跨
// 候选按行号拼接合并、fullRead 按连续性 + 无界读证据诚实判定。
const MD = (n: number) => `SK${String(n).padStart(2, '0')}`;
const MD_LINES = Array.from({ length: 20 }, (_, i) => MD(i + 1));
const md = (from: number, to: number) => MD_LINES.slice(from - 1, to).join('\n');

function shellTc(cmd: string, result: string, at: number): SkillToolCall {
  return {
    toolName: 'exec_command',
    argsJson: JSON.stringify({ cmd }),
    resultJson: result,
    startedAt: t(at),
  };
}

describe('skillMdReadsOfToolCall（shell 通道归因——现场污染形态）', () => {
  it('多命令链（pwd + printf 锚 + sed）：只归因 SKILL.md 自己的行，噪声不进正文', () => {
    const tc = shellTc(
      "pwd && printf '== md ==' && sed -n '1,20p' skill/SKILL.md",
      `/repo\n== md ==\n${md(1, 20)}\n`,
      1,
    );
    const reads = skillMdReadsOfToolCall(tc);
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ skillName: 'skill', source: 'shell', fullRead: false, maxLine: 20 });
    expect(reads[0].content).toBe(md(1, 20));
    expect(reads[0].content).not.toContain('/repo');
    expect(reads[0].content).not.toContain('== md ==');
  });

  it('采集期截断：截断 banner/丢弃段不进正文，缺口行如实缺席（fullRead 降级）', () => {
    const tc = shellTc(
      "sed -n '1,20p' skill/SKILL.md",
      `Warning: truncated output (original token count: 900)\nTotal output lines: 20\n\n${md(1, 8)}\n…9 chars truncated…\n${md(18, 20)}\n`,
      1,
    );
    const reads = skillMdReadsOfToolCall(tc);
    expect(reads[0].fullRead).toBe(false);
    expect(reads[0].content).not.toContain('Warning: truncated');
    expect(reads[0].content).not.toContain('chars truncated');
    // 头段 1-8 + 尾段 18-20 恢复、中段 9-17 丢弃段如实缺席
    expect(reads[0].content.startsWith(md(1, 8))).toBe(true);
    expect(reads[0].content.endsWith(md(18, 20))).toBe(true);
    expect(reads[0].content).not.toContain(MD(12));
    expect(reads[0].maxLine).toBe(20);
  });

  it('多 SKILL.md 混 dump（cat a b）：归因不可判定 → 候选骨架保留、正文空串（宁缺毋假）', () => {
    const tc = shellTc('cat a/foo/SKILL.md b/bar/SKILL.md', 'FOO\nBAR\n', 1);
    const reads = skillMdReadsOfToolCall(tc);
    expect(reads.map(r => r.skillName)).toEqual(['foo', 'bar']);
    expect(reads.every(r => r.content === '')).toBe(true);
  });

  it('管道过滤段（cat | grep）：候选骨架保留、正文空串——过滤输出不是原文', () => {
    const tc = shellTc('cat skill/SKILL.md | grep SK1', 'SK01\nSK10\n', 1);
    const reads = skillMdReadsOfToolCall(tc);
    expect(reads.map(r => r.skillName)).toEqual(['skill']);
    expect(reads[0].content).toBe('');
  });

  it('无壳无截断的整读 cat：fullRead=true（正文可作完整声明）', () => {
    const tc = shellTc('cat skill/SKILL.md', `${md(1, 20)}\n`, 1);
    const reads = skillMdReadsOfToolCall(tc);
    expect(reads[0]).toMatchObject({ skillName: 'skill', source: 'shell', fullRead: true, maxLine: 20 });
    expect(reads[0].content).toBe(md(1, 20));
  });
});

describe('selectSkillContent（行号校准合并——现场 01a1c5d6 形态）', () => {
  it('跨调用拼接：sed 区间互补/重叠 → 行号校准合并胜出，缺口如实（1-4 缺席）', () => {
    const ops: SkillToolCall[] = [
      shellTc("sed -n '5,12p' skill/SKILL.md", `${md(5, 12)}\n`, 1),
      shellTc("sed -n '10,20p' skill/SKILL.md", `${md(10, 20)}\n`, 2),
    ];
    const r = selectSkillContent(ops, 'skill');
    expect(r).not.toBeNull();
    expect(r!.source).toBe('shell');
    expect(r!.fullRead).toBe(false); // 1-4 缺席 + 全部有界读
    expect(r!.maxLine).toBe(20);
    // 合并正文 = 5..20 连续（重叠区 10-12 同内容），缺 1-4
    expect(r!.content).toBe(md(5, 20));
  });

  it('部分读 + 无界 cat 互补 → 连续且有无界读证据 → fullRead=true', () => {
    const ops: SkillToolCall[] = [
      shellTc("sed -n '1,8p' skill/SKILL.md", `${md(1, 8)}\n`, 1),
      shellTc('cat skill/SKILL.md', `${md(1, 20)}\n`, 2),
    ];
    const r = selectSkillContent(ops, 'skill');
    expect(r!.fullRead).toBe(true);
    expect(r!.maxLine).toBe(20);
    expect(r!.content).toBe(md(1, 20));
  });

  it('污染最长者不再胜出：噪声版（更长）与归因版并存 → 只取归因行', () => {
    // 旧「最长者胜」形态：同一次调用旧实现会把整段输出当正文（含噪声，更长）；
    // 新实现同调用只产归因候选。这里直接锁新旧行为的分界——归因版 + 无关
    // 长文本的其他技能读不影响本技能的选择
    const ops: SkillToolCall[] = [
      shellTc("sed -n '1,20p' skill/SKILL.md", `${md(1, 20)}\n`, 1),
      { toolName: 'Read', argsJson: '{"file_path":"/a/other/SKILL.md"}', resultJson: `${'x'.repeat(5000)}\n`, startedAt: t(2) },
    ];
    const r = selectSkillContent(ops, 'skill');
    expect(r!.content).toBe(md(1, 20));
    expect(selectSkillContent(ops, 'other')!.content).toContain('xxxx');
  });

  it('归因全灭（混 dump/管道）→ null（诚实缺口，不拿过滤输出充数）', () => {
    const ops: SkillToolCall[] = [shellTc('cat skill/SKILL.md | grep SK1', 'SK01\n', 1)];
    expect(selectSkillContent(ops, 'skill')).toBeNull();
  });
});

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
      {
        skillName: 'foo', source: 'skill-tool', content: 'BODY', fullRead: true, maxLine: null,
        fileLines: null, truncated: false, ts: t(1).getTime(),
      },
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

describe('codex exec input 形态 shell 读（检测面与归因面同源）', () => {
  const inputTc = (result: string): SkillToolCall => ({
    toolName: 'exec',
    argsJson: JSON.stringify({ input: 'exec_command({cmd:"cat /home/u/.agents/skills/data-analysis/SKILL.md"})' }),
    resultJson: result,
    startedAt: t(1),
  });

  it('skillMdReadsOfToolCall：input 内嵌 exec_command 读 SKILL.md → 正文（此前检测恒空漏检）', () => {
    const reads = skillMdReadsOfToolCall(inputTc('# 数据分析技能\n\n按步骤执行。\n'));
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ skillName: 'data-analysis', source: 'shell', fullRead: true });
    expect(reads[0].content).toBe('# 数据分析技能\n\n按步骤执行。');
  });

  it('selectSkillContent：input 形态读 SKILL.md → 完整正文胜出', () => {
    const r = selectSkillContent([inputTc('# 数据分析技能\n\n按步骤执行。\n')], 'data-analysis');
    expect(r).not.toBeNull();
    expect(r!.source).toBe('shell');
    expect(r!.fullRead).toBe(true);
    expect(r!.content).toBe('# 数据分析技能\n\n按步骤执行。');
  });
});

describe('skillMdReadsOfTurn（斜杠命令注入轮）', () => {
  it('C 形行首 marker：剥前言，正文纯净', () => {
    const turn = { role: 'system', content: 'Base directory for this skill: /x/day0-inference\n\n# Day0\n\nbody' };
    const reads = skillMdReadsOfTurn(turn);
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ skillName: 'day0-inference', source: 'command', fullRead: true, maxLine: null });
    expect(reads[0].content).toBe('# Day0\n\nbody');
  });

  it('S3 形中部 marker：剥标记块与运行时尾部，与 collect 路径同口径', () => {
    const body = '# 基于 ACLNN 的算子开发工作流\n\n你是纯编排者';
    const turn = {
      role: 'system',
      content: `${body}\n\nBase directory for this skill: /home/hwd/x/.opencode/skills/ops-registry-invoke-glacier\nRelative paths in this skill (e.g., scripts/) are relative to this base directory.\n\nsoftplus_v2_grad`,
    };
    const reads = skillMdReadsOfTurn(turn);
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ skillName: 'ops-registry-invoke-glacier', source: 'command', fullRead: true, maxLine: null });
    expect(reads[0].content).toContain(body);
    expect(reads[0].content).toContain('softplus_v2_grad');
    expect(reads[0].content).not.toContain('Base directory for this skill');
    expect(reads[0].content).not.toContain('Relative paths in this skill');
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
