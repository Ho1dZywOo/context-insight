// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// run 工作台 Turns 搜索命中过滤面回归锁（useTurnsHitsFilter）。
// classifyHitSource 是未导出的私有谓词，经 hook 的 sourceOptions 计数与
// visible 收窄间接锁定：来源六类（用户/工具输出/父agent指令/子agent产出/
// 子agent返回/模型产出）、thinking 面、工具名面（降序取前 12）。

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useTurnsHitsFilter } from "@/components/run/RunTurnsSearch";
import type { TurnSearchItem } from "@/lib/observe/collectors/search";

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeItem(overrides: Partial<TurnSearchItem> = {}): TurnSearchItem {
  return {
    turnId: "h1",
    turnIndex: 1,
    role: "assistant",
    agentName: null,
    isSubagent: false,
    subagentName: null,
    subagentSessionId: null,
    contentSummary: null,
    matchContext: "ctx",
    matchField: "content",
    createdAt: "2026-09-01T00:00:00.000Z",
    hasDispatchBridge: false,
    ...overrides,
  };
}

function renderFilter(items: TurnSearchItem[], bridgeResponseTurnIds: ReadonlySet<string>) {
  let captured: ReturnType<typeof useTurnsHitsFilter>;
  const container = document.createElement("div");
  document.body.appendChild(container);
  function Harness() {
    captured = useTurnsHitsFilter(items, bridgeResponseTurnIds);
    return null;
  }
  const root = createRoot(container);
  act(() => {
    root.render(createElement(Harness));
  });
  return {
    get value() {
      return captured;
    },
    setFilter(f: string | null) {
      act(() => {
        captured.setFilter(f);
      });
    },
    unmount() {
      root.unmount();
      container.remove();
    },
  };
}

describe("useTurnsHitsFilter：来源分类（classifyHitSource）", () => {
  it("六类来源各归其属，顺序沿 HIT_SOURCE_CONFIG", () => {
    const items = [
      makeItem({ turnId: "u", role: "user" }),
      makeItem({ turnId: "tr", role: "tool_result" }),
      makeItem({ turnId: "root", role: "assistant", hasDispatchBridge: true }),
      makeItem({ turnId: "bridged", role: "assistant", isSubagent: true, subagentSessionId: "s1" }),
      makeItem({ turnId: "sub", role: "assistant", isSubagent: true, subagentSessionId: "s2" }),
      makeItem({ turnId: "model", role: "assistant" }),
    ];
    const r = renderFilter(items, new Set(["bridged"]));
    expect(r.value.sourceOptions).toEqual([
      { key: "src:user_input", label: "用户引入", count: 1 },
      { key: "src:model_output", label: "模型产出", count: 1 },
      { key: "src:tool_output", label: "工具输出", count: 1 },
      { key: "src:root_agent_dispatch", label: "父agent指令", count: 1 },
      { key: "src:subagent_output", label: "子agent产出", count: 1 },
      { key: "src:bridge_response", label: "子agent返回", count: 1 },
    ]);
    r.unmount();
  });

  it("桥接命中子代理 → bridge_response；非桥接子代理 → subagent_output", () => {
    const bridged = makeItem({ turnId: "b", role: "assistant", isSubagent: true, subagentSessionId: "s1" });
    const items = [bridged, makeItem({ turnId: "s", role: "assistant", isSubagent: true, subagentSessionId: "s2" })];
    const r = renderFilter(items, new Set(["b"]));
    r.setFilter("src:bridge_response");
    expect(r.value.visible.map(x => x.turnId)).toEqual(["b"]);
    r.setFilter("src:subagent_output");
    expect(r.value.visible.map(x => x.turnId)).toEqual(["s"]);
    r.unmount();
  });

  it("父agent指令（hasDispatchBridge）→ root_agent_dispatch", () => {
    const dispatch = makeItem({ turnId: "d", role: "assistant", hasDispatchBridge: true });
    const r = renderFilter([dispatch, makeItem({ turnId: "m", role: "assistant" })], new Set());
    r.setFilter("src:root_agent_dispatch");
    expect(r.value.visible.map(x => x.turnId)).toEqual(["d"]);
    r.unmount();
  });
});

describe("useTurnsHitsFilter：thinking / 工具名过滤面", () => {
  it("thinking 面按 reasoningTokens>0 计数并收窄", () => {
    const items = [
      makeItem({ turnId: "a", reasoningTokens: 5 }),
      makeItem({ turnId: "b", reasoningTokens: 0 }),
      makeItem({ turnId: "c", reasoningTokens: 3 }),
    ];
    const r = renderFilter(items, new Set());
    expect(r.value.thinkingOption).toEqual({ key: "thinking", label: "thinking", count: 2 });
    r.setFilter("thinking");
    expect(r.value.visible.map(x => x.turnId)).toEqual(["a", "c"]);
    r.unmount();
  });

  it("工具名面降序、去重取前 12", () => {
    const items = [
      makeItem({ turnId: "a", toolNames: ["read", "bash"] }),
      makeItem({ turnId: "b", toolNames: ["read"] }),
      makeItem({ turnId: "c", toolNames: ["bash", "grep"] }),
    ];
    const r = renderFilter(items, new Set());
    expect(r.value.toolOptions).toEqual([
      { key: "tool:read", label: "read", count: 2 },
      { key: "tool:bash", label: "bash", count: 2 },
      { key: "tool:grep", label: "grep", count: 1 },
    ]);
    r.setFilter("tool:grep");
    expect(r.value.visible.map(x => x.turnId)).toEqual(["c"]);
    r.unmount();
  });
});

describe("useTurnsHitsFilter：默认与复位", () => {
  it("无过滤 → filter null、visible 全量", () => {
    const items = [makeItem({ turnId: "a" }), makeItem({ turnId: "b", role: "user" })];
    const r = renderFilter(items, new Set());
    expect(r.value.filter).toBeNull();
    expect(r.value.visible).toEqual(items);
    r.unmount();
  });

  it("筛选后复位 null → 恢复全量", () => {
    const items = [makeItem({ turnId: "a", role: "user" }), makeItem({ turnId: "b" })];
    const r = renderFilter(items, new Set());
    r.setFilter("src:user_input");
    expect(r.value.visible.map(x => x.turnId)).toEqual(["a"]);
    r.setFilter(null);
    expect(r.value.visible.map(x => x.turnId)).toEqual(["a", "b"]);
    r.unmount();
  });
});