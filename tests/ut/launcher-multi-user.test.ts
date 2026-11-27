// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See the License in the root of the software repository for the full text of the License.

/**
 * npm 全局启动器多人服务器行为 IT（bin/launcher-*.mjs，真实进程 / 真实 socket / 真实 /proc）。
 *
 * 固定端口语义 + --stop 的归属证据模型：
 *   - 固定端口被占 fail-fast，绝不静默漂移（漂移断 cpx 发现与书签）
 *   - --stop 只停「能证明属于本数据目录」的进程：归属键是数据目录，不是安装目录
 *     （一个安装目录可以服务多份数据目录——源码仓里 start.sh 起的实例、开发时的多 HOME）
 *   - 证明不了的一律不杀，如实报告占用者是谁
 */
import { describe, it, expect, afterEach } from "vitest"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import net from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isTcpFree } from "../../bin/ports.mjs"
import { resolveContext } from "../../bin/launcher-context.mjs"
import { saveRecord } from "../../bin/launcher-records.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PKG_DIR = path.resolve(__dirname, "../..")
const LAUNCHER = path.join(PKG_DIR, "bin", "context-insight.mjs")
const SMART_AGENT_DIR = path.join(PKG_DIR, "smart-agent")
const binSource = (name: string) => fs.readFileSync(path.join(PKG_DIR, "bin", name), "utf8")

const cleanups: Array<() => void> = []
afterEach(() => {
  cleanups.splice(0).forEach((fn) => {
    try { fn() } catch { /* 尽力而为 */ }
  })
})

function mkHome(prefix = "ctxi-launcher-it-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function ephemeralPort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port
      s.close(() => resolve(p))
    })
  })
}

/** BASE 与候选区间 BASE+1~+3 全空的起点。 */
async function freeBase(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const b = await ephemeralPort()
    if ((await isTcpFree(b)) && (await isTcpFree(b + 1)) && (await isTcpFree(b + 2)) && (await isTcpFree(b + 3))) return b
  }
  throw new Error("20 次内未找到四连空闲端口段")
}

function occupy(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once("error", reject)
    s.listen(port, "127.0.0.1", () => resolve(s))
  })
}

function runLauncher(cliArgs: string[], home: string, base: number, timeout = 30_000) {
  return spawnSync(process.execPath, [LAUNCHER, ...cliArgs], {
    env: { ...process.env, CONTEXT_INSIGHT_HOME: home, CONTEXT_INSIGHT_PORT: String(base), CONTEXT_NO_BROWSER: "1" },
    encoding: "utf8",
    timeout,
  })
}

function track(child: ChildProcess): ChildProcess {
  cleanups.push(() => { try { child.kill("SIGKILL") } catch { /* 尽力而为 */ } })
  return child
}

function isDead(pid: number | undefined): boolean {
  if (!pid) return false
  try { process.kill(pid, 0); return false } catch { return true }
}

/** 轮询等进程消失：spawnSync 期间测试进程收不到 SIGCHLD，被杀子进程会先以僵尸态存在。 */
async function eventuallyDead(pid: number | undefined, ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (isDead(pid)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return isDead(pid)
}

async function eventuallyTrue(check: () => Promise<boolean>, what: string, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`等待超时：${what}`)
}

async function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection({ port, host: "127.0.0.1" })
    s.once("connect", () => { s.destroy(); resolve(true) })
    s.once("error", () => resolve(false))
  })
}

/**
 * 假 next-server：进程标题与真实 next-server 一致（next 启动后自改标题），
 * 可选打开指定的库文件、按给定数据目录自报实例身份。
 */
const NEXT_STUB = `
  const fs = require("node:fs"), http = require("node:http")
  process.title = "next-server (v16.2.9)"
  if (process.env.STUB_DB) fs.openSync(process.env.STUB_DB, "a")
  if (process.env.STUB_IGNORE_TERM) process.on("SIGTERM", () => {})
  http.createServer((q, s) => {
    if (q.url === "/api/instance/identity" && process.env.STUB_IDENTITY_HOME) {
      s.writeHead(200, { "content-type": "application/json" })
      s.end(JSON.stringify({ product: "context-insight", home: process.env.STUB_IDENTITY_HOME, pid: process.pid, port: Number(process.env.STUB_PORT) }))
      return
    }
    s.writeHead(404).end()
  }).listen(Number(process.env.STUB_PORT), "127.0.0.1")
`
interface StubOptions { port: number; cwd?: string; db?: string; identityHome?: string; ignoreTerm?: boolean }

