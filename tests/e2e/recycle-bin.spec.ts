// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 回收站全旅程（删除 → 撤销回程 / 删除 → 回收站面板 → 恢复回流）：一次性
// 夹具 claude-autorefresh-base 自行经 HTTP 导入（global-setup 同款管线）。
// 删除走乐观移除范式：确认即行离场（不再整页 reload——SPA 标记断言锁死），
// 结果以底部 toast 呈现，限时撤销 = POST /api/recycle restore 的真实数据
// 恢复；面板路径覆盖另一恢复入口。全程自包自净——结束时该会话回流为普通
// 行，与播种态等价（幂等重跑安全）。
// 列表同步语义：主列表 items 是客户端 state，router.refresh() 只换 props 不
// 重置 state——删除/撤销结算统一走 fetchAssets 局部刷新 + router.refresh()
// 软刷指标卡（syncAfterDeletion），回流行靠 fetchAssets 浮现。

import { expect, test } from "./fixtures";
import { AUTOREFRESH_JSONL, AUTOREFRESH_SESSION_ID, BASE_URL } from "./constants";
import { WorkbenchHomePO } from "./support/pom/WorkbenchHomePO";

/** HTTP 导入一条 JSONL 会话（global-setup 同一端点同一代码路径）。 */
async function importDisposableSession(): Promise<void> {
  const listRes = await fetch(`${BASE_URL}/api/ingest/import-file/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "jsonl", filePath: AUTOREFRESH_JSONL }),
  });
  if (!listRes.ok) throw new Error(`recycle spec: list sessions failed (HTTP ${listRes.status})`);
  const { sessions } = (await listRes.json()) as { sessions: Array<{ id: string; source: string }> };
  if (sessions.length === 0) throw new Error("recycle spec: no sessions listed from disposable fixture");
  for (const s of sessions) {
    const res = await fetch(`${BASE_URL}/api/ingest/import-file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: s.id, filePath: AUTOREFRESH_JSONL, source: s.source }),
    });
    if (!res.ok) throw new Error(`recycle spec: import session failed (HTTP ${res.status})`);
  }
}

