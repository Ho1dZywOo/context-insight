// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// ContextTracker 大 run 自适应 IT（百级成员的真实形态——workflow run 成员墙）：
// ①聚焦模式：agent 数超阈值（12）时默认只画峰值 Top-8 曲线（236 条曲线墙
//   既不可读也难渲染），快捷控件补「峰值 Top」一键回焦，全显仍是用户显式
//   选择（全部/主Agent 语义不变）；
// ②图例折叠区：组数超阈值时胶囊折叠为预览前 16（可见组前置——预览先回答
//   「图上正画着谁」）+ +N 展开（限高滚动区）+ 行首搜索按名过滤（带命中
//   计数）——百级组里找任务是刚需；
// ③Agent 概览面板退役：页面无卡片网格/收起控件，数字收编进组详情弹窗
//  （弹窗内恰一张选中实例卡——页面只留曲线形状）；
// ④阈值以下（单会话/小 run）零变化：无搜索框/展开钮，胶囊全量平铺、曲线默认
//   全显——既有行为的回归锁。

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ContextTracker, type TurnRowItem } from '@/components/observe/ContextTracker';

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function turn(over: Partial<TurnRowItem> & Pick<TurnRowItem, 'turnId' | 'turnIndex'>): TurnRowItem {
  return {
    role: 'assistant',
    contentSummary: null,
    agentName: 'build',
    isSubagent: false,
    subagentName: null,
    subagentSessionId: null,
    parentExecutionId: null,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    inputMessagesTokens: 0,
    contextWindowPct: null,
    latencyMs: 100,
    createdAt: null,
    completedAt: null,
    model: null,
    member: null,
    ...over,
  } as TurnRowItem;
}

// ── 大 run 夹具：40 个 root 成员（mem-00..mem-39，峰值 1K..40K 递增）+ 5 个
// 子代理实例（research ×3 / coder ×2，峰值低于全部 root）= 45 agent / 42 图例组。
// 每成员 2 轮（峰值在第二轮）——单点线走 circle 分支，双点才有 stroke path。
const ROOT_MEMBERS = 40;
const pad = (i: number) => String(i).padStart(2, '0');

const bigTurns: TurnRowItem[] = [];
const bigLimits: Record<string, number> = {};
for (let i = 0; i < ROOT_MEMBERS; i++) {
  const member = { taskId: `ses-m${i}`, label: `mem-${pad(i)}` };
  const peak = 1000 * (i + 1);
  bigTurns.push(turn({
    turnId: `t-m${i}-0`, turnIndex: 0, member,
    createdAt: `2026-10-13T03:${pad(i)}:00Z`,
    totalTokens: Math.round(peak * 0.5), inputMessagesTokens: Math.round(peak * 0.5),
    contextWindowPct: 1,
  }));
  bigTurns.push(turn({
    turnId: `t-m${i}-1`, turnIndex: 1, member,
    createdAt: `2026-10-13T03:${pad(i)}:30Z`,
    totalTokens: peak, inputMessagesTokens: peak,
    contextWindowPct: Math.round(peak / 2000),
  }));
  bigLimits[`root:ses-m${i}`] = 200000;
}
const SUBS: { sid: string; type: string; peak: number; memberIndex: number }[] = [
  { sid: 'sub-r1', type: 'research', peak: 2000, memberIndex: 0 },
  { sid: 'sub-r2', type: 'research', peak: 1800, memberIndex: 1 },
  { sid: 'sub-r3', type: 'research', peak: 1600, memberIndex: 2 },
  { sid: 'sub-c1', type: 'coder', peak: 1500, memberIndex: 3 },
  { sid: 'sub-c2', type: 'coder', peak: 1200, memberIndex: 4 },
];
for (const s of SUBS) {
  bigTurns.push(turn({
    turnId: `t-${s.sid}`, turnIndex: 2, isSubagent: true, subagentType: s.type,
    subagentSessionId: s.sid, subagentName: s.type, agentName: `派发-${s.type}`,
    member: { taskId: `ses-m${s.memberIndex}`, label: `mem-${pad(s.memberIndex)}` },
    createdAt: '2026-10-13T04:00:00Z',
    totalTokens: s.peak, inputMessagesTokens: s.peak, contextWindowPct: 2,
  }));
  bigLimits[s.sid] = 64000;
}

