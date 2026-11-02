// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// run 工作台 Turns 角色筛选条（RunTurnsRoleFilter）纯函数回归锁：选项派生
// 计数口径（主链轮走行渲染同源归一、命令附注行不计数、子代理轮按原始 role）
// 与多选状态机（点入/点出、不改原集合）。

import { describe, it, expect } from "vitest";
import { deriveRoleOptions, toggleRoleFilter } from "@/components/run/RunTurnsRoleFilter";
import type { TurnsBlockTurn } from "@/components/run/run-turns-display";

const CONTINUATION_SUMMARY =
  "This session is being continued from a previous conversation\n\nPrimary Request and Intent: build a run workbench";

function makeTurn(overrides: Partial<TurnsBlockTurn> = {}): TurnsBlockTurn {
  return {
    turnId: "t1",
    turnIndex: 1,
    role: "assistant",
    contentSummary: null,
    agentName: null,
    isSubagent: false,
    subagentName: null,
    subagentSessionId: null,
    totalTokens: 0,
    inputTokens: 0,
    inputMessagesCount: 0,
    createdAt: null,
    contextWindowPct: null,
    latencyMs: 0,
    toolCalls: [],
    ...overrides,
  };
}

describe("deriveRoleOptions：角色选项计数", () => {
  const turns: TurnsBlockTurn[] = [
    makeTurn({ turnId: "cmd", contentSummary: `<command-name>/compact</command-name>` }),
    makeTurn({ turnId: "cav", contentSummary: `<local-command-caveat>x</local-command-caveat>` }),
    makeTurn({ turnId: "out", contentSummary: `<local-command-stdout>o</local-command-stdout>` }),
    makeTurn({ turnId: "cont", contentSummary: CONTINUATION_SUMMARY }),
    makeTurn({ turnId: "comp", agentName: "compaction-boundary", contentSummary: "" }),
    makeTurn({ turnId: "asst", contentSummary: "hi" }),
    makeTurn({ turnId: "user", role: "user", contentSummary: "go" }),
    makeTurn({ turnId: "sub1", role: "assistant", isSubagent: true, subagentSessionId: "s1" }),
    makeTurn({ turnId: "sub2", role: "tool_result", isSubagent: true, subagentSessionId: "s2" }),
  ];

  it("固定优先序 + 计数：命令附注行不计数，子代理轮按原始 role 计数", () => {
    expect(deriveRoleOptions(turns)).toEqual([
      { role: "user", label: "user", count: 1 },
      { role: "assistant", label: "assistant", count: 2 },
      { role: "tool_result", label: "tool_result", count: 1 },
      { role: "command", label: "命令", count: 1 },
      { role: "continuation", label: "续接", count: 1 },
      { role: "compaction", label: "压缩", count: 1 },
    ]);
  });

  it("未登记角色按出现序追加在后", () => {
    const extra = [
      makeTurn({ turnId: "c1", role: "custom_role", contentSummary: "a" }),
      makeTurn({ turnId: "u", role: "user", contentSummary: "b" }),
    ];
    const options = deriveRoleOptions(extra);
    expect(options.map(o => o.role)).toEqual(["user", "custom_role"]);
    expect(options[1].label).toBe("custom_role");
  });

  it("空列表 → 空选项", () => {
    expect(deriveRoleOptions([])).toEqual([]);
  });
});

describe("toggleRoleFilter：多选状态机", () => {
  it("点入/点出，返回新集合且不改原集合", () => {
    const prev = new Set<string>();
    const added = toggleRoleFilter(prev, "user");
    expect(added.has("user")).toBe(true);
    expect(prev.size).toBe(0);

    const removed = toggleRoleFilter(added, "user");
    expect(removed.has("user")).toBe(false);
    expect(added.has("user")).toBe(true);
  });

  it("多选并集", () => {
    const next = toggleRoleFilter(new Set(["user"]), "assistant");
    expect([...next].sort()).toEqual(["assistant", "user"]);
  });
});