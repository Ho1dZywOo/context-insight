// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// Regression guard for the duplicate-key React warning on PerfBenchmarkChart.
// When all values are 0, the y-axis clamp degenerates tick values; any
// value-keyed list (grid lines/bars) collides and React's dev build emits
// "Encountered two children with the same key" during a client render. We use
// createRoot + act (not SSR — SSR doesn't warn) to capture the console.error,
// and assert none mentions duplicate keys.

import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { PerfBenchmarkChart } from '@/components/observe/perf-shared';

describe('PerfBenchmarkChart', () => {
  it('renders without duplicate-key warnings when all values are zero', () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(' '));
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const points = [
      { turnIndex: 0, createdAt: '2026-08-13T11:00:00Z', tpot: 0, tps: 0 },
      { turnIndex: 1, createdAt: '2026-08-13T11:01:00Z', tpot: 0, tps: 0 },
      { turnIndex: 2, createdAt: '2026-08-13T11:02:00Z', tpot: 0, tps: 0 },
    ];
    act(() => { root.render(createElement(PerfBenchmarkChart, { points })); });
    const dupKey = errors.find(e => e.includes('two children with the same key'));
    expect(dupKey ? `duplicate-key warning: ${dupKey}` : undefined).toBeUndefined();
    spy.mockRestore();
    document.body.removeChild(container);
  });

  it('效率分布折线：统计条 + 平滑折线/渐变面积（稀疏逐点成线），TPS/TPOT 分段切换单图呈现；纯观测无跳转', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const points = [
      { turnIndex: 0, turnId: 'bm-turn-0', createdAt: '2026-08-13T11:00:00Z', tpot: 120, tps: 40 },
      { turnIndex: 1, turnId: 'bm-turn-1', createdAt: '2026-08-13T11:01:00Z', tpot: 100, tps: 50 },
    ];
    act(() => {
      root.render(createElement(PerfBenchmarkChart, { points }));
    });
    // TPS / TPOT 互为倒数（同信息双镜头）——分段控制单图切换，不再双面板并列
    expect(container.textContent).toContain('tok/s');
    expect(container.textContent).toContain('均值');
    expect(container.textContent).toContain('峰值');
    expect(container.textContent).toContain('谷值');
    // 折线 + 线下渐变面积两条路径（无柱体；工具条图标 svg 不在此列）
    const chart = container.querySelector('svg[data-bench]')!;
    expect(chart.querySelectorAll('path').length).toBe(2);
    expect(chart.querySelectorAll('rect').length).toBe(0);
    // 纯观测无跳转：图面不带 pointer 标记（分段控件不在此列）
    expect(container.querySelector('svg .cursor-pointer')).toBeNull();
    // 分段切到 TPOT：单位随镜头切换，图重挂（fade 入场）
    const segBtn = [...container.querySelectorAll('button')].find(b => b.textContent === 'TPOT');
    expect(segBtn).toBeTruthy();
    act(() => { segBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })) });
    expect(container.textContent).toContain('ms/tok');
    expect(container.querySelector('svg[data-bench]')!.querySelectorAll('path').length).toBe(2);
    act(() => { root.unmount() });
    document.body.removeChild(container);
  });

  it('悬停聚焦：十字线 + 聚焦点 + 数值气泡（时刻/数值/单位）', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const points = [
      { turnIndex: 0, turnId: 'bm-turn-0', createdAt: '2026-08-13T11:00:00Z', tpot: 120, tps: 40 },
      { turnIndex: 1, turnId: 'bm-turn-1', createdAt: '2026-08-13T11:01:00Z', tpot: 100, tps: 50 },
    ];
    act(() => {
      root.render(createElement(PerfBenchmarkChart, { points }));
    });
    // 悬停前：无气泡
    expect(container.textContent).not.toContain('40 tok/s');
    const svg = container.querySelector('svg[data-bench]')!;
    // 悬停移到首点（首点贴左轴，viewBox x = padL = 36）
    act(() => { svg.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 36 })) });
    // 气泡：时刻 + 数值 + 单位（SVG 内文本，无跳转提示）
    expect(container.textContent).toContain('40 tok/s');
    expect(container.textContent).not.toContain('点击跳转');
    // 十字线在场（网格 3 + 均值 1 + 十字 1 = 5 条 line）
    expect(svg.querySelectorAll('line').length).toBe(5);
    // 跟手：移到两点中点，焦点骑线内插（v = 40→50 的中值 45，cx 跟随光标）
    const dotAt = (cx: string) => [...svg.querySelectorAll('circle')].some(c => c.getAttribute('cx') === cx);
    expect(dotAt('36')).toBe(true);
    act(() => { svg.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 372 })) });
    expect(container.textContent).toContain('45 tok/s');
    expect(dotAt('372')).toBe(true);
    // x 轴为时间刻度（时:分:秒形态），非会话局部轮号
    expect(container.textContent).toMatch(/\d{2}:\d{2}:\d{2}/);
    expect(container.textContent).not.toMatch(/^#|\s#\d+\s/);
    act(() => { root.unmount() });
    document.body.removeChild(container);
  });

  it('宽卡片映射：svg meet 居中缩放下像素→viewBox 换算对齐（十字线/焦点贴手）', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const points = [
      { turnIndex: 0, turnId: 'bm-turn-0', createdAt: '2026-08-13T11:00:00Z', tpot: 120, tps: 40 },
      { turnIndex: 1, turnId: 'bm-turn-1', createdAt: '2026-08-13T11:01:00Z', tpot: 100, tps: 50 },
    ];
    act(() => { root.render(createElement(PerfBenchmarkChart, { points })) });
    const svg = container.querySelector('svg[data-bench]')!;
    // 模拟 1440px 宽元素：720 回退几何 meet 居中（两侧各 360px 留白），元素左缘在页面 x=100
    const fakeRect = { x: 100, y: 0, left: 100, top: 0, right: 1540, bottom: 200, width: 1440, height: 200, toJSON: () => ({}) };
    (svg as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () => fakeRect as DOMRect;
    // 光标在绘图区首点（元素内 x = 360 + 36 = 396 → 页面 x = 496）
    act(() => { svg.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 496 })) });
    expect(container.textContent).toContain('40 tok/s');
    expect([...svg.querySelectorAll('circle')].some(c => c.getAttribute('cx') === '36')).toBe(true);
    // 光标在两点中点（页面 x = 100 + 360 + 372 = 832）→ 内插 45、焦点 cx=372
    act(() => { svg.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 832 })) });
    expect(container.textContent).toContain('45 tok/s');
    expect([...svg.querySelectorAll('circle')].some(c => c.getAttribute('cx') === '372')).toBe(true);
    // 留白区（元素内 x < 360）不出示读数：十字线退场（网格 3 + 均值 1 = 4 条 line）
    act(() => { svg.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 200 })) });
    expect(svg.querySelectorAll('line').length).toBe(4);
    act(() => { root.unmount() });
    document.body.removeChild(container);
  });

  it('y 轴不钳制：离群值撑满量程，轴顶刻度覆盖峰值（整步上取），不压顶自欺', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    // 21 轮：20 轮 TPS=50 + 1 轮离群 300——分位钳制会把轴压到 50、离群
    // 点贴顶；整步上取轴顶 = 500，刻度与数值处处一致
    const points = Array.from({ length: 21 }, (_, i) => ({
      turnIndex: i,
      createdAt: `2026-08-13T11:${String(i).padStart(2, '0')}:00Z`,
      tpot: 20,
      tps: i === 20 ? 300 : 50,
    }));
    act(() => { root.render(createElement(PerfBenchmarkChart, { points })) });
    expect(container.textContent).toContain('500');
    expect(container.textContent).toContain('峰值');
    act(() => { root.unmount() });
    document.body.removeChild(container);
  });

  it('高密度聚合：样本超容量按时间桶聚合，min-max 包络带在场且峰值不因平滑而抹平', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    // 300 轮：多数 TPS=50 + 单轮离群 300——包络带保峰，轴顶整步上取 = 500
    const points = Array.from({ length: 300 }, (_, i) => ({
      turnIndex: i,
      createdAt: `2026-08-13T${String(10 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z`,
      tpot: 20,
      tps: i === 150 ? 300 : 50,
    }));
    act(() => { root.render(createElement(PerfBenchmarkChart, { points })) });
    // 包络带 + 渐变面积 + 均值线 = 3 条路径
    expect(container.querySelector('svg[data-bench]')!.querySelectorAll('path').length).toBe(3);
    // 轴顶覆盖真实峰值（500 > 300，不钳制）
    expect(container.textContent).toContain('500');
    // 轮次统计条仍是真实轮数（聚合只影响呈现，不改口径）
    expect(container.textContent).toContain('300');
    act(() => { root.unmount() });
    document.body.removeChild(container);
  });

  it('时间窗缩放：Ctrl+滚轮锚定放大（窗口内重新采样、统计随窗），拖拽平移，工具条适配复位', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    // 8 轮按 2s 排布（全程 14s）——轮次统计随窗口变化可精确断言
    const points = Array.from({ length: 8 }, (_, i) => ({
      turnIndex: i,
      createdAt: `2026-08-13T11:00:${String(i * 2).padStart(2, '0')}Z`,
      tpot: 20,
      tps: 50,
    }));
    act(() => { root.render(createElement(PerfBenchmarkChart, { points })) });
    const svg = container.querySelector('svg[data-bench]')!;
    const turnsStat = () => {
      const cell = [...container.querySelectorAll('div')].find(
        d => d.children.length === 2 && d.children[0].textContent === '轮次',
      );
      return cell?.children[1].textContent;
    };
    // 全程：8 轮、折线 + 面积 2 路径、倍率 100%
    expect(turnsStat()).toBe('8');
    expect(svg.querySelectorAll('path').length).toBe(2);
    expect(container.textContent).toContain('100%');
    // Ctrl+滚轮 ×10 锚定左缘：窗口 ≈ [0, 4.5s] 只含 0/2/4s 三轮 → 轮次随窗、倍率 311%
    // （happy-dom 的 WheelEvent 不透传 ctrlKey/clientX，实例级补齐）
    const wheel = (clientX: number) => {
      const ev = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 });
      Object.defineProperty(ev, 'ctrlKey', { value: true });
      Object.defineProperty(ev, 'clientX', { value: clientX });
      act(() => { svg.dispatchEvent(ev) });
    };
    for (let i = 0; i < 10; i++) wheel(36);
    expect(turnsStat()).toBe('3');
    expect(container.textContent).toContain('311%');
    // 拖拽平移（向左拖 100px → 窗口右移）：0s 轮移出、5s 轮纳入 → 2/4/5s？窗口 [0.67, 5.17] 含 2/4s
    act(() => { svg.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 200 })) });
    act(() => { svg.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 100 })) });
    act(() => { svg.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })) });
    expect(turnsStat()).toBe('2');
    // 适配全程：轮次/倍率复位
    const fitBtn = container.querySelector('button[aria-label="适配全程"]')!;
    expect(fitBtn).toBeTruthy();
    act(() => { fitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) });
    expect(turnsStat()).toBe('8');
    expect(container.textContent).toContain('100%');
    act(() => { root.unmount() });
    document.body.removeChild(container);
  });

  it('宽卡片适配：容器实测宽直写 viewBox（1:1 满铺无 meet 留白），光标像素坐标恒等映射贴手', () => {
    // 假 ResizeObserver：observe 即同步回报 1000px 容器宽（真 RO 在浏览器按帧回报）
    class FakeRO {
      constructor(private cb: ResizeObserverCallback) {}
      observe() {
        this.cb([{ contentRect: { width: 1000 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      disconnect() {}
      unobserve() {}
    }
    const g = globalThis as Record<string, unknown>;
    const orig = g.ResizeObserver;
    g.ResizeObserver = FakeRO;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      const points = [
        { turnIndex: 0, turnId: 'bm-turn-0', createdAt: '2026-08-13T11:00:00Z', tpot: 120, tps: 40 },
        { turnIndex: 1, turnId: 'bm-turn-1', createdAt: '2026-08-13T11:01:00Z', tpot: 100, tps: 50 },
      ];
      act(() => { root.render(createElement(PerfBenchmarkChart, { points })) });
      const svg = container.querySelector('svg[data-bench]')!;
      // 实测宽直写 viewBox：绘图横向 1:1，宽卡片两侧不再留白（高度恒定）
      expect(svg.getAttribute('viewBox')).toBe('0 0 1000 200');
      // 模拟 1000px 宽元素（左缘页面原点）：恒等映射——clientX 136 → viewBox x 136
      const fakeRect = { x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 200, width: 1000, height: 200, toJSON: () => ({}) };
      (svg as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () => fakeRect as DOMRect;
      act(() => { svg.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 136 })) });
      expect([...svg.querySelectorAll('circle')].some(c => c.getAttribute('cx') === '136')).toBe(true);
      expect(container.textContent).toContain('tok/s');
      // 图宽中点 clientX 512 → 内插 45、焦点 cx=512（满铺后绘图区右缘到 988）
      act(() => { svg.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 512 })) });
      expect(container.textContent).toContain('45 tok/s');
      expect([...svg.querySelectorAll('circle')].some(c => c.getAttribute('cx') === '512')).toBe(true);
      act(() => { root.unmount() });
    } finally {
      g.ResizeObserver = orig;
      document.body.removeChild(container);
    }
  });
});
