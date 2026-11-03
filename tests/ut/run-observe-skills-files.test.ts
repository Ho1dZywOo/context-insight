// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// run 合并 Skills/Files IT（design: docs/design/run-observe-parity/design.md §3.2/§4，刀D）：
// 真实 fixture（mini-bundle，rop- 前缀）+ 真实 prisma 种跨成员技能/文件读取 →
// 锁：①skills 聚合跨成员合并（invocationCount 求和、version 取最大）+ 事件
// 平铺带 member 归因与真值 duration/errorMessage；②file-reads 跨成员归并
// （Read + bash 隐式读、跨成员重叠读取）；③file-restore/dir-restore 合并
// 重编（run 名 zip）。session 侧三路由薄壳化由既有 file-reads/file-restore/
// dir-restore IT 护住（行为逐字节不变）。

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { parseAndIndex } from '@/lib/run/reader';
import { saveRun, type RunImportMeta } from '@/lib/run/run-store';
import { prisma } from '@/lib/db';
import { GET as runSkillsGET } from '@/app/api/observe/run/[runId]/skills/route';
import { GET as runFileReadsGET } from '@/app/api/observe/run/[runId]/file-reads/route';
import { GET as runFileRestoreGET } from '@/app/api/observe/run/[runId]/file-restore/route';
import { GET as runDirRestoreGET } from '@/app/api/observe/run/[runId]/dir-restore/route';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-run-observe-skills-'));
const ORIG_HOME = process.env.CONTEXT_INSIGHT_HOME;

const RUN_ID = 'minidemo01';
const MEMBER_SIDS = ['ropd-ses-mini-a', 'ropd-ses-mini-b', 'ropd-ses-mini-c'];
const MEMBER_A = 'ropd-ses-mini-a';
const MEMBER_B = 'ropd-ses-mini-b';

