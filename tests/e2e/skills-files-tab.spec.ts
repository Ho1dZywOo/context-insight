// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Skills / Files 面板内容契约。语料分工：
//   e2e-tools01 → Files（Read×3 的三个文件路径逐字锁定 + 搜索胶囊过滤）
//   solo claude-sample → Skills（skill-creator 斜杠调用 → SkillEvent →
//     技能观测行）与 Files（Read common_conversion.md）
// 文件路径是夹具常量（Read tool_use 的 file_path 参数——断言逐字锁定）。

import { expect, test } from "./fixtures";
import { CLAUDE_SAMPLE_SESSION_ID, E2E_TOOL_RUN_ID } from "./constants";
import { RunWorkbenchPO } from "./support/pom/RunWorkbenchPO";

test.describe("Files 面板", () => {
  test("文件读取观测：三个 Read 文件行 + 搜索胶囊过滤", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_TOOL_RUN_ID, "tab=files");
    await run.expectTabActive("files");

    // Read×3 的文件路径（data-file-row={file.path} 契约，夹具常量）
    for (const file of ["/repo/build.config.json", "/repo/src/main.ts", "/repo/dist/manifest.json"]) {
      await expect(page.locator(`[data-file-row="${file}"]`)).toBeVisible({ timeout: 20_000 });
    }

    // 搜索胶囊：客户端过滤（"main" 只命中 src/main.ts——manifest 不含该串）
    const search = page.locator("[data-file-search]");
    await expect(search).toBeVisible();
    await search.fill("main");
    await expect(page.locator("[data-file-row='/repo/src/main.ts']")).toBeVisible();
    await expect(page.locator("[data-file-row='/repo/build.config.json']")).toHaveCount(0);
    await expect(page.locator("[data-file-row='/repo/dist/manifest.json']")).toHaveCount(0);
  });

  test("solo 会话 Files：Read 的设计文档行在场", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(`solo:${CLAUDE_SAMPLE_SESSION_ID}`, "tab=files");
    await run.expectTabActive("files");

    // claude-sample 唯一一次 Read：设计文档（夹具常量）
    await expect(
      page.locator("[data-file-row='/home/wangrui/code/ops-math/common_conversion.md']"),
    ).toBeVisible({ timeout: 20_000 });
  });
});

test.describe("Skills 面板", () => {
  test("solo 会话 Skills：skill-creator 斜杠调用的技能观测行", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(`solo:${CLAUDE_SAMPLE_SESSION_ID}`, "tab=skills");
    await run.expectTabActive("skills");

    // claude-sample 以 /skill-creator 开场（斜杠命令 + skill 注入 →
    // SkillEvent invoke）——技能观测行的端到端回声
    await expect(page.locator('[data-skill-row="skill-creator"]').first()).toBeVisible({ timeout: 20_000 });
  });
});
