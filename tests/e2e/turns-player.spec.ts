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

  // 顶部时间线（执行时间线自 Perf 迁入）：真布局下的三条契约——刻度只为可视
  // 窗口生成（放大后不随跨度爆炸）、放大以播放头为锚（屏幕位置不漂）、
  // 单击即选中该刻的轮次（播放头 = 所选轮起点，落在落点左侧不远处）
  test("顶部时间线：刻度只随可视窗口、放大锚定播放头、单击落到该刻的轮次", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_TOOL_RUN_ID, "tab=turns");
    await run.expectTabActive("turns");

    const timeline = page.locator("[data-turns-timeline]");
    const track = timeline.locator("[data-timeline-track]");
    await expect(track).toBeVisible();
    const playhead = timeline.locator("[data-playhead]");
    const detail = page.locator("[data-turn-detail]");
    const gridLines = timeline.locator("[data-timeline-grid] span");
    // 一屏最多 6 格 + 窗口外扩一格（不足 3 格时降一档步长，最多约 8 格）：与 run 的时间跨度无关
    expect(await gridLines.count()).toBeLessThanOrEqual(11);

    // 选列表中段的一轮 → 播放头立在它的起点（视野中部）
    const rows = page.locator("[data-turn-list] [data-turn-row]");
    await expect(rows.first()).toBeVisible();
    await rows.nth(Math.floor((await rows.count()) / 2)).click();
    await expect(detail).toBeVisible({ timeout: 20_000 });
    await expect(playhead).toBeAttached();
    // 可视宽度 = 滚动容器宽度（轨道在 1× 时与之等宽）
    const viewport = (await timeline.locator("[data-timeline-scroll]").boundingBox())!;
    const viewLeft = viewport.x;
    const viewWidth = viewport.width;
    const anchorBefore = (await playhead.boundingBox())!.x;
    expect(anchorBefore).toBeGreaterThan(viewLeft);
    expect(anchorBefore).toBeLessThan(viewLeft + viewWidth);

    // 放大 10 档到 1024×：每一步都以视野内的播放头为锚 → 屏幕位置不漂
    const zoomIn = timeline.getByRole("button", { name: "放大" });
    for (let i = 0; i < 10; i++) await zoomIn.click();
    await expect(timeline.locator("[data-zoom-value]")).toHaveText("1024×");
    const anchorAfter = (await playhead.boundingBox())!.x;
    expect(Math.abs(anchorAfter - anchorBefore)).toBeLessThan(8);
    // 刻度仍只为可视窗口生成（整段上有数千个刻度点，一个都不多画）
    expect(await gridLines.count()).toBeLessThanOrEqual(11);
    expect(await gridLines.count()).toBeGreaterThan(0);

    // 单击即跳的期望值不靠猜：从 /executions 取回逐轮区间，按「像素 → 时刻 →
    // 轮次」独立算一遍（落在区间内取该轮；空档取最近一轮，等距取前一轮），
    // 再与界面选中轮对比——点哪一刻就选中那一刻的轮次
    const execRes = await page.request.get(`/api/observe/run/${E2E_TOOL_RUN_ID}/executions`);
    expect(execRes.ok()).toBe(true);
    const items = ((await execRes.json()) as { items: Array<{ isSubagent: boolean; activeIntervals: Array<{ start: number; end: number; turnId?: string; hidden?: boolean }> }> }).items;
    const all = items.flatMap(a => a.activeIntervals);
    const startMs = Math.min(...all.map(iv => iv.start));
    const totalMs = Math.max(...all.map(iv => iv.end)) - startMs;
    const windows = (items.find(a => !a.isSubagent)!.activeIntervals ?? [])
      .filter(iv => iv.turnId && !iv.hidden)
      .sort((a, b) => a.start - b.start);
    expect(windows.length).toBeGreaterThan(1);

    const trackBox = (await track.boundingBox())!;
    const laneBox = (await timeline.locator("[data-timeline-track] [data-lane]").first().boundingBox())!;
    const clickX = viewLeft + viewWidth * 0.75;
    const clickMs = startMs + ((clickX - trackBox.x) / trackBox.width) * totalMs;
    const inside = windows.find(w => w.start <= clickMs && clickMs <= w.end);
    let expected: string | undefined = inside?.turnId;
    if (!expected) {
      const before = [...windows].reverse().find(w => w.end <= clickMs);
      const after = windows.find(w => w.start >= clickMs);
      const pick = !before ? after : !after ? before : clickMs - before.end <= after.start - clickMs ? before : after;
      expected = pick?.turnId;
    }
    expect(expected).toBeTruthy();

    await page.mouse.click(clickX, laneBox.y + laneBox.height / 2);
    // 选中轮 = 独立算出的那一轮；播放头 = 所选轮起点（落点在空档时取最近一轮，
    // 所以播放头可以在落点任一侧）——屏幕位置按轨道比例换算逐像素对上，且不出
    // 视野（出视野即跟随滚动）
    await expect(detail).toHaveAttribute("data-turn-detail", expected!, { timeout: 10_000 });
    const expectedStart = windows.find(w => w.turnId === expected)!.start;
    await expect
      .poll(async () => {
        const t = (await track.boundingBox())!;
        const x = (await playhead.boundingBox())!.x;
        return Math.abs(x - (t.x + ((expectedStart - startMs) / totalMs) * t.width));
      }, { timeout: 5_000 })
      .toBeLessThan(2);
    const landed = (await playhead.boundingBox())!.x;
    expect(landed).toBeGreaterThanOrEqual(viewLeft - 1);
    expect(landed).toBeLessThanOrEqual(viewLeft + viewWidth + 1);
  });
});