async function stubNextServer(opts: StubOptions): Promise<ChildProcess> {
  const child = track(spawn(process.execPath, ["-e", NEXT_STUB], {
    cwd: opts.cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      STUB_PORT: String(opts.port),
      STUB_DB: opts.db ?? "",
      STUB_IDENTITY_HOME: opts.identityHome ?? "",
      STUB_IGNORE_TERM: opts.ignoreTerm ? "1" : "",
    },
  }))
  await eventuallyTrue(() => listening(opts.port), `next-server 桩监听 ${opts.port}`)
  return child
}

/** 假 smart-agent：argv0 换成 `python3 server.py`，/proc cmdline 形态与真实 agent 一致。 */
const AGENT_STUB = `
  require("node:http").createServer((q, s) => {
    if (q.url === "/health") {
      s.writeHead(200, { "content-type": "application/json" })
      s.end(JSON.stringify({ service: "context-smart-agent" }))
    } else { s.writeHead(404).end() }
  }).listen(Number(process.env.STUB_PORT), "127.0.0.1")
`
async function stubAgent(port: number, cwd = SMART_AGENT_DIR): Promise<ChildProcess> {
  const child = track(spawn("bash", ["-c", 'exec -a "python3 server.py" node -e "$STUB_CODE"'], {
    cwd,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, STUB_PORT: String(port), STUB_CODE: AGENT_STUB },
  }))
  await eventuallyTrue(() => listening(port), `smart-agent 桩监听 ${port}`)
  return child
}

function writeRecord(home: string, base: number, nextPid: number, agentPids: number[]): void {
  const ctx = resolveContext({ CONTEXT_INSIGHT_HOME: home, CONTEXT_INSIGHT_PORT: String(base) })
  saveRecord(ctx, { port: base, launcher: null, next: nextPid, agents: agentPids, packageDir: PKG_DIR, product: "context-insight", version: "test", startedAt: null })
}

describe("ctxi --stop（归属证据模型：证明不了属于本数据目录的一律不杀）", () => {
  it("开了本数据目录库的 next-server + 记录在案的 smart-agent 全部回收，记录清除", async () => {
    const home = mkHome()
    const base = await freeBase()
    const db = path.join(home, "insight.db")
    const server = await stubNextServer({ port: base, cwd: mkHome(), db, identityHome: home })
    const agent = await stubAgent(base + 1)
    writeRecord(home, base, server.pid!, [agent.pid!])

    const r = runLauncher(["--stop"], home, base)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain(`next-server PID ${server.pid}`)
    expect(await eventuallyDead(server.pid)).toBe(true)
    expect(await eventuallyDead(agent.pid)).toBe(true)
    expect(fs.existsSync(path.join(home, "instances", `${base}.json`))).toBe(false)
    expect(r.stdout).toContain(`端口 ${base} 空闲`)
  })

  it("没有任何记录也能回收（客户场景：kill -9 后记录缺失）——库文件与端口相邻就是证明", async () => {
    const home = mkHome()
    const base = await freeBase()
    const server = await stubNextServer({ port: base, cwd: mkHome(), db: path.join(home, "insight.db") })
    const agent = await stubAgent(base + 1)

    const r = runLauncher(["--stop"], home, base)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain("打开了本数据目录的库")
    expect(await eventuallyDead(server.pid)).toBe(true)
    expect(await eventuallyDead(agent.pid)).toBe(true)
  })

  it("同安装目录、别的数据目录的 next-server 不杀（归属键是数据目录，不是安装目录）", async () => {
    const home = mkHome()
    const base = await freeBase()
    // 工作目录就是本包目录（源码仓里 start.sh 起的实例正是这个形态），但它没打开本数据目录的库
    const stranger = await stubNextServer({ port: base, cwd: PKG_DIR })

    const r = runLauncher(["--stop"], home, base)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("仍被占用")
    expect(r.stderr).toContain(`kill ${stranger.pid}`)
    expect(isDead(stranger.pid)).toBe(false)
  })

  it("服务端自报身份是唯一证据时也认（安装目录已变更 / 非 Linux 无 /proc）", async () => {
    const home = mkHome()
    const base = await freeBase()
    const server = await stubNextServer({ port: base, cwd: mkHome(), identityHome: home })

    const r = runLauncher(["--stop"], home, base)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain("自报身份属于本数据目录")
    expect(await eventuallyDead(server.pid)).toBe(true)
  })

  it("自报属于别的数据目录的 insight 实例 → 不代杀，并说明它是谁的", async () => {
    const home = mkHome()
    const otherHome = mkHome()
    const base = await freeBase()
    const server = await stubNextServer({ port: base, cwd: mkHome(), identityHome: otherHome })

    const r = runLauncher(["--stop"], home, base)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("另一个 insight 实例")
    expect(r.stderr).toContain(otherHome)
    expect(r.stderr).toContain(`kill ${server.pid}`)
    expect(isDead(server.pid)).toBe(false)
  })

  it("候选区间里不属于本数据目录的 smart-agent 不杀", async () => {
    const home = mkHome()
    const base = await freeBase()
    const agent = await stubAgent(base + 1, mkHome())

    const r = runLauncher(["--stop"], home, base)
    expect(r.status, r.stderr).toBe(0)
    expect(isDead(agent.pid)).toBe(false)
  })

  it("SIGTERM 无效的 next-server 升级 SIGKILL", async () => {
    const home = mkHome()
    const base = await freeBase()
    const server = await stubNextServer({ port: base, cwd: mkHome(), db: path.join(home, "insight.db"), ignoreTerm: true })

    const r = runLauncher(["--stop"], home, base)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain("SIGKILL")
    expect(await eventuallyDead(server.pid)).toBe(true)
  })

  it("端口被陌生进程占用 → 退出 1 且绝不代杀", async () => {
    const home = mkHome()
    const base = await freeBase()
    const holder = await occupy(base) // 无 /health 契约的陌生 TCP 服务
    const r = runLauncher(["--stop"], home, base)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("仍被占用")
    // 占用者毫发无损（若启动器误杀端口属主，本测试进程会被杀——双重负向锁）
    expect(holder.listening).toBe(true)
  })
})

