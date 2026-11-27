#!/usr/bin/env node
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 停止编排——按「启动器还在不在」自动选路，两条路都通向同一个结果：
//   控制通道：启动器活着 → 请它自己收尾（它最清楚自己的子进程），等它退出
//   证据回收：启动器没了（kill -9 / 断电 / 旧版本）→ launcher-instances 按证据
//             认领残留进程，逐个停掉
// 之后统一做候选区间 smart-agent 清理与记录整理。绝不盲杀：占端口的若不是自家
// 实例，报清它是谁（另一个数据目录的 insight 实例 / 无关进程）并给出处置命令。

import { isSmartAgent, isTcpFree } from './ports.mjs'
import { LauncherError, sleep } from './launcher-context.mjs'
import { queryLauncher, reclaimStaleEndpoint, request } from './launcher-control.mjs'
import { fetchIdentity, identityOfHome } from './launcher-identity.mjs'
import { AGENT_PORT_SPAN, IS_LINUX, describeEvidence, discoverOwn, inAgentRange, shapeOf } from './launcher-instances.mjs'
import { findPortOwnerPid, isAlive } from './launcher-proc.mjs'
import { removeRecord } from './launcher-records.mjs'

const TERM_GRACE_MS = 3000
const LAUNCHER_STOP_WAIT_MS = 15000
const PORT_RELEASE_WAIT_MS = 10000

/**
 * 停掉一组进程；返回是否真的动了手（全部已退出 → false）。
 * entries 元素 { pid, group }：group=true 优先组杀（detached 的 smart-agent 是
 * 独立进程组组长），回退单杀；TERM → 3s 宽限 → KILL 升级。
 */
export async function killProcesses(entries, label, io) {
  const alive = entries.filter((e) => Number.isInteger(e.pid) && e.pid > 0 && e.pid !== process.pid && isAlive(e.pid))
  if (alive.length === 0) return false
  io.log(`${label}: 停止 ${alive.map((e) => e.pid).join(', ')}...`)
  for (const e of alive) signalPid(e, 'SIGTERM')
  for (let i = 0; i < TERM_GRACE_MS / 100 && alive.some((e) => isAlive(e.pid)); i++) await sleep(100)
  const stubborn = alive.filter((e) => isAlive(e.pid))
  if (stubborn.length > 0) {
    io.log(`${label}: SIGTERM 未生效，SIGKILL ${stubborn.map((e) => e.pid).join(', ')}`)
    for (const e of stubborn) signalPid(e, 'SIGKILL')
    await sleep(200)
  }
  return true
}

function signalPid({ pid, group }, sig) {
  if (group) { try { process.kill(-pid, sig); return } catch { /* 组不存在/无权限 → 单杀 */ } }
  try { process.kill(pid, sig) } catch { /* 已退出 */ }
}

/** `ctxi --stop`：停掉全部自家实例；固定端口仍被非自家进程占着 → 退出码 1。 */
export async function stopCommand(ctx, io) {
  const stopped = await stopOwnInstances(ctx, io)
  const free = stopped > 0 ? await waitTcpFree(ctx.basePort, PORT_RELEASE_WAIT_MS) : await isTcpFree(ctx.basePort)
  if (!free) {
    io.error(occupantLines(ctx, await diagnosePort(ctx, ctx.basePort), '仍被占用').join('\n'))
    return 1
  }
  io.log(`端口 ${ctx.basePort} 空闲 ✓`)
  return 0
}

/** 停掉本数据目录下的全部自家实例；返回动手停掉的进程数。 */
export async function stopOwnInstances(ctx, io) {
  let stopped = 0
  const holder = await queryLauncher(ctx)
  if (holder) {
    io.log(`通知运行中的启动器停止（launcher PID ${holder.pid}，端口 ${holder.port}）...`)
    await request(ctx, { cmd: 'stop' }).catch(() => { /* 启动器恰好退出了：下面走回收 */ })
    await waitUntil(async () => !(await queryLauncher(ctx)), LAUNCHER_STOP_WAIT_MS)
  } else {
    // 启动器已死：把它遗留的控制端点文件一并清掉，数据目录不留陈旧状态
    await reclaimStaleEndpoint(ctx)
  }
  const own = await discoverOwn(ctx)
  for (const server of own.nextServers) {
    io.log(`回收未正常退出的实例（端口 ${server.port ?? ctx.basePort}，next-server PID ${server.pid}；依据：${describeEvidence(server.evidence)}）`)
    if (await killProcesses([{ pid: server.pid }], 'next-server', io)) stopped++
  }
  for (const agent of own.agents) {
    io.log(`回收未正常退出的 smart-agent (PID ${agent.pid}；依据：${describeEvidence(agent.evidence)})`)
    if (await killProcesses([{ pid: agent.pid, group: true }], 'smart-agent', io)) stopped++
  }
  const bases = [ctx.basePort, ...own.records.map((r) => r.port), ...own.nextServers.map((s) => s.port).filter(Number.isInteger)]
  stopped += await recycleRangeAgents(ctx, bases, io, new Set(own.agents.map((a) => a.pid)))
  await pruneRecords(ctx, own.records)
  if (stopped === 0 && !holder) io.log(`没有运行中的自家实例（数据目录 ${ctx.dataDir}）`)
  return stopped
}

