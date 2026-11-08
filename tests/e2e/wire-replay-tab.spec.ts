// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 高级门内的两个 tab（URL ?a 展开）：
//   Wire 轮次 —— proxy 捕获原始 wire 逐轮重放的结构面：头部 + 成员选择器
//     常驻（e2e 语料无 wire 捕获，列表空态不崩是断言面本身）
//   Replay —— 对话全量回放（ChatReplayView 双面板）：播放器控制条 + 播放
//     逐轮推进（solo claude-sample 有真实对话轮）
// 语料：e2e-tools01（wire 多成员）+ solo claude-sample（replay）。

import { expect, test } from "./fixtures";
import { CLAUDE_SAMPLE_SESSION_ID, E2E_TOOL_RUN_ID, E2E_TOOL_MEMBER_A } from "./constants";
import { RunWorkbenchPO } from "./support/pom/RunWorkbenchPO";

test.describe("Wire 轮次面板（高级门）", () => {
  test("结构面：Wire 头部 + 成员选择器在场（无捕获不崩）", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_TOOL_RUN_ID, "a&tab=wire");
    await run.expectTabActive("wire");

    // 板块头 + 成员选择器（RunMemberPicker 的成员钮以 taskId 为 title 锚）
    await expect(page.getByRole("heading", { name: "Wire 轮次" })).toBeVisible();
    await expect(page.getByTitle(E2E_TOOL_MEMBER_A, { exact: true })).toBeVisible();
  });
});

test.describe("Replay 面板（高级门）", () => {
  test("对话回放：双面板 + 播放推进（#计数器从 — 走到 #1）", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(`solo:${CLAUDE_SAMPLE_SESSION_ID}`, "a&tab=replay");
    await run.expectTabActive("replay");

    // 双面板分栏头（ChatReplayView 契约文本）
    await expect(page.getByText("User ↔ Assistant", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Assistant ↔ LLM", { exact: true })).toBeVisible();

    // 点击 ▶ Play：播放位置推进到 #N / M（逐轮重放真正在走——计数器从
    // 「—」换为具体轮位）
    await page.getByRole("button", { name: "▶ Play" }).click();
    await expect(page.getByText(/#\d+ \/ \d+/)).toBeVisible({ timeout: 10_000 });
  });
});
