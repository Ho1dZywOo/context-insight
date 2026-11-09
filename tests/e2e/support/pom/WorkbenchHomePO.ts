// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 统一工作台首页（`/`）页面对象：资产行（会话 + run 单表混排）、类型分段
// 过滤、搜索框、行点击下钻。定位锚点全部来自 AssetList.tsx 的稳定
// data-* 契约（data-asset-row / data-asset-key / data-asset-search /
// data-kind-seg / data-stat——与 vitest IT 同一契约面，改契约两套测试一起红）。

import { expect, type Locator, type Page } from "../../fixtures";

/** 资产行 key 形态（list-service 单一源）：run = `run:<runId>`，
 * session = `session:<db-id>`（会话按 taskId 定位须用行内 title 元素，见 sessionRowByTaskId）。 */
export function assetKey(kind: "run" | "session", id: string): string {
  return `${kind}:${id}`;
}

export class WorkbenchHomePO {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async goto(query = ""): Promise<void> {
    await this.page.goto(`/${query ? `?${query}` : ""}`);
  }

  assetRows(): Locator {
    return this.page.locator("[data-asset-row]");
  }

  runRow(runId: string): Locator {
    return this.page.locator(`[data-asset-key="${assetKey("run", runId)}"]`);
  }

  /** 会话行（按 taskId——subtitle 行内 title 携带，db 自增 id 不作锚点）。 */
  sessionRowByTaskId(taskId: string): Locator {
    return this.page.locator("[data-asset-row]").filter({
      has: this.page.locator(`p[title="${taskId}"]`),
    });
  }

  /** 顶部指标瓦片（data-stat=<label>）。 */
  stat(label: string): Locator {
    return this.page.locator(`[data-stat="${label}"]`);
  }

  searchBox(): Locator {
    return this.page.locator("[data-asset-search]");
  }

  /** 类型分段（All / Sessions / Runs；data-kind-seg 镜像当前选中）。 */
  kindSegment(): Locator {
    return this.page.locator("[data-kind-seg]");
  }

  async switchKind(label: "All" | "Sessions" | "Runs"): Promise<void> {
    await this.kindSegment().getByRole("button", { name: label, exact: true }).click();
  }

  async expectKind(kind: string): Promise<void> {
    await expect(this.kindSegment()).toHaveAttribute("data-kind-seg", kind);
  }

  /** 点 run 行标题下钻 run 工作台。 */
  async openRun(runId: string): Promise<void> {
    await this.runRow(runId).getByRole("link").click();
    await this.page.waitForURL(new RegExp(`/run/${runId}$`));
  }

  /** 点会话行标题下钻 solo 会话视图。 */
  async openSession(taskId: string): Promise<void> {
    await this.sessionRowByTaskId(taskId).getByRole("link").click();
    await this.page.waitForURL(new RegExp(`/run/solo:${encodeURIComponent(taskId)}$`));
  }
}
