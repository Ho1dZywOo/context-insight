// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// IT：claude-code 斜杠命令技能调用（/skill 展开形态）计数闭环。
// 现场问题：/day0-inference 以 <command-name> 标签 + skill 注入 system 轮
// 加载（无工具调用），skills 统计不计。验证链路：
// jsonl 夹具 → claude-jsonl adapter（注入重分类 system）→ turn-split
// （斜杠命令 invoke SkillEvent）→ aggregates（sessionSkillsData 进账）。
// 恢复半链：注入轮第四通道——斜杠命令会话无任何工具调用，恢复层此前只扫
// ToolCall 表 → Skills 面板「SKILL.md 原文」恒空（现场缺陷，5295af91
// 全文 19823 字符完好入库于 system 轮却取不出）。

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { readSession } from '../../src/lib/ingest/adapters/claude-jsonl.ts';
import { splitIntoTurns, resetIdCounter } from '../../src/lib/ingest/turn-split.ts';
import { importSession } from '../../src/lib/ingest/data-service.ts';
import { recoverSkillBody, buildStructuredRecords } from '../../src/lib/sift-audit.ts';
import { GET as getSkillContent } from '@/lib/observe/session-handlers/skill-content';
import { GET as getSkillContentAudit } from '@/lib/observe/session-handlers/skill-content-audit';
import { prisma } from '../setup';
import path from 'node:path';

const FIXTURE_DIR = path.resolve(__dirname, './data/claude-sessions');
const SLASH_SKILL_FILE = path.join(FIXTURE_DIR, 'slash-skill-invoke.jsonl');
const IMPORT_SID = 'slash-skill-invoke-it';

