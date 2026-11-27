#!/usr/bin/env node
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Web UI 启动流程——一个实例的完整生命周期，从占位到退出：
//   门禁（prepareStart：同一数据目录只允许一个实例）→ 占住控制端点（互斥锁）→
//   原生模块 / Prisma / 构建（步骤异步可打断）→ smart-agent → next start → 就绪
//   → 登记端口、开浏览器 → 运行期等信号 / 控制通道的 stop / 服务进程退出
// 清理在占位成功的那一刻就绪：任何阶段收到 INT/TERM/HUP 或 --stop 都走同一条
// 收尾（进行中的步骤进程、smart-agent、next 全部带走），不留「信号处理还没挂上」
// 的窗口；步骤用异步 spawn 而非 spawnSync，信号能被及时处理。

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { platform } from 'node:os'
import path from 'node:path'
import { agentPortCandidates, isHttpHealthy, isSmartAgent, isTcpFree } from './ports.mjs'
import { LauncherError, samePath, sleep } from './launcher-context.mjs'
import { startControl } from './launcher-control.mjs'
import { killProcesses, prepareStart, recycleRangeAgents } from './launcher-stop.mjs'
import { removeRecord, saveRecord } from './launcher-records.mjs'
import { listPids, readArgs, readCwd } from './launcher-proc.mjs'

const require = createRequire(import.meta.url)
const NEXT_BIN = /(^|\/)next(\/dist\/bin\/next|\.js)?$/

export async function runWebUi(ctx, rawArgs, io) {
  const flags = parseFlags(rawArgs)
  assertNodeVersion()
  prepareDataDir(ctx, flags)
  process.title = `${ctx.pkgName} launcher :${ctx.basePort}`

  io.log(`Node ${process.versions.node} ✓`)
  io.log(`数据目录: ${ctx.dataDir}`)
  await prepareStart(ctx, { killExisting: flags.killExisting, io })
  io.log(`端口: ${ctx.basePort}`)

  const instance = createInstance(ctx, io)
  try {
    const control = await startControl(ctx, instance.handle)
    if (!control.acquired) {
      const holder = control.holder
      throw new LauncherError([
        `数据目录 ${ctx.dataDir} 的另一个启动器已经在拉起实例（launcher PID ${holder.pid}${holder.foreignProduct ? `，产品 ${holder.product}` : ''}）—— 同一数据目录只允许一个实例。`,
        '等它就绪，或先 ctxi --stop 再启动。',
      ].join('\n'))
    }
    instance.state.control = control
    installSignals(instance)
    await boot(ctx, instance, flags, io)
    instance.state.phase = 'ready'
  } catch (e) {
    if (e instanceof Stopped) return instance.done
    await instance.shutdown(e instanceof Error ? e.message : String(e), 1)
    throw e
  }
  return instance.done
}

/** 步骤进行中被停止：不算失败，静默退出启动流程。 */
class Stopped extends Error {}

/**
 * 实例生命周期状态的唯一持有者：进行中的步骤、smart-agent、next 的句柄，
 * 控制通道的应答，以及幂等的收尾（多次触发只执行一次）。
 * done 在收尾完成时兑现为退出码。
 */
function createInstance(ctx, io) {
  const state = {
    phase: 'starting',
    startedAt: new Date().toISOString(),
    step: null,
    agent: null,
    next: null,
    control: null,
    stopping: false,
  }
  let resolveDone
  const done = new Promise((resolve) => { resolveDone = resolve })

  const shutdown = (reason, exitCode = 0) => {
    if (state.stopping) return done
    state.stopping = true
    state.phase = 'stopping'
    io.log(`正在停止（${reason}）...`)
    void (async () => {
      try {
        await killProcesses([
          ...(state.agent?.pid ? [{ pid: state.agent.pid, group: true }] : []),
          ...(state.next?.pid ? [{ pid: state.next.pid }] : []),
          ...(state.step?.pid ? [{ pid: state.step.pid, group: true }] : []),
        ], '实例', io)
        removeRecord(ctx, ctx.basePort)
        if (state.control) await state.control.close()
        io.log('已停止 ✓')
      } catch (e) {
        io.warn(`收尾出错：${e instanceof Error ? e.message : String(e)}`)
        exitCode = 1
      }
      resolveDone(exitCode)
    })()
    return done
  }

  const status = () => ({
    ok: true,
    product: ctx.pkgName,
    home: ctx.dataDir,
    port: ctx.basePort,
    pid: process.pid,
    state: state.phase,
    next: state.next?.pid ?? null,
    agents: state.agent?.pid ? [state.agent.pid] : [],
    version: ctx.version,
    startedAt: state.startedAt,
  })

  return {
    state,
    done,
    shutdown,
    handle(msg) {
      if (msg?.cmd === 'status') return status()
      if (msg?.cmd === 'stop') return { ok: true, after: () => { void shutdown('收到 --stop') } }
      return { ok: false, error: 'unknown command' }
    },
  }
}

