// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// run 工作台 Turns 展示模型的回归锁（run-turns-display.ts 纯函数层）。
// 锁定 review 点名的易错字符串/边界逻辑：thinking 标签剥离（闭标签 vs 截断
// 残留）、角色归一（命令/续接/压缩/附注行）、命令归组（连续命令轮领先置
// /unknown）、continuation 相邻重排、memo 比较（选中轮进出本会话）。

import { describe, it, expect } from "vitest";
import {
  summarizeOutput,
  classifyDisplayRole,
  buildDisplayTurns,
  toLaneDisplayTurn,
  sessionBlockPropsEqual,
  effectiveExpandedSet,
  toggleNodeExpansion,
} from "@/components/run/run-turns-display";
import type {
  TurnsBlockTurn,
  TurnsNodeSession,
  MemberTurnsState,
  TurnsBridge,
  SessionBlockProps,
} from "@/components/run/run-turns-display";

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

const CMD_COMPACT = `<command-name>/compact</command-name><command-args></command-args>`;
const CMD_CLEAR = `<command-name>/clear</command-name>`;
const CMD_CAVEAT = `<local-command-caveat>foo</local-command-caveat>`;
const CMD_STDOUT = `<local-command-stdout>out</local-command-stdout>`;

describe("summarizeOutput：thinking 剥离 / 工具名聚合", () => {
  it("闭标签完好：整块剥除，正文保留", () => {
    expect(summarizeOutput("assistant", "<thinking>先想一下</thinking>最终答案", [])).toEqual({
      kind: "text",
      content: "最终答案",
    });
  });

  it("仅思考块（无正文）：按思考内容读", () => {
    expect(summarizeOutput("assistant", "<thinking>only thought</thinking>", [])).toEqual({
      kind: "thinking",
      content: "only thought",
    });
  });

  it("截断残留（无闭标签）：开标签起整体按思考内容读", () => {
    expect(summarizeOutput("assistant", "<thinking>truncated thought", [])).toEqual({
      kind: "thinking",
      content: "truncated thought",
    });
  });

  it("正文在前、截断 thinking 在后：只保留正文", () => {
    expect(summarizeOutput("assistant", "前缀答案<thinking>unclosed", [])).toEqual({
      kind: "text",
      content: "前缀答案",
    });
  });

  it("无正文但有工具调用：工具名去重聚合", () => {
    expect(
      summarizeOutput("assistant", "", [
        { toolName: "read" },
        { toolName: "bash" },
        { toolName: "read" },
      ]),
    ).toEqual({ kind: "tools", content: "read · bash" });
  });

  it("非 assistant 轮里的字面量 <thinking> 是数据不是标记，原样呈现", () => {
    expect(summarizeOutput("user", "<thinking>not a tag</thinking>", [])).toEqual({
      kind: "text",
      content: "<thinking>not a tag</thinking>",
    });
  });

  it("assistant 空正文、无工具调用：空 text", () => {
    expect(summarizeOutput("assistant", "", [])).toEqual({ kind: "text", content: "" });
  });
});

describe("classifyDisplayRole：角色归一", () => {
  it("命令 caveat / stdout 附注行不独立成行（null）", () => {
    expect(classifyDisplayRole(makeTurn({ contentSummary: CMD_CAVEAT }))).toBeNull();
    expect(classifyDisplayRole(makeTurn({ contentSummary: CMD_STDOUT }))).toBeNull();
  });

  it("compaction-boundary 代理名 → compaction", () => {
    expect(classifyDisplayRole(makeTurn({ agentName: "compaction-boundary" }))).toBe("compaction");
  });

  it("command-name 文本 → command", () => {
    expect(classifyDisplayRole(makeTurn({ contentSummary: CMD_COMPACT }))).toBe("command");
  });

  it("continuation 标记文本 → continuation", () => {
    expect(classifyDisplayRole(makeTurn({ contentSummary: CONTINUATION_SUMMARY }))).toBe("continuation");
  });

  it("非标记文本但 agentName=continuation → continuation", () => {
    expect(classifyDisplayRole(makeTurn({ agentName: "continuation", contentSummary: "plain" }))).toBe("continuation");
  });

  it("其余透传 role", () => {
    expect(classifyDisplayRole(makeTurn({ role: "system" }))).toBe("system");
  });
});

