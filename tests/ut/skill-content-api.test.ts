// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { prisma } from '../setup';
import { GET } from '@/lib/observe/session-handlers/skill-content';

const createdSessionIds: string[] = [];

async function seedSession(taskId: string) {
  const session = await prisma.session.create({ data: { taskId, framework: 'unknown' } });
  createdSessionIds.push(session.id);
  const turn = await prisma.turn.create({
    data: { sessionId: session.id, turnIndex: 0, role: 'assistant' },
  });
  return { session, turn };
}

afterEach(async () => {
  for (const id of createdSessionIds.splice(0)) {
    await prisma.session.delete({ where: { id } }).catch(() => {});
  }
});

function makeRequest(taskId: string, skillName: string) {
  const q = new URLSearchParams({ taskId, skillName });
  return new NextRequest(`http://localhost/api/observe/session/skill-content?${q.toString()}`);
}

describe('skill-content API', () => {
  it('returns 400 when taskId missing', async () => {
    const req = new NextRequest('http://localhost/api/observe/session/skill-content?skillName=x');
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 when skillName missing', async () => {
    const req = new NextRequest('http://localhost/api/observe/session/skill-content?taskId=x');
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown session', async () => {
    const res = await GET(makeRequest('no-such-task', 'foo'));
    expect(res.status).toBe(404);
  });

  it('returns SKILL.md content from native Skill tool (preamble stripped)', async () => {
    const taskId = `skill-content-tool-${Date.now()}`;
    const { turn } = await seedSession(taskId);
    await prisma.toolCall.create({
      data: {
        turnId: turn.id,
        toolCallId: 'c1',
        toolName: 'Skill',
        argsJson: JSON.stringify({ skill: 'foo' }),
        resultJson: 'Base directory for this skill: /x/foo\n\n# Foo\n\nreal content',
        isSkillRelated: true,
        startedAt: new Date('2026-01-01T00:00:00Z'),
      },
    });

    const res = await GET(makeRequest(taskId, 'foo'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.skillName).toBe('foo');
    expect(json.source).toBe('skill-tool');
    expect(json.content).toBe('# Foo\n\nreal content');
    expect(json.length).toBe(json.content.length);
  });

  it('falls back to Read of SKILL.md when no Skill tool result', async () => {
    const taskId = `skill-content-read-${Date.now()}`;
    const { turn } = await seedSession(taskId);
    await prisma.toolCall.create({
      data: {
        turnId: turn.id,
        toolCallId: 'c1',
        toolName: 'Read',
        argsJson: JSON.stringify({ file_path: '/a/b/foo/SKILL.md' }),
        resultJson: '1\t# Foo\n2\t\n3\tbody',
        startedAt: new Date('2026-01-01T00:00:00Z'),
      },
    });

    const res = await GET(makeRequest(taskId, 'foo'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.source).toBe('read');
    expect(json.content).toBe('# Foo\n\nbody');
  });

  it('falls back to exec_command cat of SKILL.md (codex 主通道，真机现场)', async () => {
    const taskId = `skill-content-shell-${Date.now()}`;
    const { turn } = await seedSession(taskId);
    await prisma.toolCall.create({
      data: {
        turnId: turn.id,
        toolCallId: 'c1',
        toolName: 'exec_command',
        // 真机形态：echo 前缀链式命令（首 token 不是读类，靠分段判定）；
        // 不打 isSkillRelated（覆盖查询兜底分支）
        argsJson: JSON.stringify({ cmd: "echo '======== foo/SKILL.md ========'; cat /home/u/.codex/skills/foo/SKILL.md" }),
        resultJson: '# Foo\n\nshell cat 的终端输出原文',
        startedAt: new Date('2026-01-01T00:00:00Z'),
      },
    });

    const res = await GET(makeRequest(taskId, 'foo'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.source).toBe('shell');
    expect(json.content).toBe('# Foo\n\nshell cat 的终端输出原文');
    expect(json.fullRead).toBe(true);
  });

  it('codex exec_command 输出剥终端元数据壳（Chunk ID/Wall time/Output:）后恢复原文', async () => {
    const taskId = `skill-content-shell-wrap-${Date.now()}`;
    const { turn } = await seedSession(taskId);
    await prisma.toolCall.create({
      data: {
        turnId: turn.id,
        toolCallId: 'c1',
        toolName: 'exec_command',
        argsJson: JSON.stringify({ cmd: 'cat /s/foo/SKILL.md' }),
        resultJson: 'Chunk ID: 9014f0\nWall time: 0.0000 seconds\nProcess exited with code 0\nOriginal token count: 410\nOutput:\n# Foo\n\n真实正文',
        isSkillRelated: true,
        startedAt: new Date('2026-01-01T00:00:00Z'),
      },
    });

    const res = await GET(makeRequest(taskId, 'foo'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.source).toBe('shell');
    expect(json.content).toBe('# Foo\n\n真实正文');
    expect(json.fullRead).toBe(true);
  });

  it('exec_command 行范围读取（sed -n）标记非全文', async () => {
    const taskId = `skill-content-shell-partial-${Date.now()}`;
    const { turn } = await seedSession(taskId);
    await prisma.toolCall.create({
      data: {
        turnId: turn.id,
        toolCallId: 'c1',
        toolName: 'exec_command',
        argsJson: JSON.stringify({ cmd: "sed -n '1,50p' /s/foo/SKILL.md" }),
        resultJson: '# Foo 前 50 行',
        isSkillRelated: true,
        startedAt: new Date('2026-01-01T00:00:00Z'),
      },
    });

    const res = await GET(makeRequest(taskId, 'foo'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.source).toBe('shell');
    expect(json.fullRead).toBe(false);
  });

  it('shell 命令读多个技能 → 按 skillName 各自恢复', async () => {
    const taskId = `skill-content-shell-multi-${Date.now()}`;
    const { turn } = await seedSession(taskId);
    await prisma.toolCall.create({
      data: {
        turnId: turn.id,
        toolCallId: 'c1',
        toolName: 'exec_command',
        argsJson: JSON.stringify({ cmd: 'cat /s/foo/SKILL.md /s/bar/SKILL.md' }),
        resultJson: '# Foo\n\n# Bar',
        isSkillRelated: true,
        startedAt: new Date('2026-01-01T00:00:00Z'),
      },
    });

    const foo = await (await GET(makeRequest(taskId, 'foo'))).json();
    expect(foo.source).toBe('shell');
    const bar = await (await GET(makeRequest(taskId, 'bar'))).json();
    expect(bar.source).toBe('shell');
  });

  it('returns content null when skill not found', async () => {
    const taskId = `skill-content-none-${Date.now()}`;
    const { turn } = await seedSession(taskId);
    await prisma.toolCall.create({
      data: {
        turnId: turn.id,
        toolCallId: 'c1',
        toolName: 'Skill',
        argsJson: JSON.stringify({ skill: 'other' }),
        resultJson: 'Base directory for this skill: /x\n\n# Other',
        isSkillRelated: true,
        startedAt: new Date('2026-01-01T00:00:00Z'),
      },
    });

    const res = await GET(makeRequest(taskId, 'foo'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.content).toBeNull();
    expect(json.source).toBeNull();
  });
});
