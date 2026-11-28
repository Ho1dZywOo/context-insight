// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with
// the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See the License in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// Turns 顶部时间线（RunTurnsTimeline）交互契约 IT：
//   ① 单击即跳——点哪一刻就选中那一刻的轮次（root 道整道可点、槽道只在条上可点、
//      点空槽不动作），无行轮不作目标；
//   ② 播放头跟随选中轮，且换选不重渲染道行子树（性能契约：走查时只有播放头动）；
//   ③ 图例过滤 / 测距模式 / 缩放 / 折叠 / 悬停浮窗 / 加载与空态。
// happy-dom 没有布局：轨道宽度统一打桩成 1000px，点击落点 = clientX / 1000。
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { RunTurnsTimeline } from '@/components/run/turns-timeline/RunTurnsTimeline';
import type { SwimAgent, SwimBridge } from '@/lib/swimlane-model';

const lanesRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/components/run/turns-timeline/TimelineLanes', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/components/run/turns-timeline/TimelineLanes')>();
  const { memo, createElement } = await import('react');
  return {
    ...mod,
    TimelineLanes: memo(function CountingTimelineLanes(props: ComponentProps<typeof mod.TimelineLanes>) {
      lanesRenders.count += 1;
      return createElement(mod.TimelineLanes, props);
    }),
  };
});

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

const T0 = Date.parse('2026-10-15T10:00:00Z');
const at = (s: number) => T0 + s * 1000;

/** 夹具：显式给出的字段原样生效，其余取子代理缺省值 */
function agent(over: Partial<SwimAgent>): SwimAgent {
  const span = over.span ?? { start: at(0), end: at(60) };
  const base: SwimAgent = {
    executionId: 'exec', agentName: 'general', agentSessionId: null, isSubagent: true, parentExecutionId: null,
    tokens: 1000, maxSingleCallTokens: 500, toolCallCount: 3, model: 'glm-5.3',
    createdAt: new Date(span.start).toISOString(), latencyMs: span.end - span.start,
    firstPrompt: null, span, activeIntervals: [], member: null,
  };
  return { ...base, ...over };
}

const ROOT = agent({
  executionId: 'root', isSubagent: false, agentName: 'build', span: { start: at(0), end: at(120) },
  member: { taskId: 'ses-a', label: '成员A', isProxy: false },
  activeIntervals: [
    { start: at(0), end: at(30), turnId: 't1' },
    { start: at(30), end: at(31), turnId: 'caveat', hidden: true },
    { start: at(60), end: at(90), turnId: 't2' },
  ],
});
const EXPLORER = agent({
  executionId: 'sub-a', agentSessionId: 'ses-sub-a', agentName: '探索',
  span: { start: at(20), end: at(50) },
  activeIntervals: [{ start: at(20), end: at(35), turnId: 'sa1' }, { start: at(40), end: at(50), turnId: 'sa2' }],
});
const WRITER = agent({
  executionId: 'sub-b', agentSessionId: 'ses-sub-b',
  span: { start: at(95), end: at(110) },
  activeIntervals: [{ start: at(95), end: at(110), turnId: 'sb1' }],
});
const BRIDGES: SwimBridge[] = [
  { bridgeId: 'b1', dispatchContent: 'P1 需求分析', dispatchTimestamp: new Date(at(20)).toISOString(), responseTimestamp: null,
    subagentSessionId: 'ses-sub-a', subagentType: 'explorer', status: 'completed' },
  { bridgeId: 'b2', dispatchContent: 'P1 写报告', dispatchTimestamp: new Date(at(95)).toISOString(), responseTimestamp: null,
    subagentSessionId: 'ses-sub-b', subagentType: 'writer', status: 'completed' },
];
const AGENTS = [ROOT, EXPLORER, WRITER];

