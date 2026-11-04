// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

// 从入库的 opencode-sample.sql（source of truth）物化一份 v1 opencode 样例库。
// OAT 禁二进制入库、.db 被 gitignore 吞掉——每个消费者拿独立临时副本，无共享
// 路径首建竞态、不依赖其它文件先跑（旧 existsSync 共享守卫的并行竞态由
// PR #106 review 指出，统一收敛到本 helper）。用完由调用方在 afterAll 里
// rmSync(path.dirname(dbPath)) 清理。
//
// replaceSid（SID 私有化）：样例 SQL 是多个测试文件的共享源，但共享 sid 会让
// 并行 worker 在同一 test.db 上争抢同一条 (taskId, framework) 行——现场：
// lake.test.ts 的 beforeAll 清扫删掉 lake-native-upload ⑥ 导入到一半的行 →
// 上传报 Session not found（状态 'failed'）。消费方各自改写出私有 sid 的副本，
// 行归属彻底解耦；改写为全量字符串替换（覆盖 INSERT 键值与内容 blob 里的
// 同串），SQL 语义不变。仅做测试库名义隔离，不落任何用户数据。
export function materializeV1Fixture(
  tag: string,
  opts: { replaceSid?: { from: string; to: string } } = {},
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `opencode-v1-${tag}-`))
  const dbPath = path.join(dir, 'opencode-sample.db')
  const db = new Database(dbPath)
  try {
    let sql = fs.readFileSync(path.resolve(__dirname, '../ut/data/e2e/opencode-sample.sql'), 'utf8')
    if (opts.replaceSid) sql = sql.split(opts.replaceSid.from).join(opts.replaceSid.to)
    try {
      db.exec(sql)
    } finally {
      db.close()
    }
  } catch (e) {
    // 失败路径自清理（review 建议）：exec 抛出时调用方拿不到 dbPath、
    // afterAll 无从接管——先确保句柄关闭，再回收目录后原样上抛
    fs.rmSync(dir, { recursive: true, force: true })
    throw e
  }
  return dbPath
}
