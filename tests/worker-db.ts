// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 测试库按 worker 分片（根治满并行共写单库的整族 flake）。历史架构：全部并行
// worker 共写同一 prisma/test.db——物理层 SQLite 单写者锁（socket timeout /
// SQLITE_BUSY 类 flake 的系统性根因），逻辑层跨文件夹具共享同一批 taskId，
// deleteMany/createMany 交错后外键/唯一键连环违例（2026-11-24 sentry run#762
// 现场：rfmv-*/rop- 两组，与触发它的 PR 无关、纯基线 flake）。此前靠测试
// 作者各自手工隔离（sid 文件级前缀、VITEST_POOL_ID 后缀、withDbRaceRetry），
// 逐文件自保不可扩展且防不胜防。
//
// 本模块把不变量下沉到基础设施：pretest 在单进程窗口重建 prisma/test.db 作为
// 黄金模板（migrations 重放 + WAL + checkpoint 后主文件自包含），每个 worker
// 进程首次 setup 从模板复制出自己的 test-w<id>.db（WAL 模式随文件头继承）。
// vitest 默认 isolate 下每测试文件一进程 ≈ 每文件一库；进程复用形态下同进程
// 文件串行共享 → 两种形态下并发交错都不复存在，跨文件竞态整族消失，前缀
// 纪律降级为纵深防御。显式 DATABASE_URL（CI 指定特定库）优先于分片，
// 解析不介入；.env 泄漏判定复用 db-env-guard。
//
// 纯函数拆分 + 回归锁矩阵：tests/ut/worker-db.test.ts。

import fs from "node:fs";
import path from "node:path";
import { isEnvFileLeakedUrl } from "./db-env-guard";

export type WorkerDbReason = "explicit" | "leak-stripped-shard" | "shard";

export interface WorkerDbResolution {
  /** 分片库的 DATABASE_URL；null = 显式指定，沿用调用方当前值不介入 */
  url: string | null;
  reason: WorkerDbReason;
}

/** worker 槽位：VITEST_WORKER_ID 优先，VITEST_POOL_ID 兜底（同语义历名），
 * 非 vitest 上下文（直接跑 setup 的退化场景）回落 '1' */
export function workerSlotId(env: Record<string, string | undefined>): string {
  return env.VITEST_WORKER_ID ?? env.VITEST_POOL_ID ?? "1";
}

/** 分片库 URL（Prisma 的 file: 相对路径锚定 prisma/ 目录，与模板同基） */
export function workerShardUrl(slotId: string): string {
  return `file:./test-w${slotId}.db`;
}

/** 从分片 URL 提取 prisma/ 下的文件名；非分片形态（显式 URL 不应走到这里）直接抛错 */
export function workerShardFileFromUrl(url: string): string {
  const m = /^file:\.\/(test-w[\w.-]*\.db)$/.exec(url);
  if (!m) throw new Error(`非分片 DATABASE_URL 不应物化: ${url}`);
  return m[1];
}

/** 纯解析：决出「谁说了算」。泄漏值（与 .env 提供值一致）剥除回落分片；
 * 显式值（shell/CI 设定）原样保留 url=null */
export function resolveWorkerDatabaseUrl(input: {
  currentUrl: string | undefined;
  envDir: string;
  slotId: string;
}): WorkerDbResolution {
  const { currentUrl, envDir, slotId } = input;
  if (currentUrl && isEnvFileLeakedUrl(currentUrl, envDir)) {
    return { url: workerShardUrl(slotId), reason: "leak-stripped-shard" };
  }
  if (currentUrl) return { url: null, reason: "explicit" };
  return { url: workerShardUrl(slotId), reason: "shard" };
}

/** 物化分片库：目标缺位时从黄金模板复制（pretest 已 wal_checkpoint(TRUNCATE)，
 * 模板主文件自包含，无需带走 -wal/-shm 边车）。幂等：目标已存在（同槽位后续
 * 测试文件 / setup 重跑）不覆盖不重建——worker 库内容是本 worker 的运行态。
 * 模板缺失 = 绕过 pretest 的 fresh clone 直跑 → 在这里给可行动错误，而不是
 * 用例期才炸出难懂的 "no such table" */
export function materializeWorkerShard(input: { prismaDir: string; shardFile: string }): void {
  const target = path.resolve(input.prismaDir, input.shardFile);
  if (fs.existsSync(target)) return;
  const template = path.resolve(input.prismaDir, "test.db");
  if (!fs.existsSync(template)) {
    throw new Error(
      "prisma/test.db 黄金模板不存在：先跑一次 `npm run test`（pretest 自动重建测试库），" +
        "或手动 `node scripts/ensure-test-db.mjs`。测试不得直连真实 prisma/dev.db。",
    );
  }
  fs.copyFileSync(template, target);
}
