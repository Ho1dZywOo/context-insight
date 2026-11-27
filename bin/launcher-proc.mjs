#!/usr/bin/env node
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 进程观测层——启动器家族共用的唯一「怎么看一个进程」入口。
// Linux 走 /proc（cmdline / cwd / 打开的文件 / 监听端口 / 端口属主，零子进程）；
// 非 Linux 退 lsof（与 start.sh 同款回退）。取不到一律返回 null，绝不抛。
// 他人进程的 /proc/<pid>/fd 与 cwd 天然读不到（权限）——本层「取得到」本身就是
// 「属于当前用户」的证明，上层据此做到结构性不越权。

import { readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { platform } from 'node:os'

const LINUX = platform() === 'linux'
const DELETED_SUFFIX = ' (deleted)'

/** 进程是否存活（Linux 上僵尸态按已退出处理：它已经不占任何资源，只等父进程收割）。 */
export function isAlive(pid) {
  try { process.kill(pid, 0) } catch { return false }
  if (!LINUX) return true
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z'
  } catch { return false }
}

/** 全部进程 PID（仅 Linux；其它平台 null）。 */
export function listPids() {
  if (!LINUX) return null
  try { return readdirSync('/proc').filter((d) => /^\d+$/.test(d)).map(Number) } catch { return null }
}

/**
 * 进程的参数数组。next-server 启动后会自改进程标题，此时 args[0] 就是新标题
 * （如 `next-server (v16.2.9)`）；取不到 → null。
 */
export function readArgs(pid) {
  if (!LINUX) return null
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean) } catch { return null }
}

/** 进程工作目录；取不到 → null。 */
export function readCwd(pid) {
  if (LINUX) {
    try { return readlinkSync(`/proc/${pid}/cwd`) } catch { return null }
  }
  const line = lsof(['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])?.split('\n').find((l) => l.startsWith('n'))
  return line ? line.slice(1) : null
}

/** 进程打开的文件路径集合；取不到 → null。 */
export function readOpenFiles(pid) {
  if (LINUX) {
    const targets = readFdTargets(pid)
    if (!targets) return null
    return new Set([...targets].map((t) => t.replace(DELETED_SUFFIX, '')))
  }
  const out = lsof(['-a', '-p', String(pid), '-Fn'])
  if (out == null) return null
  return new Set(out.split('\n').filter((l) => l.startsWith('n')).map((l) => l.slice(1)))
}

/** 进程正在监听的 TCP 端口集合；取不到 → null。 */
export function listeningPorts(pid) {
  if (LINUX) {
    const inodes = new Set()
    for (const target of readFdTargets(pid) ?? []) {
      const m = target.match(/^socket:\[(\d+)\]$/)
      if (m) inodes.add(m[1])
    }
    if (inodes.size === 0) return new Set()
    return new Set(listenTable().filter((row) => inodes.has(row.inode)).map((row) => row.port))
  }
  const out = lsof(['-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-P', '-Fn'])
  if (out == null) return null
  return new Set(out.split('\n').map((l) => l.match(/:(\d+)$/)?.[1]).filter(Boolean).map(Number))
}

/**
 * 端口监听进程的 PID（--stop 与端口诊断的锚点）。逐进程扫 /proc/<pid>/fd 需要
 * 权限——他人进程天然定位不到（返回 null），因此这个锚点在多人服务器上结构性地
 * 不会指到别人的实例。
 */
export function findPortOwnerPid(port) {
  if (LINUX) {
    const inodes = new Set(listenTable().filter((row) => row.port === port).map((row) => row.inode))
    if (inodes.size === 0) return null
    for (const pid of listPids() ?? []) {
      for (const target of readFdTargets(pid) ?? []) {
        const m = target.match(/^socket:\[(\d+)\]$/)
        if (m && inodes.has(m[1])) return pid
      }
    }
    return null
  }
  const first = lsof(['-ti', `tcp:${port}`, '-sTCP:LISTEN'])?.split('\n')[0]
  const pid = Number.parseInt(first ?? '', 10)
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

/** /proc/<pid>/fd 的指向集合；读不到（无权限 / 已退出 / 非 Linux）→ null。 */
function readFdTargets(pid) {
  if (!LINUX) return null
  let fds
  try { fds = readdirSync(`/proc/${pid}/fd`) } catch { return null }
  const targets = new Set()
  for (const fd of fds) {
    try { targets.add(readlinkSync(`/proc/${pid}/fd/${fd}`)) } catch { /* fd 已关 */ }
  }
  return targets
}

/** /proc/net/tcp{,6} 的 LISTEN 行 → [{ port, inode }]。 */
function listenTable() {
  const rows = []
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text
    try { text = readFileSync(file, 'utf8') } catch { continue }
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/)
      if (cols.length < 10 || cols[3] !== '0A') continue
      rows.push({ port: Number.parseInt(cols[1].split(':')[1], 16), inode: cols[9] })
    }
  }
  return rows
}

/** lsof 调用（仅非 Linux）：lsof 不在 / 失败 / 超时 → null。 */
function lsof(args) {
  if (LINUX) return null
  const r = spawnSync('lsof', args, { encoding: 'utf8', timeout: 8000 })
  return r.error || r.status !== 0 ? null : r.stdout
}
