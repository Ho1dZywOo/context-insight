// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 回收站全旅程（删除 → 回收站 → 恢复）：一次性夹具 claude-autorefresh-base
// 自行经 HTTP 导入（global-setup 同款管线），UI 走行内删除钮 → 确认弹窗 →
// 侧栏回收站行 → 恢复回流。全程自包自净——结束时该会话回流为普通行，
// 与播种态等价（幂等重跑安全）。删除与恢复均整页 reload（恢复侧是修过的
// 缺陷：主列表 items 是客户端 state，router.refresh() 只换 props 不重置
// state，回流行原本不会浮现——徽章与列表自相矛盾），回收站面板随重挂载
// 重新拉取，断言天然同步。

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

    // 删除成功 → 整页 reload → 行消失
    await expect(row).toHaveCount(0, { timeout: 15_000 });

    // 侧栏回收站面板：快照行在场（p[title=taskId] 携带身份）
    const recycleRow = page.locator("[data-recycle-row]").filter({
      has: page.locator(`p[title="${AUTOREFRESH_SESSION_ID}"]`),
    });
    await expect(recycleRow).toBeVisible({ timeout: 15_000 });

    // 恢复：快照回流为独立会话（router.refresh() 主列表同步）
    await recycleRow.locator("[data-recycle-restore]").click();
    await expect(home.sessionRowByTaskId(AUTOREFRESH_SESSION_ID)).toBeVisible({ timeout: 15_000 });
    // 回收站行随之离场（恢复成功后条目移除）
    await expect(recycleRow).toHaveCount(0, { timeout: 15_000 });
  });
});
