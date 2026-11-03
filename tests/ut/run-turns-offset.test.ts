// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. Do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// run turns offset 补拉契约 IT（Turns tab 全量自动拉齐的服务端半边）：
// ①page 语义原样（缺省 offset 为 null，存量分页消费方零影响）；
// ②offset 续拉与 page 续页同序同界（确定性排序下补拉链拼接无重叠无缝隙）；
// ③offset 与 page 同传时 offset 优先；
// ④尾段截断与越界空页（补拉链终止条件）；
// ⑤member 过滤与 offset 组合。

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { GET as runTurnsGET } from '@/app/api/observe/run/[runId]/turns/route';

const SID = 'rto-ses-offset';
const RUN_ID = `solo:${SID}`;
const TURN_COUNT = 7;

beforeAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: SID } });
  const s = await prisma.session.create({
    data: {
      taskId: SID,
      framework: 'opencode',
      model: 'volc-gateway/glm-4.7',
      startTime: new Date('2026-10-13T02:00:00Z'),
      endTime: new Date('2026-10-13T02:10:00Z'),
    },
  });
  for (let i = 0; i < TURN_COUNT; i++) {
    await prisma.turn.create({
      data: {
        sessionId: s.id,
        turnIndex: i,
        role: i % 2 === 0 ? 'user' : 'assistant',
        contentSummary: `rto-轮次-${i}`,
        createdAt_ts: new Date(`2026-10-13T02:00:${String(10 + i).padStart(2, '0')}Z`),
      },
    });
  }
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: SID } });
  await prisma.$disconnect();
});

function getTurns(query = '') {
  return runTurnsGET(
    new NextRequest(`http://localhost/api/observe/run/${RUN_ID}/turns${query}`),
    { params: Promise.resolve({ runId: RUN_ID }) },
  );
}

const idxOf = (data: { items: Array<{ turnIndex: number }> }) => data.items.map(i => i.turnIndex);

describe('run turns offset 补拉契约（两段式全量拉齐的服务端半边）', () => {
  it('page 语义原样：缺省 offset 为 null，存量分页消费方零影响', async () => {
    const res = await getTurns('?page=1&pageSize=3');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.total).toBe(TURN_COUNT);
    expect(data.offset).toBeNull();
    expect(idxOf(data)).toEqual([0, 1, 2]);
  });

  it('offset 续拉与 page 续页同序同界：拼接无重叠无缝隙', async () => {
    const [page1, byOffset, byPage] = await Promise.all([
      getTurns('?page=1&pageSize=3'),
      getTurns('?offset=3&pageSize=3'),
      getTurns('?page=2&pageSize=3'),
    ]);
    const d1 = await page1.json();
    const dOff = await byOffset.json();
    const dPage = await byPage.json();
    expect(dOff.offset).toBe(3);
    expect(dOff.total).toBe(TURN_COUNT);
    expect(idxOf(dOff)).toEqual([3, 4, 5]);
    // 与页码续页逐值等价（确定性排序下两种寻址同一窗口）
    expect(dOff.items.map((i: { turnId: string }) => i.turnId))
      .toEqual(dPage.items.map((i: { turnId: string }) => i.turnId));
    expect([...idxOf(d1), ...idxOf(dOff)]).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('offset 与 page 同传时 offset 优先', async () => {
    const res = await getTurns('?offset=3&page=9&pageSize=3');
    const data = await res.json();
    expect(data.offset).toBe(3);
    expect(idxOf(data)).toEqual([3, 4, 5]);
  });

  it('尾段截断与越界空页：补拉链终止条件', async () => {
    const tail = await (await getTurns('?offset=6&pageSize=3')).json();
    expect(idxOf(tail)).toEqual([6]);
    const beyond = await (await getTurns('?offset=50&pageSize=3')).json();
    expect(beyond.items).toEqual([]);
    expect(beyond.total).toBe(TURN_COUNT);
    expect(beyond.offset).toBe(50);
  });

  it('member 过滤与 offset 组合', async () => {
    const res = await getTurns(`?member=${SID}&offset=2&pageSize=2`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(idxOf(data)).toEqual([2, 3]);
    expect(data.offset).toBe(2);
  });
});
