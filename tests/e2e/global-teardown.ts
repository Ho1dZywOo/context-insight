// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// E2E teardown 不变量：被测服务必须死透（端口释放）。
//
// 刻意不抄 opsbot 的「pgrep next-server + cwd 在仓内」全局断言：opsbot 的
// matrix 层独占一个隔离 checkout，而 insight E2E 与用户日常实例共享本仓
// （.next/ 与 node_modules 复用，Turbopack 禁止 distDir 外置）——用户自己
// 的 dev 实例（next-server，cwd 同仓）是合法并行进程，按进程画像断言会
// 误杀误报。端口级断言才是本套件的精确边界：E2E 端口被占 = 我们的实例
// 泄漏，直接 fail-fast（下次 run 会撞 EADDRINUSE）。

import { execFileSync } from "node:child_process";
import { E2E_PORT } from "./constants";

function portListenerPid(): number | null {
  // 三级回退与 start.sh 的 port_pid 同款（WSL2 上 lsof 对部分 LISTEN 失明）
  try {
    const out = execFileSync("ss", ["-ltnp"], { encoding: "utf8" });
    const line = out.split("\n").find((l) => l.includes(`:${E2E_PORT} `));
    const pid = line?.match(/pid=(\d+)/)?.[1];
    return pid ? Number(pid) : null;
  } catch {
    // ss 不可用（如 macOS）→ lsof
  }
  try {
    const out = execFileSync("lsof", ["-ti", `tcp:${E2E_PORT}`, "-sTCP:LISTEN"], { encoding: "utf8" });
    const pid = out.trim().split("\n")[0];
    return pid ? Number(pid) : null;
  } catch {
    // lsof 也查不到（或无监听）→ 视为无占用
    return null;
  }
}

export default function globalTeardown(): void {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const pid = portListenerPid();
    if (pid == null) return; // Playwright 的 gracefulShutdown 已收干净
    // webServer 已 SIGTERM（10s 宽限）仍存活的残骸：补刀后下轮复查
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* 进程恰好退出——下一轮复查 */
    }
    execFileSync("sleep", ["0.3"]);
  }
  throw new Error(
    `E2E teardown invariant violated: port ${E2E_PORT} still listening after 10s — ` +
      `kill the holder manually (ss -ltnp | grep ${E2E_PORT}) before the next run`,
  );
}