test.describe("回收站旅程", () => {
  test("删除 → 回收站 → 恢复回流", async ({ page }) => {
    await importDisposableSession();

    const home = new WorkbenchHomePO(page);
    await home.goto();
    const row = home.sessionRowByTaskId(AUTOREFRESH_SESSION_ID);
    await expect(row).toBeVisible();

    // 行内删除钮（title 语义锚点；opacity-0 悬停浮现但可点）
    await row.getByTitle("Delete session", { exact: true }).click();
    // 确认弹窗（radix Dialog；scope 到 dialog 防「确认删除」多弹窗歧义）
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Delete Session", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "确认删除" }).click();

    // 乐观移除：行离场（不等服务端结算、无整页 reload）。结果 toast（sonner）
    // 带限时撤销——本用例走面板路径，不消费快照条目，toast 自行超时离场
    await expect(row).toHaveCount(0, { timeout: 15_000 });

    // 侧栏回收站面板：快照行在场（p[title=taskId] 携带身份）
    const recycleRow = page.locator("[data-recycle-row]").filter({
      has: page.locator(`p[title="${AUTOREFRESH_SESSION_ID}"]`),
    });
    await expect(recycleRow).toBeVisible({ timeout: 15_000 });

    // 恢复：快照回流为独立会话（面板广播 assets-changed → 主列表 fetchAssets
    // 软同步浮现，回收站行随之离场）
    await recycleRow.locator("[data-recycle-restore]").click();
    await expect(home.sessionRowByTaskId(AUTOREFRESH_SESSION_ID)).toBeVisible({ timeout: 15_000 });
    // 回收站行随之离场（恢复成功后条目移除）
    await expect(recycleRow).toHaveCount(0, { timeout: 15_000 });
  });

  test("乐观移除 + toast 撤销 → 行回归（全程无整页 reload）", async ({ page }) => {
    await importDisposableSession();

    const home = new WorkbenchHomePO(page);
    await home.goto();
    const row = home.sessionRowByTaskId(AUTOREFRESH_SESSION_ID);
    await expect(row).toBeVisible();

    // SPA 判定标记：乐观移除范式全程不得发生整页导航（location.reload 会
    // 丢失窗口标记）——这是「删除卡住等刷新」缺陷的范式级回归锁
    await page.evaluate(() => {
      (window as unknown as { __noReload: number }).__noReload = 1;
    });

    await row.getByTitle("Delete session", { exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "确认删除" }).click();

    // 乐观移除：行即刻离场（确认后同步隐藏，不等服务端结算）
    await expect(row).toHaveCount(0, { timeout: 5_000 });

    // 结果 toast（sonner）：限时撤销在场（撤销 = POST /api/recycle restore
    // 真实恢复；action 按钮带 data-button 锚点）
    const toastItem = page.locator('[data-sonner-toast]').filter({ hasText: "已删除会话" });
    await expect(toastItem).toBeVisible({ timeout: 15_000 });
    await toastItem.locator("[data-button]").click();

    // 撤销结算：行回归（fetchAssets 局部刷新带回流数据）+ 删除 toast 离场
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(toastItem).toHaveCount(0, { timeout: 10_000 });
    // 快照条目已被撤销消费：回收站不再有该行
    const recycleRow = page.locator("[data-recycle-row]").filter({
      has: page.locator(`p[title="${AUTOREFRESH_SESSION_ID}"]`),
    });
    await expect(recycleRow).toHaveCount(0, { timeout: 15_000 });
    // 全程无整页 reload（标记存活）
    expect(
      await page.evaluate(() => (window as unknown as { __noReload: number | undefined }).__noReload),
    ).toBe(1);
  });

  test("恢复失败：持久报错卡须点「知道了」确认，不自动消失", async ({ page }) => {
    await importDisposableSession();

    const home = new WorkbenchHomePO(page);
    await home.goto();
    const row = home.sessionRowByTaskId(AUTOREFRESH_SESSION_ID);
    await expect(row).toBeVisible();

    // 删除进回收站（同旅程一）
    await row.getByTitle("Delete session", { exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "确认删除" }).click();
    await expect(row).toHaveCount(0, { timeout: 15_000 });
    const recycleRow = page.locator("[data-recycle-row]").filter({
      has: page.locator(`p[title="${AUTOREFRESH_SESSION_ID}"]`),
    });
    await expect(recycleRow).toBeVisible({ timeout: 15_000 });

    // 网络拦截：恢复请求 POST /api/recycle 强制失败（面板 GET 列表放行）——
    // 模拟服务异常/断网下的恢复动作
    await page.route("**/api/recycle", async (route) => {
      if (route.request().method() === "POST") return route.abort();
      return route.continue();
    });

    // 恢复失败：持久报错卡（NoticeHud，role=alert）在场并给出原因
    await recycleRow.locator("[data-recycle-restore]").click();
    const errorCard = page.locator('[data-notice-tone="error"]');
    await expect(errorCard).toBeVisible({ timeout: 10_000 });
    await expect(errorCard).toContainText("恢复失败");

    // 不自动消失（报错语义回归锁）：静置 7s——旧 toast 报错 6s 即蒸发，
    // 报错原因用户可能根本没看到；持久卡必须仍在场
    await page.waitForTimeout(7_000);
    await expect(errorCard).toBeVisible();

    // 唯一离场出口：点「知道了」确认
    await errorCard.locator("[data-notice-confirm]").click();
    await expect(errorCard).toHaveCount(0, { timeout: 5_000 });

    // 自净：解除拦截后重新恢复成功，会话回流为普通行（与播种态等价，幂等重跑安全）
    await page.unroute("**/api/recycle");
    await recycleRow.locator("[data-recycle-restore]").click();
    await expect(recycleRow).toHaveCount(0, { timeout: 15_000 });
    await expect(row).toBeVisible({ timeout: 15_000 });
  });
});
