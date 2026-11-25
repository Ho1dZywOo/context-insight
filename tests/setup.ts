// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isEnvFileLeakedUrl } from "./db-env-guard";
import {
  resolveWorkerDatabaseUrl,
  materializeWorkerShard,
  workerSlotId,
  workerShardFileFromUrl,
} from "./worker-db";
// BigInt JSON 垫片：roll-up BigInt 列配套，测试进程内全局生效（见 src/lib/bigint-json.ts）
import "../src/lib/bigint-json";

// 测试库隔离默认值：按 worker 分片——pretest 重建 prisma/test.db 黄金模板，
// 本 setup（随 worker 进程各跑一次）为其物化独立 prisma/test-w<id>.db。
// vitest 默认 isolate 下每测试文件一进程 ≈ 每文件一库（文件间零共享）；
// 进程复用形态下同进程文件串行共享一份分片库（也零交错）——两种形态
// 满并行的并发交错都不复存在，物理层 SQLITE_BUSY/socket timeout 与逻辑层
// 跨文件同 taskId 外键/唯一键连环违例整族根治（2026-11-24 sentry run#762
// 现场）。真实 prisma/dev.db 由常驻 server 独占——夹具会话从物理上不可能
// 再泄进用户数据（历史缺陷：测试直连 dev.db，漏清理夹具删了下次跑测试又
// 回来）。显式 DATABASE_URL（CI/本地指向特定库）优先于分片，解析不介入。
// PrismaClient 构造时读 process.env——本段必须先于任何 PrismaClient（含
// 被测模块经 @/lib/db 的单例）。
// vitest 3 会经 Vite loadEnv 把包根 .env*（server 运行时引导，ensure-test-db
// 在 fresh clone 创建）合入 process.env 且不覆盖已有值——与 .env 同值的
// DATABASE_URL 是泄漏而非显式选择，先剥除再走分片（shell 显式值不受影响），
// 否则全套件击穿隔离写生产库（回归锁：tests/ut/test-db-isolation.test.ts +
// tests/ut/db-env-guard.test.ts + tests/ut/worker-db.test.ts）
if (isEnvFileLeakedUrl(process.env.DATABASE_URL, path.resolve(__dirname, ".."))) {
  delete process.env.DATABASE_URL;
}
const workerDb = resolveWorkerDatabaseUrl({
  currentUrl: process.env.DATABASE_URL,
  envDir: path.resolve(__dirname, ".."),
  slotId: workerSlotId(process.env),
});
if (workerDb.url) {
  materializeWorkerShard({
    prismaDir: path.resolve(__dirname, "../prisma"),
    shardFile: workerShardFileFromUrl(workerDb.url),
  });
  process.env.DATABASE_URL = workerDb.url;
}

// 回收站/数据主目录测试隔离默认值：级联删除现在会归档快照（见
// src/lib/recycle.ts）——不设此默认，任何删除类 IT 都会把快照写进真实
// ~/.context-insight。每进程独立 tmp（setup 随 worker 进程各跑一次），
// 并行文件间零共享态；显式 CONTEXT_INSIGHT_HOME（run-store 系 IT 已自带
// tmpHome）优先于本默认
process.env.CONTEXT_INSIGHT_HOME ||= fs.mkdtempSync(path.join(os.tmpdir(), 'insight-test-home-'));

// 兜底守卫：绕过 pretest 的直接 vitest（`npx vitest run <file>`）显式指向
// prisma/ 下测试库（file:./test*.db）而文件缺位（fresh clone 首跑）时，
// SQLite 会建出无表空库、用例期才炸出难懂的 "no such table"——在这里给一条
// 可行动的错误。分片默认路径的缺位由 materializeWorkerShard 同款报错覆盖
const resolvedDbUrl = process.env.DATABASE_URL ?? "";
const explicitTestDb = /^file:\.\/(test[\w.-]*\.db)(?:\?.*)?$/.exec(resolvedDbUrl);
if (
  explicitTestDb &&
  !fs.existsSync(path.resolve(__dirname, "../prisma", explicitTestDb[1]))
) {
  throw new Error(
    `prisma/${explicitTestDb[1]} 不存在：先跑一次 \`npm run test\`（pretest 自动重建测试库），` +
      "或手动 `node scripts/ensure-test-db.mjs`。测试不得直连真实 prisma/dev.db。",
  );
}

// 测试进程统一加大 socket_timeout（Prisma sqlite URL 参数，单位秒）：分片库
// 默认仅本 worker 的测试进程写，但 pipeline 类 IT 会 spawn 继承 DATABASE_URL
// 的子进程服务（与测试进程并发写同一分片库），SQLite 单写者锁下默认 5s 仍有
// 偶发 "Socket timeout" 空间——保留放大等待做兜底。仅测试侧放大——服务端
// 运行时仍走 .env 默认，不受影响；先设先赢（||=）语义下 CI 想覆盖可直接带参设置。
if (!resolvedDbUrl.includes("socket_timeout=")) {
  process.env.DATABASE_URL =
    resolvedDbUrl + (resolvedDbUrl.includes("?") ? "&socket_timeout=60" : "?socket_timeout=60");
}

// 统一日志全局静音：被测模块（data-service/lake 层等）引入 logger 后，全量测试
// 会把日志写进真实 ~/.context-insight/logs/。||= 语义 = 显式设置优先（CI 想开
// 日志设 CONTEXT_LOG=1 即可）；logger 自己的测试文件内在 beforeAll 删掉此变量
process.env.CONTEXT_LOG ||= "0";

const prisma = new PrismaClient();

beforeAll(async () => {
  // Probe native addons that vitest loads in-worker. A `node` upgrade leaves
  // the compiled binary on a stale ABI → "Module did not self-register" /
  // NODE_MODULE_VERSION mismatch, which surfaces as a dozen cryptic test
  // failures. Fail fast with one actionable message instead. (`npm run test`
  // auto-rebuilds via pretest; this guards bare `npx vitest` runs.)
  try {
    const mod = await import("better-sqlite3");
    const Database = (mod as { default?: unknown }).default ?? mod;
    const db = new (Database as new (s: string) => { close: () => void })(":memory:");
    db.close();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/NODE_MODULE_VERSION|did not self-register|was compiled against a different Node\.js version/i.test(msg)) {
      throw new Error(
        `Native addon better-sqlite3 is stale (Node ABI mismatch after a Node.js upgrade).\n` +
        `Run: npm rebuild better-sqlite3   (or: ./start.sh -u)\n` +
        `Original error: ${msg}`
      );
    }
    throw e;
  }
  // WAL 下 many-worker 并发首开 -shm 有瞬时锁竞争（偶发 SQLITE_CANTOPEN/
  // BUSY），有界重试即过；真实连接错误重试耗尽后原样抛出。满并行 worker
  // 冷启动（WAL 未初始化）时 3×(200/400/600ms) 预算偶发耗尽——那个 worker
  // 的整个测试文件红、重跑即绿（flaky 源头），改 6 次指数退避（最长 ~16s）
  let lastErr: unknown;
  for (let i = 0; i < 6; i++) {
    try {
      await prisma.$connect();
      lastErr = undefined;
      break;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 250 * 2 ** i));
    }
  }
  if (lastErr) throw lastErr;
});

afterAll(async () => {
  await prisma.$disconnect();
});

export { prisma };