beforeAll(async () => {
  process.env.CONTEXT_INSIGHT_HOME = tmpHome;
  const rewrite = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(/^ses_mini_/, 'ropd-ses-mini-');
    if (Array.isArray(v)) return v.map(rewrite);
    if (v != null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, rewrite(val)]));
    }
    return v;
  };
  const manifest = parseAndIndex(
    rewrite(JSON.parse(fs.readFileSync(path.resolve(__dirname, './data/run/mini-bundle/workflow.json'), 'utf-8'))) as Parameters<typeof parseAndIndex>[0],
  ).manifest;
  const meta: RunImportMeta = {
    schema: 'insight-run-import',
    version: 1,
    data: {
      importedAt: '2026-10-15T10:00:00+08:00',
      sourceDir: '/bundle/mini',
      manifestFile: 'workflow.json',
      exportDataComplete: true,
      sessions: { total: 3, imported: 3, existing: 0, missingFile: 0, failed: 0 },
      failures: [],
      warnings: [],
      ownedSessions: MEMBER_SIDS.map(sid => ({ sid, framework: 'opencode' })),
    },
  };
  saveRun(manifest, meta);

  await prisma.session.deleteMany({ where: { taskId: { in: MEMBER_SIDS } } });
  await prisma.session.createMany({
    data: MEMBER_SIDS.map((sid, i) => ({
      taskId: sid,
      framework: 'opencode',
      model: 'volc-gateway/glm-4.7',
      totalTokens: 100 * (i + 1),
      startTime: new Date('2026-10-13T02:00:00Z'),
      endTime: new Date('2026-10-13T02:10:00Z'),
    })),
  });
  const ids = await Promise.all(
    MEMBER_SIDS.map(sid => prisma.session.findFirst({ where: { taskId: sid }, select: { id: true } })),
  );
  const [sa, sb] = ids.map(r => r!.id);

  // SessionSkill：a 与 b 同名技能（version 不同）+ b 独有技能
  await prisma.sessionSkill.createMany({
    data: [
      { sessionId: sa, skillName: 'rop-skill-x', skillVersion: 2, invocationCount: 3 },
      { sessionId: sb, skillName: 'rop-skill-x', skillVersion: 1, invocationCount: 2 },
      { sessionId: sb, skillName: 'rop-skill-y', skillVersion: 1, invocationCount: 1 },
    ],
  });

  const mkTurn = (sessionId: string, turnIndex: number, at: string) =>
    prisma.turn.create({
      data: {
        sessionId, turnIndex, role: 'assistant', content: `rop-turn-${turnIndex}`,
        createdAt_ts: new Date(at), totalTokens: 100, inputTokens: 50, outputTokens: 40,
        reasoningTokens: 5, cacheReadTokens: 10, cacheWriteTokens: 4, agentName: 'build',
      },
    });
  const ta0 = await mkTurn(sa, 0, '2026-10-13T02:00:10Z');
  const tb0 = await mkTurn(sb, 0, '2026-10-13T02:00:20Z');
  const tb1 = await mkTurn(sb, 1, '2026-10-13T02:00:30Z');

  // SkillEvent：a 调 skill-x（真值 duration/version）；b 调 skill-x + 加载 skill-y 失败
  await prisma.skillEvent.create({
    data: { turnId: ta0.id, skillName: 'rop-skill-x', skillVersion: 2, eventType: 'invoke', success: true, durationMs: 40 },
  });
  await prisma.skillEvent.create({
    data: { turnId: tb0.id, skillName: 'rop-skill-x', skillVersion: 1, eventType: 'invoke', success: true, durationMs: 25 },
  });
  await prisma.skillEvent.create({
    data: { turnId: tb1.id, skillName: 'rop-skill-y', skillVersion: 1, eventType: 'load', success: false, errorMessage: 'rop-boom', durationMs: 7 },
  });

  // 文件读取：a Read shared.md（offset 1 limit 10）；b Read shared.md（重叠）+ bash cat other.md
  await prisma.toolCall.create({
    data: { turnId: ta0.id, toolCallId: 'rop-tc-read-a', toolName: 'Read', state: 'ok', argsJson: '{"file_path": "/repo/rop-shared.md", "offset": 1, "limit": 10}' },
  });
  await prisma.toolCall.create({
    data: { turnId: tb0.id, toolCallId: 'rop-tc-read-b', toolName: 'Read', state: 'ok', argsJson: '{"file_path": "/repo/rop-shared.md", "offset": 1, "limit": 5}' },
  });
  await prisma.toolCall.create({
    data: { turnId: tb1.id, toolCallId: 'rop-tc-bash', toolName: 'bash', state: 'ok', argsJson: '{"command": "cat /repo/rop-other.md"}' },
  });
  // Write 供恢复重编（file-restore / dir-restore 走 read+write 操作序）
  await prisma.toolCall.create({
    data: { turnId: ta0.id, toolCallId: 'rop-tc-write-a', toolName: 'Write', state: 'ok', argsJson: '{"file_path": "/repo/rop-shared.md", "content": "line1\\nline2\\n"}', resultJson: null },
  });
});

afterAll(async () => {
  for (const sid of MEMBER_SIDS) {
    try { await prisma.session.deleteMany({ where: { taskId: sid } }); } catch { /* ignore */ }
  }
  await prisma.$disconnect();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  if (ORIG_HOME === undefined) delete process.env.CONTEXT_INSIGHT_HOME;
  else process.env.CONTEXT_INSIGHT_HOME = ORIG_HOME;
});

function get(runId: string, seg: string, query = '') {
  const handlers = { skills: runSkillsGET, 'file-reads': runFileReadsGET, 'file-restore': runFileRestoreGET, 'dir-restore': runDirRestoreGET } as const;
  return handlers[seg as keyof typeof handlers](
    new NextRequest(`http://localhost/api/observe/run/${runId}/${seg}${query}`),
    { params: Promise.resolve({ runId }) },
  );
}

