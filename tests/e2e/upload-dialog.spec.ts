// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 上传到 contextBay 对话框（run 头部的常驻药丸 → UploadDialog）：表单字段
// 契约（提交人 / 内容描述 / 任务结果）与取消出口。只锁开合与字段在场，
// 不发起真实上传（远端仓依赖不属于 E2E 被测面）。语料 = minidemo01。

import { expect, test } from "./fixtures";
import { E2E_RUN_ID } from "./constants";
import { RunWorkbenchPO } from "./support/pom/RunWorkbenchPO";

test.describe("上传对话框", () => {
  test("run 头部药丸 → 上传表单字段在场，取消可关", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_RUN_ID);
    await run.expectTabActive("overview");

    // 头部药丸（BAY_NAME 常驻文本）
    await page.getByRole("button", { name: "上传到contextBay" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // 共享表单件（会话/run 双通路同款：范式目录* / 提交人* / 内容描述 /
    // 任务结果*——label 带必填星标，按子串正则锁定）
    for (const label of [/范式目录/, /提交人/, /内容描述/, /任务结果/]) {
      await expect(dialog.getByText(label).first()).toBeVisible();
    }

    // 取消出口（run 通路的取消钮文案是「关闭」）：对话框关闭
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  });
});
