// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom
// Turns 角色筛选多选 IT：左列列表头筛选条（RunTurnsRoleFilter）与节点列表
// （RunTurnsNodes）按 RunTurnsTab 同款接线组成 harness，在真实 React 树上
// 逐 chip 点击驱动完整状态机——初始全显 → 单选 → 加选并集 → 取消单角色 →
// 「全部」清空；泳道行同口径过滤、无匹配轮的 lane 整块让位；角色归一
// （命令/续接/压缩）与选项派生为纯函数直测。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createElement, useState, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import {
  RunTurnsNodes,
  type TurnsNode,
  type TurnsNodeSession,
  type TurnsBlockTurn,
  type TurnsBridge,
} from "@/components/run/RunTurnsNodes";
import { RunTurnsRoleFilter, deriveRoleOptions, toggleRoleFilter } from "@/components/run/RunTurnsRoleFilter";

function makeTurn(turnIndex: number, role: string, over: Partial<TurnsBlockTurn> = {}): TurnsBlockTurn {
  return {
    turnId: `t-${turnIndex}`,
    turnIndex,
    role,
    contentSummary: `turn ${turnIndex}`,
    agentName: null,
    isSubagent: false,
    subagentName: null,
    subagentSessionId: null,
    subagentType: null,
    totalTokens: 10,
    inputTokens: 0,
    inputMessagesCount: 0,
    createdAt: null,
    contextWindowPct: null,
    latencyMs: 0,
    toolCalls: [],
    finishReason: null,
    ...over,
  };
}

const session: TurnsNodeSession = {
  taskId: "task-1",
  label: null,
  role: "execute",
  attemptOrdinal: 1,
  ref: {
    taskId: "task-1",
    framework: "",
    rowId: "",
    turns: 7,
    totalTokens: 0,
    durationMs: null,
    label: "task-1",
    startTime: null,
    endTime: null,
    cacheReadTokens: null,
  },
};

function buildNodes(): TurnsNode[] {
  return [
    {
      key: "n-1-g0",
      nodeId: "1",
      generation: 0,
      label: "节点一",
      taskType: "agent",
      status: "passed",
      executionState: "executed",
      carriedFromGeneration: null,
      hasSubgraph: false,
      depth: 0,
      attempts: [
        {
          ordinal: 1,
          status: "passed",
          verification: { type: "none", status: "none", reason: null },
          outputText: null,
          execute: session,
          verify: null,
        },
      ],
      sessions: [session],
    },
  ];
}

// RunTurnsTab 同款接线（去掉 fetch 壳）：筛选条持有 roleFilter，节点列表消费
function Harness({ turns, bridges, selectedTurnId }: { turns: TurnsBlockTurn[]; bridges: TurnsBridge[]; selectedTurnId: string | null }) {
  const [roleFilter, setRoleFilter] = useState<ReadonlySet<string>>(new Set());
  const memberData = useMemo(
    () => new Map([["task-1", { turns, total: turns.length, page: 1, loading: false }]]),
    [turns],
  );
  const nodes = useMemo(() => buildNodes(), []);
  const options = useMemo(() => deriveRoleOptions(turns), [turns]);
  return createElement(
    "div",
    null,
    createElement(RunTurnsRoleFilter, {
      options,
      total: turns.length,
      selected: roleFilter,
      onToggle: r => setRoleFilter(p => toggleRoleFilter(p, r)),
      onReset: () => setRoleFilter(new Set()),
    }),
    createElement(RunTurnsNodes, {
      nodes,
      bands: [],
      rollbacks: [],
      expanded: new Set(["n-1-g0"]),
      onToggleNode: () => {},
      memberData,
      bridges,
      selectedTurnId,
      onSelectTurn: () => {},
      onLoadMore: () => {},
      roleFilter,
    }),
  );
}

