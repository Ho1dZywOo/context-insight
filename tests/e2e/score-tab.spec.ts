// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Score 面板（TrajectoryScoring + DimensionRadar）：六维雷达（纯 SVG，
// aria-label 语义锚）+ 维度卡（D1~D6 中文名逐字锁定）+ 成员轨道（多成员
// run 经 RunMemberPicker 切换）+ 板块内评分导出钮（下载旅程已在
// session-view.spec 锁定，这里锁钮的常驻在场）。语料 = e2e-tools01。

import { expect, test } from "./fixtures";
import { E2E_TOOL_RUN_ID, E2E_TOOL_MEMBER_B } from "./constants";
import { RunWorkbenchPO } from "./support/pom/RunWorkbenchPO";

test.describe("Score 面板", () => {
  test("六维雷达 + 维度卡：D1~D6 中文名逐字在场", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_TOOL_RUN_ID, "tab=score");
    await run.expectTabActive("score");

    const panel = run.panel("score");
    // 六维雷达（DimensionRadar：纯 SVG + aria-label 语义锚）
    await expect(panel.locator('svg[aria-label="六维能力雷达图"]').first()).toBeVisible({ timeout: 30_000 });
    // 维度卡标题 = 内置维度定义名（D1~D6，单一源 src/lib/scoring/*/definition；
    // CardTitle 是 div——按精确文本锁定，逐字不模糊）
    for (const name of ["完成度", "行为可信", "完成质量", "完成效率", "冗余度", "自主性"]) {
      await expect(panel.getByText(name, { exact: true }).first()).toBeVisible();
    }
  });

  test("成员轨道：切成员雷达重渲染 + 导出钮常驻", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_TOOL_RUN_ID, "tab=score");
    await run.expectTabActive("score");

    const panel = run.panel("score");
    await expect(panel.locator('svg[aria-label="六维能力雷达图"]').first()).toBeVisible({ timeout: 30_000 });

    // 成员选择器（RunMemberPicker：成员钮以 taskId 为 title 锚）——切到
    // 另一成员，评分卡与雷达随成员重渲染
    await page.getByTitle(E2E_TOOL_MEMBER_B, { exact: true }).click();
    await expect(panel.locator('svg[aria-label="六维能力雷达图"]').first()).toBeVisible({ timeout: 30_000 });

    // 板块内导出钮（issue #116，RSI 自循环演进语料出口）常驻
    await expect(
      page.getByTitle("导出评分 JSON（全员评分卡 + 维度定义快照——RSI 自循环演进语料）"),
    ).toBeVisible();
  });
});