/** 启动前的门禁：同一数据目录只允许一个实例；固定端口被非自家进程占 → 明确拒绝。 */
export async function prepareStart(ctx, { killExisting, io }) {
  if (killExisting) {
    await stopOwnInstances(ctx, io)
  } else {
    const holder = await queryLauncher(ctx)
    if (holder) {
      throw new LauncherError([
        `数据目录 ${ctx.dataDir} 已有实例在运行：端口 ${holder.port}（launcher PID ${holder.pid}）—— 同一数据目录只允许一个实例。`,
        `继续使用：${urlOf(holder.port)}      换端口重启：CONTEXT_INSIGHT_PORT=<端口> ctxi -k      停止：ctxi --stop`,
      ].join('\n'))
    }
    const own = await discoverOwn(ctx)
    if (own.nextServers.length > 0 || own.ownPorts.length > 0) {
      const where = own.nextServers.map((s) => describeServer(s)).join('；') || `端口 ${own.ownPorts.join('、')}上的服务自报属于本数据目录`
      throw new LauncherError([
        `数据目录 ${ctx.dataDir} 已有实例在运行，但不是本启动器拉起的（${where}）—— 同一数据目录只允许一个实例。`,
        `接管（停掉它并在端口 ${ctx.basePort} 重启）：ctxi -k      只停止：ctxi --stop`,
      ].join('\n'))
    }
  }
  if (!(await isTcpFree(ctx.basePort))) {
    throw new LauncherError(occupantLines(ctx, await diagnosePort(ctx, ctx.basePort), '被占用').join('\n'))
  }
}

/**
 * 候选区间内自家的 smart-agent 清理（next 启动前的恒 clean 与 --stop 收尾共用）。
 * Linux 有 /proc：只认 discoverOwn 证明了属于本数据目录的；非 Linux 无 /proc：退
 * /health 服务身份 + 属主定位，定位不到属主（可能是他人的）就避让。
 */
export async function recycleRangeAgents(ctx, basePorts, io, skip = new Set()) {
  let killed = 0
  if (IS_LINUX) {
    const { agents } = await discoverOwn(ctx)
    for (const agent of agents) {
      if (skip.has(agent.pid) || !inAgentRange(agent.port, basePorts)) continue
      io.log(`回收候选区间的 smart-agent (port ${agent.port}, PID ${agent.pid})`)
      if (await killProcesses([{ pid: agent.pid, group: true }], 'smart-agent', io)) killed++
    }
    return killed
  }
  for (const base of basePorts) {
    for (let port = base + 1; port <= base + AGENT_PORT_SPAN; port++) {
      if (!(await isSmartAgent(port))) continue
      const pid = findPortOwnerPid(port)
      if (pid && pid !== process.pid) {
        io.log(`回收候选区间的 smart-agent (port ${port}, PID ${pid})`)
        if (await killProcesses([{ pid, group: true }], 'smart-agent', io)) killed++
      } else {
        io.warn(`端口 ${port} 有 smart-agent 应答但定位不到属主（可能是他人的）—— 避让`)
      }
    }
  }
  return killed
}

/** 占用端口的到底是谁：本数据目录的自家实例 / 另一个 insight 实例 / 无关进程。 */
export async function diagnosePort(ctx, port) {
  const pid = findPortOwnerPid(port)
  const identity = await fetchIdentity(port)
  if (identityOfHome(identity, ctx)) return { kind: 'own', port, pid: pid ?? identity.pid }
  if (identity) return { kind: 'insight-other', port, pid: pid ?? identity.pid, home: identity.home }
  return { kind: 'foreign', port, pid, nextShaped: !!pid && shapeOf(pid) === 'next-server' }
}

function occupantLines(ctx, found, verb) {
  const head = `端口 ${found.port} ${verb}`
  const pid = found.pid ? `（PID ${found.pid}）` : ''
  const switchPort = ['不是自家的，换自己的固定端口（多人每人固定、间隔 ≥5）：', '  export CONTEXT_INSIGHT_PORT=<你的端口>']
  if (found.kind === 'foreign') {
    return [
      `${head}，占用者不是本数据目录的实例${pid} —— 不代杀。`,
      // 有身份端点的版本都能自报归属；对不上归属的 next-server 形态进程只剩两种：
      // 旧版 insight 实例、或无关的 Next.js 应用——都只能由用户确认
      ...(found.nextShaped ? [`它是一个 Next.js 服务进程：若是自己之前起的旧版 insight，kill ${found.pid} 后重试`] : []),
      ...switchPort,
    ]
  }
  if (found.kind === 'insight-other') {
    return [
      `${head}，是另一个 insight 实例${pid}${found.home ? `，它的数据目录是 ${found.home}` : ''} —— 不是本数据目录（${ctx.dataDir}）的实例，不代杀。`,
      ...(found.pid ? [`确认是自己的：kill ${found.pid}`] : []),
      ...switchPort,
    ]
  }
  return [
    `${head}，是本数据目录未正常退出的自家实例${pid} —— 同一数据目录只允许一个实例。`,
    '回收并重启：ctxi -k      只停止：ctxi --stop',
  ]
}

function describeServer(server) {
  const where = server.port != null ? `端口 ${server.port}` : '端口未知'
  return `${where}：next-server PID ${server.pid}，依据：${describeEvidence(server.evidence)}`
}

/** 记录整理（在击杀之后做）：重新发现一遍，next 进程已不是自家实例的记录（已回收 / PID 被复用）删除。 */
async function pruneRecords(ctx, records) {
  const living = new Set((await discoverOwn(ctx)).nextServers.map((s) => s.pid))
  for (const record of records) {
    if (!living.has(record.next)) removeRecord(ctx, record.port)
  }
}

function urlOf(port) {
  return port ? `http://localhost:${port}` : ''
}

async function waitTcpFree(port, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await isTcpFree(port)) return true
    await sleep(200)
  }
  return isTcpFree(port)
}

async function waitUntil(predicate, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(200)
  }
  return predicate()
}
