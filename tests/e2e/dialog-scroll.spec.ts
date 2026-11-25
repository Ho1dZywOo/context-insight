// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 弹窗视口适配（GitCode issue #167 回归锁）：居中弹窗内容超出视口高度时，
// DialogContent 基类给出视口高度上限 + 纵向滚动，页脚按钮粘滞常驻可达——
// 修复前弹窗整体溢出屏幕、底部「确认上传」等操作钮位于视口外无法点击。
// 以低视口（1280×400）驱动上传弹窗（issue 实报场景：范式列表/警告明细堆叠
// 超高），同基类的所有居中弹窗（含删除确认、连接引导）一并受益。

import { expect, test } from "./fixtures";
import { E2E_RUN_ID } from "./constants";
import { RunWorkbenchPO } from "./support/pom/RunWorkbenchPO";

test.describe("弹窗视口适配（#167）", () => {
  test("上传弹窗内容超高：内容区可滚，确认上传钮常驻视口内可达", async ({ page }) => {
    // 低视口：内容必然超出可视高度（弹窗被视口高度上限约束）
    await page.setViewportSize({ width: 1280, height: 400 });

    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_RUN_ID);

    // 头部药丸打开上传（boot server 未配置数据仓 → 配置先行弹引导）
    await page.getByRole("button", { name: "上传到contextBay" }).click();

    // 引导弹窗同样被视口高度上限约束：粘滞页脚让「取消」常驻可达
    const configDialog = page.getByRole("dialog", { name: "连接数据仓" });
    await expect(configDialog).toBeVisible();
    await configDialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(configDialog).toHaveCount(0);

    // 引导取消后上传表单在场（run 通路：范式目录 / 提交人 / 内容描述 / 任务结果）
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    for (const label of [/范式目录/, /提交人/, /内容描述/, /任务结果/]) {
      await expect(dialog.getByText(label).first()).toBeVisible();
    }

    // #167 核心：弹窗受视口高度上限约束且内容区可滚（超高内容不再溢出屏幕）
    const scrollable = await dialog.evaluate(
      (el) => el.scrollHeight > el.clientHeight + 8,
    );
    expect(scrollable).toBe(true);

    // 底部「确认上传」钮在视口内可达（不再被顶出屏幕外点击不到）
    await page.waitForTimeout(300); // 入场动画收尾，量准包围盒
    const uploadBtn = dialog.getByRole("button", { name: "确认上传" });
    await expect(uploadBtn).toBeVisible();
    let box = await uploadBtn.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(400);

    // 页脚粘滞：滚回顶部时按钮仍在视口内（不随内容滚走）
    await dialog.evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect(uploadBtn).toBeVisible();
    box = await uploadBtn.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(400);

    // 关闭可退（弹窗收尾正常）
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  });
});
