// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See the License in the root of the software repository for the full text of the License.

/**
 * 实例身份契约 IT：GET /api/instance/identity（服务端自报）↔ bin/launcher-identity.mjs
 * （npm 启动器的读取与归属判定）。启动器靠它判断端口上的服务是不是本数据目录的
 * 实例，两侧字段必须对得上——这里用真实 HTTP 把两端接起来验。
 */
import { describe, it, expect, afterAll } from "vitest"
import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import path from "node:path"
import os from "node:os"
import { GET } from "@/app/api/instance/identity/route"
import { readInstanceIdentity } from "@/lib/instance-identity"
import { VERSION } from "@/lib/version"
import { fetchIdentity, identityOfHome } from "../../bin/launcher-identity.mjs"
import { resolveContext } from "../../bin/launcher-context.mjs"

const cleanups: Array<() => void> = []
afterAll(() => {
  cleanups.splice(0).forEach((fn) => {
    try { fn() } catch { /* 尽力而为 */ }
  })
})

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port
      s.close(() => resolve(p))
    })
  })
}

/** 起一个只挂身份路由的真实 HTTP 服务（返回体与线上路由逐字节同源）。 */
async function serveIdentity(): Promise<{ port: number }> {
  const port = await freePort()
  const server = http.createServer(async (req, res) => {
    if (req.url !== "/api/instance/identity") { res.writeHead(404).end(); return }
    const routeRes = await GET()
    res.writeHead(routeRes.status, Object.fromEntries(routeRes.headers))
    res.end(await routeRes.text())
  })
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve))
  cleanups.push(() => server.close())
  return { port }
}

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctxi-identity-it-"))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

describe("GET /api/instance/identity", () => {
  it("自报产品 / 版本 / 进程 / 数据目录 / 安装目录，字段齐整且禁缓存", async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    const body = await res.json()
    expect(body).toMatchObject({
      product: "context-insight",
      brand: "Context-Insight",
      version: VERSION,
      pid: process.pid,
      packageDir: process.cwd(),
    })
    expect(typeof body.home).toBe("string")
    expect(Number.isInteger(body.buildId) || typeof body.buildId === "string").toBe(true)
    expect(new Date(body.startedAt).toString()).not.toBe("Invalid Date")
  })

  it("数据目录随 CONTEXT_INSIGHT_HOME；端口与启动器 PID 来自启动器写入的 env", () => {
    const identity = readInstanceIdentity({ CONTEXT_INSIGHT_HOME: "/tmp/identity-it-home", PORT: "21800", CONTEXT_INSIGHT_LAUNCHER_PID: "4242" })
    expect(identity).toMatchObject({ home: "/tmp/identity-it-home", port: 21800, launcherPid: 4242 })
    expect(readInstanceIdentity({})).toMatchObject({
      home: path.join(os.homedir(), ".context-insight"),
      port: null,
      launcherPid: null,
    })
  })
})

describe("启动器读取身份（真实 HTTP）", () => {
  it("本数据目录的本产品实例 → 认定为自家", async () => {
    // 路由在测试进程内执行：它自报的数据目录就是本进程的 CONTEXT_INSIGHT_HOME
    const home = readInstanceIdentity().home
    const { port } = await serveIdentity()
    const identity = await fetchIdentity(port)
    expect(identity).toMatchObject({ product: "context-insight", home, pid: process.pid })
    expect(identityOfHome(identity, resolveContext({ CONTEXT_INSIGHT_HOME: home }))).toBe(true)
  })

  it("别的数据目录 / 别的产品 → 不认", async () => {
    const home = tempHome()
    const { port } = await serveIdentity()
    const identity = (await fetchIdentity(port))!
    expect(identityOfHome(identity, resolveContext({ CONTEXT_INSIGHT_HOME: tempHome() }))).toBe(false)
    expect(identityOfHome({ ...identity, product: "someone-else" }, resolveContext({ CONTEXT_INSIGHT_HOME: home }))).toBe(false)
  })

  it("不是 insight 实例的端口 → null（无关 HTTP 服务 / 无人监听 / 挂起不应答）", async () => {
    const plain = http.createServer((_req, res) => { res.writeHead(200).end("ok") })
    const port = await freePort()
    await new Promise<void>((resolve) => plain.listen(port, "127.0.0.1", resolve))
    cleanups.push(() => plain.close())
    expect(await fetchIdentity(port)).toBeNull()

    const silent = http.createServer(() => { /* 收下连接不应答 */ })
    const silentPort = await freePort()
    await new Promise<void>((resolve) => silent.listen(silentPort, "127.0.0.1", resolve))
    cleanups.push(() => { silent.closeAllConnections(); silent.close() })
    const started = Date.now()
    expect(await fetchIdentity(silentPort, 800)).toBeNull()
    expect(Date.now() - started).toBeLessThan(4000)

    expect(await fetchIdentity(await freePort())).toBeNull()
  })
})

