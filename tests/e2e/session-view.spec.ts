// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Solo 会话视图（`/run/solo:<taskId>`——会话以 solo run 形态打开同一工作
// 台）：默认 Overview、Markdown 导出（solo 专属 title 锚点按钮）、可切
// Turns（跨成员搜索胶囊）与 Perf（会话级工具耗时卡——claude-sample 带
// 2 次工具调用）。语料 = global-setup 播种的 claude-sample 会话。

import { expect, test } from "./fixtures";
import { CLAUDE_SAMPLE_SESSION_ID } from "./constants";
import { RunWorkbenchPO } from "./support/pom/RunWorkbenchPO";

test.describe("Solo 会话视图", () => {
  test("solo 会话打开同一工作台：Overview 默认 + Markdown 导出在场", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(`solo:${CLAUDE_SAMPLE_SESSION_ID}`);

    // 与 run 同壳同默认（DEFAULT_RUN_TAB 单一源），tab 导航在场
    await run.expectTabActive("overview");
    // Markdown 导出（solo 专属动作；图标钮走 title 语义锚点）
    await expect(page.getByTitle("导出 Markdown")).toBeVisible();
  });

  test("solo 视图可切 Turns 与 Perf：会话级工具耗时卡照常渲染", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(`solo:${CLAUDE_SAMPLE_SESSION_ID}`);

    await run.switchTab("turns");
    await expect(run.turnsSearchInput()).toBeVisible();

    // claude-sample 夹具含 2 次工具调用 → 工具耗时卡渲染（toolStats 空时
    // 整卡缺席，此断言即「会话导入→采集→聚合」链路的端到端回声）
    await run.switchTab("perf");
    await expect(page.locator('[data-testid="perf-tool-time"]')).toBeVisible();
  });
});
