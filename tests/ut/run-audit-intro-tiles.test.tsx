// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// RunAuditTab 域导览瓦片回归锁：store 版本号必须进 introTiles 的 useMemo 依赖，
// 否则任一目标对账完成（结果写入 skill-audit-job store、版本自增）后，组件虽经
// useSyncExternalStore 重渲，「已审 / 可对账成员」计数仍停留在 useMemo 缓存旧值。
// 这里 mock skill-audit-job 成可控 store，渲染 RunAuditTab 后令某个目标从「无结果」
// 变为「有结果」，断言「已审」瓦片计数 0 → 1。

import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auditStore = vi.hoisted(() => {
  const EMPTY = { running: false, result: null, error: null };
  const snapshots = new Map<string, { running: boolean; result: unknown; error: string | null }>();
  const listeners = new Set<() => void>();
  let version = 0;
  return {
    EMPTY,
    snapshots,
    listeners,
    getVersion: () => version,
    setResult(key: string, result: unknown): void {
      snapshots.set(key, { running: false, result, error: null });
      version += 1;
      for (const l of Array.from(listeners)) l();
    },
    reset(): void {
      snapshots.clear();
      listeners.clear();
      version = 0;
    },
  };
});

vi.mock("@/lib/skill-audit-job", () => ({
  subscribeSkillAudit: (cb: () => void) => {
    auditStore.listeners.add(cb);
    return () => {
      auditStore.listeners.delete(cb);
    };
  },
  getSkillAuditSnapshot: (key: string) => auditStore.snapshots.get(key) ?? auditStore.EMPTY,
  getSkillAuditServerSnapshot: () => auditStore.EMPTY,
  getSkillAuditVersion: () => auditStore.getVersion(),
  hydrateRunAuditFromStorage: () => {},
  runAuditKey: (runId: string, kind: string, name: string) => `run:${runId}:${kind}:${name}`,
}));

vi.mock("@/components/ui/button", () => ({
  Button: () => createElement("button"),
}));

vi.mock("@/components/run/audit/AuditReportPanel", () => ({
  AuditReportPanel: () => null,
}));

import { RunAuditTab } from "@/components/run/audit/RunAuditTab";
import type { RunMemberRow } from "@/lib/run/member-rows";

const originalFetch = globalThis.fetch;

const members = [{ taskId: "m1", displayName: "成员1" }] as unknown as RunMemberRow[];

function skillsFetch(): Response {
  return new Response(
    JSON.stringify({
      events: [{ skillName: "opdef-developer", eventType: "invoke", member: { taskId: "m1", label: "成员1" } }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("RunAuditTab 域导览瓦片（store 版本进 introTiles 依赖）", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    auditStore.reset();
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/skills")) return skillsFetch();
      if (url.includes("main-agent-workflow")) {
        return new Response(JSON.stringify({ available: false, name: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
    auditStore.reset();
  });

  async function render(): Promise<void> {
    await act(async () => {
      root.render(createElement(RunAuditTab, { runId: "r1", members }));
      await new Promise(r => setTimeout(r, 20));
    });
  }

  function tileValue(label: string): string | null {
    for (const el of Array.from(container.querySelectorAll("div"))) {
      if (el.children.length === 0 && el.textContent?.trim() === label) {
        const val = el.nextElementSibling;
        return val ? (val.textContent ?? "").trim() : null;
      }
    }
    return null;
  }

  it("目标对账完成 → 域导览「已审」计数 0 → 1（store 版本号进 memo 依赖）", async () => {
    await render();
    // 关键回归：旧实现在 introTiles 的 useMemo 依赖里没有 store 版本号——
    // 组件虽经 useSyncExternalStore 重渲，useMemo 仍返回「已审 0」的旧缓存。
    expect(tileValue("已审")).toBe("0");

    await act(async () => {
      auditStore.setResult("run:r1:skill:opdef-developer", {
        summary: { total: 1, pass: 1, fail: 0, na: 0 },
      });
      await new Promise(r => setTimeout(r, 20));
    });

    expect(tileValue("已审")).toBe("1");
  });

  it("未对账时「已审」为 0（基线，确保断言有效）", async () => {
    await render();
    expect(tileValue("目标")).toBe("1");
    expect(tileValue("涉事成员")).toBe("1");
    expect(tileValue("已审")).toBe("0");
  });
});