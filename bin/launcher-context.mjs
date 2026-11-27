#!/usr/bin/env node
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 启动器环境解析单点——「我是谁、我的数据在哪」只在这里算一次：
// 安装目录 / 包名 / 数据目录 / 固定端口 / 库文件 / 各类登记文件路径。
// 启动器其余模块一律从 context 取路径，不再各自读 env，读写两侧天然同源。

import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 启动器上下文。
 * - dataDir：可写状态（库 / 记录 / 控制端点 / 发现登记）的根。显式
 *   CONTEXT_INSIGHT_HOME 为用户自管目录，否则 ~/.context-insight
 * - basePort：固定端口语义（多人服务器每人固定），绝不静默漂移
 * - registryFile：发现契约登记文件——读侧是 cpx 与本包 CLI，锚定与读侧严格一致
 *   （设了 CONTEXT_PROXY_DIR 登记随它走，否则随数据目录）
 * @param {Record<string, string | undefined>} [env]
 */
export function resolveContext(env = process.env) {
  const pkg = createRequire(import.meta.url)('../package.json')
  const dataDir = env.CONTEXT_INSIGHT_HOME || path.join(homedir(), '.context-insight')
  const proxyRoot = env.CONTEXT_PROXY_DIR ? path.dirname(env.CONTEXT_PROXY_DIR) : dataDir
  return {
    pkgDir: canonical(PKG_DIR),
    pkgName: pkg.name,
    version: pkg.version,
    dataDir: canonical(dataDir),
    dbPath: canonical(path.join(dataDir, 'insight.db')),
    basePort: Number.parseInt(env.CONTEXT_INSIGHT_PORT || '21025', 10),
    recordsDir: path.join(canonical(dataDir), 'instances'),
    registryFile: path.join(canonical(proxyRoot), 'insight-port'),
  }
}

/** 两个路径是否指向同一处（能取真实路径就按真实路径比，符号链接不致误判）。 */
export function samePath(a, b) {
  if (!a || !b) return false
  return canonical(a) === canonical(b)
}

function canonical(p) {
  try { return realpathSync(p) } catch { return path.resolve(p) }
}

/** 启动器主动拒绝（端口被占 / 同一数据目录已有实例 / 构建步骤失败）：消息直接给用户看。 */
export class LauncherError extends Error {}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