function installSignals(instance) {
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      if (instance.state.stopping) process.exit(0)
      void instance.shutdown(`收到 ${sig}`)
    })
  }
}

async function boot(ctx, instance, flags, io) {
  const { state } = instance
  const run = (label, cmd, args) => step(ctx, state, label, cmd, args)
  const distDir = path.join(ctx.pkgDir, '.next')

  await ensureNative(ctx, run, io)
  if (!prismaClientGenerated(ctx)) {
    io.log('@prisma/client 未生成，运行 prisma generate...')
    await run('prisma generate', process.execPath, [prismaBin(ctx), 'generate'])
  }
  io.log('应用 Prisma migrations...')
  await run('prisma migrate', process.execPath, [prismaBin(ctx), 'migrate', 'deploy'])

  const buildId = path.join(distDir, 'BUILD_ID')
  if (flags.fresh || !existsSync(buildId)) {
    await waitForRunningBuild(ctx, instance, io)
    if (flags.fresh) {
      io.log('-f: 清理旧 build...')
      rmSync(distDir, { recursive: true, force: true })
    }
    if (existsSync(buildId)) {
      io.log('构建已由另一进程完成 ✓')
    } else {
      io.log('首次启动：构建 Next.js 产物（约 30s-2min，仅首次）...')
      await run('next build', process.execPath, [nextBin(ctx), 'build'])
      io.log('构建完成 ✓')
    }
  }

  if (!existsSync(path.join(ctx.pkgDir, 'public', 'export-view.js'))) {
    io.warn('export-view bundle 缺失，重新构建...')
    try {
      await run('export-view 构建', process.execPath, ['scripts/build-export-view.mjs'])
    } catch (e) {
      if (e instanceof Stopped) throw e
      io.warn('export-view 构建失败 —— HTML 导出功能不可用，其余功能正常')
    }
  }

  state.agent = await startSmartAgent(ctx, io)
  await launchServer(ctx, instance, io)
}

/**
 * 同一安装目录里正在进行的 next build（启动器被 kill -9 后留下的孤儿构建步骤）。
 * Next 不允许两个构建并存（会直接报错退出），所以构建前先等它结束；它跑完
 * BUILD_ID 就有了，通常连构建都不用再做。只等不杀——等待不会伤到任何进程。
 */
export async function waitForRunningBuild(ctx, instance, io, timeoutMs = 15 * 60_000) {
  let running = runningBuilds(ctx)
  if (running.length === 0) return
  io.log(`本安装目录另有构建正在进行（PID ${running.join(', ')}，通常是启动器被强杀后留下的构建步骤），等它结束...`)
  const deadline = Date.now() + timeoutMs
  while (running.length > 0 && Date.now() < deadline) {
    await sleep(1000)
    if (instance?.state.stopping) throw new Stopped()
    running = runningBuilds(ctx)
  }
  if (running.length > 0) throw new LauncherError(`本安装目录的构建（PID ${running.join(', ')}）${Math.round(timeoutMs / 60000)} 分钟内未结束`)
}

/** 形态为 `node …/next build` 且工作目录是本包安装目录的进程。 */
export function runningBuilds(ctx) {
  const builds = []
  for (const pid of listPids() ?? []) {
    if (pid === process.pid) continue
    const args = readArgs(pid)
    if (!args?.includes('build') || !args.some((a) => NEXT_BIN.test(a))) continue
    if (samePath(readCwd(pid), ctx.pkgDir)) builds.push(pid)
  }
  return builds
}

/** 起一个步骤子进程并等它结束；期间被停止 → Stopped，非零退出 → LauncherError。 */
function step(ctx, state, label, cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: ctx.pkgDir,
      stdio: 'inherit',
      env: process.env,
      // 独立进程组：构建步骤会再派生 worker（孙进程），收尾时按组停才不留残余
      // （Windows 上 detached 会单开控制台窗口，不启用，退单杀 + worker 随父退出）
      detached: process.platform !== 'win32',
      shell: process.platform === 'win32' && cmd === 'npm',
    })
    state.step = child
    child.once('error', (e) => {
      if (state.step === child) state.step = null
      reject(e)
    })
    child.on('exit', (code) => {
      if (state.step === child) state.step = null
      if (state.stopping) reject(new Stopped())
      else if (code !== 0) reject(new LauncherError(`${label} 失败（退出码 ${code}）`))
      else resolve()
    })
  })
}

