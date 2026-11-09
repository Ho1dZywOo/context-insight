// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root directory of the software repository for the full text of the License.

// @vitest-environment happy-dom

// 工具耗时卡（PerfToolTime）回归锁（PR #28 审查意见修复）：
// ① 占比口径诚实：Σ 工具执行（跨成员累加）/ 非 LLM 墙钟——多成员并发执行时
//   Σ 工具时长可超墙钟非 LLM 时间，比率可 >100%。不按「占 … ≤100%」语义钳制，
//   标签明示 Σ/墙钟口径（不谎报成 bug 感的「占非 LLM 时间 150%」）。
// ② master-detail 选中兜底：dataEpoch 刷新换新 stats（组件不重挂）时，selected
//   指向已消失工具 → 回落到新的 Σ 最高工具，右栏不退成占位空态；收起态（null）
//   不回落（点同行收起仍给占位空态）。

import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { PerfToolTime } from '@/components/observe/PerfToolTime';
import type { RunToolStats } from '@/lib/observe/collectors/tool-stats';

const tool = (toolName: string, totalMs: number): RunToolStats['tools'][number] => ({
  toolName, calls: 1, errors: 0, totalMs, timedCalls: 1, untimedCalls: 0,
  wireDerived: 0, minMs: totalMs, p50Ms: totalMs, p95Ms: totalMs, maxMs: totalMs,
  avgMs: totalMs, isDispatch: false, isSkillRelated: false, errorTypes: [],
});

const statsOf = (tools: RunToolStats['tools'], totalToolMs: number): RunToolStats => ({
  tools,
  matrix: Object.fromEntries(
    tools.map(t => [t.toolName, { m1: { calls: t.calls, totalMs: t.totalMs, errors: 0, firstTurnId: null } }]),
  ),
  members: ['m1'],
  meta: {
    totalCalls: tools.reduce((s, t) => s + t.calls, 0),
    totalToolMs,
    dispatchMs: 0,
    timedCalls: tools.reduce((s, t) => s + t.timedCalls, 0),
    untimedCalls: 0,
    wireDerivedCalls: 0,
  },
});

const members = [{ taskId: 'm1', label: '成员M' }];

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  return { container, root };
}

function teardown(root: Root, container: HTMLElement) {
  act(() => { root.unmount() });
  document.body.removeChild(container);
}

describe('PerfToolTime 回归锁', () => {
  it('占比口径诚实：Σ工具执行/非LLM墙钟 明示口径，多成员并发比率可 >100% 不钳制', () => {
    const { container, root } = mount();
    try {
      // totalToolMs（Σ 跨成员）= 20s > totalNonLlmMs（墙钟）= 10s → 200%，如实呈现
      const stats = statsOf([tool('Read', 20000)], 20000);
      act(() => { root.render(createElement(PerfToolTime, { stats, members, totalNonLlmMs: 10000 })) });
      expect(container.textContent).toContain('Σ工具执行/非LLM墙钟 200%');
      expect(container.textContent).not.toContain('占非 LLM 时间');
    } finally {
      teardown(root, container);
    }
  });

  it('dataEpoch 刷新换 stats：selected 指向已消失工具 → 回落到新 Σ 最高工具（不退占位空态）', () => {
    const { container, root } = mount();
    try {
      const statsA = statsOf([tool('Read', 9000), tool('Grep', 0)], 9000);
      act(() => { root.render(createElement(PerfToolTime, { stats: statsA, members, totalNonLlmMs: 20000 })) });
      // 默认选中 Σ 最高工具 Read
      expect(container.querySelector('[data-tool-breakdown="Read"]')).toBeTruthy();

      // 刷新：Read/Grep 消失、Write 顶替；组件不重挂（selected 仍指向 Read）
      const statsB = statsOf([tool('Write', 5000)], 5000);
      act(() => { root.render(createElement(PerfToolTime, { stats: statsB, members, totalNonLlmMs: 10000 })) });
      expect(container.querySelector('[data-tool-breakdown="Write"]')).toBeTruthy();
      expect(container.querySelector('[data-tool-breakdown-empty]')).toBeNull();
    } finally {
      teardown(root, container);
    }
  });

  it('收起态（selected=null）刷新后不回落：点同行收起仍给占位空态', () => {
    const { container, root } = mount();
    try {
      const statsA = statsOf([tool('Read', 9000), tool('Grep', 0)], 9000);
      act(() => { root.render(createElement(PerfToolTime, { stats: statsA, members, totalNonLlmMs: 20000 })) });
      // 点击 Read 行收起 → 占位空态
      act(() => { container.querySelector('[data-tool-toggle="Read"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) });
      expect(container.querySelector('[data-tool-breakdown-empty]')).toBeTruthy();

      // 刷新换 stats（Write 顶替）——收起态不回落，仍占位空态
      const statsB = statsOf([tool('Write', 5000)], 5000);
      act(() => { root.render(createElement(PerfToolTime, { stats: statsB, members, totalNonLlmMs: 10000 })) });
      expect(container.querySelector('[data-tool-breakdown-empty]')).toBeTruthy();
      expect(container.querySelector('[data-tool-breakdown]')).toBeNull();
    } finally {
      teardown(root, container);
    }
  });
});