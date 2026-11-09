// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 韧性面：真 404（缺失 run）走完整服务端；API 故障注入（page.route 定点
// 拦截——insight 全栈单进程自含，无需 opsbot 式独立 mock 层，失败重放是
// page.route 在这套架构里的正确用法）下的错误卡而非白屏。
// 「页面无未处理异常」由 fixtures.ts 的 browserConsole 门统一把守。

import { expect, test } from "./fixtures";
import { E2E_RUN_ID } from "./constants";
import { RunWorkbenchPO } from "./support/pom/RunWorkbenchPO";

test.describe("韧性", () => {
  test("缺失 run：错误卡（可行动文案 + 返回/重试），不出白屏", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto("no-such-run-e2e");

    await run.expectErrorState();
    // 服务端错误文案透传（/api/observe/run/:id 的 404 body.error）
    await expect(page.getByText("Run not found: no-such-run-e2e")).toBeVisible();
  });

  test("run 主端点 500：错误卡收场，页面不静默崩", async ({ page }) => {
    // 定点注入：只拦主档案端点，其余依赖照常（骨架/局部降级语义由组件
    // 层自证；这里锁「主档案挂 → 错误卡 + 无白屏」）
    await page.route(`**/api/observe/run/${E2E_RUN_ID}`, async (route) => {
      await route.fulfill({ status: 500, json: { error: "injected e2e failure" } });
    });

    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_RUN_ID);

    await run.expectErrorState();
    await expect(page.getByText("injected e2e failure")).toBeVisible();
  });
});
