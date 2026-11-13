// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Insight 浏览器 E2E（Playwright）：真构建 + 真服务 + 真库（prisma/e2e.db）
// + 真浏览器——与 opsbot 的 matrix 层同哲学（insight 是自含 Next+SQLite
// 应用，数据库即受控夹具，全栈直跑是最高价值层；失败注入走 page.route
// 定点，见 tests/e2e/resilience.spec.ts）。架构文档：tests/e2e/README.md。

import { defineConfig, devices } from "@playwright/test";
import { BASE_URL } from "./tests/e2e/constants";

export default defineConfig({
  testDir: "./tests/e2e",
  // spec 文件不进测试发现（constants/fixtures/support/boot 均非用例）
  testMatch: /.*\.spec\.ts$/,
  globalSetup: "./tests/e2e/global-setup.ts",
  globalTeardown: "./tests/e2e/global-teardown.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // 单 worker 串行：导入旅程会写库（+整页 reload），共享语料下的并行
  // 是自找的 flake；套件规模（六个 spec 文件）串行也只要一两分钟
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: BASE_URL,
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    // boot-server.sh：重建 prisma/e2e.db（migrations）→ 按需 next build →
    // 隔离环境（CONTEXT_INSIGHT_HOME/日志静音）→ next start 绑 127.0.0.1
    command: "bash tests/e2e/boot/boot-server.sh",
    // 健康探针 = 起动器同款 API 探活（start.sh CLI 模式同路径）
    url: `${BASE_URL}/api/observe/data?pageSize=1`,
    // 首跑含 next build（~2min，产物落隔离目录 .next-e2e——不抽换生产 .next）；
    // 复跑走 .next-e2e BUILD_ID 缓存秒过
    timeout: 300_000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
  },
});