// 5 主链轮（user×1 / assistant×1 / 命令×1 / system×1 / 压缩×1）+ 子代理
// 泳道 2 轮（user/assistant）挂在 t-1 派发下
const fixtureTurns = [
  makeTurn(0, "user", { contentSummary: "uq-root-user-zero" }),
  makeTurn(1, "assistant", { contentSummary: "uq-root-assistant-one" }),
  makeTurn(2, "user", {
    contentSummary: "<command-name>/compact</command-name><command-message>compact</command-message><command-args></command-args>",
  }),
  makeTurn(3, "system", { contentSummary: "uq-root-system-three" }),
  makeTurn(4, "user", { isSubagent: true, subagentSessionId: "sub-br-1", subagentName: "uq-helper", contentSummary: "uq-lane-user-four" }),
  makeTurn(5, "assistant", { isSubagent: true, subagentSessionId: "sub-br-1", contentSummary: "uq-lane-assistant-five" }),
  makeTurn(6, "user", { agentName: "compaction-boundary", contentSummary: "uq-root-compaction-six" }),
];

const fixtureBridges: TurnsBridge[] = [
  {
    bridgeId: "br-1",
    dispatchTurnId: "t-1",
    dispatchContent: "派发任务",
    subagentSessionId: "sub-br-1",
    subagentType: null,
    subagentName: "uq-helper",
    agentName: null,
    status: "completed",
    subagentTokens: 0,
    subagentLatencyMs: 0,
  },
];

