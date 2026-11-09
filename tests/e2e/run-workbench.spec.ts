// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Run 工作台（`/run/:id`，11 tab 观测面）：tab 矩阵渲染、?tab= 深链、
// ?a 高级门、浏览器历史栈（返回钮 = 逐步回退工作台动作）。
// 语料分工：minidemo01 = 结构面（图/代际/验收/子图）；e2e-tools01 的
// Perf 工具耗时数据断言在 turns-deep-link.spec（工具语料的事实地）。

import { expect, test } from "./fixtures";
import { E2E_RUN_ID } from "./constants";
import { RunWorkbenchPO, RUN_TAB_LABELS, type RunTabKey } from "./support/pom/RunWorkbenchPO";

test.describe("Run 工作台", () => {
  test("默认落在 Overview：9 个可见 tab（wire/replay 高级门内）", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_RUN_ID);

    await run.expectTabActive("overview");
    // 默认可见的 9 tab（wire/replay 经 ?a / NEXT_PUBLIC 开关）
    for (const tab of ["overview", "graph", "turns", "context", "audit", "perf", "skills", "files", "score"] as RunTabKey[]) {
      await expect(run.tabButton(tab)).toBeVisible();
    }
    // 高级 tab 默认不在导航上
    await expect(run.tabBar().getByRole("button", { name: RUN_TAB_LABELS.wire })).toHaveCount(0);
    await expect(run.tabBar().getByRole("button", { name: RUN_TAB_LABELS.replay })).toHaveCount(0);
  });

  test("tab 矩阵：逐 tab 切换，面板真实挂载渲染（惰性挂载 + hidden 切换契约）", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_RUN_ID);
    await run.expectTabActive("overview");

    // Turns：跨成员搜索胶囊常驻（Run 轨右端）
    await run.switchTab("turns");
    await expect(run.turnsSearchInput()).toBeVisible();

    // 其余 tab：切到位即面板渲染（内容深度由 vitest IT 各自锁定；E2E 锁
    // 「切换后真有东西渲染」——含 Graph 的全宽特殊布局与 Score 末位）
    for (const tab of ["graph", "context", "audit", "perf", "skills", "files", "score"] as RunTabKey[]) {
      await run.switchTab(tab);
    }
    // 回到 Overview 收尾（全矩阵往返无残留）
    await run.switchTab("overview");
  });

  test("?tab= 深链：URL 直达 Turns（q 镜像由 turns-deep-link.spec 锁定）", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_RUN_ID, "tab=turns");
    await run.expectTabActive("turns");
    await expect(run.turnsSearchInput()).toBeVisible();
  });

  test("?a 高级门：wire/replay tab 展开", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_RUN_ID, "a");
    await expect(run.tabButton("wire")).toBeVisible();
    await expect(run.tabButton("replay")).toBeVisible();
  });

  test("工作台历史栈：返回钮逐步回退 tab 切换", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_RUN_ID);
    await run.expectTabActive("overview");

    // overview → turns → graph：每次切换是真实浏览器历史条目
    await run.switchTab("turns");
    await run.switchTab("graph");
    await expect(run.backButton()).toBeVisible();

    // 返回一步 = 回 turns（工作台内回退，不出页）
    await run.backButton().click();
    await run.expectTabActive("turns");
    await expect(page).toHaveURL(/\/run\//);
  });
});
