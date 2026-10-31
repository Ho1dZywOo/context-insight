// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// run-first 回归锁：Prisma 6.19 引擎 bug 规避（skills collector）。嵌套
// skillEvents.orderBy + 全量父行拉取（约 ≥1000 行）触发查询引擎 panic
//（record.rs "no entry found for key"）——大会话（2500+ turns）的 Skill 观测
// tab 500。修复 = 嵌套排序上移 JS。本 IT 用 1200 turns 复现引擎边界，锁：
// ① 大会话 skills 端点 200；② 事件按轮序（nulls-last 父级排序）平铺；
// ③ 轮内事件按 createdAt 升序（乱序写入被 JS 排序纠正）。

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { GET } from '@/app/api/observe/run/[runId]/skills/route';

const TASK_ID = 'rsep-ses-panic';
const TURNS = 1200;

beforeAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: TASK_ID } });
  await prisma.session.create({ data: { taskId: TASK_ID, framework: 'claude-code' } });
  const session = await prisma.session.findFirstOrThrow({ where: { taskId: TASK_ID } });
  await prisma.sessionSkill.create({
    data: { sessionId: session.id, skillName: 'rsep-skill', skillVersion: 1, invocationCount: TURNS * 2 },
  });

  // turns：偶数序 createdAt_ts 为空（锁父级 nulls-last：挪尾）、奇数序时间戳
  // 倒序（父级排序非平凡——非插入序）
  await prisma.turn.createMany({
    data: Array.from({ length: TURNS }, (_, i) => ({
      sessionId: session.id,
      turnIndex: i,
      role: 'assistant',
      createdAt_ts: i % 2 === 0 ? null : new Date(1_700_000_000_000 + (TURNS - i) * 1000),
      createdAt: new Date(1_700_000_000_000 + i * 1000),
    })),
  });

  const turns = await prisma.turn.findMany({
    where: { sessionId: session.id },
    select: { id: true, turnIndex: true },
  });
  // skillEvents：每轮两条（use 先写但 createdAt 更晚；invoke 后写更早）——
  // 乱序写入锁 JS 侧升序排序
  await prisma.skillEvent.createMany({
    data: turns.flatMap(t => [
      {
        turnId: t.id,
        skillName: 'rsep-skill',
        eventType: 'use',
        success: true,
        durationMs: 2,
        createdAt: new Date(1_700_000_000_000 + (TURNS - t.turnIndex) * 1000 + 1),
      },
      {
        turnId: t.id,
        skillName: 'rsep-skill',
        eventType: 'invoke',
        success: true,
        durationMs: 1,
        createdAt: new Date(1_700_000_000_000 + (TURNS - t.turnIndex) * 1000),
      },
    ]),
  });
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: TASK_ID } });
});

describe('run-first：skills collector 引擎 panic 规避（嵌套 orderBy × 全量拉取）', () => {
  it('大会话（1200 turns × 双事件）skills 端点 200、轮序平铺、轮内升序', async () => {
    const res = await GET(
      new NextRequest(`http://localhost/api/observe/run/solo:${TASK_ID}/skills`),
      { params: Promise.resolve({ runId: `solo:${TASK_ID}` }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    // 聚合：单技能 2400 次（invoke/use 各半）
    expect(body.total).toBe(TURNS * 2);
    expect(body.skills).toHaveLength(1);
    expect(body.skills[0].skillName).toBe('rsep-skill');
    expect(body.skills[0].invocationCount).toBe(TURNS * 2);

    // 事件平铺序 = 轮序（createdAt_ts nulls-last → 奇数轮倒序在前、偶数轮
    // createdAt 升序在后），每轮内 invoke（早）先于 use（晚）
    expect(body.events.length).toBe(TURNS * 2);
    const expectedTurnOrder: number[] = [
      ...Array.from({ length: TURNS / 2 }, (_, k) => TURNS - 1 - 2 * k), // 奇数轮倒序
      ...Array.from({ length: TURNS / 2 }, (_, k) => 2 * k), // 偶数轮升序
    ];
    for (let i = 0; i < TURNS; i++) {
      const first = body.events[i * 2];
      const second = body.events[i * 2 + 1];
      expect(first.turnIndex).toBe(expectedTurnOrder[i]);
      expect(first.eventType).toBe('invoke');
      expect(second.eventType).toBe('use');
    }
  });
});
