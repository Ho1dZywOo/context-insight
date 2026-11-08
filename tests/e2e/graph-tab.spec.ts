// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Graph 面板（RunGraph 纯 SVG 铁律的端到端回声）：DAG 画布以 <svg
// role="img"> 渲染、缩放工具条四钮在场可点、节点标签来自 workflow.json 的
// 节点定义（minidemo01：init / build）。语料 = minidemo01（结构面）。

import { expect, test } from "./fixtures";
import { E2E_RUN_ID } from "./constants";
import { RunWorkbenchPO } from "./support/pom/RunWorkbenchPO";

test.describe("Graph 面板", () => {
  test("DAG 画布：SVG 渲染 + 节点标签（init/build）在场", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_RUN_ID, "tab=graph");
    await run.expectTabActive("graph");

    // 画布本体：纯 SVG（无 canvas、无第三方图表库），role=img 语义锚点
    const canvas = run.panel("graph").locator("svg[role='img']").first();
    await expect(canvas).toBeVisible();
    // 节点标签 = workflow.json 节点 id（init / build——结构语料夹具常量）
    await expect(canvas).toContainText("init");
    await expect(canvas).toContainText("build");
  });

  test("缩放工具条：四钮在场，适配画布可点", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_RUN_ID, "tab=graph");
    await run.expectTabActive("graph");

    // 工具条按钮走 title 语义锚点（RunCanvas 契约）
    for (const title of ["放大（Ctrl + 滚轮）", "缩小（Ctrl + 滚轮）", "适配画布", "重置缩放"]) {
      await expect(page.getByTitle(title)).toBeVisible();
    }
    // 适配画布点击后画布仍在（相机重置不崩——browserConsole 哨兵盯异常）
    await page.getByTitle("适配画布").click();
    await expect(run.panel("graph").locator("svg[role='img']").first()).toBeVisible();
  });
});
