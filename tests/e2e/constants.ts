// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// E2E 套件单一事实源：端口 / 被测 URL / 夹具路径 / 关键 id。
// playwright.config.ts（webServer 与 use.baseURL）、boot-server.sh（端口）、
// global-setup.ts（播种夹具路径）与各 spec 共用——魔法串只活在这里。

import path from "node:path";
import { fileURLToPath } from "node:url";

/** 仓库根（tests/e2e/constants.ts → 上退两级：tests/e2e → tests → 根）。 */
export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** 被测服务端口：刻意避开 dev 实例 21025 与 test:report 21031；可经
 *  INSIGHT_E2E_PORT 覆盖（boot-server.sh 同款回退，两边必须一致）。 */
export const E2E_PORT = Number(process.env.INSIGHT_E2E_PORT ?? 21100);

/** 被测服务基址（webServer 只绑 127.0.0.1——E2E 不该对外网暴露）。 */
export const BASE_URL = `http://127.0.0.1:${E2E_PORT}`;

/** mini-bundle（minidemo01）：run 工作台结构语料（图/代际/验收/子图）——
 *  与 vitest IT 同一夹具（tests/ut/run-*.test.tsx 的 view-model 事实源），
 *  E2E 换真服务真库跑。注意：它的会话是极简骨架（1 问 1 答，零工具调用），
 *  工具维度的断言走 TOOL_BUNDLE_DIR。 */
export const MINI_BUNDLE_DIR = path.join(REPO_ROOT, "tests/ut/data/run/mini-bundle");

/** E2E 自有工具语料（e2e-tools01）：init/build 两节点 + 3 个带 tool_use/
 *  tool_result 的 claude-code 会话（Read×3 / bash×2 / Grep×1，时间戳撑起
 *  真实工具时长）——工具耗时卡与 tool:/member: 下钻链路的事实源。工具名
 *  是夹具常量（断言可逐字锁定）。 */
export const TOOL_BUNDLE_DIR = path.join(REPO_ROOT, "tests/e2e/fixtures/tool-bundle");
export const E2E_TOOL_RUN_ID = "e2e-tools01";
/** Σ 最高工具（bash：15s + 8s = 23s）——工具耗时卡默认选中行。 */
export const E2E_TOP_TOOL = "bash";
/** bash 的两个成员会话（下钻归因与成员分解的断言锚点）。 */
export const E2E_TOOL_MEMBER_A = "ses_e2e_exec";
export const E2E_TOOL_MEMBER_B = "ses_e2e_exec2";

/** 播种用 solo 会话夹具（claude-code JSONL，导入管线与 vitest
 *  e2e-import-observe.test.ts 同款）。taskId = 文件名主干（适配器
 *  deriveSessionIdFromName 契约——目录扫描/单文件直导/缺省推导同值）。 */
export const CLAUDE_SAMPLE_JSONL = path.join(REPO_ROOT, "tests/ut/data/e2e/claude-sample.jsonl");

/** 该 JSONL 的会话 id（文件名主干——适配器契约，非 JSONL 内 sessionId 字段）。 */
export const CLAUDE_SAMPLE_SESSION_ID = "claude-sample";

/** 导入旅程专用 JSONL（claude-skill-dispatch）：global-setup 刻意不播种，
 *  留给 import-journey.spec 走 UI 向导首导——「新行出现」的旅程断言需要
 *  一条播种前不存在的会话。 */
export const CLAUDE_SKILL_JSONL = path.join(REPO_ROOT, "tests/ut/data/e2e/claude-skill-dispatch.jsonl");

/** 该 JSONL 的会话 id（文件名主干，同上契约）。 */
export const CLAUDE_SKILL_SESSION_ID = "claude-skill-dispatch";

/** 回收站旅程专用一次性 JSONL（claude-autorefresh-base）：同样刻意不播种，
 *  recycle-bin.spec 自行经 HTTP 导入 → UI 删除 → 回收站 → 恢复——全程自包
 *  自净，不对其他 spec 留任何先验状态（首条用户消息「2+2」亦作断言锚）。 */
export const AUTOREFRESH_JSONL = path.join(REPO_ROOT, "tests/ut/data/e2e/claude-autorefresh-base.jsonl");

/** 该 JSONL 的会话 id（文件名主干，同上契约）。 */
export const AUTOREFRESH_SESSION_ID = "claude-autorefresh-base";

/** 播种产出的 run id（mini-bundle/workflow.json 的 id 字段）。 */
export const E2E_RUN_ID = "minidemo01";