function render(props: Partial<ComponentProps<typeof RunTurnsTimeline>> = {}) {
  const onSelectTurn = vi.fn();
  const full: ComponentProps<typeof RunTurnsTimeline> = {
    agents: AGENTS, bridges: BRIDGES, lanes: [], lanesInferred: false,
    selectedTurnId: null, onSelectTurn, ...props,
  };
  const el = createElement(RunTurnsTimeline, full);
  act(() => { root!.render(el); });
  return { onSelectTurn, rerender: (next: Partial<ComponentProps<typeof RunTurnsTimeline>>) => act(() => { root!.render(createElement(RunTurnsTimeline, { ...full, ...next })); }) };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  lanesRenders.count = 0;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() =>
    ({ left: 0, top: 0, right: 1000, bottom: 20, width: 1000, height: 20, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (root) act(() => { root!.unmount(); });
  container?.remove();
  root = null;
  container = null;
});

const q = <T extends Element = HTMLElement>(sel: string) => container!.querySelector<T>(sel);
const qa = (sel: string) => [...container!.querySelectorAll<HTMLElement>(sel)];
const laneEl = (key: string) => q(`[data-lane="${key}"]`)!;

/** 在元素上按住 clientX 点下去（轨道 1000px 宽 → x 即千分比 × 1000） */
function clickAt(el: Element, x: number) {
  const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clientX', { value: x });
  Object.defineProperty(ev, 'clientY', { value: 10 });
  act(() => { el.dispatchEvent(ev); });
}
const sec = (s: number) => Math.round((s / 120) * 1000);

describe('RunTurnsTimeline — 道与工具条', () => {
  it('渲染 root 道 + 子代理槽道、图例与摘要（执行数 / 子代理数 / 并发）', () => {
    render();
    expect(q('[data-turns-timeline]')).toBeTruthy();
    expect(q('[data-timeline-track]')).toBeTruthy();
    const lanes = qa('[data-lane]');
    expect(lanes.map(l => l.dataset.lane)).toEqual(['root', 'slot-1']);
    expect(q('[data-lane="root"] [data-bar="root"]')).toBeTruthy();
    expect(q('[data-bar="sub-a"]')).toBeTruthy();
    expect(q('[data-bar="sub-b"]')).toBeTruthy();
    expect(q('[data-lane-label="root"]')!.textContent).toBe('root');
    expect(q('[data-timeline-summary]')!.textContent).toBe('3 执行 · 子代理 2 · 最大并发 1');
    expect(qa('[data-legend-item]').map(b => [b.dataset.legendItem, b.getAttribute('aria-pressed'), b.textContent])).toEqual([
      ['explorer', 'true', 'explorer1次'], ['writer', 'true', 'writer1次'],
    ]);
    // 活跃切片：默认 5min 阈值下秒级空档不断开 → 每根条各一片（深色活跃衬在浅色条上）
    expect(qa('[data-bar-piece]')).toHaveLength(3);
    // 无子代理类型时不出现图例行
    render({ agents: [ROOT], bridges: [] });
    expect(q('[data-legend]')).toBeNull();
  });

  it('多成员：root 按成员分道，道名列显示成员名', () => {
    render({
      agents: [
        agent({ ...ROOT, executionId: 'ra', span: { start: at(0), end: at(60) }, activeIntervals: [{ start: at(0), end: at(60), turnId: 't1' }], member: { taskId: 'ses-a', label: '成员A', isProxy: false } }),
        agent({ ...ROOT, executionId: 'rb', span: { start: at(10), end: at(70) }, activeIntervals: [{ start: at(10), end: at(70), turnId: 't9' }], member: { taskId: 'ses-b', label: '成员B', isProxy: false } }),
      ],
      bridges: [],
    });
    expect(qa('[data-lane-label]').map(l => [l.dataset.laneLabel, l.textContent])).toEqual([['ses-a', '成员A'], ['ses-b', '成员B']]);
    expect(qa('[data-lane]').map(l => l.dataset.lane)).toEqual(['ses-a', 'ses-b']);
  });

  it('加载态 / 空态', () => {
    render({ agents: null });
    expect(q('[data-timeline-loading]')).toBeTruthy();
    expect(q('[data-timeline-track]')).toBeNull();
    render({ agents: [] });
    expect(q('[data-timeline-empty]')!.textContent).toBe('暂无执行数据');
  });

  it('折叠：图收起、工具条常驻；再点展开', () => {
    render();
    clickAt(q('[data-timeline-toggle]')!, 0);
    expect(q('[data-timeline-track]')).toBeNull();
    expect(q('[data-timeline-toggle]')!.getAttribute('aria-expanded')).toBe('false');
    clickAt(q('[data-timeline-toggle]')!, 0);
    expect(q('[data-timeline-track]')).toBeTruthy();
  });

  it('缩放：放大一档轨道宽翻倍、读数 2×；点读数复位', () => {
    render();
    const zoom = () => q('[data-zoom-value]')!.textContent;
    expect(zoom()).toBe('1×');
    expect(q('[data-timeline-track]')!.style.width).toBe('100%');
    clickAt(q('button[aria-label="放大"]')!, 0);
    expect(zoom()).toBe('2×');
    expect(q('[data-timeline-track]')!.style.width).toBe('200%');
    clickAt(q('[data-zoom-value]')!, 0);
    expect(zoom()).toBe('1×');
    expect(q('button[aria-label="缩小"]')!.hasAttribute('disabled')).toBe(true);
  });

  it('休眠阈值分段控件：点选切换选中态', () => {
    render();
    expect(q('[data-threshold="5m"]')!.getAttribute('aria-pressed')).toBe('true');
    clickAt(q('[data-threshold="15m"]')!, 0);
    expect(q('[data-threshold="15m"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(q('[data-threshold="5m"]')!.getAttribute('aria-pressed')).toBe('false');
  });
});

describe('RunTurnsTimeline — ① 单击即跳', () => {
  it('root 道整道可点：点在哪一刻就选中那一刻的轮次；空档取最近一轮；越过末轮取末轮', () => {
    const { onSelectTurn } = render();
    const rootLane = laneEl('root');
    clickAt(rootLane, sec(15));   // t1 [0,30] 内
    expect(onSelectTurn).toHaveBeenLastCalledWith('t1');
    clickAt(rootLane, sec(72));   // t2 [60,90] 内
    expect(onSelectTurn).toHaveBeenLastCalledWith('t2');
    clickAt(rootLane, sec(45));   // 空档：距 t1 终点 15 / 距 t2 起点 15 → 前一轮
    expect(onSelectTurn).toHaveBeenLastCalledWith('t1');
    clickAt(rootLane, sec(52));   // 空档：距 t2 起点 8 → t2
    expect(onSelectTurn).toHaveBeenLastCalledWith('t2');
    clickAt(rootLane, 999);       // 越过末轮
    expect(onSelectTurn).toHaveBeenLastCalledWith('t2');
    expect(onSelectTurn).toHaveBeenCalledTimes(5);
  });

  it('无行轮（命令附注）不作目标：点在它的时刻落到最近的可见轮', () => {
    const { onSelectTurn } = render();
    clickAt(laneEl('root'), sec(30.5));
    expect(onSelectTurn).toHaveBeenLastCalledWith('t1');
  });

  it('槽道只在条上可点：点子代理条 → 该子代理当时的轮；点空槽不动作', () => {
    const { onSelectTurn } = render();
    const slot = laneEl('slot-1');
    clickAt(q('[data-bar="sub-a"]')!, sec(25));
    expect(onSelectTurn).toHaveBeenLastCalledWith('sa1');
    clickAt(q('[data-bar="sub-a"]')!, sec(45));
    expect(onSelectTurn).toHaveBeenLastCalledWith('sa2');
    clickAt(q('[data-bar="sub-b"]')!, sec(100));
    expect(onSelectTurn).toHaveBeenLastCalledWith('sb1');
    // 空槽（60s 处没有任何条子）
    clickAt(slot, sec(60));
    expect(onSelectTurn).toHaveBeenCalledTimes(3);
    // 轴上点击不动作
    clickAt(q('[data-timeline-track]')!.firstElementChild!, sec(15));
    expect(onSelectTurn).toHaveBeenCalledTimes(3);
  });

  it('图例过滤后：被隐藏类型的条子不可点，root 不受影响', () => {
    const { onSelectTurn } = render();
    clickAt(q('[data-legend-item="explorer"]')!, 0);
    expect(q('[data-bar="sub-a"]')).toBeNull();
    expect(q('[data-bar="sub-b"]')).toBeTruthy();
    clickAt(laneEl('slot-1'), sec(25));
    expect(onSelectTurn).not.toHaveBeenCalled();
    clickAt(laneEl('root'), sec(15));
    expect(onSelectTurn).toHaveBeenLastCalledWith('t1');
  });
});

describe('RunTurnsTimeline — ② 播放头跟随与性能契约', () => {
  it('选中轮的播放头立在它的时间窗起点；换选只动播放头，道行子树不重渲染', () => {
    const { rerender, onSelectTurn } = render({ selectedTurnId: 't2' });
    const initial = lanesRenders.count;
    expect(q('[data-playhead]')!.style.left).toBe('50%');
    // 时刻牌 = 选中轮起点（本机时区 HH:MM:SS——放大后要能对到秒级落点）
    const hm = (ms: number) => { const d = new Date(ms); return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':'); };
    expect(q('[data-playhead-time]')!.textContent).toBe(hm(at(60)));
    rerender({ selectedTurnId: 'sa1' });
    expect(q('[data-playhead]')!.style.left).toBe(`${(20 / 120) * 100}%`);
    expect(q('[data-playhead-time]')!.textContent).toBe(hm(at(20)));
    rerender({ selectedTurnId: 'sb1' });
    expect(q('[data-playhead]')!.style.left).toBe(`${(95 / 120) * 100}%`);
    // 时间线上点击换选同样不碰道行
    clickAt(laneEl('root'), sec(15));
    expect(onSelectTurn).toHaveBeenLastCalledWith('t1');
    expect(lanesRenders.count).toBe(initial);
    // 未知轮 / 无选中 → 无播放头
    rerender({ selectedTurnId: null });
    expect(q('[data-playhead]')).toBeNull();
    expect(lanesRenders.count).toBe(initial);
  });

  it('道行子树只在模型变化时重渲染（图例过滤、阈值切换）', () => {
    const { rerender } = render();
    const initial = lanesRenders.count;
    clickAt(q('[data-legend-item="writer"]')!, 0);
    expect(lanesRenders.count).toBe(initial + 1);
    clickAt(q('[data-threshold="15m"]')!, 0);
    expect(lanesRenders.count).toBe(initial + 2);
    rerender({ lanes: ['base'] });
    expect(lanesRenders.count).toBe(initial + 3);
  });
});

describe('RunTurnsTimeline — ③ 测距、悬停与图例', () => {
  it('测距是显式模式：开着才量、不抢导航单击；两点出时距、第三点重测、关闭即清', () => {
    const { onSelectTurn } = render();
    const measureBtn = q('[data-timeline-measure]')!;
    expect(measureBtn.getAttribute('aria-pressed')).toBe('false');
    clickAt(measureBtn, 0);
    expect(measureBtn.getAttribute('aria-pressed')).toBe('true');
    clickAt(laneEl('root'), sec(10));
    expect(onSelectTurn).not.toHaveBeenCalled();
    expect(q('[data-measure-readout]')!.textContent).toContain('再点一处');
    clickAt(laneEl('root'), sec(70));
    expect(onSelectTurn).not.toHaveBeenCalled();
    expect(q('[data-measure-readout]')!.textContent).not.toContain('再点一处');
    expect(q('[data-measure-readout]')!.textContent).toMatch(/1\.0min|60s/);
    expect(q('[data-measure]')).toBeTruthy();
    // 第三点重新起测
    clickAt(laneEl('root'), sec(20));
    expect(q('[data-measure-readout]')!.textContent).toContain('再点一处');
    // 关闭测距 → 读数与标记清空，导航恢复
    clickAt(measureBtn, 0);
    expect(q('[data-measure-readout]')).toBeNull();
    expect(q('[data-measure]')).toBeNull();
    clickAt(laneEl('root'), sec(15));
    expect(onSelectTurn).toHaveBeenLastCalledWith('t1');
  });

  it('悬停条子弹浮窗（类型 / 步骤 / 时长），离开即收', () => {
    render();
    const bar = q('[data-bar="sub-a"]')!;
    act(() => { bar.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
    const tip = q('[data-tooltip]')!;
    expect(tip.textContent).toContain('explorer');
    expect(tip.textContent).toContain('P1 需求分析');
    act(() => { bar.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })); });
    expect(q('[data-tooltip]')).toBeNull();
  });

  it('图例：隐藏某类型只收它的条子；显示全部恢复；无隐藏时「隐藏全部」收掉全部子代理', () => {
    render();
    clickAt(q('[data-legend-item="explorer"]')!, 0);
    expect(q('[data-legend-item="explorer"]')!.getAttribute('aria-pressed')).toBe('false');
    expect(q('[data-bar="sub-a"]')).toBeNull();
    expect(q('[data-legend-item="writer"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(q('[data-bar="sub-b"]')).toBeTruthy();
    expect(q('[data-legend-all]')!.textContent).toBe('显示全部');
    clickAt(q('[data-legend-all]')!, 0);
    expect(q('[data-bar="sub-a"]')).toBeTruthy();
    expect(q('[data-legend-all]')!.textContent).toBe('隐藏全部');
    clickAt(q('[data-legend-all]')!, 0);
    expect(q('[data-bar="sub-a"]')).toBeNull();
    expect(q('[data-bar="sub-b"]')).toBeNull();
    expect(q('[data-bar="root"]')).toBeTruthy();
    expect(qa('[data-lane]').map(l => l.dataset.lane)).toEqual(['root']);
  });
});