describe("固定端口语义（多人服务器：每人固定端口，绝不静默漂移）", () => {
  it("启动端口被陌生进程占用 → fail-fast 退出 1（不 migrate、不 build、不漂移）", async () => {
    const home = mkHome()
    const base = await freeBase()
    const holder = await occupy(base)
    const r = runLauncher([], home, base)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(`端口 ${base} 被占用`)
    expect(r.stderr).toContain("CONTEXT_INSIGHT_PORT")
    // 重活（migrate/build）绝不在端口被占时启动——fail-fast 必须先于重活
    expect(r.stdout + r.stderr).not.toContain("Prisma migrations")
    expect(holder.listening).toBe(true)
  })

  it("自报属于本数据目录的孤儿实例占着端口 → 拒绝启动，给出 -k / --stop 两条路", async () => {
    const home = mkHome()
    const base = await freeBase()
    const server = await stubNextServer({ port: base, cwd: mkHome(), identityHome: home })

    const r = runLauncher([], home, base)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("同一数据目录只允许一个实例")
    expect(r.stderr).toContain("ctxi -k")
    expect(r.stderr).toContain("ctxi --stop")
    expect(r.stdout + r.stderr).not.toContain("Prisma migrations")
    expect(isDead(server.pid)).toBe(false)
  })
})

describe("源断言（回归锁）", () => {
  it("SIGHUP 已挂——SSH 断开/终端关闭走清理链", () => {
    expect(binSource("launcher-web.mjs")).toContain("'SIGHUP'")
  })

  it("端口登记写入发现契约（读侧 cpx/ctxi，持久保留）", () => {
    expect(binSource("launcher-web.mjs")).toContain("writeFileSync(ctx.registryFile, `${port}\\n`)")
  })

  it("数据目录解析单点：CONTEXT_INSIGHT_HOME → ~/.context-insight，登记路径与读侧一致", () => {
    const src = binSource("launcher-context.mjs")
    expect(src).toContain("env.CONTEXT_INSIGHT_HOME || path.join(homedir(), '.context-insight')")
    expect(src).toContain("'insight-port'")
  })

  it("单槽位 PID 文件不再是击杀依据——只剩旧记录迁移一处引用", () => {
    for (const name of fs.readdirSync(path.join(PKG_DIR, "bin"))) {
      if (!name.endsWith(".mjs")) continue
      const hits = binSource(name).includes("insight.pid")
      expect(hits, `${name} 不应再引用 insight.pid`).toBe(name === "launcher-records.mjs")
    }
  })

  it("findFreePort 已退役——固定端口语义不漂移", () => {
    expect(binSource("ports.mjs")).not.toContain("findFreePort")
    expect(binSource("launcher-web.mjs")).not.toContain("findFreePort")
  })

  it("smart-agent 恒 clean——启动前回收候选区间自家的旧 agent", () => {
    expect(binSource("launcher-web.mjs")).toContain("recycleRangeAgents")
    expect(binSource("launcher-web.mjs")).not.toContain("不重复 spawn")
  })

  it("击杀升级路径：TERM 宽限 → SIGKILL（next-server 无视 TERM 实测）", () => {
    expect(binSource("launcher-stop.mjs")).toContain("'SIGKILL'")
  })

  it("归属必须带数据目录证明：install-dir 只能作旁证", () => {
    const src = binSource("launcher-instances.mjs")
    expect(src).toContain("proof.push('data-dir')")
    expect(src).toContain("proof.push('http-identity')")
    expect(src).toContain("if (proof.length === 0) continue")
    expect(src).not.toMatch(/proof\.push\('install-dir'\)/)
  })
})