// ── 小 run 夹具（阈值以下）：3 成员 + 1 子代理实例 = 4 agent
const smallTurns: TurnRowItem[] = [
  turn({ turnId: 'st-a0', turnIndex: 0, member: { taskId: 's-ma', label: '成员A' }, createdAt: '2026-10-13T02:00:00Z', totalTokens: 30000, inputMessagesTokens: 25000, contextWindowPct: 20 }),
  turn({ turnId: 'st-a1', turnIndex: 1, member: { taskId: 's-ma', label: '成员A' }, createdAt: '2026-10-13T02:00:30Z', totalTokens: 50000, inputMessagesTokens: 42000, contextWindowPct: 38 }),
  turn({ turnId: 'st-b0', turnIndex: 0, member: { taskId: 's-mb', label: '成员B' }, createdAt: '2026-10-13T02:01:00Z', totalTokens: 60000, inputMessagesTokens: 50000, contextWindowPct: 45 }),
  turn({ turnId: 'st-b1', turnIndex: 1, member: { taskId: 's-mb', label: '成员B' }, createdAt: '2026-10-13T02:01:30Z', totalTokens: 65000, inputMessagesTokens: 55000, contextWindowPct: 48 }),
  turn({ turnId: 'st-c0', turnIndex: 0, member: { taskId: 's-mc', label: '成员C' }, createdAt: '2026-10-13T02:02:00Z', totalTokens: 10000, inputMessagesTokens: 8000, contextWindowPct: 7 }),
  turn({ turnId: 'st-s0', turnIndex: 1, isSubagent: true, subagentType: 'research', subagentSessionId: 's-sub', subagentName: 'research', member: { taskId: 's-ma', label: '成员A' }, createdAt: '2026-10-13T02:00:15Z', totalTokens: 5000, inputMessagesTokens: 4000, contextWindowPct: 7 }),
];
const smallLimits: Record<string, number> = {
  'root:s-ma': 128000, 'root:s-mb': 128000, 'root:s-mc': 128000, 's-sub': 64000,
};

vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ limit: 200000 }) })));

let root: Root | null = null;

async function render(turns: TurnRowItem[], agentContextLimits: Record<string, number>) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(ContextTracker, { turns, sessionModel: null, agentContextLimits }));
  });
  await act(async () => { await new Promise(r => setTimeout(r, 20)) });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const checkedPills = (container: Element) =>
  container.querySelectorAll('label[data-legend] > input[type="checkbox"]:checked');
const legendLabels = (container: Element) =>
  Array.from(container.querySelectorAll('label[data-legend]')).map(el => el.getAttribute('data-legend'));
const curvePaths = (container: Element) =>
  container.querySelectorAll('svg[data-chart="growth"] path[fill="none"]');

