// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 回收站（删除即归档、可逆恢复）：从 insight 库删除的资产不是真消失——级联
// 删除前先落一份独立 SQLite 快照（复用 exportSession 导出管线），恢复时经
// context-insight 适配器走既有 importSession 管线回流（零 schema 变更、与手
// 工导出/导入同一事实源）。归档 best-effort：单条失败不阻断删除（warn 可
// 追），删除的可逆性是尽力语义而非硬保证。

import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import type { PrismaClient } from '@prisma/client'
import { insightDataHome } from '@/lib/run/run-store'
import { exportSession } from '@/lib/ingest/export-service'
import { importSession } from '@/lib/ingest/data-service'
import { BRAND_SOURCE_TYPE } from '@/lib/branding'
import { logInfo, logWarn } from '@/lib/logger'

export function recycleRoot(): string {
  return path.join(insightDataHome(), 'recycle')
}

/** 目录名安全闸：防路径注入/穿越，回收站条目名（taskId__framework.db） */
function isSafeEntryName(name: string): boolean {
  return /^[\w.-]+\.db$/.test(name) && !name.includes('..')
}

function entryFileName(taskId: string, framework: string | null): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_')
  return `${safe(taskId)}__${safe(framework ?? 'none')}.db`
}

function entryPath(name: string): string {
  if (!isSafeEntryName(name)) throw new Error(`非法回收站条目名: ${JSON.stringify(name.slice(0, 40))}`)
  return path.join(recycleRoot(), name)
}

export interface RecycleEntry {
  /** 文件名（客户端回传的身份键） */
  name: string
  taskId: string
  framework: string | null
  query: string | null
  model: string | null
  size: number
  deletedAt: string
}

/**
 * 级联删除前的归档：按行（id）取 taskId/framework，逐行 exportSession 落
 * 快照。同 taskId 双记录按 framework 分文件；重复删除同一条 = 覆盖为新快
 * 照（exportSession 对已存在输出先清后写）。
 */
export async function archiveSessionsToRecycle(prisma: PrismaClient, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0
  let archived = 0
  try {
    const rows = await prisma.session.findMany({
      where: { id: { in: ids } },
      select: { taskId: true, framework: true },
    })
    fs.mkdirSync(recycleRoot(), { recursive: true })
    for (const row of rows) {
      try {
        await exportSession(row.taskId, entryPath(entryFileName(row.taskId, row.framework)), prisma, row.framework ?? undefined)
        archived++
      } catch (e) {
        logWarn('recycle:archive', '快照失败（删除继续）', { taskId: row.taskId, error: e instanceof Error ? e.message : String(e) })
      }
    }
    if (archived > 0) logInfo('recycle:archive', '归档完成', { archived, total: ids.length })
  } catch (e) {
    logWarn('recycle:archive', '归档整体失败（删除继续）', { error: e instanceof Error ? e.message : String(e) })
  }
  return archived
}

/** 列表：目录直读 + 逐件读 Session 行元信息（mtime = 删除时间） */
export function listRecycleEntries(): RecycleEntry[] {
  const root = recycleRoot()
  if (!fs.existsSync(root)) return []
  const entries: RecycleEntry[] = []
  for (const name of fs.readdirSync(root)) {
    if (!name.endsWith('.db')) continue
    const file = path.join(root, name)
    try {
      const stat = fs.statSync(file)
      const db = new Database(file, { readonly: true })
      try {
        const row = db.prepare('SELECT taskId, framework, query, model FROM "Session" LIMIT 1').get() as
          | { taskId: string; framework: string | null; query: string | null; model: string | null }
          | undefined
        if (!row) continue
        entries.push({
          name,
          taskId: row.taskId,
          framework: row.framework,
          query: row.query,
          model: row.model,
          size: stat.size,
          deletedAt: stat.mtime.toISOString(),
        })
      } finally {
        db.close()
      }
    } catch {
      // 损坏/写入中的文件跳过，列表永远可用
    }
  }
  return entries.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
}

/** 恢复：快照经 context-insight 适配器回流（readSession 按 taskId 定位），
 *  仅真实导入成功（imported === true）后才移除快照；imported:false（空会话
 *  0 轮 / 同 taskId 已存在走 merge 路径）保留快照——不静默抹除，上层据此
 *  暴露失败语义。恢复后的会话是独立会话（原 run 目录已删，不复活 run）。 */
export async function restoreRecycleEntry(name: string, prisma: PrismaClient): Promise<{ taskId: string; imported: boolean; query: string | null }> {
  const file = entryPath(name)
  if (!fs.existsSync(file)) throw new Error(`回收站条目不存在: ${name}`)

  let taskId: string
  {
    const db = new Database(file, { readonly: true })
    try {
      const row = db.prepare('SELECT taskId FROM "Session" LIMIT 1').get() as { taskId: string } | undefined
      if (!row) throw new Error(`快照内无会话行: ${name}`)
      taskId = row.taskId
    } finally {
      db.close()
    }
  }

  const result = await importSession(file, taskId, prisma, file, BRAND_SOURCE_TYPE)
  if (result.imported) {
    fs.unlinkSync(file)
    logInfo('recycle:restore', '恢复完成', { name, taskId })
  } else {
    // imported:false 不删快照：空会话（0 轮）或同 taskId 已在库走 merge/dedup
    // 路径——删除即静默丢数据，保留快照供复查/重试，并向上层暴露失败语义
    logWarn('recycle:restore', '恢复未导入（快照保留）', { name, taskId })
  }
  return { taskId, imported: result.imported, query: result.query }
}

/** 彻底删除单条（不可恢复） */
export function purgeRecycleEntry(name: string): void {
  const file = entryPath(name)
  if (fs.existsSync(file)) fs.unlinkSync(file)
}

/** 清空回收站（不可恢复） */
export function emptyRecycle(): number {
  const root = recycleRoot()
  if (!fs.existsSync(root)) return 0
  let removed = 0
  for (const name of fs.readdirSync(root)) {
    if (!name.endsWith('.db')) continue
    try { fs.unlinkSync(path.join(root, name)); removed++ } catch { /* 尽力清 */ }
  }
  return removed
}
