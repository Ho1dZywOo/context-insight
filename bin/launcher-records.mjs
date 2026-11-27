#!/usr/bin/env node
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 实例记录——崩溃后回收的线索（不是依据：依据在 launcher-instances 的证据模型）。
// 每个端口一份（DATA_DIR/instances/<port>.json），谁起过谁留名；旧版的单槽
// insight.pid 首次读到时自动迁移，升级不丢线索。

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export function recordFile(ctx, port) {
  return path.join(ctx.recordsDir, `${port}.json`)
}

/** 落盘一份实例记录（临时文件 + rename，读侧永远看不到半截 JSON）。 */
export function saveRecord(ctx, record) {
  mkdirSync(ctx.recordsDir, { recursive: true, mode: 0o700 })
  const target = recordFile(ctx, record.port)
  const temp = `${target}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(record, null, 2) + '\n')
  renameSync(temp, target)
}

export function removeRecord(ctx, port) {
  rmSync(recordFile(ctx, port), { force: true })
}

/** 全部有效记录（按端口升序）；损坏的文件按不存在处理。 */
export function listRecords(ctx) {
  adoptLegacyRecord(ctx)
  if (!existsSync(ctx.recordsDir)) return []
  const records = []
  for (const name of readdirSync(ctx.recordsDir)) {
    if (!/^\d+\.json$/.test(name)) continue
    try {
      const record = JSON.parse(readFileSync(path.join(ctx.recordsDir, name), 'utf8'))
      if (Number.isInteger(record?.port) && Number.isInteger(record?.next)) records.push(record)
    } catch { /* 损坏记录：回收不依赖它 */ }
  }
  return records.sort((a, b) => a.port - b.port)
}

/** 旧版单槽 insight.pid → instances/<port>.json（每份数据目录只做一次）。 */
function adoptLegacyRecord(ctx) {
  const legacy = path.join(ctx.dataDir, 'insight.pid')
  if (!existsSync(legacy)) return
  try {
    const old = JSON.parse(readFileSync(legacy, 'utf8'))
    const port = Number.isInteger(old?.port) ? old.port : ctx.basePort
    const hasPid = (pid) => Number.isInteger(pid) && pid > 0
    if (!existsSync(recordFile(ctx, port)) && (hasPid(old?.next) || hasPid(old?.launcher))) {
      saveRecord(ctx, {
        port,
        launcher: hasPid(old.launcher) ? old.launcher : null,
        next: hasPid(old.next) ? old.next : null,
        agents: Array.isArray(old.agents) ? old.agents.filter(hasPid) : [],
        packageDir: null,
        product: ctx.pkgName,
        version: null,
        startedAt: old.savedAt ?? null,
      })
    }
  } catch { /* 旧记录损坏：线索丢了就丢，回收靠证据 */ }
  rmSync(legacy, { force: true })
}
