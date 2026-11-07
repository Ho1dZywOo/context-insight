// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// E2E 公共 fixture 层（承袭 opsbot web/frontend/e2e/fixtures.ts 的成熟设计）。
//
// browserConsole（auto fixture）双职责：
// 1. 「页面无未处理异常」作为验收门：断言全绿的用例若期间抛过未捕获
//    pageerror → 用例判负（绿着的白屏回归从此躲不掉）；已知无害片段
//    （带注释说明来源）可加入 ALLOWED_PAGEERROR_FRAGMENTS 豁免。
// 2. 失败诊断落盘：console/pageerror 全程采集，失败时写到 Playwright 的
//    test-results 输出目录（与 trace/截图/录像并排，`npx playwright show-report` 可见）。

import { mkdir, writeFile } from "node:fs/promises";
import { expect as playwrightExpect, test as base, type Locator, type Page } from "@playwright/test";

export type { Locator, Page };
export const expect = playwrightExpect;

type Fixtures = {
  browserConsole: void
}

// 已知无害的页面异常片段豁免清单：每一条都必须带来源注释（为什么无害、
// 从哪个用例观察到）；清单为空 = 门噪声为零，出现新 pageerror 一律先修。
const ALLOWED_PAGEERROR_FRAGMENTS: readonly string[] = [];

export const test = base.extend<Fixtures>({
  browserConsole: [async ({ page }, use, testInfo) => {
    const entries: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (message) => {
      entries.push(`[console:${message.type()}] ${message.text()}`);
    });
    page.on("pageerror", (error) => {
      const text = error.stack || error.message;
      pageErrors.push(text);
      entries.push(`[pageerror] ${text}`);
    });

    await use();

    // 只在断言全绿时把 pageerror 升级为判负：已失败的用例里它只是次级
    // 诊断（照常落盘），再抛会掩盖主失败。
    if (testInfo.status === "passed") {
      const unexpected = pageErrors.filter(
        (text) => !ALLOWED_PAGEERROR_FRAGMENTS.some((fragment) => text.includes(fragment)),
      );
      if (unexpected.length > 0) {
        throw new Error(`Page raised unhandled exception(s):\n${unexpected.join("\n---\n")}`);
      }
    }

    // 失败/超时的用例才落盘诊断（跳过的用例不写空文件）。
    if (testInfo.status === "failed" || testInfo.status === "timedOut") {
      const outputPath = testInfo.outputPath("browser-console.log");
      await mkdir(testInfo.outputDir, { recursive: true });
      const content = entries.length > 0 ? entries.join("\n") : "[no browser console entries]";
      await writeFile(outputPath, `${content}\n`, "utf8");
    }
  }, { auto: true }],
});
