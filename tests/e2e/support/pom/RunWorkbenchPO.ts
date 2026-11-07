// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Run 工作台（`/run/:runId`，solo 会话同壳）页面对象：tab 导航（RUN_TABS
// 表：Overview / Graph / Turns / Context / Audit / Perf / Skills / Files /
// Wire 轮次 / Replay / Score——wire/replay 默认隐藏，URL ?a 展开）、tab 面
// 板可见性、跨成员搜索胶囊与命中浮层、返回钮（工作台历史栈）。锚点 =
// RunTabBar（data-run-tabbar）与面板（data-run-tab=<key>）的既有契约。

import { expect, type Locator, type Page } from "../../fixtures";

export const RUN_TAB_LABELS = {
  overview: "Overview",
  graph: "Graph",
  turns: "Turns",
  context: "Context",
  audit: "Audit",
  perf: "Perf",
  skills: "Skills",
  files: "Files",
  wire: "Wire 轮次",
  replay: "Replay",
  score: "Score",
} as const;

export type RunTabKey = keyof typeof RUN_TAB_LABELS;

export class RunWorkbenchPO {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async goto(runId: string, params = ""): Promise<void> {
    await this.page.goto(`/run/${runId}${params ? `?${params}` : ""}`);
  }

  tabBar(): Locator {
    return this.page.locator("[data-run-tabbar]");
  }

  tabButton(tab: RunTabKey): Locator {
    return this.tabBar().getByRole("button", { name: RUN_TAB_LABELS[tab], exact: true });
  }

  /** 活跃面板定位器（data-run-tab=<key>）。 */
  panel(tab: RunTabKey): Locator {
    return this.page.locator(`[data-run-tab="${tab}"]`);
  }

  /** 活跃面板断言。注意只看可见性：非活跃面板挂 tailwind `hidden` 类
   *  （display:none → 不可见），但合法类名里含 `overflow-hidden` 这类
   *  子串——不能用 /hidden/ 正则判类（会把活跃面板误判成隐藏）。另注意
   *  非活跃面板要「访问过才挂载」（visitedTabs 惰性挂载契约）。 */
  async expectTabActive(tab: RunTabKey): Promise<void> {
    await expect(this.panel(tab)).toBeVisible();
  }

  async switchTab(tab: RunTabKey): Promise<void> {
    await this.tabButton(tab).click();
    await this.expectTabActive(tab);
    await expect(this.page).toHaveURL(new RegExp(`tab=${tab}`));
  }

  /** 返回钮（导航行最左，title 即语义锚点）。 */
  backButton(): Locator {
    return this.page.getByTitle("返回上一步");
  }

  /** 跨成员搜索胶囊输入框（Run 轨右端常驻）。 */
  turnsSearchInput(): Locator {
    return this.page.locator("[data-turns-search-input]");
  }

  /** 搜索命中浮层（毛玻璃命中索引）。 */
  hitsOverlay(): Locator {
    return this.page.locator("[data-turns-hits]");
  }

  /** 错误态（加载失败在面板区居中）：重试/返回钮同时在场即错误卡形态。 */
  async expectErrorState(): Promise<void> {
    await expect(this.page.getByRole("button", { name: "重试", exact: true })).toBeVisible();
    await expect(this.page.getByRole("button", { name: "返回", exact: true })).toBeVisible();
  }
}
