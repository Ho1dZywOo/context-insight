// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 回收站服务层 IT（删除即归档 → 列表 → 恢复回流 → 快照移除 → 彻底删除/清空）：
// 归档钩子挂在 cascadeDeleteSessionRows（单条/批量/run 级联三路删除的事实源），
// 此处经同一入口驱动。恢复走 context-insight 适配器（exportSession 快照格式
// 的既有读方）——导出/导入同源闭环。CONTEXT_INSIGHT_HOME 指向独立 tmp，快照
// 不落真实家目录。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { PrismaClient } from '@prisma/client'
import { cascadeDeleteSessionRows } from '../../src/lib/ingest/session-cascade'
import { listRecycleEntries, restoreRecycleEntry, purgeRecycleEntry, emptyRecycle, recycleRoot } from '../../src/lib/recycle'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'recycle-svc-it-'))
process.env.CONTEXT_INSIGHT_HOME = TMP

const prisma = new PrismaClient()
const SID = 'ses-recycle-it-001'

async function seedSession(taskId: string): Promise<string> {
  const s = await prisma.session.create({
    data: { taskId, framework: 'dsh', query: '回收站全链路验证', model: 'glm-4.7' },
  })
  await prisma.turn.create({
    data: { sessionId: s.id, turnIndex: 0, role: 'user', content: 'hello recycle bin' },
  })
  return s.id
}

const findByTask = (taskId: string) => listRecycleEntries().find(e => e.taskId === taskId)

beforeAll(async () => {
  // 清理历史遗留同名行（重跑韧性）
  const rows = await prisma.session.findMany({ where: { taskId: SID }, select: { id: true } })
  if (rows.length > 0) await cascadeDeleteSessionRows(prisma, rows.map(r => r.id))
  for (const e of listRecycleEntries()) purgeRecycleEntry(e.name)
})

afterAll(async () => {
  await prisma.$disconnect()
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('回收站服务（删除即归档、可逆恢复）', () => {
  it('删除 → 归档快照在场（taskId/query/model 元信息可读）', async () => {
    const id = await seedSession(SID)
    await cascadeDeleteSessionRows(prisma, [id])

    expect(await prisma.session.count({ where: { taskId: SID } })).toBe(0)
    const entry = findByTask(SID)
    expect(entry).toBeTruthy()
    expect(entry!.query).toBe('回收站全链路验证')
    expect(entry!.model).toBe('glm-4.7')
    expect(entry!.framework).toBe('dsh')
    expect(entry!.size).toBeGreaterThan(0)
    expect(entry!.deletedAt).toBeTruthy()
    expect(fs.existsSync(path.join(recycleRoot(), entry!.name))).toBe(true)
  })

  it('恢复 → 会话+轮次回流 insight 库，快照移除', async () => {
    const entry = findByTask(SID)!
    expect(entry).toBeTruthy()

    const r = await restoreRecycleEntry(entry.name, prisma)
    expect(r.imported).toBe(true)

    const back = await prisma.session.findFirst({ where: { taskId: SID } })
    expect(back).toBeTruthy()
    // query 走导入管线语义（首问即标题）；model 来自轮级数据（种子 turn 无
    // 模型 → null 合法）——归档件内元信息已由上一用例锁定
    expect(['回收站全链路验证', 'hello recycle bin']).toContain(back!.query)
    const turns = await prisma.turn.count({ where: { sessionId: back!.id } })
    expect(turns).toBeGreaterThanOrEqual(1)

    // 快照已随恢复移除（回收站不留已回流条目）
    expect(findByTask(SID)).toBeUndefined()
  })

  it('再次删除可再归档；彻底删除后不可恢复', async () => {
    const back = await prisma.session.findFirst({ where: { taskId: SID } })
    expect(back).toBeTruthy()
    await cascadeDeleteSessionRows(prisma, [back!.id])

    const entry = findByTask(SID)
    expect(entry).toBeTruthy()

    purgeRecycleEntry(entry!.name)
    expect(findByTask(SID)).toBeUndefined()
    expect(await prisma.session.count({ where: { taskId: SID } })).toBe(0)
  })

  it('emptyRecycle 清空全部快照', async () => {
    const id = await seedSession('ses-recycle-it-002')
    await cascadeDeleteSessionRows(prisma, [id])
    expect(findByTask('ses-recycle-it-002')).toBeTruthy()

    const removed = emptyRecycle()
    expect(removed).toBeGreaterThanOrEqual(1)
    expect(listRecycleEntries()).toEqual([])
  })
})
