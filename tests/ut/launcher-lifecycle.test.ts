// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See the License in the root of the software repository for the full text of the License.

/**
 * npm 全局启动器的实例生命周期 IT（真实进程 / 真实 Unix socket / 真实 /proc）。
 *
 * 客户问题：kill -9 启动器后重启 insight 报端口被占用，--stop / -k 都停不掉后台进程。
 * 实例语义：
 *   - 控制通道 = 数据目录里的 socket，既是启动器互斥锁（同一数据目录只允许一个实例），
 *     也是活着的启动器的停止入口；进程一死监听即消失，不留下需要猜的陈旧锁
 *   - 启动器没了 → 按证据回收残留进程（tests/ut/launcher-multi-user.test.ts 覆盖证据模型）
 * 假启动器（tests/helpers/launcher-fake.mjs）用真实模块扮「活着的启动器」。
 */
import { describe, it, expect, afterEach } from "vitest"
import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isTcpFree } from "../../bin/ports.mjs"
import { resolveContext } from "../../bin/launcher-context.mjs"
import { controlEndpoints, queryLauncher, startControl } from "../../bin/launcher-control.mjs"
import { listRecords } from "../../bin/launcher-records.mjs"
import { runningBuilds, waitForRunningBuild } from "../../bin/launcher-web.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PKG_DIR = path.resolve(__dirname, "../..")
const LAUNCHER = path.join(PKG_DIR, "bin", "context-insight.mjs")
const FAKE_LAUNCHER = path.join(PKG_DIR, "tests", "helpers", "launcher-fake.mjs")

const cleanups: Array<() => void> = []
afterEach(() => {
  cleanups.splice(0).forEach((fn) => {
    try { fn() } catch { /* 尽力而为 */ }
  })
})

function mkHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctxi-lifecycle-it-"))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function freeBase(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const port = await new Promise<number>((resolve) => {
      const s = net.createServer()
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as net.AddressInfo).port
        s.close(() => resolve(p))
      })
    })
    if ((await isTcpFree(port)) && (await isTcpFree(port + 1))) return port
  }
  throw new Error("20 次内未找到两连空闲端口")
}

function runLauncher(cliArgs: string[], home: string, base: number): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [LAUNCHER, ...cliArgs], {
    env: { ...process.env, CONTEXT_INSIGHT_HOME: home, CONTEXT_INSIGHT_PORT: String(base), CONTEXT_NO_BROWSER: "1" },
    encoding: "utf8",
    timeout: 30_000,
  })
}

function track(child: ChildProcess): ChildProcess {
  cleanups.push(() => { try { child.kill("SIGKILL") } catch { /* 尽力而为 */ } })
  return child
}

async function eventuallyTrue(check: () => boolean | Promise<boolean>, what: string, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`等待超时：${what}`)
}

/** 假 next-server：形态与真实一致、打开本数据目录的库、监听指定端口。 */
const NEXT_STUB = `
  const fs = require("node:fs"), http = require("node:http")
  process.title = "next-server (v16.2.9)"
  fs.openSync(process.env.STUB_DB, "a")
  http.createServer((q, s) => s.writeHead(404).end()).listen(Number(process.env.STUB_PORT), "127.0.0.1")
`
function stubNextServer(port: number, db: string): ChildProcess {
  return track(spawn(process.execPath, ["-e", NEXT_STUB], {
    cwd: mkHome(),
    stdio: "ignore",
    env: { ...process.env, STUB_PORT: String(port), STUB_DB: db },
  }))
}

/** 假 smart-agent：argv0 换成 `python3 server.py`，工作目录是本包的 smart-agent/。 */
const AGENT_STUB = `
  require("node:http").createServer((q, s) => {
    if (q.url === "/health") {
      s.writeHead(200, { "content-type": "application/json" })
      s.end(JSON.stringify({ service: "context-smart-agent" }))
    } else { s.writeHead(404).end() }
  }).listen(Number(process.env.STUB_PORT), "127.0.0.1")
`
function stubAgent(port: number): ChildProcess {
  return track(spawn("bash", ["-c", 'exec -a "python3 server.py" node -e "$STUB_CODE"'], {
    cwd: path.join(PKG_DIR, "smart-agent"),
    detached: true,
    stdio: "ignore",
    env: { ...process.env, STUB_PORT: String(port), STUB_CODE: AGENT_STUB },
  }))
}

async function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection({ port, host: "127.0.0.1" })
    s.once("connect", () => { s.destroy(); resolve(true) })
    s.once("error", () => resolve(false))
  })
}

