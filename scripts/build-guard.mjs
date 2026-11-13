// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. Do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 构建守门（npm prebuild，`npm run build` 前自动执行）：next build 会重写
// 产物目录，而运行中的 next-server 不会热感知——Next 16 启动时全量预载
// 路由模块，Turbopack 进程级模块注册表「先到的工厂赢」，产物被抽换后进程
// 仍在内存里跑旧代码，新旧混跑静默错乱（2026-11-12 实录：门禁构建重写
// .next 后，长跑实例的 lake 导入恒走旧代码、codex 原生会话导回全降级
// claude 占位，重启即愈）。语义与 start.sh 杀旧重启一致：构建失效的实例
// 继续跑就是事故源，构建前先停掉本仓（cwd 锚定）的 next 实例。
// INSIGHT_DIST_DIR 指向非默认目录（E2E 隔离构建 .next-e2e）时不碰生产
// 产物，直接放行。
// 测试锚点：BUILD_GUARD_ROOT 覆盖包根（行为测试用假包根仿真自家实例，
// 真实例零波及）。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = process.env.BUILD_GUARD_ROOT || PROJECT_ROOT;

const distDir = (process.env.INSIGHT_DIST_DIR || '').trim();
if (distDir && distDir !== '.next') process.exit(0);

// 进程 cwd 解析（与 start.sh proc_cwd 同款）：Linux 走 /proc readlink；
// 无 /proc 平台（macOS）退 lsof；都不可得返回 null——该 pid 不认定自家，
// 宁可漏杀不误杀
function procCwd(pid) {
  const procDir = `/proc/${pid}`;
  try {
    if (fs.existsSync(procDir)) return fs.readlinkSync(`${procDir}/cwd`);
  } catch {
    // fallthrough：readlink 失败（权限/竞态）按不可得处理
  }
  const lsof = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
  if (lsof.status !== 0 || !lsof.stdout) return null;
  const line = lsof.stdout.split('\n').find((entry) => entry.startsWith('n'));
  return line ? line.slice(1) : null;
}

// 本仓 next 实例收集：next-server / next start / npx next 三形（与 start.sh
// kill_all_insight 同一匹配面）。win32 无 /proc 与 lsof，cwd 不可得——
// 放行（守门失效但绝不误杀；生产启动链 ./start.sh 本就要求 bash 环境）
function ownNextPids() {
  if (process.platform === 'win32') return [];
  const pgrep = spawnSync('pgrep', ['-f', 'next-server|next start|npx next'], { encoding: 'utf8' });
  if (pgrep.status !== 0 || !pgrep.stdout) return [];
  return pgrep.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line))
    .map(Number)
    .filter((pid) => pid !== process.pid)
    .filter((pid) => {
      const cwd = procCwd(pid);
      return cwd !== null && (cwd === ROOT || cwd.startsWith(ROOT + path.sep));
    });
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const pids = ownNextPids();
if (pids.length === 0) process.exit(0);

console.error(
  `[build-guard] stopping own next instances (PID: ${pids.join(' ')}) — build rewrites the dist dir; a running instance would keep serving stale in-memory code (mixed-generation hazard). Restart via ./start.sh after the build.`,
);
for (const pid of pids) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // already gone
  }
}

// SIGTERM 宽限 → SIGKILL 补刀（next-server 对 SIGTERM 走 graceful close，
// 忽略信号的挂死进程只有 SIGKILL 收得掉——升级语义与 start.sh -k 同款）
const deadline = Date.now() + 3000;
while (Date.now() < deadline && pids.some(alive)) {
  await sleep(100);
}
for (const pid of pids) {
  if (!alive(pid)) continue;
  console.error(`[build-guard] SIGKILL ${pid} (ignored SIGTERM)`);
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
}