async function typeSearch(container: Element, value: string) {
  const input = container.querySelector('[data-legend-search]') as HTMLInputElement | null;
  expect(input, '搜索框应存在').toBeTruthy();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input!, value);
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('ContextTracker 大 run 自适应（百级成员收敛）', () => {
  it('聚焦模式：默认只画峰值 Top-8（非全显），胶囊折叠预览可见组前置，快捷「峰值 Top」回焦', async () => {
    const container = await render(bigTurns, bigLimits);

    // 45 agent > 阈值 12：默认可见 = 峰值 Top-8（mem-32..mem-39），其余隐藏
    expect(checkedPills(container)).toHaveLength(8);
    expect(curvePaths(container)).toHaveLength(8);
    expect(legendLabels(container).slice(0, 8).sort()).toEqual(
      Array.from({ length: 8 }, (_, k) => `mem-${pad(32 + k)}`).sort(),
    );

    // 快捷控件：峰值 Top 按钮存在且激活；全部 = 用户显式选择后全显（折叠区
    // 只渲染前 16 胶囊——全选中；展开后 42 组全亮）
    const quickTop = container.querySelector('[data-quick-top]') as HTMLButtonElement;
    expect(quickTop?.textContent).toBe('峰值 Top8');
    expect(quickTop?.className).toContain('bg-background');
    const quickAll = Array.from(container.querySelectorAll('[data-quick-filter] button'))
      .find(b => b.textContent === '全部') as HTMLButtonElement;
    await act(async () => { quickAll.click() });
    expect(curvePaths(container)).toHaveLength(40); // root 曲线全量（子代理 area 态非激活不画线）
    await act(async () => { (container.querySelector('[data-legend-expand]') as HTMLButtonElement).click() });
    expect(checkedPills(container)).toHaveLength(42);
    await act(async () => { quickTop.click() });
    expect(checkedPills(container)).toHaveLength(8);
    expect(curvePaths(container)).toHaveLength(8);
  });

  it('图例折叠区：预览 16 + +26 展开限高滚动 + 收起；搜索按名过滤带命中计数', async () => {
    const container = await render(bigTurns, bigLimits);

    // 折叠态：42 组只出预览 16（可见 8 前置），尾部 +26 展开钮
    expect(legendLabels(container)).toHaveLength(16);
    const expand = container.querySelector('[data-legend-expand]') as HTMLButtonElement;
    expect(expand?.textContent).toBe('+26');

    // 展开：42 组全出（限高滚动区），收起钮在
    const zone = expand.closest('.run-scroll-fade') as HTMLElement;
    await act(async () => { expand.click() });
    expect(legendLabels(container)).toHaveLength(42);
    // 滚动感知渐隐（晕染修复）：静止贴边首行完整显示——胶囊区 data-fade=none
    //（此前无条件双向渐隐把展开区首行晕染掉）；真滚出视口后才亮对应侧渐隐
    expect(zone?.getAttribute('data-fade')).toBe('none');
    await act(async () => {
      zone.scrollTop = 40;
      zone.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    expect(zone.getAttribute('data-fade')).toBe('top');
    const collapse = Array.from(container.querySelectorAll('button'))
      .find(b => b.textContent === '收起') as HTMLButtonElement;
    expect(collapse).toBeTruthy();
    await act(async () => { collapse.click() });
    expect(legendLabels(container)).toHaveLength(16);

    // 搜索：清空态折叠 → 输入即全匹配（mem-3* = 10 组），计数 10/42
    await typeSearch(container, 'mem-3');
    expect(legendLabels(container)).toHaveLength(10);
    expect(container.querySelector('[data-legend-search]')?.parentElement?.textContent).toContain('10/42');
    // 命中的峰值 Top-8（mem-32..39）依然前置可见
    expect(legendLabels(container).slice(0, 8).sort()).toEqual(
      Array.from({ length: 8 }, (_, k) => `mem-${pad(32 + k)}`).sort(),
    );
    // 清空回落折叠预览
    await typeSearch(container, '');
    expect(legendLabels(container)).toHaveLength(16);
  });

  it('Agent 概览面板退役：页面无卡片网格/收起控件，卡片收编进组详情弹窗', async () => {
    const container = await render(bigTurns, bigLimits);

    // 页面再无概览表/卡片网格/收起控件（数字全归弹窗，页面只留曲线形状）
    expect(container.querySelector('[data-agent-table]')).toBeNull();
    expect(container.querySelectorAll('[data-agent-row]')).toHaveLength(0);
    expect(container.querySelector('[data-cards-toggle]')).toBeNull();

    // 卡片活在弹窗里：胶囊 chevron（唯一入口）→ 档案弹窗（身份行 + 关键四数）
    //（组 = 单实例 root：趋势小图 + 四数 + 缓存效率卡同屏）
    const label = container.querySelector('[data-legend="mem-39"]') as HTMLElement;
    expect(label).toBeTruthy();
    const chevron = label.parentElement!.querySelector('button') as HTMLButtonElement;
    await act(async () => { chevron.click() });
    await act(async () => { await new Promise(r => setTimeout(r, 20)) });
    const dialog = document.querySelector('[data-agent-detail]');
    expect(dialog).toBeTruthy();
    expect(dialog!.textContent).toContain('mem-39');
    expect(dialog!.querySelector('[data-agent-stats]')).toBeTruthy();
    expect(dialog!.querySelector('[data-cache-card]')).toBeTruthy();
  });

  it('阈值以下（小 run/单会话）零变化：全显、无搜索/折叠/峰值 Top 控件、概览面板同口径退役', async () => {
    const container = await render(smallTurns, smallLimits);

    // 4 agent ≤ 12：曲线默认全显（root 3 条——成员C 单轮走 circle 分支无 stroke）
    expect(checkedPills(container)).toHaveLength(4);
    expect(curvePaths(container)).toHaveLength(2);
    // 无大 run 控件：搜索框/图例展开/峰值 Top 快捷键
    expect(container.querySelector('[data-legend-search]')).toBeNull();
    expect(container.querySelector('[data-legend-expand]')).toBeNull();
    expect(container.querySelector('[data-quick-top]')).toBeNull();
    // 概览面板退役对小 run 同口径：页面无卡片网格
    expect(container.querySelector('[data-agent-table]')).toBeNull();
    expect(container.querySelectorAll('[data-agent-row]')).toHaveLength(0);
    // 胶囊全量平铺（4 组）
    expect(legendLabels(container)).toHaveLength(4);
  });

  it('历史 epoch 时间戳不参与时间域：单条 1970 数据不能把整张图拉回几十年前', async () => {
    const realStart = '2026-10-13T02:00:00.000Z';
    const turns = [
      turn({ turnId: 'epoch-root', turnIndex: 0, member: { taskId: 's-era', label: 'era' }, createdAt: realStart, inputMessagesTokens: 1000, totalTokens: 1000 }),
      turn({ turnId: 'epoch-bad', turnIndex: 1, member: { taskId: 's-era', label: 'era' }, createdAt: '1970-01-01T00:00:00.000Z', inputMessagesTokens: 1200, totalTokens: 1200 }),
      turn({ turnId: 'epoch-real', turnIndex: 2, member: { taskId: 's-era', label: 'era' }, createdAt: '2026-10-13T02:00:10.000Z', inputMessagesTokens: 1400, totalTokens: 1400 }),
    ];
    const container = await render(turns, { 'root:s-era': 200000 });
    const labels = Array.from(container.querySelectorAll('svg[data-chart="growth"] text')).map(n => n.textContent ?? '');
    const d = new Date(realStart);
    const hh = String(d.getHours()).padStart(2, '0');
    expect(labels.some(label => label.startsWith(`${hh}:`))).toBe(true);
    expect(labels).not.toContain('1/1');
  });
});
