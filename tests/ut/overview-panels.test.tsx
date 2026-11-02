// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// Overview 面板回归锁：
//   ① 技能 `…t` token 按 turn 去重——同一 turn 内某技能多条事件只计一次
//      （修复前逐事件累加会重复计总 turn token、高估技能 token）；
//   ② 时间窗（formatWindow 的 md）与 formatTimestamp 的 month/day 补零，
//      消除 `2026/1/5` 这种宽度不一致的时间。
// 无 @testing-library/react，沿用仓内既有的 renderToStaticMarkup 静态渲染
// 断言模式（如 turn-timeline-jump、skill-audit-view smoke 测试）。

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import {
  OverviewPanels,
  formatTimestamp,
  type OverviewTurn,
  type OverviewSkill,
  type OverviewIdentity,
  type OverviewMetrics,
} from "@/components/observe/OverviewPanels";

function turn(over: Partial<OverviewTurn> & Pick<OverviewTurn, "turnId" | "turnIndex">): OverviewTurn {
  return {
    role: "assistant",
    contentSummary: null,
    agentName: null,
    isSubagent: false,
    subagentName: null,
    subagentSessionId: null,
    model: null,
    finishReason: null,
    totalTokens: 0,
    createdAt: null,
    toolCalls: [],
    skillEvents: [],
    ...over,
  };
}

const IDENTITY: OverviewIdentity = {
  framework: "opencode",
  frameworkVersion: null,
  memberCount: 1,
  model: "test-model",
  startTime: "2026-01-05T03:04:00",
  endTime: "2026-01-05T04:05:00",
  sourcePath: null,
};

const METRICS: OverviewMetrics = {
  totalTokens: 0,
  totalCost: 0,
  wallMs: 0,
  activeMs: 0,
  llmActiveMs: 0,
  llmCallCount: 0,
  toolCallCount: 0,
  subagentCount: 0,
  errorCount: 0,
};

function render(
  turns: OverviewTurn[],
  skills: OverviewSkill[],
  identityOver: Partial<OverviewIdentity> = {},
): string {
  return renderToStaticMarkup(
    createElement(OverviewPanels, {
      identity: { ...IDENTITY, ...identityOver },
      metrics: METRICS,
      turns,
      skills,
      onOpenTurns: () => {},
    }),
  );
}

const SKILL_EVENT = (skillName: string, eventType: string) => ({
  skillName,
  eventType,
  success: true,
  errorMessage: null,
});

describe("OverviewPanels", () => {
  it("技能 token 按 turn 去重：同一 turn 多条事件只计一次，跨 turn 累加", () => {
    const turns = [
      turn({
        turnId: "t0",
        turnIndex: 0,
        totalTokens: 100,
        // 同一 turn 内 s1 有 3 条事件——修复前会被计 3 次（300），修复后只计一次（100）
        skillEvents: [
          SKILL_EVENT("s1", "load"),
          SKILL_EVENT("s1", "use"),
          SKILL_EVENT("s1", "invoke"),
        ],
      }),
      turn({
        turnId: "t1",
        turnIndex: 1,
        totalTokens: 200,
        skillEvents: [SKILL_EVENT("s1", "invoke")],
      }),
    ];
    const skills: OverviewSkill[] = [{ skillName: "s1", version: 1, invocationCount: 4 }];

    const html = render(turns, skills);

    // 去重正确值：100 + 200 = 300 → "300t"
    expect(html).toContain("300t");
    // 逐事件累加的错误值：100*3 + 200 = 500 → 不得出现 "500t"
    expect(html).not.toContain("500t");
  });

  it("时间窗 month/day 补零（formatWindow 的 md）", () => {
    const html = render([], [], {
      startTime: "2026-01-05T03:04:00",
      endTime: "2026-01-05T04:05:00",
    });

    expect(html).toContain("01/05 03:04 → 04:05");
    // 修复前宽参差形态：1/5 03:04
    expect(html).not.toContain("1/5 03:04");
  });
});

describe("formatTimestamp", () => {
  it("month/day 补零，保持列宽对齐", () => {
    expect(formatTimestamp("2026-01-05T03:04:00")).toBe("2026/01/05 03:04");
    expect(formatTimestamp("2026-11-03T15:07:00")).toBe("2026/11/03 15:07");
    expect(formatTimestamp("2026-02-15T00:00:00")).toBe("2026/02/15 00:00");
  });

  it("空值回退 N/A", () => {
    expect(formatTimestamp(null)).toBe("N/A");
  });
});