describe('slash-command skill invocation', () => {
  let interactions: ReturnType<typeof readSession>;
  let result: ReturnType<typeof splitIntoTurns>;

  beforeAll(async () => {
    resetIdCounter();
    interactions = readSession(SLASH_SKILL_FILE, 'slash-skill-invoke');
    result = splitIntoTurns(interactions, 'session-slash-skill-invoke-test');

    await prisma.session.deleteMany({ where: { taskId: IMPORT_SID } }).catch(() => {});
    await importSession(SLASH_SKILL_FILE, IMPORT_SID, prisma, SLASH_SKILL_FILE, 'claude-jsonl');
  });

  afterAll(async () => {
    await prisma.session.deleteMany({ where: { taskId: IMPORT_SID } }).catch(() => {});
  });

  // ── Adapter: 注入行重分类 system ──

  describe('adapter layer', () => {
    it('keeps command-tag user turn as user role', () => {
      const cmdTurn = interactions.find(i => (i.content ?? '').includes('<command-name>/day0-inference</command-name>'));
      expect(cmdTurn).toBeDefined();
      expect(cmdTurn!.role).toBe('user');
    });

    it('reclassifies skill body injection into a system turn', () => {
      const inj = interactions.find(i => (i.content ?? '').includes('Base directory for this skill'));
      expect(inj).toBeDefined();
      expect(inj!.role).toBe('system');
    });
  });

  // ── turn-split: 斜杠命令 SkillEvent ──

  describe('turn-split: slash SkillEvent', () => {
    it('creates invoke SkillEvent for /day0-inference', () => {
      const ev = result.skillEvents.find(se => se.skillName === 'day0-inference');
      expect(ev).toBeDefined();
      expect(ev!.eventType).toBe('invoke');
      expect(ev!.success).toBe(true);
    });

    it('carries command args in argsJson', () => {
      const ev = result.skillEvents.find(se => se.skillName === 'day0-inference');
      expect(ev!.argsJson).toContain('Kimi-K3');
      expect(ev!.argsJson).toContain('tpot');
    });

    it('anchors the event on the user command turn', () => {
      const ev = result.skillEvents.find(se => se.skillName === 'day0-inference');
      const ownerTurn = result.turns.find(t => t.id === ev!.turnId);
      expect(ownerTurn).toBeDefined();
      expect(ownerTurn!.role).toBe('user');
      expect(ownerTurn!.content).toContain('<command-name>/day0-inference</command-name>');
    });

    it('does not count built-in local commands (no injection follows)', () => {
      const builtin = result.skillEvents.find(se => se.skillName === 'skills');
      expect(builtin).toBeUndefined();
      expect(result.skillEvents.filter(se => se.skillName === 'day0-inference').length).toBe(1);
    });
  });

  // ── DB 落库：skills 统计数据源（SkillEvent 表）进账 ──

  describe('import + DB roundtrip', () => {
    it('persists the slash invoke SkillEvent row', async () => {
      const events = await prisma.skillEvent.findMany({
        where: { turn: { session: { taskId: IMPORT_SID } } },
      });
      const ev = events.find(e => e.skillName === 'day0-inference');
      expect(ev).toBeDefined();
      expect(ev!.eventType).toBe('invoke');
      expect(ev!.success).toBe(true);
      expect(ev!.argsJson).toContain('Kimi-K3');
    });

    it('persists no SkillEvent for the built-in command', async () => {
      const events = await prisma.skillEvent.findMany({
        where: { turn: { session: { taskId: IMPORT_SID } } },
      });
      expect(events.filter(e => e.skillName === 'skills').length).toBe(0);
      expect(events.length).toBe(1);
    });
  });

  // ── 恢复层：斜杠命令注入轮第四通道 ──
  // 夹具无任何工具调用，全文只活在 system 注入轮——三个恢复消费方都必须
  // 从注入轮拿到正文（此前只扫 ToolCall 表，恒空）。

  describe('restore layer: command-injection turn channel', () => {
    const makeContentRequest = (skillName: string) => new NextRequest(
      `http://localhost/api/observe/session/skill-content?taskId=${encodeURIComponent(IMPORT_SID)}&skillName=${encodeURIComponent(skillName)}`
    );

    it('skill-content handler restores full body from the system injection turn', async () => {
      const res = await getSkillContent(makeContentRequest('day0-inference'));
      expect(res.status).toBe(200);
      const json = await res.json() as {
        content: string | null; source: string | null; length: number; fullRead: boolean;
      };
      expect(json.source).toBe('command');
      expect(json.fullRead).toBe(true);
      expect(json.content).toContain('# Day0 推理四阶段流程控制（Stage Orchestrator）');
      // 前言剥离：注入壳行不是正文
      expect(json.content).not.toContain('Base directory for this skill');
      expect(json.length).toBe(json.content!.length);
    });

    it('skill-content-audit handler marks the slash-invoked skill as hasContent', async () => {
      const res = await getSkillContentAudit(new NextRequest(
        `http://localhost/api/observe/session/skill-content-audit?taskId=${encodeURIComponent(IMPORT_SID)}`
      ));
      expect(res.status).toBe(200);
      const json = await res.json() as {
        items: Array<{ skillName: string; hasContent: boolean; source: string | null; fullRead: boolean }>;
      };
      const item = json.items.find(i => i.skillName === 'day0-inference')!;
      expect(item).toBeTruthy();
      expect(item.hasContent).toBe(true);
      expect(item.source).toBe('command');
      expect(item.fullRead).toBe(true);
    });

    it('recoverSkillBody (sift-audit) restores from the injection turn too', async () => {
      const session = await prisma.session.findFirst({ where: { taskId: IMPORT_SID } });
      expect(session).toBeTruthy();
      const body = await recoverSkillBody(session!.id, 'day0-inference', prisma);
      expect(body).toContain('# Day0 推理四阶段流程控制（Stage Orchestrator）');
      expect(body).not.toContain('Base directory for this skill');
    });

    it('skill with no injection and no reads stays honestly empty', async () => {
      const res = await getSkillContent(makeContentRequest('no-such-skill'));
      expect(res.status).toBe(200);
      const json = await res.json() as { content: string | null; source: string | null };
      expect(json.content).toBeNull();
      expect(json.source).toBeNull();
    });
  });

  // ── audit 导出链：C 形（斜杠命令）Skill 锚点 ──
  // 现场缺陷：day0-inference 以斜杠命令加载（无任何工具调用），transcript 导出
  // 只为 B 形（use + source_tool_call_id）合成 sift --kind skill 切段锚点 →
  // C 形会话切不出段 → sift audit exit 2。

  describe('audit export: slash-command skill anchor', () => {
    it('buildStructuredRecords 为命令轮补合成 skill 锚点（day0-inference audit exit 2 回归锁）', async () => {
      const session = await prisma.session.findFirst({ where: { taskId: IMPORT_SID } });
      const out = await buildStructuredRecords(session!.id, prisma);
      const cmdTurn = out.records.find(r =>
        (r as Record<string, unknown>).role === 'user' &&
        String((r as Record<string, unknown>).text ?? '').includes('<command-name>/day0-inference</command-name>')
      ) as Record<string, unknown> | undefined;
      expect(cmdTurn).toBeDefined();
      expect(cmdTurn!.tool_calls).toEqual([{ name: 'skill', input: { skill: 'day0-inference' } }]);
      // 会话里再无其他 skill 锚点（夹具无 B 形读取、无 A 形工具）
      const allAnchors = out.records.flatMap(r =>
        ((r as Record<string, unknown>).tool_calls as Array<Record<string, unknown>> | undefined ?? [])
          .filter(tc => tc.name === 'skill'));
      expect(allAnchors).toHaveLength(1);
    });
  });
});
