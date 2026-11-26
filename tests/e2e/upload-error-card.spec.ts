// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.


// 上传结果走需确认卡（GitCode issue #167 回归锁）。首修给弹窗加了滚动条——方向
// 错了：让弹窗变高的是堆在里面的报错 / 告警明细，而报错内容此前还会随 HUD
// 一闪而过。现口径：弹窗版面固定、不出滚动条；变长的结果内容进 NoticeHud 的
// 需确认卡（不自动消失、须点「知道了」）。以数据仓三接口的定点应答驱动真实
// 上传路径（弹窗 → 表单校验 → 提交 → 结果通知），一条旅程走完
// 「失败 → 确认 → 原样重试 → 成功但缺正文 → 确认」。

import { expect, test } from "./fixtures";
import { E2E_RUN_ID } from "./constants";
import { RunWorkbenchPO } from "./support/pom/RunWorkbenchPO";

const LAKE = { configured: true, address: "https://example.com/lake.git", branch: "main" };
const REFUSED = [
  "敏感信息清洗未通过，以下 3 处拒绝上传：",
  "  L12: 疑似密钥 sk-****",
  "  L48: 内网地址 10.0.0.1",
  "  L90: 身份证号 110***********1234",
].join("\n");
const MISSING = ["ses-alpha-0001", "ses-alpha-0002", "ses-alpha-0003"];

test.describe("上传结果走需确认卡（#167）", () => {
  test("失败：弹窗版面不变、不出滚动条；报错进需确认卡，静置不消失，须点「知道了」", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    // 数据仓三接口定点应答：配置已就绪（表单可填可传）；上传按剧本切换
    let uploadReply: { status: number; body: unknown } = { status: 500, body: { error: REFUSED } };
    await page.route("**/api/settings/lake-config**", (route) =>
      route.fulfill({ json: LAKE }),
    );
    await page.route("**/api/settings/lake-auth**", (route) =>
      route.fulfill({
        json: { remotes: [{ url: LAKE.address, username: "u", tokenMasked: "****" }] },
      }),
    );
    await page.route("**/api/ingest/lake", async (route) => {
      const body = (route.request().postDataJSON() ?? {}) as { action?: string };
      if (body.action === "list") {
        await route.fulfill({ json: { dirs: ["e2e-paradigm"], sessions: [] } });
      } else if (body.action === "bundle-upload") {
        await route.fulfill({ status: uploadReply.status, json: uploadReply.body });
      } else {
        await route.fulfill({ status: 400, json: { error: "unexpected action" } });
      }
    });

    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_RUN_ID);
    await page.getByRole("button", { name: "上传到contextBay" }).click();

    // 配置已就绪：直接是上传表单
    // 按槽位取弹窗（不按 role）：确认卡打开后下层弹窗被模态标为不可访问，
    // getByRole 会把它滤掉——那正是模态该有的行为
    const dialog = page.locator('[data-slot="dialog-content"]');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("combobox").locator("option")).toHaveCount(2);
    await dialog.getByPlaceholder("必填：真实姓名或账号").fill("张三");
    await dialog.getByRole("combobox").selectOption("e2e-paradigm");
    await dialog.getByRole("button", { name: "成功", exact: true }).click();
    await page.waitForTimeout(400); // 入场动画收尾，量准高度
    const before = await dialog.boundingBox();

    await dialog.getByRole("button", { name: "确认上传" }).click();

    // 报错进需确认卡：首行作副文，全文逐行进明细块
    const card = page.locator('[data-notice-ack][data-notice-tone="error"]');
    await expect(card).toBeVisible();
    await expect(card).toContainText("上传失败");
    await expect(card).toContainText("敏感信息清洗未通过，以下 3 处拒绝上传：");
    await expect(card.locator('[data-slot="notice-detail-text"]')).toHaveText(REFUSED);
    // 居中 Alert（role=alertdialog）：焦点落在确认钮上，键盘回车即可确认；
    // Esc 与遮罩点击关不掉——唯一出口是「知道了」
    await expect(card).toHaveAttribute("role", "alertdialog");
    await expect(card.getByRole("button", { name: "知道了" })).toBeFocused();
    await page.keyboard.press("Escape");
    await page.mouse.click(12, 12);
    await expect(card).toBeVisible();

    // #167 核心：弹窗不关、版面不随报错变、不出滚动条、一个字的报错都不在里面
    await expect(dialog).toBeVisible();
    // 判定串取报错原文首行（弹窗固定提示语里也有「拒绝上传」四字）
    await expect(dialog).not.toContainText("以下 3 处拒绝上传");
    const shape = await dialog.evaluate((el) => ({
      scrollable: el.scrollHeight > el.clientHeight + 1,
      overflowY: getComputedStyle(el).overflowY,
    }));
    expect(shape).toEqual({ scrollable: false, overflowY: "visible" });
    const after = await dialog.boundingBox();
    expect(Math.abs(after!.height - before!.height)).toBeLessThanOrEqual(1);

    // 静置 7 秒不消失；唯一出口是「知道了」
    await page.waitForTimeout(7_000);
    await expect(card).toBeVisible();
    await card.locator("[data-notice-confirm]").click();
    await expect(card).toHaveCount(0);

    // 重试上下文不丢：表单值原样，直接再传；这次成功但缺正文 → 需确认警示卡
    // 承载完整清单，弹窗照常关闭
    await expect(dialog.getByPlaceholder("必填：真实姓名或账号")).toHaveValue("张三");
    await expect(dialog.getByRole("combobox")).toHaveValue("e2e-paradigm");
    uploadReply = { status: 200, body: { unchanged: false, sessionCount: 3, missingSessions: MISSING } };
    await dialog.getByRole("button", { name: "确认上传" }).click();
    const warning = page.locator('[data-notice-ack][data-notice-tone="warning"]');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText("3 个缺正文");
    await expect(warning.locator('[data-slot="notice-detail-text"]')).toHaveText(MISSING.join("\n"));
    await expect(dialog).toHaveCount(0);
    await warning.locator("[data-notice-confirm]").click();
    await expect(warning).toHaveCount(0);
  });
});