describe("buildDisplayTurns：命令归组 / continuation 重排", () => {
  it("命令三连（command/caveat/stdout）归组为单行，附注行不进入列表", () => {
    const turns = [
      makeTurn({ turnId: "cmd", turnIndex: 1, contentSummary: CMD_COMPACT }),
      makeTurn({ turnId: "cav", turnIndex: 2, contentSummary: CMD_CAVEAT }),
      makeTurn({ turnId: "out", turnIndex: 3, contentSummary: CMD_STDOUT }),
      makeTurn({ turnId: "ans", turnIndex: 4, contentSummary: "done" }),
    ];
    const result = buildDisplayTurns(turns);
    expect(result.map(t => t.turnId)).toEqual(["cmd", "ans"]);
    expect(result[0]).toMatchObject({ displayRole: "command", displayContent: "/compact" });
    expect(result[1]).toMatchObject({ displayRole: "assistant", displayContent: "done" });
  });

  it("连续命令轮（无 caveat/stdout 分隔）：领先命令置 /unknown，后者归组为第二命令", () => {
    const turns = [
      makeTurn({ turnId: "a", turnIndex: 1, contentSummary: CMD_COMPACT }),
      makeTurn({ turnId: "b", turnIndex: 2, contentSummary: CMD_CLEAR }),
    ];
    const result = buildDisplayTurns(turns);
    expect(result.map(t => [t.turnId, t.displayContent])).toEqual([
      ["a", "/unknown"],
      ["b", "/clear"],
    ]);
  });

  it("continuation 先于 /compact 命令：相邻交换让命令领先其摘要", () => {
    const turns = [
      makeTurn({ turnId: "cont", turnIndex: 4, contentSummary: CONTINUATION_SUMMARY }),
      makeTurn({ turnId: "cmd", turnIndex: 5, contentSummary: CMD_COMPACT }),
    ];
    const result = buildDisplayTurns(turns);
    expect(result.map(t => [t.turnId, t.displayRole])).toEqual([
      ["cmd", "command"],
      ["cont", "continuation"],
    ]);
    expect(result[0].displayContent).toBe("/compact");
    expect(result[1].displayContent).toContain("Primary Request and Intent");
  });

  it("continuation 摘要行取标记后首条实质行", () => {
    const turns = [makeTurn({ turnId: "c", contentSummary: CONTINUATION_SUMMARY })];
    const [c] = buildDisplayTurns(turns);
    expect(c.displayRole).toBe("continuation");
    expect(c.displayContent).toBe("Primary Request and Intent: build a run workbench");
  });

  it("compaction 轮：空正文回退 /compact", () => {
    const turns = [makeTurn({ turnId: "c", agentName: "compaction-boundary", contentSummary: "" })];
    expect(buildDisplayTurns(turns)[0].displayContent).toBe("/compact");
  });
});

describe("toLaneDisplayTurn：泳道行显示对象（原始角色 + 截断）", () => {
  it("displayRole 恒为原始 role，thinking 只落在 displayKind", () => {
    const d = toLaneDisplayTurn(makeTurn({ role: "assistant", contentSummary: "<thinking>t</thinking>" }));
    expect(d.displayRole).toBe("assistant");
    expect(d.displayContent).toBe("t");
    expect(d.displayKind).toBe("thinking");
  });

  it("窄列截断 48 字符", () => {
    const d = toLaneDisplayTurn(makeTurn({ contentSummary: "x".repeat(100) }));
    expect(d.displayContent.length).toBe(48);
  });
});