async function ensureNative(ctx, run, io) {
  let failure = null
  try {
    const Database = require('better-sqlite3')
    const db = new Database(':memory:')
    db.prepare('select 1 as x').get()
    db.close()
  } catch (e) {
    failure = e
  }
  if (!failure) return
  const msg = failure instanceof Error ? failure.message : String(failure)
  if (!/NODE_MODULE_VERSION|did not self-register|was compiled against a different Node\.js version/i.test(msg)) {
    throw new LauncherError(`better-sqlite3 加载失败: ${msg}`)
  }
  io.warn('better-sqlite3 二进制与 Node ABI 不匹配，rebuild...')
  await run('better-sqlite3 rebuild', 'npm', ['rebuild', 'better-sqlite3'])
}

async function startSmartAgent(ctx, io) {
  if (!existsSync(path.join(ctx.pkgDir, 'smart-agent', 'server.py'))) return null
  // 恒 clean：候选区间内自家的旧 smart-agent 先回收再起全新的（复用是残留泄漏的来源）
  await recycleRangeAgents(ctx, [ctx.basePort], io)

  let pythonBin = null
  for (const c of ['python3', 'python']) {
    if (spawnSync('sh', ['-c', `command -v ${c}`], { stdio: 'pipe' }).status === 0) { pythonBin = c; break }
  }
  if (!pythonBin) {
    io.warn('未检测到 python3 —— smart-agent 后端跳过（audit v2/v3/v4 分析功能降级）')
    return null
  }
  const candidates = agentPortCandidates(ctx.basePort)
  let agentPort = null
  for (const p of candidates) {
    if (await isTcpFree(p)) { agentPort = p; break }
    // 候选区间被别的 smart-agent 占着（不是本数据目录的，--stop 不会动它）：如实告警并避让
    if (await isSmartAgent(p)) io.warn(`端口 ${p} 上已有一个不属于本数据目录的 smart-agent —— 避让`)
  }
  if (agentPort == null) {
    io.warn(`smart-agent 端口 ${candidates[0]}-${candidates[candidates.length - 1]} 均被占用（已避让 next 的 ${ctx.basePort}），跳过`)
    return null
  }
  io.log(`检测到 ${pythonBin}，启动 smart-agent (port ${agentPort})...`)
  const child = spawn(pythonBin, ['server.py'], {
    cwd: path.join(ctx.pkgDir, 'smart-agent'),
    detached: true,
    env: { ...process.env, CONTEXT_AGENT_PORT: String(agentPort) },
    stdio: 'ignore',
  })
  child.unref()
  for (let i = 0; i < 10; i++) {
    if (await isSmartAgent(agentPort)) {
      io.log('smart-agent ready ✓')
      process.env.CONTEXT_AGENT_URL = `http://localhost:${agentPort}`
      return child
    }
    await sleep(500)
  }
  io.warn('smart-agent 5s 内未就绪，跳过（后端仍可用）')
  return child
}

async function launchServer(ctx, instance, io) {
  const { state } = instance
  const port = ctx.basePort
  io.log('启动 Context-Insight...')
  const nextProc = spawn(process.execPath, [nextBin(ctx), 'start', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: ctx.pkgDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      // 实例身份（/api/instance/identity）的数据目录与启动器 PID 来源
      CONTEXT_INSIGHT_HOME: ctx.dataDir,
      CONTEXT_INSIGHT_LAUNCHER_PID: String(process.pid),
    },
  })
  state.next = nextProc
  nextProc.once('error', (e) => {
    if (!state.stopping) void instance.shutdown(`服务进程启动失败：${e.message}`, 1)
  })
  nextProc.on('exit', (code, signal) => {
    if (!state.stopping) void instance.shutdown(`服务进程已退出（${signal ? `信号 ${signal}` : `code ${code}`}）`, code ?? 1)
  })
  try {
    saveRecord(ctx, {
      port,
      launcher: process.pid,
      next: nextProc.pid,
      agents: state.agent?.pid ? [state.agent.pid] : [],
      packageDir: ctx.pkgDir,
      product: ctx.pkgName,
      version: ctx.version,
      startedAt: state.startedAt,
    })
  } catch (e) {
    io.warn(`实例记录写入失败（--stop 将只靠证据回收）: ${e instanceof Error ? e.message : String(e)}`)
  }

  const ready = await waitForReady(port, io, () => state.stopping || state.next?.exitCode !== null)
  if (!ready || state.stopping) return
  // 发现契约登记（读侧 cpx insight-discovery / ctxi config；持久保留，不随退出删除）
  try { writeFileSync(ctx.registryFile, `${port}\n`) } catch (e) { io.warn(`端口登记写入失败: ${e.message}`) }
  openBrowser(port, io)
}

