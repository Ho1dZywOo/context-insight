// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 跨成员搜索语法面（turns-deep-link.spec 已锁 tool: ——这里补齐语法矩阵的
// 其余成员）：role: 过滤、#N 轮次直达（solo 单成员单候选直跳）、零命中
// 的优雅文案。语料：e2e-tools01（role: / 零命中）+ solo claude-sample（#N
// 单候选直跳，多候选才弹下钻列表）。

import { expect, test } from "./fixtures";
import { CLAUDE_SAMPLE_SESSION_ID, E2E_TOOL_RUN_ID } from "./constants";
import { RunWorkbenchPO } from "./support/pom/RunWorkbenchPO";

test.describe("搜索语法矩阵", () => {
  test("role: 过滤：assistant 命中浮层驻留", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_TOOL_RUN_ID, "tab=turns");
    const input = run.turnsSearchInput();
    await expect(input).toBeVisible();

    await input.fill("role:assistant");
    await input.press("Enter");
    // 命中浮层进场驻留（工具语料必有 assistant 轮——零命中 = 语法回归）
    await expect(run.hitsOverlay()).toBeVisible({ timeout: 20_000 });
    await expect(run.hitsOverlay()).toContainText(/assistant/i);
  });

  test("#N 轮次直达：solo 单成员单候选直跳轮详情", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(`solo:${CLAUDE_SAMPLE_SESSION_ID}`, "tab=turns");
    const input = run.turnsSearchInput();
    await expect(input).toBeVisible();

    await input.fill("#1");
    await input.press("Enter");
    // 单候选 → 直接跳转该轮（轮详情挂载；多候选才弹下钻列表）
    await expect(page.locator("[data-turn-detail]")).toBeVisible({ timeout: 20_000 });
  });

  test("零命中：优雅文案收场（不白屏、不静默）", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_TOOL_RUN_ID, "tab=turns");
    const input = run.turnsSearchInput();
    await expect(input).toBeVisible();

    await input.fill("qzxvwjk不存在的词");
    await input.press("Enter");
    await expect(run.hitsOverlay()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("无命中——换个关键词试试")).toBeVisible();
  });
});
