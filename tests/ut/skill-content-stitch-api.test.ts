// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See the License in the root of the software repository for the full text of the License.

// codex 客户现场形态的 SKILL.md 恢复：工具输出被 harness 截断（banner + 行中内联
// 「…N tokens truncated…」中缝，头尾各留一段），agent 用 cat / sed 范围 / nl -ba 管道
// 分多次读同一份文件。数据驱动：tests/data/skill-content-stitch.json（合成 168 行
// 文件 + 14 次读取的原始输出片段 + 独立推出的期望覆盖面）。
//
// 锁定三件事：
//   ① 宁缺毋假：恢复出的每一行都与源文件对应行逐字相同，未读到的行不出现；
//   ② 证据出口：skill-content / skill-content-audit 两个 API 如实报覆盖面、缺口、截断、冲突；
//   ③ root 对账候选：同一 SKILL.md 的多段读取合并为一个候选并带证据（不再逐片段竞争）。

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { prisma } from '../setup';
import { GET as getSkillContent } from '@/lib/observe/session-handlers/skill-content';
import { GET as getSkillContentAudit } from '@/lib/observe/session-handlers/skill-content-audit';
import { collectWorkflowExtractCandidates } from '@/lib/llm-workflow-extract';

interface StitchRead {
  cmd: string;
  sub?: string | null;
  total?: number;
  /** 流式多块卷回：banner 之前已到达的前序块整行。 */
  prefix?: string;
  head?: string;
  tail?: string;
  output?: string;
}

const data = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'tests/data/skill-content-stitch.json'), 'utf8'),
) as {
  skillName: string;
  file: { path: string; lines: string[] };
  reads: StitchRead[];
  expected: { fileLines: number; lineNumbers: number[]; gaps: Array<{ from: number; to: number }>; conflictLines: number[] };
};

const EXEC_HEADER = 'Chunk ID: 7f3a9c\nWall time: 0.0041 seconds\nProcess exited with code 0\nOriginal token count: 9944\nOutput:\n';

/** 截断读取 → codex exec_command 的 resultJson 原始形态（终端元数据壳 + [前序块整行] +
 *  banner + 头段 + 中缝 + 尾段）。banner 的 Total output lines 相对 banner 所在块。 */
function resultJsonOf(read: StitchRead): string {
  if (read.output != null) return EXEC_HEADER + read.output;
  return (
    EXEC_HEADER
    + (read.prefix ?? '')
    + `Warning: truncated output (original token count: ${Math.round(read.head!.length / 2.5)})\n`
    + `Total output lines: ${read.total}\n\n`
    + read.head!
    + '…9876 tokens truncated…'
    + read.tail!
  );
}

const createdSessionIds: string[] = [];

async function seedSession(taskId: string, skillName: string) {
  const session = await prisma.session.create({ data: { taskId, framework: 'codex' } });
  createdSessionIds.push(session.id);
  const turn = await prisma.turn.create({
    data: { sessionId: session.id, turnIndex: 0, role: 'assistant' },
  });
  for (const [i, read] of data.reads.entries()) {
    await prisma.toolCall.create({
      data: {
        turnId: turn.id,
        toolCallId: `read-${i}`,
        toolName: 'exec_command',
        argsJson: JSON.stringify({ cmd: read.cmd }),
        resultJson: resultJsonOf(read),
        startedAt: new Date(Date.parse('2026-11-17T10:00:00Z') + i * 60_000),
      },
    });
  }
  // 真实 ingest 里 cat/nl 读 SKILL.md 会产生 use SkillEvent（校验面的 skill 名单来源）
  await prisma.skillEvent.create({ data: { turnId: turn.id, skillName, eventType: 'use', success: true } });
  return session;
}

afterEach(async () => {
  for (const id of createdSessionIds.splice(0)) {
    await prisma.session.delete({ where: { id } }).catch(() => {});
  }
});

const SKILL = data.skillName;

