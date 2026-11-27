#!/usr/bin/env node
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 测试夹具·假启动器：用真实的控制通道（bin/launcher-control.mjs）与实例记录
// （bin/launcher-records.mjs）扮一个「活着的启动器」，让真实的 ctxi --stop 走到
// 控制通道那条路。被 kill -9 后留下的就是真实的陈旧 socket + 真实的记录。
//   node launcher-fake.mjs <home> <port> <nextPid> <agentPid|->   → 就绪后输出 READY
import { resolveContext } from '../../bin/launcher-context.mjs'
import { startControl } from '../../bin/launcher-control.mjs'
import { removeRecord, saveRecord } from '../../bin/launcher-records.mjs'

const [home, portArg, nextArg, agentArg] = process.argv.slice(2)
const port = Number(portArg)
const next = Number(nextArg)
const agents = agentArg && agentArg !== '-' ? [Number(agentArg)] : []
const ctx = resolveContext({ CONTEXT_INSIGHT_HOME: home, CONTEXT_INSIGHT_PORT: portArg })
process.title = `${ctx.pkgName} launcher :${port}`
const startedAt = new Date().toISOString()
saveRecord(ctx, { port, launcher: process.pid, next, agents, packageDir: ctx.pkgDir, product: ctx.pkgName, version: ctx.version, startedAt })

const control = await startControl(ctx, (msg) => {
  if (msg?.cmd === 'status') {
    return { ok: true, product: ctx.pkgName, home: ctx.dataDir, port, pid: process.pid, state: 'ready', next, agents, version: ctx.version, startedAt }
  }
  if (msg?.cmd === 'stop') {
    return {
      ok: true,
      after: () => {
        for (const pid of [next, ...agents]) { try { process.kill(pid, 'SIGKILL') } catch { /* 已退出 */ } }
        removeRecord(ctx, port)
        void control.close().then(() => process.exit(0))
      },
    }
  }
  return { ok: false, error: 'unknown command' }
})
if (!control.acquired) {
  process.stderr.write(`控制端点已被 launcher PID ${control.holder?.pid} 占用\n`)
  process.exit(3)
}
process.stdout.write('READY\n')
setInterval(() => { /* 运行期：等控制通道的 stop */ }, 1000)
