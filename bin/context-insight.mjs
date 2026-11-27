#!/usr/bin/env node
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Context-Insight 全局启动器（npm install -g / npx 入口）——只做分发，生命周期逻辑
// 全在 bin/launcher-*.mjs（每个模块一个职责，文件头有契约说明）：
//   无参数 / -k   启动 Web UI（首次自动 build + migrate，后续直接 start）
//   --stop         停掉本数据目录下自家的全部实例
//   子命令         透传给 CLI（dist/cli.mjs）
// 实例语义：
//   - 固定端口（CONTEXT_INSIGHT_PORT，默认 21025）：被非自家进程占 fail-fast，绝不漂移
//   - 同一数据目录只允许一个实例：已有实例 → 明确拒绝并给出 --stop / -k 两条路
//   - -k = 接管：停掉本数据目录的现有实例，再在本端口重启
//   - --stop 两条路：启动器活着走控制通道让它自己收尾；启动器没了（kill -9 等）
//     按证据回收残留——「谁算自家」见 launcher-instances 的证据模型

import { spawn } from 'node:child_process'
import { existsSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { LauncherError, resolveContext } from './launcher-context.mjs'
import { stopCommand } from './launcher-stop.mjs'
import { runWebUi } from './launcher-web.mjs'

const ctx = resolveContext()

const CLI_COMMANDS = new Set([
  'tui', 'sessions', 'session', 'stats', 'compare', 'search', 'turn',
  'import', 'delete', 'config', 'analyze', 'export', 'export-md', 'upload',
  'help', '--help', '-h', '--version', '-V', '-v',
])

const io = {
  log: (msg) => process.stdout.write(`[ctxi] ${msg}\n`),
  warn: (msg) => process.stderr.write(`[ctxi] ${msg}\n`),
  error: (msg) => process.stderr.write(`${msg.split('\n').map((line) => `[ctxi] ${line}`).join('\n')}\n`),
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    if (e instanceof LauncherError) io.error(e.message)
    else console.error(e)
    process.exit(1)
  },
)

async function main(args) {
  migrateLegacyDataDir()
  if (args[0] === '--stop') return stopCommand(ctx, io)
  if (args[0] && CLI_COMMANDS.has(args[0])) return runCli(args)
  return runWebUi(ctx, args, io)
}

function runCli(args) {
  io.log(`CLI: ${args.join(' ')}`)
  // 优先 dist/cli.mjs（prepack 时的 esbuild 单文件产物）；
  // tsx 回退仅用于仓内开发态 —— npm 全局安装位置在 node_modules 内，
  // tsx 对 node_modules 内文件禁用 tsconfig paths，`@/` 别名会 ERR_MODULE_NOT_FOUND。
  const cliBundle = path.join(ctx.pkgDir, 'dist', 'cli.mjs')
  const cliArgv = existsSync(cliBundle)
    ? [cliBundle, ...args]
    : ['--import', 'tsx', 'src/cli/index.ts', ...args]
  return new Promise((resolve) => {
    const child = spawn(process.execPath, cliArgv, {
      cwd: ctx.pkgDir,
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL || `file:${ctx.dbPath}` },
    })
    child.on('exit', (code) => resolve(code ?? 0))
  })
}

// 数据目录迁移：cannbot 时代（≤0.2.39）的 ~/.cannbot-insight 首启原子改名到
// ~/.context-insight。仅当「旧在、新不在」时执行；显式 CONTEXT_INSIGHT_HOME
// 覆盖 = 用户自管目录，不掺和；两目录并存 = 沿用新目录并提示（不合并）。
function migrateLegacyDataDir() {
  if (process.env.CONTEXT_INSIGHT_HOME) return
  const legacy = path.join(homedir(), '.cannbot-insight')
  const next = path.join(homedir(), '.context-insight')
  // 等路径 = cannbot 品牌变体（pack-cannbot 打包期翻转了新目录字面量）——迁移无意义
  if (legacy === next || !existsSync(legacy)) return
  if (existsSync(next)) {
    io.warn(`检测到 ${legacy} 与 ${next} 并存——沿用新目录，旧目录请手动确认后清理`)
    return
  }
  try {
    renameSync(legacy, next)
    io.log(`数据目录已迁移: ${legacy} → ${next}`)
  } catch (e) {
    io.warn(`数据目录迁移失败（${e instanceof Error ? e.message : e}），继续使用 ${next}`)
  }
}
