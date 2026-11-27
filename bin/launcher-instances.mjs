#!/usr/bin/env node
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 自家实例的判定与发现——「谁算我这份数据目录的实例」的唯一真相源。
//
// 归属键是数据目录，不是安装目录：一个安装目录可以服务多份数据目录（源码仓里
// start.sh 起的实例、npx 缓存、开发时的多 HOME 隔离），按安装目录认领会误伤
// 别的数据目录的实例。所以一个进程是自家的，当且仅当：
//   形态对得上 且 至少一条数据目录证明：
//     next-server —— data-dir 打开了本数据目录的库文件 / http-identity 服务端自报
//                    身份属于本数据目录 / record 本数据目录的实例记录在案且端口吻合
//     smart-agent —— record 本数据目录的记录在案 / adjacent 端口紧邻本数据目录的
//                    next-server（一个实例的 agent 只落在它端口后面 3 个里）
// 工作目录是本包安装目录（install-dir）只是旁证，单独不足以归属。
// 旧版只认单槽位 PID 文件：记录缺失或被覆盖就认不出占端口的自家实例——kill -9
// 后 --stop 停不掉的病根。现在记录只是三条证明之一，候选一律重新验证。
// 证明不了的一律不杀（他人进程的 /proc 天然读不到；同用户别的数据目录的实例
// 没有本数据目录的证明），只如实报告并给出 kill 命令。

import path from 'node:path'
import { platform } from 'node:os'
import { samePath } from './launcher-context.mjs'
import { fetchIdentity, identityOfHome } from './launcher-identity.mjs'
import { findPortOwnerPid, isAlive, listPids, listeningPorts, readArgs, readCwd, readOpenFiles } from './launcher-proc.mjs'
import { listRecords } from './launcher-records.mjs'

/** smart-agent 端口候选区间长度：一个实例的 agent 落在它端口后面这 3 个里。 */
export const AGENT_PORT_SPAN = 3

export const IS_LINUX = platform() === 'linux'

const NEXT_BIN = /(^|\/)next(\/dist\/bin\/next|\.js)?$/

const EVIDENCE_LABEL = {
  'data-dir': '打开了本数据目录的库',
  'http-identity': '自报身份属于本数据目录',
  record: '本数据目录的实例记录在案',
  adjacent: '端口紧邻本数据目录的实例',
  'install-dir': '工作目录是本包安装目录',
}

/** 进程形态（与归属无关）：next-server / smart-agent / unknown。 */
export function shapeOf(pid) {
  const args = readArgs(pid)
  if (!args || args.length === 0) return 'unknown'
  if (args[0].startsWith('next-server')) return 'next-server'
  if (args.includes('start') && args.some((a) => NEXT_BIN.test(a))) return 'next-server'
  if (/^python\S*\s+server\.py/.test(args.slice(0, 2).join(' '))) return 'smart-agent'
  return 'unknown'
}

/**
 * 发现本数据目录的全部自家进程。
 * → {
 *     nextServers: [{ pid, port, evidence, cwd }],        // 每个是一条 next-server
 *     agents: [{ pid, port, evidence, belongsTo }],       // belongsTo = 所服务实例的端口
 *     records,                                            // 本数据目录的实例记录
 *     ownPorts: number[],                                 // 自报身份属于本数据目录但定位不到进程的端口
 *   }
 * port 为 null 表示进程当前没在监听。
 */