describe('run 合并 Skills/Files 观测（run-observe-parity 刀D）', () => {
  it('skills：SessionSkill 跨成员合并（计数求和/version 取最大）+ 事件平铺带 member 归因与真值字段', async () => {
    const res = await get(RUN_ID, 'skills');
    expect(res.status).toBe(200);
    const data = await res.json();
    // 聚合：skill-x = 3+2 = 5（version 2 > 1，成员 a+b）；skill-y = 1（成员 b）。
    // members = 图结构短名（刀G：build·g0 / build·验收，不用 prompt 开头）
    expect(data.skills).toEqual([
      { skillName: 'rop-skill-x', version: 2, invocationCount: 5, members: ['build·g0', 'build·验收'] },
      { skillName: 'rop-skill-y', version: 1, invocationCount: 1, members: ['build·验收'] },
    ]);
    // 事件平铺：3 条，member 归因正确（b 两条）
    expect(data.total).toBe(3);
    const byMember = new Map(data.events.map((e: { member: { taskId: string } }) => [e.member.taskId, 0]));
    expect([...byMember.keys()].sort()).toEqual([MEMBER_A, MEMBER_B]);
    const failEvent = data.events.find((e: { errorMessage: string | null }) => e.errorMessage === 'rop-boom');
    expect(failEvent).toBeTruthy();
    expect(failEvent.member.taskId).toBe(MEMBER_B);
    expect(failEvent.eventType).toBe('load');
    expect(failEvent.success).toBe(false);
    expect(failEvent.durationMs).toBe(7);
    expect(failEvent.skillVersion).toBe(1);
    // turnTokens 透传
    expect(failEvent.turnTokens.totalTokens).toBe(100);

    // member 过滤：仅 a → skill-x 聚合 3、事件 1 条
    const one = await get(RUN_ID, 'skills', `?member=${MEMBER_A}`);
    const oneData = await one.json();
    expect(oneData.skills).toEqual([{ skillName: 'rop-skill-x', version: 2, invocationCount: 3, members: ['build·g0'] }]);
    expect(oneData.total).toBe(1);
    expect(oneData.events[0].member.taskId).toBe(MEMBER_A);

    const bad = await get(RUN_ID, 'skills', '?member=rop-not-in-run');
    expect(bad.status).toBe(400);
  });

  it('file-reads：跨成员归并（Read 重叠 + bash 隐式读），member 过滤收敛', async () => {
    const res = await get(RUN_ID, 'file-reads');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.summary.totalFiles).toBe(2);
    expect(data.summary.totalReads).toBe(3);
    // shared.md 被两成员重叠读取（a: 1-10 / b: 1-5）
    expect(data.summary.filesWithOverlap).toBe(1);
    const shared = data.files.find((f: { path: string }) => f.path === '/repo/rop-shared.md');
    expect(shared.totalReads).toBe(2);
    // 成员归因（刀F）：读取条目带 member（a/b 各一条），session 端点不含此字段
    expect(shared.reads.map((r: { member: { taskId: string } }) => r.member.taskId).sort()).toEqual([MEMBER_A, MEMBER_B]);
    // bash cat 隐式读入列
    const other = data.files.find((f: { path: string }) => f.path === '/repo/rop-other.md');
    expect(other).toBeTruthy();

    // member 过滤：仅 a → shared.md 单次读取，无重叠文件
    const one = await get(RUN_ID, 'file-reads', `?member=${MEMBER_A}`);
    const oneData = await one.json();
    expect(oneData.summary.totalFiles).toBe(1);
    expect(oneData.summary.totalReads).toBe(1);
    expect(oneData.summary.filesWithOverlap).toBe(0);
  });

  it('file-restore / dir-restore：合并 read+write 操作序重编（run 名 zip + 统计头）', async () => {
    const fr = await get(RUN_ID, 'file-restore', '?filePath=/repo/rop-shared.md');
    expect(fr.status).toBe(200);
    const frData = await fr.json();
    expect(frData.path).toBe('/repo/rop-shared.md');
    // Read ×2 + Write ×1
    expect(frData.opsUsed).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(frData.lines)).toBe(true);

    const dr = await get(RUN_ID, 'dir-restore');
    expect(dr.status).toBe(200);
    expect(dr.headers.get('Content-Type')).toBe('application/zip');
    expect(dr.headers.get('Content-Disposition')).toContain('run_minidemo01_restored.zip');
    // 重编只吃 Read/Write 工具族（bash 隐式读不进，与 session 端点行为一致）：
    // 仅 shared.md（a/b Read + a Write）
    expect(Number(dr.headers.get('X-Restored-Count'))).toBe(1);
    expect(Number(dr.headers.get('X-Restored-Total-Lines'))).toBeGreaterThan(0);

    const bad = await get(RUN_ID, 'file-restore', '?member=rop-not-in-run&filePath=/x');
    expect(bad.status).toBe(400);
    const missing = await get('rop-no-such-run', 'file-reads');
    expect(missing.status).toBe(404);
  });
});
