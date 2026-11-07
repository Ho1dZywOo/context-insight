// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 跨成员搜索与下钻深链（Turns 搜索语法舞台）。语料 = E2E 自有工具 bundle
// （e2e-tools01，见 e2e/fixtures/tool-bundle/）：Read×3 / bash×2 / Grep×1，
// Σ 最高 = bash（23s，默认选中行）——工具名是夹具常量，断言逐字锁定。
//
//   ① Perf tab：工具耗时卡 master-detail 就位 + 下钻角标 → `tool:bash` 深链
//   ② 成员行展开逐轮调用 → 点轮次行跳转该轮（三级下钻：?turn= 深链 +
//      轮详情深钻）
//   ③ 搜索胶囊直打 tool: 语法 + Enter → 命中浮层驻留
//
// 断言锁定「q 换值重放」的连续下钻链路：每次下钻都该带搜索词进场、自动
// 执行并给出可见结果（空转 = 回归）。

import { expect, test } from "./fixtures";
import { E2E_TOOL_MEMBER_A, E2E_TOOL_RUN_ID, E2E_TOP_TOOL } from "./constants";
import { RunWorkbenchPO } from "./support/pom/RunWorkbenchPO";

/** 当前 URL 的 ?q= 参数（深链镜像断言——比正则拼装稳，免转义泥潭）。 */
function urlQuery(page: { url(): string }): string {
  return new URL(page.url()).searchParams.get("q") ?? "";
}

test.describe("Turns 搜索语法与下钻深链", () => {
  test("Perf 工具耗时卡 master-detail + Σ 最高工具 bash 默认选中", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_TOOL_RUN_ID, "tab=perf");

    // 两张卡同场：热点排行 + 工具耗时（PerfPanorama 装配契约）
    await expect(page.getByText("热点排行", { exact: true })).toBeVisible();
    await expect(page.locator('[data-testid="perf-tool-time"]')).toBeVisible();

    // 左排行：三工具在场，Σ 最高 = bash（夹具常量）默认选中
    await expect(page.locator('[data-tool-row="Read"]')).toBeVisible();
    await expect(page.locator(`[data-tool-row="${E2E_TOP_TOOL}"]`)).toBeVisible();
    await expect(page.locator('[data-tool-row="Grep"]')).toBeVisible();
    // 右下钻面板常驻（默认选中 Σ 最高工具，不再有空态）
    await expect(page.locator(`[data-tool-breakdown="${E2E_TOP_TOOL}"]`)).toBeVisible();
  });

  test("下钻角标 → tool:bash 深链：q 预填、tab 切换、搜索词进场", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_TOOL_RUN_ID, "tab=perf");
    await expect(page.locator(`[data-tool-row="${E2E_TOP_TOOL}"]`)).toBeVisible();

    // bash 行的幽灵下钻角标（悬停浮现 SearchIcon——无 hover 也保持可点）
    await page.locator(`[data-tool-row="${E2E_TOP_TOOL}"] [data-tool-drill]`).click();

    await expect(page).toHaveURL(/tab=turns/);
    expect(urlQuery(page)).toBe(`tool:${E2E_TOP_TOOL}`);
    await run.expectTabActive("turns");
    // 搜索胶囊随驻留关键词自动回填
    await expect(run.turnsSearchInput()).toHaveValue(`tool:${E2E_TOP_TOOL}`);
  });

  test("成员行展开逐轮调用 → 点轮次行跳转该轮（三级下钻）", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_TOOL_RUN_ID, "tab=perf");
    await expect(page.locator(`[data-tool-breakdown="${E2E_TOP_TOOL}"]`)).toBeVisible();

    // 右栏分解面板（默认选中 bash）：成员行点击 → 面板内展开逐轮调用清单
    const memberRow = page.locator(`[data-member-row="${E2E_TOP_TOOL}·${E2E_TOOL_MEMBER_A}"]`);
    await expect(memberRow).toBeVisible();
    await memberRow.click();

    const turnsBox = page.locator(`[data-member-turns="${E2E_TOP_TOOL}·${E2E_TOOL_MEMBER_A}"]`);
    await expect(turnsBox).toBeVisible();
    await expect(turnsBox.locator("[data-member-turn]")).not.toHaveCount(0);
    // 轮次序号标注（#N 直达同口径）
    await expect(turnsBox).toContainText(/#\d+/);

    // 轮次行点击 → ?turn= 深链 + 轮详情深钻（非空态）
    await turnsBox.locator("[data-member-turn]").first().click();
    await expect(page).toHaveURL(/tab=turns/);
    await expect(page).toHaveURL(/turn=/);
    await expect(page.locator("[data-turn-detail]")).toBeVisible({ timeout: 20_000 });
  });

  test("搜索胶囊直打 tool: 语法 + Enter → 命中浮层驻留", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_TOOL_RUN_ID, "tab=turns");
    const input = run.turnsSearchInput();
    await expect(input).toBeVisible();

    await input.fill(`tool:${E2E_TOP_TOOL}`);
    await input.press("Enter");
    // 命中浮层进场并驻留（毛玻璃命中索引；bash 在语料里有 2 次调用，
    // 零命中 = 搜索执行回归）
    await expect(run.hitsOverlay()).toBeVisible({ timeout: 20_000 });
  });
});
