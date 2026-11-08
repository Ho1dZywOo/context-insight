// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Overview 面板内容契约（此前套件只锁「面板挂载」，这里锁面板里的真实观测
// 内容）。语料分工：minidemo01 = 身份卡 + 指标瓦片（结构 run 的静态面）；
// e2e-tools01 = 分组列表（Tool Calls 卡——6 次工具调用的聚合回声，导入→
// 采集→聚合链路的端到端断言）。

import { expect, test } from "./fixtures";
import { E2E_RUN_ID, E2E_TOOL_RUN_ID } from "./constants";
import { RunWorkbenchPO } from "./support/pom/RunWorkbenchPO";

test.describe("Overview 面板内容", () => {
  test("身份卡与指标瓦片：run 名 + Tokens/Turns/LLM Calls 在场", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_RUN_ID);
    await run.expectTabActive("overview");

    const panel = run.panel("overview");
    // 身份卡：run 名（workflow.json name 字段——导入链路带回 UI）
    await expect(panel.getByText("mini-bundle", { exact: true }).first()).toBeVisible();
    // 指标瓦片标签（OverviewPanels 契约文本；值随语料变，标签不变）
    for (const label of ["Tokens", "Turns", "LLM Calls"]) {
      await expect(panel.getByText(label, { exact: true }).first()).toBeVisible();
    }
  });

  test("分组列表：Tool Calls 卡渲染（e2e-tools01 六次工具调用的聚合回声）", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_TOOL_RUN_ID);
    await run.expectTabActive("overview");

    const panel = run.panel("overview");
    // Tool Calls 卡标题带聚合计数（Read×3 / bash×2 / Grep×1 → ≥ 6）
    await expect(panel.getByText(/Tool Calls \((\d+)\)/).first()).toBeVisible();
    const count = Number(
      (await panel.getByText(/Tool Calls \((\d+)\)/).first().innerText()).match(/Tool Calls \((\d+)\)/)![1],
    );
    expect(count).toBeGreaterThanOrEqual(6);
  });
});
