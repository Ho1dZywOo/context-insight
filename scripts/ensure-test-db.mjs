// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Pre-test guard: 测试库隔离。测试库按 worker 分片：本脚本在 worker 拉起前的
// 单进程窗口重建 prisma/test.db 作为**黄金模板**，每个 worker 首次 setup 时从
// 模板复制出独立 test-w<slot>.db（见 tests/worker-db.ts）——满并行 worker 共写
// 单库的物理层（SQLITE_BUSY/socket timeout）与逻辑层（跨文件同 taskId 外键/
// 唯一键连环违例）竞态整族根治。真实 prisma/dev.db（常驻 server 的生产库）
// 从物理上与测试断开——夹具会话不可能再泄进用户数据（历史缺陷：测试直连共享
// dev.db，漏清理的夹具会出现在会话列表里、删了下次跑测试又回来）。模板每次
// 运行**重建**：上一轮夹具残留随建随清，run-to-run 确定性；schema 沿用 tracked
// migrations（migrate deploy）。`.env` 引导保留（server 侧 fresh clone 兜底，
// 与 start.sh 默认一致；vitest 会把 .env 合入 process.env，setup.ts 先剥除该
// 泄漏再把 DATABASE_URL 指向分片库）。Run via the `pretest` hook（npm 只对
// `test` 名挂钩，test:e2e / test:cov 已显式串联）。

import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(PKG_DIR + '/');

const TEST_DB = path.join(PKG_DIR, 'prisma', 'test.db');
const PRISMA_DIR = path.dirname(TEST_DB);
// test-w* = worker 分片库（tests/worker-db.ts 物化），含 WAL/journal 边车
const SHARD_RE = /^test-w[\w.-]*\.db(-wal|-shm|-journal)?$/;

// 分片清理。两个入口共用：pretest 全量重建时清上一轮孤儿；`--prune-shards`
// 收尾模式（全量门禁成功后由 test 脚本链尾调用，成功即回收——vitest 默认
// isolate 下每测试文件一份分片，全量 ~390 份 × ~200KB；失败轮不走该链，
// 分片保留供 post-mortem 查证，下一轮 pretest 兜底清理）
function pruneShards() {
  for (const name of readdirSync(PRISMA_DIR)) {
    if (SHARD_RE.test(name)) rmSync(path.join(PRISMA_DIR, name));
  }
}

if (process.argv.includes('--prune-shards')) {
  pruneShards();
  console.warn('[ensure-test-db] worker shards pruned');
  process.exit(0);
}

if (!existsSync(path.join(PKG_DIR, '.env'))) {
  writeFileSync(path.join(PKG_DIR, '.env'), 'DATABASE_URL="file:./dev.db"\n');
  console.warn('[ensure-test-db] .env created with default DATABASE_URL');
}

// 重建模板（worker 拉起前的单进程窗口执行，无并发）：先删主文件与
// WAL/journal 边车，再重放 migrations——fresh clone 与存量环境同一条路
for (const suffix of ['', '-wal', '-shm', '-journal']) {
  const f = TEST_DB + suffix;
  if (existsSync(f)) rmSync(f);
}
pruneShards();
writeFileSync(TEST_DB, '');
const prismaBin = require.resolve('prisma/build/index.js');
const r = spawnSync(process.execPath, [prismaBin, 'migrate', 'deploy'], {
  cwd: PKG_DIR,
  stdio: 'inherit',
  // 绝对路径显式传入：压过 .env 的 dev.db（prisma CLI env 优先于 .env）
  env: { ...process.env, DATABASE_URL: `file:${TEST_DB}` },
});
if (r.status !== 0) {
  console.error(`[ensure-test-db] prisma migrate deploy failed: exit ${r.status}`);
  process.exit(1);
}
console.warn('[ensure-test-db] prisma/test.db rebuilt via migrations');

// 模板切 WAL（幂等）：WAL 模式持久化在文件头、随复制继承到各分片库——分片内
// 测试进程与 spawn 出的服务子进程（继承 DATABASE_URL）并发读写时读不阻塞写。
// 切不上（被长事务占住等）只警告不拦测试——退化为现状行为。
try {
  const mod = require('better-sqlite3');
  const Database = mod.default ?? mod;
  const db = new Database(TEST_DB, { timeout: 10_000 });
  const mode = db.pragma('journal_mode = WAL', { simple: true });
  // 模板自包含：checkpoint(TRUNCATE) 把 WAL 帧收编回主文件并把边车清零——
  // worker 冷复制（tests/worker-db.ts materializeWorkerShard）只拷主文件即得
  // 完整快照，无需带走 -wal/-shm（并发复制边车反而是竞态源）
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  if (mode === 'wal') console.warn('[ensure-test-db] test.db journal_mode=WAL');
  else console.warn(`[ensure-test-db] journal_mode=${mode}（WAL 未生效，跳过）`);
} catch (e) {
  console.warn(`[ensure-test-db] WAL 切换失败（不影响继续）: ${e instanceof Error ? e.message : e}`);
}