/** 等若干端口全部进入监听态。 */
async function waitListening(what: string, ...ports: number[]): Promise<void> {
  await eventuallyTrue(async () => (await Promise.all(ports.map(isListening))).every(Boolean), what)
}

/** 数据目录里现存的实例记录文件名。 */
function recordFiles(home: string): string[] {
  const dir = path.join(home, "instances")
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith(".json")) : []
}

function isDead(pid: number | undefined): boolean {
  if (!pid) return false
  try { process.kill(pid, 0); return false } catch { return true }
}

/** 起一个活着的假启动器（占住控制端点、落实例记录），等它就绪。 */
async function startFakeLauncher(home: string, base: number, nextPid: number, agentPid?: number): Promise<ChildProcess> {
  const child = track(spawn(process.execPath, [FAKE_LAUNCHER, home, String(base), String(nextPid), agentPid ? String(agentPid) : "-"], {
    stdio: ["ignore", "pipe", "pipe"],
  }))
  let output = ""
  child.stdout!.on("data", (d: Buffer) => { output += d.toString() })
  child.stderr!.on("data", (d: Buffer) => { output += d.toString() })
  await eventuallyTrue(() => output.includes("READY"), `假启动器就绪（输出：${output}）`)
  return child
}

const ctxOf = (home: string, base: number) => resolveContext({ CONTEXT_INSIGHT_HOME: home, CONTEXT_INSIGHT_PORT: String(base) })

type ControlHandler = Parameters<typeof startControl>[1]

/** 取得控制端点，取不到直接判测试失败。 */
async function acquire(ctx: ReturnType<typeof ctxOf>, handler: ControlHandler) {
  const control = await startControl(ctx, handler)
  if (!control.acquired) throw new Error(`控制端点被 launcher PID ${control.holder.pid} 占用`)
  return control
}

/** 期望取不到控制端点，返回持有者的 status。 */
async function expectHeld(ctx: ReturnType<typeof ctxOf>) {
  const control = await startControl(ctx, () => ({ ok: true }))
  if (control.acquired) { await control.close(); throw new Error("本应取不到控制端点") }
  return control.holder
}

describe("控制通道：启动器活着 → 让它自己收尾", () => {
  it("--stop 通知运行中的启动器停止：子进程全停、记录与 socket 清除", async () => {
    const home = mkHome()
    const base = await freeBase()
    const server = stubNextServer(base, path.join(home, "insight.db"))
    const agent = stubAgent(base + 1)
    await waitListening("桩进程监听", base, base + 1)
    const launcher = await startFakeLauncher(home, base, server.pid!, agent.pid!)

    // 控制通道里能看到这个实例的身份
    const status = await queryLauncher(ctxOf(home, base))
    expect(status).toMatchObject({ pid: launcher.pid, port: base, next: server.pid, state: "ready" })
    expect(fs.existsSync(path.join(home, "instances", `${base}.json`))).toBe(true)

    const r = runLauncher(["--stop"], home, base)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain(`通知运行中的启动器停止（launcher PID ${launcher.pid}，端口 ${base}）`)
    // 启动器自己走完收尾退出（退出码 0），没有走到「按证据回收」那条路
    await eventuallyTrue(() => launcher.exitCode === 0, `假启动器退出（code=${launcher.exitCode}）`)
    expect(r.stdout).not.toContain("回收未正常退出")
    expect(fs.existsSync(path.join(home, "instances", `${base}.json`))).toBe(false)
    expect(fs.existsSync(controlEndpoints(ctxOf(home, base))[0])).toBe(false)
  })
})

describe("启动器被 kill -9 后的回收", () => {
  it("--stop 清掉陈旧 socket，按证据回收残留的 next-server 与 smart-agent", async () => {
    const home = mkHome()
    const base = await freeBase()
    const server = stubNextServer(base, path.join(home, "insight.db"))
    const agent = stubAgent(base + 1)
    await waitListening("桩进程监听", base, base + 1)
    const launcher = await startFakeLauncher(home, base, server.pid!, agent.pid!)
    launcher.kill("SIGKILL")
    await eventuallyTrue(() => launcher.signalCode === "SIGKILL", "假启动器被 kill -9")

    const ctx = ctxOf(home, base)
    expect(fs.existsSync(controlEndpoints(ctx)[0]), "kill -9 留下陈旧 socket 文件").toBe(true)
    expect(await queryLauncher(ctx), "无人应答 = 启动器已死").toBeNull()

    const r = runLauncher(["--stop"], home, base)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).not.toContain("通知运行中的启动器停止")
    expect(r.stdout).toContain(`next-server PID ${server.pid}`)
    expect(r.stdout).toContain(`smart-agent (PID ${agent.pid}`)
    expect(r.stdout).toContain(`端口 ${base} 空闲`)
    expect(fs.existsSync(path.join(home, "instances", `${base}.json`))).toBe(false)
    expect(fs.existsSync(controlEndpoints(ctx)[0])).toBe(false)
    expect(await isTcpFree(base)).toBe(true)
  })
})

