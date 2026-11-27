#!/usr/bin/env node
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 启动器端口工具（bin/launcher-*.mjs 与 tests/ut/launcher-ports.test.ts 共用）。
// 修复背景：smart-agent 端口曾钉死 BASE_PORT+1 且先于 next start 启动——BASE_PORT
// 被占时 next 滚到 BASE_PORT+1，smart-agent 抢先绑定同端口 → next start
// EADDRINUSE 崩溃（客户实测 21026）。端口分配必须互相避让。

export { findPortOwnerPid } from './launcher-proc.mjs'

/** 端口在 127.0.0.1 上是否空闲（真实 bind 探测，非启发）。 */
export function isTcpFree(port) {
  return new Promise((resolve) => {
    import('node:net').then((net) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.once('listening', () => { s.close(() => resolve(true)) })
      s.listen(port, '127.0.0.1')
    })
  })
}

/** 端口上是否有 HTTP 服务健康应答（Node >= 20 内置 fetch，无 curl 依赖）。 */
export async function isHttpHealthy(port, path = '/health', timeoutMs = 1500) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: ac.signal })
    return r.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** smart-agent /health 响应体里的服务标识（正身依据，server.py 同步维护）。 */
export const SMART_AGENT_SERVICE = 'context-smart-agent'

/**
 * 端口上是否为本 smart-agent：/health 2xx 且响应体带服务标识。
 * 仅凭 2xx 不够——Actuator、k8s 风格健康检查、各类 Node dev server 都有
 * /health，误认会导致复用陌生后端（audit v2/v3/v4 分析调用打错服务）。
 */
export async function isSmartAgent(port, timeoutMs = 1500) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: ac.signal })
    if (!r.ok) return false
    const body = await r.json()
    return body?.service === SMART_AGENT_SERVICE
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * smart-agent 端口候选区间：nextPort+1 起 3 个、避开 next 实占端口。
 * 历史教训：next 曾漂移到 BASE+1 与钉死 BASE+1 的 smart-agent 撞车 EADDRINUSE
 * （客户实测 21026）——现在 next 固定 BASE_PORT 不再漂移，避让保留为结构保险。
 * 与 launcher-instances 的 AGENT_PORT_SPAN 同口径：一个实例的 agent 只会落在
 * 它的端口后面这 3 个里。
 */
export function agentPortCandidates(nextPort) {
  const out = []
  for (let p = nextPort + 1; p < nextPort + 4; p++) out.push(p)
  return out
}
