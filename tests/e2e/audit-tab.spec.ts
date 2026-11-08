// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Audit 面板（四域对账看板）：域导航（Skill/Agent/Workflow/Run 四钮，默认
// skill）+ 目标列表（workflow 域按成员出 root 行——data-audit-target 契约）。
// 语料 = e2e-tools01（3 个带会话的成员）。审计 job 的触发依赖 sift 原生对
// 账环境，E2E 只锁导航与目标列表的结构契约，不跑 job。

import { expect, test } from "./fixtures";
import { E2E_TOOL_RUN_ID } from "./constants";
import { RunWorkbenchPO } from "./support/pom/RunWorkbenchPO";

test.describe("Audit 面板", () => {
  test("四域导航在场，默认 skill 域", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_TOOL_RUN_ID, "tab=audit");
    await run.expectTabActive("audit");

    await expect(page.locator("[data-run-audit]")).toBeVisible();
    // 四域各一钮（data-audit-domain 契约锚点）
    for (const key of ["skill", "agent", "workflow", "run"]) {
      await expect(page.locator(`[data-audit-domain="${key}"]`)).toBeVisible();
    }
    // 默认落在 skill 域（aria-pressed 镜像）
    await expect(page.locator('[data-audit-domain="skill"]')).toHaveAttribute("aria-pressed", "true");
  });

  test("workflow 域：成员 root 目标行；run 域：全 run 目标行", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_TOOL_RUN_ID, "tab=audit");
    await run.expectTabActive("audit");

    // workflow 域 = 主 agent 编排（成员私有，每成员一行 root:<taskId>）
    await page.locator('[data-audit-domain="workflow"]').click();
    const rootRows = page.locator("[data-audit-target^='root:']");
    await expect(rootRows.first()).toBeVisible({ timeout: 20_000 });
    // e2e-tools01 有 3 个带会话的成员（夹具常量）
    await expect(rootRows).toHaveCount(3);

    // run 域 = 编排规程声明 × 全 run（声明源成员一行；无声明也有占位行）
    await page.locator('[data-audit-domain="run"]').click();
    await expect(page.locator("[data-audit-target^='run:']").first()).toBeVisible({ timeout: 20_000 });
  });
});