export async function discoverOwn(ctx) {
  const records = listRecords(ctx)
  const recorded = { next: new Set(), agents: new Set() }
  for (const record of records) {
    if (Number.isInteger(record.next)) recorded.next.add(record.next)
    for (const pid of record.agents ?? []) if (Number.isInteger(pid)) recorded.agents.add(pid)
  }

  // 候选池：形态对得上且存活的进程（依据在后面统一验证）
  const candidates = new Map()
  const consider = (pid, via) => {
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || isAlive(pid) === false) return
    const shape = shapeOf(pid)
    if (shape === 'unknown') return
    const entry = candidates.get(pid) ?? { shape, via: new Set() }
    entry.via.add(via)
    candidates.set(pid, entry)
  }
  // ① 记录里的候选 PID
  for (const pid of recorded.next) consider(pid, 'record')
  for (const pid of recorded.agents) consider(pid, 'record')
  // ② 全表扫描（仅 Linux）：记录缺失 / 被覆盖也能把候选捞出来
  for (const pid of listPids() ?? []) consider(pid, 'scan')
  // ③ 端口属主 + 服务端自报身份（跨平台锚点）
  const byHttp = new Set()
  const ownPorts = new Set()
  for (const port of new Set([ctx.basePort, ...records.map((r) => r.port)])) {
    const owner = findPortOwnerPid(port)
    if (owner) consider(owner, 'port-owner')
    const identity = await fetchIdentity(port)
    if (!identityOfHome(identity, ctx)) continue
    ownPorts.add(port)
    const pid = owner ?? (Number.isInteger(identity.pid) ? identity.pid : null)
    if (pid != null) { byHttp.add(pid); consider(pid, 'http-identity') }
  }

  const details = new Map()
  for (const [pid, entry] of candidates) {
    details.set(pid, { pid, port: pickPort(listeningPorts(pid)), cwd: readCwd(pid), opensDb: entry.shape === 'next-server' && opensDatabase(pid, ctx) })
  }

  const nextServers = []
  for (const [pid, entry] of candidates) {
    if (entry.shape !== 'next-server') continue
    const detail = details.get(pid)
    const proof = []
    if (detail.opensDb) proof.push('data-dir')
    if (byHttp.has(pid)) proof.push('http-identity')
    const record = records.find((r) => r.next === pid)
    if (record && (record.port == null || detail.port == null || detail.port === record.port)) proof.push('record')
    if (proof.length === 0) continue
    nextServers.push({ ...detail, evidence: [...proof, ...(samePath(detail.cwd, ctx.pkgDir) ? ['install-dir'] : [])] })
  }
  nextServers.sort((a, b) => (a.port ?? 0) - (b.port ?? 0))

  const serverPorts = new Set(nextServers.map((s) => s.port).filter(Number.isInteger))
  const agents = []
  for (const [pid, entry] of candidates) {
    if (entry.shape !== 'smart-agent') continue
    const detail = details.get(pid)
    const belongsTo = serverPortOf(detail.port, serverPorts)
    const proof = []
    if (belongsTo != null) proof.push('adjacent')
    const record = records.find((r) => (r.agents ?? []).includes(pid))
    if (record && (record.port == null || detail.port == null || inRange(detail.port, record.port))) proof.push('record')
    if (proof.length === 0) continue
    agents.push({ ...detail, opensDb: false, evidence: [...proof, ...(samePath(detail.cwd, path.join(ctx.pkgDir, 'smart-agent')) ? ['install-dir'] : [])], belongsTo })
  }

  return { nextServers, agents, records, ownPorts: [...ownPorts] }
}

function opensDatabase(pid, ctx) {
  const files = readOpenFiles(pid)
  if (!files) return false
  for (const file of files) {
    if (samePath(file, ctx.dbPath)) return true
  }
  return false
}

function pickPort(ports) {
  return ports && ports.size > 0 ? Math.min(...ports) : null
}

function inRange(port, base) {
  return port != null && port > base && port <= base + AGENT_PORT_SPAN
}

function serverPortOf(agentPort, serverPorts) {
  if (agentPort == null) return null
  for (let k = 1; k <= AGENT_PORT_SPAN; k++) {
    if (serverPorts.has(agentPort - k)) return agentPort - k
  }
  return null
}

/** agent 的端口是否落在给定实例端口的候选区间内。 */
export function inAgentRange(agentPort, basePorts) {
  return basePorts.some((base) => inRange(agentPort, base))
}

/** 用户可读的归属证明。 */
export function describeEvidence(evidence) {
  return evidence.map((e) => EVIDENCE_LABEL[e] ?? e).join('、')
}
