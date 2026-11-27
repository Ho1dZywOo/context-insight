#!/usr/bin/env node
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 实例控制通道——同一份数据目录的启动器互斥锁 + 停止/查询入口，二合一。
// 端点是数据目录里的一个 Unix socket（Windows 为命名管道）：内核保证同一端点
// 只有一个监听者，所以「拿到监听」=「我是这份数据目录唯一的启动器」；进程一死
// （含 kill -9）监听即消失，锁自动释放，不会留下需要猜的陈旧锁。
// 协议：一行 JSON 请求 → 一行 JSON 应答 → 关闭。命令：
//   status → { ok, product, home, port, pid, state, next, agents, version, startedAt }
//   stop   → { ok }，应答写出后启动器自行收尾并退出
// --stop 优先走这里：活着的启动器最清楚自己的子进程，让它自己收尾。

import { createHash } from 'node:crypto'
import { existsSync, statSync, unlinkSync } from 'node:fs'
import net from 'node:net'
import { platform, tmpdir } from 'node:os'
import path from 'node:path'

const REQUEST_TIMEOUT_MS = 4000
const SOCKET_PATH_LIMIT = 100

/** 控制端点候选（按优先级）：数据目录内 → 系统临时目录下的短路径兜底。 */
export function controlEndpoints(ctx) {
  const digest = createHash('sha1').update(ctx.dataDir).digest('hex').slice(0, 16)
  if (platform() === 'win32') return [`\\\\.\\pipe\\${ctx.pkgName}-instance-${digest}`]
  const tmp = tmpdir()
  const short = Buffer.byteLength(tmp) + 64 > SOCKET_PATH_LIMIT ? `.${digest}.sock` : `.${ctx.pkgName}-instance-${digest}.sock`
  return [path.join(ctx.dataDir, 'instance.sock'), path.join(tmp, short)]
}

/** @typedef {{ cmd?: string } | null} ControlMessage */
/** @typedef {{ ok: boolean, after?: () => void, [key: string]: unknown }} ControlReply */
/** @typedef {(msg: ControlMessage) => ControlReply} ControlHandler */
/** @typedef {{ ok: true, pid: number, [key: string]: unknown }} LauncherStatus */

/**
 * 占住本数据目录的控制端点。
 * 成功 → { acquired: true, endpoint, close }；已有活着的启动器 → { acquired: false, holder }；
 * 端点不可用 → 抛错。首选端点被占时不再退到兜底端点——否则同一数据目录会出现
 * 两个监听者，互斥失效。
 * @param {any} ctx
 * @param {ControlHandler} handler
 * @returns {Promise<{ acquired: true, endpoint: string, close: () => Promise<void> } | { acquired: false, holder: LauncherStatus }>}
 */
export async function startControl(ctx, handler) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const busy = []
    for (const endpoint of controlEndpoints(ctx)) {
      const server = net.createServer((sock) => serve(sock, handler))
      const err = await listen(server, endpoint)
      if (!err) return { acquired: true, endpoint, close: () => closeServer(server, endpoint) }
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') { busy.push(endpoint); break }
    }
    const endpoint = busy[0]
    const holder = await request(ctx, { cmd: 'status' }, endpoint).catch(() => null)
    if (holder?.ok) return { acquired: false, holder }
    // 端点在、无人应答 = 上个启动器被 kill -9 留下的套接字文件：清掉重试
    if (!(await reclaimStaleEndpoint(ctx, endpoint))) break
  }
  throw new Error(`实例控制端点不可用：${controlEndpoints(ctx).join(' / ')}`)
}

/**
 * 清掉无人应答的控制端点文件（启动器被 kill -9 的遗留）。
 * @param {any} ctx
 * @param {string} [onlyEndpoint]
 * @returns {Promise<boolean>} 是否清掉了文件
 */
export async function reclaimStaleEndpoint(ctx, onlyEndpoint = null) {
  if (platform() === 'win32') return false
  let reclaimed = false
  for (const endpoint of onlyEndpoint ? [onlyEndpoint] : controlEndpoints(ctx)) {
    if (!existsSync(endpoint)) continue
    const alive = await request(ctx, { cmd: 'status' }, endpoint).catch(() => null)
    if (alive?.ok) continue
    try { unlinkSync(endpoint); reclaimed = true } catch { /* 他人的文件 */ }
  }
  return reclaimed
}

/** 本数据目录的启动器是否活着；活着 → 它的 status，否则 null。 */
export async function queryLauncher(ctx) {
  const status = await request(ctx, { cmd: 'status' }).catch(() => null)
  if (!status?.ok || !Number.isInteger(status.pid)) return null
  return { ...status, foreignProduct: status.product !== ctx.pkgName }
}

/** 向控制端点发一条命令（逐个候选端点试，取第一个应答）。 */
export async function request(ctx, msg, onlyEndpoint = null) {
  let lastError = null
  for (const endpoint of onlyEndpoint ? [onlyEndpoint] : controlEndpoints(ctx)) {
    try { return await exchange(endpoint, msg) } catch (e) { lastError = e }
  }
  throw lastError ?? new Error('无控制端点')
}

function listen(server, endpoint) {
  return new Promise((resolve) => {
    server.once('error', resolve)
    server.listen(endpoint, () => resolve(null))
  })
}

function exchange(endpoint, msg) {
  return new Promise((resolve, reject) => {
    if (platform() !== 'win32' && existsSync(endpoint)) {
      try {
        if (statSync(endpoint).uid !== process.getuid?.()) return reject(new Error('控制端点属于其他用户'))
      } catch { /* 竞态：紧接着的 connect 自己会失败 */ }
    }
    const sock = net.createConnection(endpoint)
    let buf = ''
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('控制通道应答超时')) }, REQUEST_TIMEOUT_MS)
    sock.on('connect', () => sock.write(JSON.stringify(msg) + '\n'))
    sock.on('data', (chunk) => { buf += chunk })
    sock.on('error', (e) => { clearTimeout(timer); reject(e) })
    sock.on('end', () => {
      clearTimeout(timer)
      try { resolve(JSON.parse(buf)) } catch (e) { reject(e) }
    })
  })
}

function serve(sock, handler) {
  let buf = ''
  const timer = setTimeout(() => sock.destroy(), REQUEST_TIMEOUT_MS)
  sock.setEncoding('utf8')
  sock.on('error', () => clearTimeout(timer))
  sock.on('data', (chunk) => {
    buf += chunk
    if (!buf.includes('\n')) return
    sock.pause()
    let msg = null
    try { msg = JSON.parse(buf.slice(0, buf.indexOf('\n'))) } catch { /* 非法请求按未知命令应答 */ }
    let res
    try { res = handler(msg) ?? { ok: false, error: 'unknown command' } } catch (e) { res = { ok: false, error: String(e?.message ?? e) } }
    const after = typeof res.after === 'function' ? res.after : null
    // after 是给本进程的回调（应答 flush 之后再执行），不出协议
    const body = { ...res, after: undefined }
    sock.end(JSON.stringify(body) + '\n', () => { clearTimeout(timer); after?.() })
  })
}

function closeServer(server, endpoint) {
  return new Promise((resolve) => {
    server.close(() => {
      if (platform() !== 'win32') { try { unlinkSync(endpoint) } catch { /* 已消失 */ } }
      resolve()
    })
    server.closeAllConnections?.()
  })
}