describe("同一数据目录只允许一个实例", () => {
  it("启动器活着时再启动 → 拒绝：报出现有实例的端口，给出继续使用 / -k / --stop", async () => {
    const home = mkHome()
    const base = await freeBase()
    const server = stubNextServer(base, path.join(home, "insight.db"))
    await waitListening("桩进程监听", base)
    const launcher = await startFakeLauncher(home, base, server.pid!)

    const r = runLauncher([], home, base)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("同一数据目录只允许一个实例")
    expect(r.stderr).toContain(`端口 ${base}（launcher PID ${launcher.pid}）`)
    expect(r.stderr).toContain(`http://localhost:${base}`)
    expect(r.stderr).toContain("ctxi -k")
    expect(r.stderr).toContain("ctxi --stop")
    expect(r.stdout + r.stderr).not.toContain("Prisma migrations")
    expect(isDead(server.pid)).toBe(false)
    expect(launcher.exitCode, "拒绝启动不得动现有实例").toBeNull()
  })

  it("换端口也起不来第二个：归属键是数据目录，不是端口（客户场景 E）", async () => {
    const home = mkHome()
    const base = await freeBase()
    const otherBase = base + 10
    const server = stubNextServer(base, path.join(home, "insight.db"))
    await waitListening("桩进程监听", base)
    await startFakeLauncher(home, base, server.pid!)

    const r = runLauncher([], home, otherBase)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("同一数据目录只允许一个实例")
    expect(r.stderr).toContain(`端口 ${base}`)
    expect(r.stderr).not.toContain(`端口: ${otherBase}`)
  })

  it("--stop 停掉本数据目录的全部实例（历史遗留的多端口记录一个不留）", async () => {
    const home = mkHome()
    const base = await freeBase()
    const second = base + 10
    const serverA = stubNextServer(base, path.join(home, "insight.db"))
    const serverB = stubNextServer(second, path.join(home, "insight.db"))
    await waitListening("桩进程监听", base, second)
    const { saveRecord } = await import("../../bin/launcher-records.mjs")
    saveRecord(ctxOf(home, base), { port: base, launcher: null, next: serverA.pid, agents: [], packageDir: PKG_DIR, product: "context-insight", version: "test", startedAt: null })
    saveRecord(ctxOf(home, second), { port: second, launcher: null, next: serverB.pid, agents: [], packageDir: PKG_DIR, product: "context-insight", version: "test", startedAt: null })

    const r = runLauncher(["--stop"], home, base)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain(`端口 ${base}，next-server PID ${serverA.pid}`)
    expect(r.stdout).toContain(`端口 ${second}，next-server PID ${serverB.pid}`)
    expect(recordFiles(home)).toEqual([])
  })
})

