// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// RunTabBar IT（凹槽分段导航）：锁——①药丸按钮渲染表（12 tab 含 Wire 轮次
// 中文标签）；②凹槽轨道（浅灰 rounded-full 轨道）+ 活跃态卡舌样式
// （text-foreground）+ 浮起卡舌指示器（bg-card，transform/width 过渡族）
// + 图标彩色常驻（非活跃压暗）；③点击切换回调（点活跃自身不触发）；
// ④无 ARIA tab 角色的工作台契约（普通 button，页面级 IT 亦锁）；
// ⑤高级门：默认可见表不含 wire/replay。
// 注：happy-dom 无布局引擎（offsetLeft/offsetWidth 恒 0），指示器的量测
// 定位数值不可测——属浏览器视觉行为，由线上人工验证。

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RunTabBar, RUN_TABS, RUN_TABS_DEFAULT_VISIBLE } from '@/components/run/RunTabBar';
import type { RunTabKey } from '@/app/run/[runId]/run-view';

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

async function renderBar(active: RunTabKey, onSelect: (key: RunTabKey) => void = () => {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(RunTabBar, { tabs: RUN_TABS, active, onSelect }));
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function barButtons(container: Element): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button'));
}

describe('RunTabBar（凹槽分段导航）', () => {
  it('渲染表完整：11 药丸按钮（含 Wire 轮次标签，Trace 已退役并入 Turns），无 ARIA tab 角色（工作台契约）', async () => {
    const container = await renderBar('overview');
    const btns = barButtons(container);
    expect(btns.length).toBe(11);
    expect(btns.map(b => b.textContent)).toContain('Wire 轮次');
    expect(btns.map(b => b.textContent)).not.toContain('Trace');
    expect(container.querySelectorAll('[role="tab"]').length).toBe(0);
    expect(container.querySelector('[data-run-tabbar]')).toBeTruthy();
  });

  it('活跃态卡舌样式 + 浮起卡舌指示器 + 凹槽轨道 + 图标彩色常驻（非活跃压暗）', async () => {
    const container = await renderBar('context');
    const btns = barButtons(container);
    const activeBtn = btns.find(b => b.textContent === 'Context')!;
    const inactiveBtn = btns.find(b => b.textContent === 'Graph')!;
    expect(activeBtn.className).toContain('text-foreground');
    expect(activeBtn.className).not.toContain('text-muted-foreground');
    expect(inactiveBtn.className).toContain('text-muted-foreground');
    // 凹槽轨道：浅灰 rounded-full 轨道 + p-1 内衬 + 居中收束（w-fit）
    const groove = container.querySelector('[data-run-tabbar] > div') as HTMLElement;
    expect(groove.className).toContain('bg-foreground/[0.04]');
    expect(groove.className).toContain('rounded-full');
    expect(groove.className).toContain('w-fit');
    // 指示器：浮起卡舌（bg-card），aria-hidden 装饰层，过渡族覆盖 transform 与 width
    const indicator = container.querySelector('[data-run-tabbar] > div > div[aria-hidden]') as HTMLElement | null;
    expect(indicator).toBeTruthy();
    expect(indicator!.className).toContain('bg-card');
    expect(indicator!.className).toContain('transition-[transform,width]');
    expect(indicator!.className).toContain('rounded-full');
    // 图标彩色常驻：活跃点亮全彩、非活跃压暗
    const activeIcon = activeBtn.querySelector('svg');
    const inactiveIcon = inactiveBtn.querySelector('svg');
    expect(activeIcon!.getAttribute('class')).toContain('opacity-100');
    expect(inactiveIcon!.getAttribute('class')).toContain('opacity-55');
  });

  it('点击切换：回调携带目标键；点活跃自身不触发', async () => {
    const onSelect = vi.fn();
    const container = await renderBar('overview', onSelect);
    const btns = barButtons(container);
    await act(async () => { btns.find(b => b.textContent === 'Perf')!.click() });
    expect(onSelect).toHaveBeenCalledWith('perf');
    await act(async () => { btns.find(b => b.textContent === 'Overview')!.click() });
    expect(onSelect).toHaveBeenCalledWith('perf'); // 仍是首次调用——点活跃自身无效
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('高级门：默认可见表不含 wire/replay，全量表含 11 项（trace 退役出表）', () => {
    const defaultKeys = RUN_TABS_DEFAULT_VISIBLE.map(t => t.key);
    expect(defaultKeys).not.toContain('wire');
    expect(defaultKeys).not.toContain('replay');
    expect(defaultKeys).not.toContain('trace');
    expect(defaultKeys.length).toBe(9);
    expect(RUN_TABS.length).toBe(11);
  });
});
