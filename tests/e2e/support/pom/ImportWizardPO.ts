// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 导入向导弹窗（ImportDialog）页面对象：双源大卡（本地文件 / 数据仓）→
// 路径输入 + Browse 目录表（绿 = 可导：Bundle 目录 / JSONL 文件）→ 导入
// 进度（run job 轮询视图 / 会话批并发）→ Done（整页 reload 刷新资产表）。
// 会话纯批次 1s 自动关闭并 reload；bundle job 需手动 Done。

import { expect, type Locator, type Page } from "../../fixtures";

export class ImportWizardPO {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  /** 打开向导（首页/资产表头的 Import 实心药丸）。 */
  async open(): Promise<void> {
    await this.page.getByRole("button", { name: "Import", exact: true }).click();
    await expect(this.dialog()).toBeVisible();
  }

  dialog(): Locator {
    return this.page.getByRole("dialog");
  }

  /** 路径输入框（本地源第一步）。 */
  pathInput(): Locator {
    return this.dialog().locator("input").first();
  }

  /** Browse 目录表：按条目名取行（点击 = 分发——bundle 目录起 job、
   * 可导入文件直导、普通目录下钻）。 */
  entryRow(name: string): Locator {
    return this.dialog().getByRole("row").filter({ hasText: name });
  }

  /** 本地路径 → Browse → 目录表出现（Browse 打开的是目录本身；bundle
   * 目录与 JSONL 文件作为目录表里的绿色条目被点击）。 */
  async browseTo(dirPath: string): Promise<void> {
    await this.pathInput().fill(dirPath);
    await this.dialog().getByRole("button", { name: "Browse" }).click();
    await expect(this.dialog().getByText("Browse directories", { exact: false })).toBeVisible();
  }

  /** 走完 bundle 目录导入：Browse 打开 bundle 的**父目录**（bundle 自身是
   * 目录表里的绿色 Bundle 行）→ 点击起 job → 等完成 → Done（整页 reload）。 */
  async importBundleDir(parentDir: string, bundleName: string): Promise<void> {
    await this.browseTo(parentDir);
    await this.entryRow(bundleName).click();
    await expect(this.dialog().getByText("Import complete", { exact: false })).toBeVisible({ timeout: 30_000 });
    await this.dialog().getByRole("button", { name: "Done" }).click();
    await this.page.waitForLoadState("load");
  }

  /** 走完 JSONL 单文件直导：Browse 打开文件所在目录 → 点击绿色 JSONL 行
   *  → 会话批完成后弹窗 1s 自动关闭并整页 reload（无手动 Done）。 */
  async importJsonlFile(parentDir: string, fileName: string): Promise<void> {
    await this.browseTo(parentDir);
    await this.entryRow(fileName).click();
    // 自动关闭 + reload：等待弹窗退场（而非轮询文案——auto-close 有 1s 延迟）
    await expect(this.dialog()).toBeHidden({ timeout: 30_000 });
    await this.page.waitForLoadState("load");
  }
}