describe('截断会话的 SKILL.md 恢复（codex 现场形态）', () => {
  it('skill-content：只含确实读到的行，逐行与源文件一致，未读行不补', async () => {
    const taskId = `stitch-content-${Date.now()}`;
    await seedSession(taskId, SKILL);

    const res = await getSkillContent(new NextRequest(
      `http://localhost/api/observe/session/skill-content?taskId=${taskId}&skillName=${SKILL}`,
    ));
    expect(res.status).toBe(200);
    const json = await res.json();

    const texts: string[] = json.content.split('\n');
    expect(json.evidence.lineNumbers).toEqual(data.expected.lineNumbers);
    expect(texts).toHaveLength(data.expected.lineNumbers.length);
    // 宁缺毋假：每一行都是源文件对应行的原文
    texts.forEach((text, i) => expect(text).toBe(data.file.lines[data.expected.lineNumbers[i] - 1]));
    // 缺口处的行一个都不出现（第 7 行冲突弃用；68–89 未读到）
    expect(texts.some(t => t.includes('第 68 行'))).toBe(false);
    expect(json.content).not.toContain('初版内容');
    expect(json.content).not.toContain('改写后的内容');
  });

  it('skill-content：证据如实报覆盖面 / 文件总行数 / 缺口 / 截断 / 冲突行', async () => {
    const taskId = `stitch-evidence-${Date.now()}`;
    await seedSession(taskId, SKILL);

    const json = await (await getSkillContent(new NextRequest(
      `http://localhost/api/observe/session/skill-content?taskId=${taskId}&skillName=${SKILL}`,
    ))).json();

    expect(json.source).toBe('shell');
    expect(json.fullRead).toBe(false);
    expect(json.maxLine).toBe(168);
    expect(json.evidence.fileLines).toBe(data.expected.fileLines);
    expect(json.evidence.gaps).toEqual(data.expected.gaps);
    expect(json.evidence.truncated).toBe(true);
    expect(json.evidence.conflictLines).toEqual(data.expected.conflictLines);
    // 15 次读取里 tail（无文件起点）、过滤管道（nl | grep）与 Fermat 的那次（只归因到 tracker.md）
    // 对本文件不产出可靠行 → 12 次读取参与合并
    expect(json.evidence.readCount).toBe(12);
    // 终端元数据壳与截断 banner 不进正文
    expect(json.content).not.toContain('Chunk ID');
    expect(json.content).not.toContain('truncated');
  });

  it('skill-content-audit：校验面带同一份证据（部分读取 + 已读/总行数）', async () => {
    const taskId = `stitch-audit-${Date.now()}`;
    await seedSession(taskId, SKILL);

    const json = await (await getSkillContentAudit(new NextRequest(
      `http://localhost/api/observe/session/skill-content-audit?taskId=${taskId}`,
    ))).json();
    const item = json.items.find((i: { skillName: string }) => i.skillName === SKILL);

    expect(item.fullRead).toBe(false);
    expect(item.lines).toBe(data.expected.lineNumbers.length);
    expect(item.evidence).toMatchObject({
      fileLines: data.expected.fileLines,
      gaps: data.expected.gaps,
      truncated: true,
      conflictLines: data.expected.conflictLines,
    });
  });

  it('root 对账候选：同一 SKILL.md 的多段读取合并为一份候选并带证据（缺口不进正文）', async () => {
    const session = await seedSession(`stitch-root-${Date.now()}`, SKILL);

    const { regulation: regCands } = await collectWorkflowExtractCandidates(session.id, prisma);
    const skillCands = regCands.filter(c => c.source === `${SKILL} (SKILL.md)`);

    // 此前每次读取各占一个候选（12 个残篇互相竞争）；现在每技能一份
    expect(skillCands).toHaveLength(1);
    const cand = skillCands[0]!;
    expect(cand.partialRead).toBe(true);
    expect(cand.content.split('\n')).toHaveLength(data.expected.lineNumbers.length);
    expect(cand.content).not.toContain('第 68 行');
    expect(cand.evidence).toMatchObject({
      fileLines: data.expected.fileLines,
      gaps: data.expected.gaps,
      conflictLines: data.expected.conflictLines,
      truncated: true,
    });
    // 同一条命令里读的其他规程文件（tracker.md）仍是独立候选，不与 SKILL.md 混、也不因
    // 命令读了 SKILL.md 而被整条独占
    const trackerCand = regCands.find(c => c.source === 'tracker.md');
    expect(trackerCand?.partialRead).toBe(true);
    expect(trackerCand!.content.split('\n')).toHaveLength(25);
    expect(trackerCand!.content).toContain('tracker 第 25 项');
  });

  it('未截断的整文件 cat：读到的行拼齐整个文件 → 全文，证据无缺口', async () => {
    const taskId = `stitch-inject-${Date.now()}`;
    const session = await prisma.session.create({ data: { taskId, framework: 'codex' } });
    createdSessionIds.push(session.id);
    const turn = await prisma.turn.create({ data: { sessionId: session.id, turnIndex: 0, role: 'assistant' } });
    await prisma.toolCall.create({
      data: {
        turnId: turn.id,
        toolCallId: 'inj-1',
        toolName: 'exec_command',
        argsJson: JSON.stringify({ cmd: 'cat /work/.codex/skills/injected-skill/SKILL.md' }),
        resultJson: data.file.lines.join('\n'),
      },
    });

    const json = await (await getSkillContent(new NextRequest(
      `http://localhost/api/observe/session/skill-content?taskId=${taskId}&skillName=injected-skill`,
    ))).json();
    // 未截断的整文件 cat：读到的行拼齐整个文件 → 全文，无缺口
    expect(json.fullRead).toBe(true);
    expect(json.evidence).toMatchObject({ fileLines: data.file.lines.length, gaps: [], truncated: false, conflictLines: [] });
    expect(json.content.split('\n')).toHaveLength(data.file.lines.length);
  });
});