describe("构建期间启动器被强杀：同一安装目录的孤儿构建", () => {
  const BUILD_STUB = `require("node:fs").writeFileSync(process.env.STUB_READY, "1"); setInterval(() => {}, 1000)`
  /** 形态为 `node <dir>/next/dist/bin/next build` 的桩（真实构建主进程的参数形态）。 */
  function stubBuild(cwd: string): ChildProcess {
    const dir = mkHome()
    const script = path.join(dir, "next", "dist", "bin", "next")
    fs.mkdirSync(path.dirname(script), { recursive: true })
    fs.writeFileSync(script, BUILD_STUB)
    const ready = path.join(dir, "ready")
    const child = track(spawn(process.execPath, [script, "build"], { cwd, stdio: "ignore", env: { ...process.env, STUB_READY: ready } }))
    let waited = 0
    while (!fs.existsSync(ready) && (waited += 20) < 5000) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    return child
  }
  const silentIo = () => {
    const lines: string[] = []
    return { lines, io: { log: (m: string) => lines.push(m), warn: (m: string) => lines.push(m), error: (m: string) => lines.push(m) } }
  }

  it("工作目录是本包安装目录的构建才算；别处的构建不算", () => {
    const ctx = ctxOf(mkHome(), 21516)
    const own = stubBuild(PKG_DIR)
    const elsewhere = stubBuild(mkHome())
    expect(runningBuilds(ctx)).toEqual([own.pid])
    expect(runningBuilds(ctx)).not.toContain(elsewhere.pid)
  })

  it("构建前等它结束：结束后放行（此时 BUILD_ID 已在，不必再构建）", async () => {
    const ctx = ctxOf(mkHome(), 21517)
    const build = stubBuild(PKG_DIR)
    const { lines, io } = silentIo()
    const waiting = waitForRunningBuild(ctx, null, io)
    await new Promise((r) => setTimeout(r, 300))
    build.kill("SIGKILL")
    await waiting
    expect(lines).toEqual([expect.stringContaining(`等它结束`)])
    expect(lines[0]).toContain(`PID ${build.pid}`)
  })

  it("没有进行中的构建时不等待、不输出", async () => {
    const { lines, io } = silentIo()
    await waitForRunningBuild(ctxOf(mkHome(), 21518), null, io)
    expect(lines).toEqual([])
  })

  it("等不到 → 明确报错（不静默进入必然失败的构建）", async () => {
    const ctx = ctxOf(mkHome(), 21519)
    const build = stubBuild(PKG_DIR)
    const { lines, io } = silentIo()
    await expect(waitForRunningBuild(ctx, null, io, 1200)).rejects.toThrow(/未结束/)
    expect(lines.some((l) => l.includes(`PID ${build.pid}`))).toBe(true)
  })
})

describe("控制端点互斥（直接驱动 bin/launcher-control.mjs）", () => {
  it("同一端点只有一个监听者：后来者拿到持有者的 status，释放后可重新取得", async () => {
    const ctx = ctxOf(mkHome(), 21511)
    fs.mkdirSync(ctx.dataDir, { recursive: true })
    const first = await acquire(ctx, (msg) => (msg?.cmd === "status" ? { ok: true, product: ctx.pkgName, home: ctx.dataDir, port: 21511, pid: process.pid } : { ok: false }))

    expect(await expectHeld(ctx)).toMatchObject({ pid: process.pid, port: 21511 })

    await first.close()
    expect(await queryLauncher(ctx)).toBeNull()
    const third = await acquire(ctx, () => ({ ok: true }))
    await third.close()
  })

  it("端点位置被无人监听的文件占着（崩溃遗留）→ 清掉后取得", async () => {
    const ctx = ctxOf(mkHome(), 21512)
    fs.mkdirSync(ctx.dataDir, { recursive: true })
    fs.writeFileSync(controlEndpoints(ctx)[0], "")
    await (await acquire(ctx, () => ({ ok: true }))).close()
  })

  it("status 必须应答数据目录——换一份数据目录查询时视作没有启动器", async () => {
    const ctx = ctxOf(mkHome(), 21513)
    fs.mkdirSync(ctx.dataDir, { recursive: true })
    const control = await acquire(ctx, (msg) => (msg?.cmd === "status" ? { ok: true, product: ctx.pkgName, home: ctx.dataDir, port: 21513, pid: process.pid } : { ok: false }))
    expect(await queryLauncher(ctx)).toMatchObject({ home: ctx.dataDir, product: "context-insight" })
    expect(await queryLauncher(ctxOf(mkHome(), 21513))).toBeNull()
    await control.close()
  })
})

describe("实例记录", () => {
  it("旧版单槽位 insight.pid 自动迁移为每端口记录，旧文件移除", () => {
    const home = mkHome()
    const base = 21514
    fs.writeFileSync(path.join(home, "insight.pid"), JSON.stringify({ launcher: 111, next: 222, agents: [333], port: base, savedAt: "2026-11-01T00:00:00.000Z" }))
    const records = listRecords(ctxOf(home, base))
    expect(records).toEqual([expect.objectContaining({ port: base, launcher: 111, next: 222, agents: [333], startedAt: "2026-11-01T00:00:00.000Z" })])
    expect(fs.existsSync(path.join(home, "insight.pid"))).toBe(false)
    expect(fs.existsSync(path.join(home, "instances", `${base}.json`))).toBe(true)
    expect(listRecords(ctxOf(home, base))).toHaveLength(1)
  })

  it("损坏的旧记录按不存在处理（不抛、不留文件）", () => {
    const home = mkHome()
    fs.writeFileSync(path.join(home, "insight.pid"), "{not json")
    expect(listRecords(ctxOf(home, 21515))).toEqual([])
    expect(fs.existsSync(path.join(home, "insight.pid"))).toBe(false)
  })
})
