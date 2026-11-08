// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may not refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Context 面板（ContextTracker 单一源，run 泛化）：上下文增长趋势纯 SVG
// 曲线（data-chart 契约锚）+ 头部摘要一行（agents/轮次/峰值/缓存命中）+
// 图表模式分段控件（面积↔折线，aria-pressed 真值断言）+ 图例胶囊 chevron
// 下钻 AgentDetailDialog（档案关键四数：峰值/窗口水位/增速）。语料 =
// e2e-tools01（3 成员，水位故事完整）。

import { expect, test } from "./fixtures";
import { E2E_TOOL_RUN_ID } from "./constants";
import { RunWorkbenchPO } from "./support/pom/RunWorkbenchPO";

test.describe("Context 面板", () => {
  test("增长趋势卡：SVG 曲线 + 头部摘要 + 图表模式切换", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_TOOL_RUN_ID, "tab=context");
    await run.expectTabActive("context");

    const panel = run.panel("context");
    // 增长曲线：纯 SVG 铁律，data-chart 契约锚
    await expect(panel.locator('svg[data-chart="growth"]')).toBeVisible({ timeout: 30_000 });

    // 头部摘要一行：agent 数 · 轮次 · 峰值 · 缓存命中（tabular-nums 真值）
    await expect(panel.getByText(/agents · \d+ 轮次 · 峰值 /).first()).toBeVisible();

    // 图表模式分段控件：面积 → 折线，aria-pressed 翻转（状态真值断言）
    const areaBtn = panel.getByRole("button", { name: "面积", exact: true });
    const lineBtn = panel.getByRole("button", { name: "折线", exact: true });
    await expect(areaBtn).toHaveAttribute("aria-pressed", "true");
    await lineBtn.click();
    await expect(lineBtn).toHaveAttribute("aria-pressed", "true");
    await expect(areaBtn).toHaveAttribute("aria-pressed", "false");
  });

  test("图例胶囊下钻：chevron 详情 → 档案弹窗关键四数在场", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_TOOL_RUN_ID, "tab=context");
    await run.expectTabActive("context");

    const panel = run.panel("context");
    await expect(panel.locator('svg[data-chart="growth"]')).toBeVisible({ timeout: 30_000 });

    // 首个图例胶囊的 chevron 详情钮（aria-label = "<label> 详情"）——标签
    // 从 data-legend 锚动态取，不与语料成员名硬耦合
    const firstLabel = await panel.locator("[data-legend]").first().getAttribute("data-legend");
    expect(firstLabel, "legend chip label").toBeTruthy();
    await panel.getByRole("button", { name: `${firstLabel} 详情` }).click();

    // AgentDetailDialog：档案关键四数（峰值/窗口水位/增速）逐字在场
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    for (const label of ["峰值", "窗口水位", "增速"]) {
      await expect(dialog.getByText(label, { exact: true }).first()).toBeVisible();
    }
  });
});