describe("sessionBlockPropsEqual：会话块 memo 比较", () => {
  const session: TurnsNodeSession = {
    taskId: "member-1",
    label: null,
    role: "execute",
    attemptOrdinal: 1,
    ref: {
      taskId: "member-1",
      framework: "opencode",
      rowId: "row-1",
      turns: 2,
      totalTokens: 100,
      durationMs: null,
      label: null,
      startTime: null,
      endTime: null,
      cacheReadTokens: null,
    },
  };
  const turns = [makeTurn({ turnId: "t1" }), makeTurn({ turnId: "t2", turnIndex: 2 })];
  const state: MemberTurnsState = { turns, total: 2, page: 1, loading: false };
  const bridges: TurnsBridge[] = [];
  const onSelectTurn = () => {};
  const onLoadMore = () => {};

  function props(overrides: Partial<SessionBlockProps> = {}): SessionBlockProps {
    return { session, state, bridges, selectedTurnId: null, onSelectTurn, onLoadMore, ...overrides };
  }

  it("相同引用：相等", () => {
    expect(sessionBlockPropsEqual(props(), props())).toBe(true);
  });

  it("选中轮都非本会话轮：换选无关会话不重渲", () => {
    expect(
      sessionBlockPropsEqual(props({ selectedTurnId: "other-a" }), props({ selectedTurnId: "other-b" })),
    ).toBe(true);
  });

  it("选中轮任一落在本会话轮内：需重渲", () => {
    expect(
      sessionBlockPropsEqual(props({ selectedTurnId: "t1" }), props({ selectedTurnId: "t2" })),
    ).toBe(false);
  });

  it("回调身份变化（新函数）：不相等", () => {
    expect(sessionBlockPropsEqual(props(), props({ onSelectTurn: () => {} }))).toBe(false);
  });

  it("roleFilter 缺省 vs 空集：不相等（空集是显式对象，不是缺省）", () => {
    expect(sessionBlockPropsEqual(props(), props({ roleFilter: new Set() }))).toBe(false);
  });

  it("两个内容相同但身份不同的 roleFilter：不相等（按引用比较）", () => {
    expect(
      sessionBlockPropsEqual(
        props({ roleFilter: new Set(["user"]) }),
        props({ roleFilter: new Set(["user"]) }),
      ),
    ).toBe(false);
  });
});

describe("effectiveExpandedSet / toggleNodeExpansion：折叠/展开单一事实源", () => {
  it("选中轮节点未被点过 → 自动展开（不在 expanded 也不在 toggled 时补入，不改写原 expanded）", () => {
    const expanded = new Set<string>();
    const toggled = new Set<string>();
    const eff = effectiveExpandedSet(expanded, toggled, "node-a");
    expect(eff.has("node-a")).toBe(true);
    expect(expanded.has("node-a")).toBe(false);
  });

  it("选中轮节点已被用户点过（在 toggled）→ 不再自动展开", () => {
    const expanded = new Set<string>();
    const toggled = new Set(["node-a"]);
    expect(effectiveExpandedSet(expanded, toggled, "node-a").has("node-a")).toBe(false);
  });

  it("选中轮节点已在 expanded → 返回原集合身份（不无谓重建）", () => {
    const expanded = new Set(["node-a"]);
    expect(effectiveExpandedSet(expanded, new Set(), "node-a")).toBe(expanded);
  });

  it("自动展开的选中轮节点点击 → 一次收起（不误加进 expanded，expanding=false）", () => {
    // 回归锁：旧实现按 expanded.has(key) 判定翻转，会把自动展开节点「先加进
    // expanded、再点才真正收起」；这里断言一次点击即收起。
    const expanded = new Set<string>();
    const toggled = new Set<string>();
    const r = toggleNodeExpansion(expanded, toggled, "node-a", "node-a");
    expect(r.expanding).toBe(false);
    expect(r.expanded.has("node-a")).toBe(false);
    expect(r.toggled.has("node-a")).toBe(true);
  });

  it("普通已折叠节点点击 → 展开（expanding=true，补入 expanded 与 toggled）", () => {
    const r = toggleNodeExpansion(new Set(), new Set(), "node-b", "node-a");
    expect(r.expanding).toBe(true);
    expect(r.expanded.has("node-a")).toBe(true);
    expect(r.toggled.has("node-a")).toBe(true);
  });

  it("普通已展开节点点击 → 收起（从 expanded 移除，toggled 补入）", () => {
    const expanded = new Set(["node-a"]);
    const r = toggleNodeExpansion(expanded, new Set(), null, "node-a");
    expect(r.expanding).toBe(false);
    expect(r.expanded.has("node-a")).toBe(false);
    expect(r.toggled.has("node-a")).toBe(true);
  });

  it("已点过（toggled）的选中轮节点点击 → 重新展开", () => {
    const r = toggleNodeExpansion(new Set(), new Set(["node-a"]), "node-a", "node-a");
    expect(r.expanding).toBe(true);
    expect(r.expanded.has("node-a")).toBe(true);
  });

  it("非选中节点不受 ownerNodeKey 自动展开影响", () => {
    const expanded = new Set<string>();
    const toggled = new Set<string>();
    expect(effectiveExpandedSet(expanded, toggled, "node-a").has("node-b")).toBe(false);
  });
});