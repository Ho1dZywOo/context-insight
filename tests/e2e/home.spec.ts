// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 工作台首页（`/`）：播种语料就位、类型分段过滤、搜索框、行下钻、
// 指标带、设置页可达。语料 = global-setup 播种的 minidemo01 run +
// claude solo 会话（见 e2e/global-setup.ts）。

import { expect, test } from "./fixtures";
import { CLAUDE_SAMPLE_SESSION_ID, E2E_RUN_ID } from "./constants";
import { WorkbenchHomePO } from "./support/pom/WorkbenchHomePO";

test.describe("统一工作台首页", () => {
  test("播种语料就位：run 行 + solo 会话行 + 指标带", async ({ page }) => {
    const home = new WorkbenchHomePO(page);
    await home.goto();

    // run 行（data-asset-key = `run:<runId>`，list-service 单一源形态）
    await expect(home.runRow(E2E_RUN_ID)).toBeVisible();
    // solo 会话行（subtitle 行内 title 携带 taskId——db 自增 id 不作锚点）
    await expect(home.sessionRowByTaskId(CLAUDE_SAMPLE_SESSION_ID)).toBeVisible();
    // 顶部指标带（Assets / Total Tokens 等服务端聚合瓦片）
    await expect(page.locator("[data-metric-strip]")).toBeVisible();
    await expect(page.locator("[data-metric-strip]").getByText("Assets")).toBeVisible();
  });

  test("类型分段过滤：Runs 只留 run 行，Sessions 只留会话行（URL ?kind= 镜像）", async ({ page }) => {
    const home = new WorkbenchHomePO(page);
    await home.goto();
    await expect(home.runRow(E2E_RUN_ID)).toBeVisible();

    await home.switchKind("Runs");
    await home.expectKind("run");
    await expect(home.runRow(E2E_RUN_ID)).toBeVisible();
    await expect(home.sessionRowByTaskId(CLAUDE_SAMPLE_SESSION_ID)).toHaveCount(0);
    await expect(page).toHaveURL(/kind=run/);

    await home.switchKind("Sessions");
    await home.expectKind("session");
    await expect(home.sessionRowByTaskId(CLAUDE_SAMPLE_SESSION_ID)).toBeVisible();
    await expect(home.runRow(E2E_RUN_ID)).toHaveCount(0);
    await expect(page).toHaveURL(/kind=session/);
  });

  test("搜索框按 taskId/runId 过滤（客户端局部更新，无整页刷新）", async ({ page }) => {
    const home = new WorkbenchHomePO(page);
    await home.goto();
    await expect(home.runRow(E2E_RUN_ID)).toBeVisible();

    // run 侧匹配 runId/name 子串（filterRunItems）；会话行退场
    await home.searchBox().fill(E2E_RUN_ID);
    await expect(home.sessionRowByTaskId(CLAUDE_SAMPLE_SESSION_ID)).toHaveCount(0, { timeout: 15_000 });
    await expect(home.runRow(E2E_RUN_ID)).toBeVisible();

    // 会话侧匹配 taskId/query/label 子串（list-service OR 条件）；run 行退场
    await home.searchBox().fill(CLAUDE_SAMPLE_SESSION_ID);
    await expect(home.runRow(E2E_RUN_ID)).toHaveCount(0, { timeout: 15_000 });
    await expect(home.sessionRowByTaskId(CLAUDE_SAMPLE_SESSION_ID)).toBeVisible();
  });

  test("行下钻：run 行 → run 工作台；会话行 → solo 会话视图", async ({ page }) => {
    const home = new WorkbenchHomePO(page);
    await home.goto();

    await home.openRun(E2E_RUN_ID);
    await expect(page.locator("[data-run-tabbar]")).toBeVisible();
    await page.goBack();

    await home.openSession(CLAUDE_SAMPLE_SESSION_ID);
    await expect(page.locator("[data-run-tabbar]")).toBeVisible();
  });

  test("设置页可达", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });
});
