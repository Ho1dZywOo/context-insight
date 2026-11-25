// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 导出覆盖 IT（真实 prisma + 真实文件）：回收站「覆盖归档」反复写同一
// taskId__framework.db 依赖 exportSession 对已存在输出「先清后写」——
// 覆盖语义在 POSIX 下 rename 天然成立，但在 Windows 目标存在会 EPERM。
// 本 IT 锁行为契约：同路径重复导出须成功产出最新内容，不残留旧快照。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Database from 'better-sqlite3'
import { prisma } from '../setup'
import { exportSession } from '../../src/lib/ingest/export-service'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'export-overwrite-it-'))
const OUT = path.join(TMP, 'snapshot.db')
const TASK_ID = 'export-overwrite-it-001'

beforeAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: TASK_ID } })
  const s = await prisma.session.create({
    data: { taskId: TASK_ID, framework: 'dsh', query: '第一版快照' },
  })
  await prisma.turn.create({ data: { sessionId: s.id, turnIndex: 0, role: 'user', content: 'v1' } })
})

afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: TASK_ID } })
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('exportSession 同一路径重复导出（覆盖归档）', () => {
  it('同路径重复导出覆盖成功，快照为最新内容而非旧残留', async () => {
    const p1 = await exportSession(TASK_ID, OUT, prisma, 'dsh')
    expect(p1).toBe(OUT)
    expect(fs.existsSync(OUT)).toBe(true)

    // 追加一轮后覆盖导出：文件仍合法且轮数更新（证明覆盖而非跳过/残留）
    const s = await prisma.session.findFirst({ where: { taskId: TASK_ID } })
    expect(s).toBeTruthy()
    await prisma.turn.create({ data: { sessionId: s!.id, turnIndex: 1, role: 'assistant', content: 'v2' } })

    const p2 = await exportSession(TASK_ID, OUT, prisma, 'dsh')
    expect(p2).toBe(OUT)

    const db = new Database(OUT, { readonly: true })
    try {
      const row = db.prepare('SELECT COUNT(*) AS n FROM "Turn"').get() as { n: number }
      expect(row.n).toBe(2)
    } finally {
      db.close()
    }
  })
})