async function waitForReady(port, io, isOver) {
  for (let tries = 1; tries <= 60; tries++) {
    if (await isHttpHealthy(port, '/', 2000)) {
      io.log(`服务就绪 (port ${port})`)
      return true
    }
    if (isOver()) return false
    if (tries === 60) {
      io.warn('服务 60s 内未就绪，不再等待')
      return false
    }
    await sleep(1000)
  }
  return false
}

function prepareDataDir(ctx, flags) {
  // 可写状态（库/记录/控制端点）集中在数据目录；构建产物在包目录 .next——Next 16
  // Turbopack 强制 distDir 不许逃出项目根；多人隔离靠每人各自的 npm 安装
  mkdirSync(ctx.dataDir, { recursive: true, mode: 0o700 })
  // 历史清理：旧版启动器曾把绝对 distDir 传给 Next，被拼成包目录深处的垃圾路径
  rmSync(path.join(ctx.pkgDir, ctx.dataDir, '.next'), { recursive: true, force: true })
  process.env.DATABASE_URL = `file:${ctx.dbPath}`
  process.env.NEXT_PUBLIC_SHOW_ADVANCED_TABS = flags.advanced ? 'true' : 'false'
}

function parseFlags(rawArgs) {
  return {
    advanced: rawArgs.includes('-a') || rawArgs.includes('--advanced'),
    killExisting: rawArgs.includes('-k') || rawArgs.includes('--kill'),
    fresh: rawArgs.includes('-f') || rawArgs.includes('--fresh'),
  }
}

function assertNodeVersion() {
  // >= 22.14，与 engines/start.sh 同门槛：better-sqlite3@13 预编译二进制在 22.13
  // 及以下加载/构造直接段错误
  const [major, minor] = process.versions.node.split('.').map((n) => Number.parseInt(n, 10))
  if (major < 22 || (major === 22 && (minor || 0) < 14)) {
    throw new LauncherError([
      `Node.js ${process.versions.node} 不支持，需 >= 22.14.0（better-sqlite3@13 原生二进制在 22.13 及以下段错误）。`,
      '用 nvm: nvm install 22 && nvm use 22；或 https://nodejs.org 直接装。',
    ].join('\n'))
  }
}

/** 生成的 Prisma client 是否就位——只看 @prisma/client 包在不在不够：postinstall 被跳过时包在、生成物不在。 */
function prismaClientGenerated(ctx) {
  try { require.resolve('.prisma/client/default', { paths: [ctx.pkgDir] }); return true } catch { return false }
}

function nextBin(ctx) {
  return require.resolve('next/dist/bin/next', { paths: [ctx.pkgDir] })
}

function prismaBin(ctx) {
  return require.resolve('prisma/build/index.js', { paths: [ctx.pkgDir] })
}

function openBrowser(port, io) {
  // 测试环境熔断：vitest 子进程继承 VITEST env；显式 kill-switch 优先
  if (process.env.CONTEXT_NO_BROWSER || process.env.VITEST) return
  const url = `http://localhost:${port}`
  const isWin = platform() === 'win32'
  const isMac = platform() === 'darwin'
  const isWsl = !isWin && existsSync('/proc/version') && readProcVersion().includes('microsoft')
  try {
    if (isWsl && existsSync('/mnt/c/Windows/System32/cmd.exe')) {
      spawn('/mnt/c/Windows/System32/cmd.exe', ['/c', 'start', url], { detached: true, stdio: 'ignore' }).unref()
    } else if (isMac) {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
    } else if (isWin) {
      spawn('cmd', ['/c', 'start', url], { detached: true, stdio: 'ignore' }).unref()
    } else if (process.env.DISPLAY) {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
    } else {
      io.log(`无图形会话（远程/无头 VM）—— 已端口转发则在浏览器打开 ${url}，或 ssh -L ${port}:localhost:${port}`)
    }
  } catch { /* 开浏览器失败不影响服务 */ }
}

function readProcVersion() {
  try { return readFileSync('/proc/version', 'utf8') } catch { return '' }
}
