// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 导入旅程（用户视角全链路，承袭 opsbot journeys.spec 的旅程式写法）：
//
//   ① JSONL 单文件首导：向导 → Browse 目录表 → 绿色条目点击直导 → 会话
//      批自动完成并整页刷新 → 新会话行出现 → 下钻 solo 视图——「导入前后
//      差一行」是断言核心（global-setup 刻意不播种这条会话）
//   ② bundle 重导入（幂等语义）：mini-bundle 已播种 → 再走向导导入 → job
//      完成（existing 计数路径）→ run 行仍恰好一条——重导入不得复制资产行

import path from "node:path";
import { expect, test } from "./fixtures";
import { CLAUDE_SKILL_SESSION_ID, E2E_RUN_ID, REPO_ROOT } from "./constants";
import { WorkbenchHomePO } from "./support/pom/WorkbenchHomePO";
import { ImportWizardPO } from "./support/pom/ImportWizardPO";

const E2E_DATA_DIR = path.join(REPO_ROOT, "tests/ut/data/e2e");
const RUN_DATA_DIR = path.join(REPO_ROOT, "tests/ut/data/run");

test.describe("导入向导旅程", () => {
  test("JSONL 单文件首导：新会话行出现并可下钻", async ({ page }) => {
    const home = new WorkbenchHomePO(page);
    const wizard = new ImportWizardPO(page);
    await home.goto();

    // 前置：这条会话不在账上（播种清单里没有它）
    await expect(home.sessionRowByTaskId(CLAUDE_SKILL_SESSION_ID)).toHaveCount(0);

    await wizard.open();
    await wizard.importJsonlFile(E2E_DATA_DIR, "claude-skill-dispatch.jsonl");

    // 旅程断言核心：导入前后差一行（skill 派发会话进场）
    await expect(home.sessionRowByTaskId(CLAUDE_SKILL_SESSION_ID)).toBeVisible({ timeout: 15_000 });
    await home.openSession(CLAUDE_SKILL_SESSION_ID);
    await expect(page.locator("[data-run-tabbar]")).toBeVisible();
  });

  test("bundle 重导入幂等：job 走 existing 路径，run 行不重复", async ({ page }) => {
    const home = new WorkbenchHomePO(page);
    const wizard = new ImportWizardPO(page);
    await home.goto();
    await expect(home.runRow(E2E_RUN_ID)).toBeVisible();

    await wizard.open();
    await wizard.importBundleDir(RUN_DATA_DIR, "mini-bundle");

    // 重导入后 run 行仍恰好一条（(taskId, framework) 唯一约束 + existing 计数）
    await expect(home.runRow(E2E_RUN_ID)).toHaveCount(1, { timeout: 15_000 });
  });
});