const chip = (role: string): HTMLButtonElement | null => document.querySelector(`[data-role-chip="${role}"]`);
const row = (id: string): Element | null => document.querySelector(`[data-turn-row="${id}"]`);
const isActive = (el: Element | null) => !!el && el.className.includes("bg-primary");
const laneVisible = () => document.body.textContent!.includes("uq-helper");

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  delete (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

async function mount(selectedTurnId: string | null) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  await act(async () => {
    root.render(createElement(Harness, { turns: fixtureTurns, bridges: fixtureBridges, selectedTurnId }));
  });
  return {
    click: async (role: string) => {
      await act(async () => {
        chip(role)!.click();
      });
    },
    done: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

describe("Turns 角色筛选多选（主链行状态机）", () => {
  it("初始全显 + 「全部」高亮 + 角色计数正确（lane 折叠态头部保留）", async () => {
    const h = await mount(null);
    for (const id of ["t-0", "t-1", "t-2", "t-3", "t-6"]) expect(row(id)).not.toBeNull();
    expect(row("t-4")).toBeNull(); // 泳道折叠，行不在 DOM
    expect(laneVisible()).toBe(true);
    expect(isActive(chip("all"))).toBe(true);
    for (const r of ["user", "assistant", "system", "command", "compaction"]) {
      expect(chip(r)).not.toBeNull();
      expect(isActive(chip(r))).toBe(false);
    }
    expect(chip("continuation")).toBeNull(); // 未出现过的角色不出 chip
    expect(chip("user")!.textContent).toContain("2"); // 主链 1 + 泳道 1
    expect(chip("assistant")!.textContent).toContain("2");
    expect(chip("system")!.textContent).toContain("1");
    expect(chip("command")!.textContent).toContain("命令");
    expect(chip("command")!.textContent).toContain("1");
    expect(chip("compaction")!.textContent).toContain("压缩");
    await h.done();
  });

  it("单选 user → 加选 assistant 并集 → 取消 user → 「全部」清空回全显", async () => {
    const h = await mount(null);
    // 单选 user：只剩主链 user 行（命令/压缩轮按归一角色被滤掉）
    await h.click("user");
    expect(row("t-0")).not.toBeNull();
    for (const id of ["t-1", "t-2", "t-3", "t-6"]) expect(row(id)).toBeNull();
    expect(isActive(chip("user"))).toBe(true);
    expect(isActive(chip("all"))).toBe(false);
    // 泳道有 user 轮，折叠态头部保留
    expect(laneVisible()).toBe(true);
    // 加选 assistant：并集（多选核心——不顶掉第一个）
    await h.click("assistant");
    expect(row("t-0")).not.toBeNull();
    expect(row("t-1")).not.toBeNull();
    for (const id of ["t-2", "t-3", "t-6"]) expect(row(id)).toBeNull();
    expect(isActive(chip("user"))).toBe(true);
    expect(isActive(chip("assistant"))).toBe(true);
    // 取消 user：只剩 assistant
    await h.click("user");
    expect(row("t-0")).toBeNull();
    expect(row("t-1")).not.toBeNull();
    expect(isActive(chip("user"))).toBe(false);
    // 「全部」清空：回全显
    await h.click("all");
    for (const id of ["t-0", "t-1", "t-2", "t-3", "t-6"]) expect(row(id)).not.toBeNull();
    expect(isActive(chip("all"))).toBe(true);
    await h.done();
  });

  it("筛选无匹配轮的泳道整块让位（头部不残留）", async () => {
    const h = await mount(null);
    await h.click("system");
    expect(row("t-3")).not.toBeNull();
    expect(laneVisible()).toBe(false); // 泳道只有 user/assistant 轮，system 下让位
    await h.click("all");
    expect(laneVisible()).toBe(true);
    await h.done();
  });
});

describe("Turns 角色筛选多选（泳道行展开态）", () => {
  it("选中子代理轮自动展开后：泳道行同口径过滤，无匹配整块让位", async () => {
    const h = await mount("t-4");
    expect(row("t-4")).not.toBeNull();
    expect(row("t-5")).not.toBeNull();
    // 只看 assistant：泳道 user 行让位、assistant 行保留
    await h.click("assistant");
    expect(row("t-4")).toBeNull();
    expect(row("t-5")).not.toBeNull();
    expect(row("t-1")).not.toBeNull();
    expect(row("t-0")).toBeNull();
    expect(laneVisible()).toBe(true);
    // 换 system：泳道整块让位
    await h.click("all");
    await h.click("system");
    expect(row("t-3")).not.toBeNull();
    expect(row("t-4")).toBeNull();
    expect(row("t-5")).toBeNull();
    expect(laneVisible()).toBe(false);
    await h.done();
  });
});

describe("角色选项派生与状态机（纯函数）", () => {
  it("deriveRoleOptions：固定优先序、未出现角色不列、未知角色追加、命令附注行不计数、子代理按原始 role", () => {
    const turns = [
      makeTurn(0, "user"),
      makeTurn(1, "assistant"),
      makeTurn(2, "user", { contentSummary: "<local-command-caveat>caveat</local-command-caveat>" }),
      makeTurn(3, "user", { contentSummary: "<local-command-stdout>out</local-command-stdout>" }),
      makeTurn(4, "user", { agentName: "compaction-boundary" }),
      makeTurn(5, "user", { contentSummary: "This session is being continued from a previous conversation" }),
      makeTurn(6, "custom-role"),
      makeTurn(7, "user", { isSubagent: true, subagentSessionId: "s1" }),
    ];
    const opts = deriveRoleOptions(turns);
    expect(opts.map(o => o.role)).toEqual(["user", "assistant", "continuation", "compaction", "custom-role"]);
    expect(opts[0].count).toBe(2); // 主链 1 + 子代理原始 role 1；caveat/stdout 不计数
    expect(opts[1].count).toBe(1);
    expect(opts.find(o => o.role === "custom-role")!.label).toBe("custom-role"); // 未登记角色透传原名
    expect(opts.find(o => o.role === "continuation")!.label).toBe("续接");
  });

  it("deriveRoleOptions：命令轮归一为 command 并计数", () => {
    const opts = deriveRoleOptions([
      makeTurn(0, "user"),
      makeTurn(1, "user", {
        contentSummary: "<command-name>/compact</command-name><command-message>compact</command-message><command-args></command-args>",
      }),
    ]);
    expect(opts.map(o => o.role)).toEqual(["user", "command"]);
    expect(opts[1].count).toBe(1);
  });

  it("toggleRoleFilter：点入 → 加选 → 点出，集合身份逐次更替", () => {
    let f = toggleRoleFilter(new Set(), "user");
    expect([...f]).toEqual(["user"]);
    f = toggleRoleFilter(f, "assistant");
    expect([...f]).toEqual(["user", "assistant"]);
    f = toggleRoleFilter(f, "user");
    expect([...f]).toEqual(["assistant"]);
  });
});
