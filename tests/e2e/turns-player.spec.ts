// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Turns 面板交互面：角色筛选条（chip 计数 = 行为真值——筛选后的可见行数
// 必须与 chip 计数一致）、轮次行点击 → TurnDetail 播放器（胶片轨 + 走查
// 钮）。语料 = e2e-tools01（工具语料：首展开节点的三会话带 user/assistant
// 双角色轮次）。

import { expect, test, type Locator } from "./fixtures";
import { E2E_TOOL_RUN_ID } from "./constants";
import { RunWorkbenchPO } from "./support/pom/RunWorkbenchPO";

/** chip 文本里的计数（「全部 12」/「user 5」——tabular-nums 尾数）。 */
async function chipCount(chip: Locator): Promise<number> {
  const text = await chip.innerText();
  const m = text.match(/(\d+)\s*$/);
  return m ? Number(m[1]) : -1;
}

test.describe("Turns 面板交互", () => {
  test("角色筛选条：chip 计数 = 筛后可见行数（真值断言）", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_TOOL_RUN_ID, "tab=turns");
    await run.expectTabActive("turns");

    // 筛选条在列表头上常驻（首份成员数据落地即出现）
    const filter = page.locator("[data-role-filter]");
    await expect(filter).toBeVisible();
    const allChip = filter.locator('[data-role-chip="all"]');
    await expect(allChip).toBeVisible();

    const rows = page.locator("[data-turn-list] [data-turn-row]");
    const total = await chipCount(allChip);
    expect(total).toBeGreaterThan(0);
    // 无筛选：可见行数 = 「全部」chip 计数（首个内容节点默认展开，其会话
    // 轮次全量渲染；未展开节点不渲染行——两数同源同值）
    await expect(rows).toHaveCount(total);

    // 选一个角色 chip：aria-pressed 置位 + 可见行数收缩到该 chip 计数
    const roleChip = filter.locator("[data-role-chip]:not([data-role-chip='all'])").first();
    const roleTotal = await chipCount(roleChip);
    expect(roleTotal).toBeGreaterThan(0);
    await roleChip.click();
    await expect(roleChip).toHaveAttribute("aria-pressed", "true");
    await expect(rows).toHaveCount(roleTotal);

    // 「全部」复位：行数复原
    await allChip.click();
    await expect(rows).toHaveCount(total);
  });

  test("轮次行点击 → TurnDetail 播放器：详情 + 胶片轨 + 走查钮", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_TOOL_RUN_ID, "tab=turns");
    await run.expectTabActive("turns");

    const rows = page.locator("[data-turn-list] [data-turn-row]");
    await expect(rows.first()).toBeVisible();
    await rows.first().click();

    // 轮详情（叙事舞台 + 传输条 + 三联指标）
    const detail = page.locator("[data-turn-detail]");
    await expect(detail).toBeVisible({ timeout: 20_000 });
    // 胶片轨 = 当前成员会话全量轮（>1 轮即渲染，桶可点）
    await expect(detail.locator("[data-testid^='filmstrip-turn-']").first()).toBeVisible();
    // 走查钮（键盘 ←/→ 同款出口）
    await expect(page.getByTitle("上一轮（←）")).toBeVisible();
    await expect(page.getByTitle("下一轮（→）")).toBeVisible();
  });

  test("走查：下一轮 → 详情换轮（turnId 变化 + 胶片选中桶推进）", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_TOOL_RUN_ID, "tab=turns");
    await run.expectTabActive("turns");

    const rows = page.locator("[data-turn-list] [data-turn-row]");
    await expect(rows.first()).toBeVisible();
    await rows.first().click();
    const detail = page.locator("[data-turn-detail]");
    await expect(detail).toBeVisible({ timeout: 20_000 });
    const before = await detail.getAttribute("data-turn-detail");

    await page.getByTitle("下一轮（→）").click();
    // 详情锚点即 turnId（data-turn-detail={turnId}）——换轮必然变值
    await expect
      .poll(async () => detail.getAttribute("data-turn-detail"))
      .not.toBe(before);
  });
});
