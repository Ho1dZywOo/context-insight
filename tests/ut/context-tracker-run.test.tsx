// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// ContextTracker run 泛化 IT（泳道同款视角）：member 归因轮次直喂组件，锁——
// ①root agent 按成员会话分组、卡名 = 成员短名（session 即 agent），子代理跨
//   成员按 sid 池化 + 同名编号；
// ②/compact 逐成员独立归因（pre/post 轮不得跨成员错配——成员间压缩降幅不同，
//   各自卡详情里的降幅即归属证据）；
// ③agentContextLimits 提供时不再拉 /api/config/context-windows（服务端预算
//   单源）；
// ④→ Turns 跳转带 member 归因；
// ⑤回放步进轴 = 合并时间序全局排名（各成员 turnIndex 空间互不相通，同 index
//   撞步会把多成员轮混进同一帧）；
// ⑥趋势图例按类型分组（root 一键一会话 + 类型条目 ×N，与泳道图例同构），
//   整组显隐联动；默认可见 = 阈值自适应（agent ≤ 12 全显，超出聚焦峰值
//   Top-K——大 run 收敛口径见 context-tracker-scale.test.tsx），类型条目整组
//   收起/展开；
// ⑦曲线渲染管线：LTTB 降采样（千轮级会话收敛到像素级点数）+ Ctrl/⌘+滚轮
//   时间窗缩放（原生 non-passive 监听，preventDefault 生效不被页面缩放劫持）；
// ⑧悬浮弹窗 = HTML 层（恒定像素不随图缩放）：点位右侧放置、右缘自动翻左，
//   不遮被检曲线与数据点；
// ⑨时间窗缩放（Perf 效率分布同款）：viewport overflow-hidden 零滚动条、图框
//   恒定（无相机 transform——缩放只作用于时间轴，不整图放缩）、Ctrl/⌘+滚轮
//   光标锚定缩放、拖拽平移窗口、玻璃工具条倍率读数、适配复位；原地点按
//   命中点跳转该轮；
// ⑩Agent 概览面板退役：卡片收编进组详情弹窗（趋势小图下方的概览卡——峰值/
//   窗口占比 + 平均/缓存命中 + → Turns 带 member 归因；卡片不随图中显隐变灰），
//   页面只留曲线形状（数字全归弹窗），胶囊 chevron 是唯一入口；卡片全名展示
//   （含 #编号/派发步骤，不截断）。
// ⑪命名单一源（run-actor 目录）：成员/子代理统一身份建模——身份键、图例键、
//   展示名（类型别名归一 + 同名编号 + 派发步骤回落）单点组合，卡片/图例/回放
//   同源；无类型子代理（无桥归因）回落派发步骤并带「派发」徽标，不再与类型
//   名裸混一列。
// ⑬组构成下钻（第四层）：右侧滑出弹窗（胶囊 chevron = 组视角 / 概览卡点击
//   = 实例视角，两个入口一个弹窗）——组头 Σ 摘要 + 该 agent 独立增长趋势小图
//   （逐轮轴、缓存读份额带、80/100% 窗口参考线、/compact 标记、多实例组灰
//   线同框）+ 概览卡 + 实例排行（峰值降序、带成员归因徽标，行即实例切换
//   器）+ 上下文组成/关键事件/缓存效率；单实例组直开详情；弹窗替代旧内联
//   面板的「打开即滚动定位」契约——入口与详情再无距离问题。
// ⑫图内点选聚焦：原地点击曲线选中该组（其余变灰、选中加亮），再点同线或点
//   空白取消；与悬浮/胶囊 hover 的瞬时高亮叠加（hover 优先）。图选只在图内
//   表达——胶囊行/概览卡均不随图亮起；隐藏组淡出仅存于胶囊（显隐语义），
//   概览卡恒常亮（恒定参照面板）。

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ContextTracker, type TurnRowItem } from '@/components/observe/ContextTracker';

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MEMBER_A = { taskId: 'ses-ma', label: '成员A' };
const MEMBER_B = { taskId: 'ses-mb', label: '成员B' };

const CMD = '<command-name>/compact</command-name><command-message>compact</command-message><command-args></command-args>';
const CONT = 'This session is being continued from a previous conversation. Previous summary: done.';

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

// 10 轮：A（assistant → /compact → 续接 → 压缩后 10000）、B（60000 → /compact
// → 续接 → 压缩后 50000）、两个同名「调研员」子代理（分属 A/B）。两成员
// turnIndex 空间重叠（0..3）——真实形态，也是回放撞步的回归材料。
const turns: TurnRowItem[] = [
  turn({ turnId: 't-a0', turnIndex: 0, member: MEMBER_A, createdAt: '2026-10-13T02:00:10Z', totalTokens: 30000, inputTokens: 20000, inputMessagesTokens: 25000, contextWindowPct: 20 }),
  turn({ turnId: 't-acmd', turnIndex: 1, role: 'user', member: MEMBER_A, createdAt: '2026-10-13T02:00:20Z', contentSummary: CMD }),
  turn({ turnId: 't-acont', turnIndex: 2, role: 'user', member: MEMBER_A, createdAt: '2026-10-13T02:00:25Z', contentSummary: CONT }),
  turn({ turnId: 't-a3', turnIndex: 3, member: MEMBER_A, createdAt: '2026-10-13T02:00:30Z', totalTokens: 10000, inputTokens: 8000, inputMessagesTokens: 9000, contextWindowPct: 8 }),
  turn({ turnId: 't-b0', turnIndex: 0, member: MEMBER_B, createdAt: '2026-10-13T02:01:10Z', totalTokens: 60000, inputTokens: 40000, inputMessagesTokens: 50000, contextWindowPct: 45 }),
  turn({ turnId: 't-bcmd', turnIndex: 1, role: 'user', member: MEMBER_B, createdAt: '2026-10-13T02:01:20Z', contentSummary: CMD }),
  turn({ turnId: 't-bcont', turnIndex: 2, role: 'user', member: MEMBER_B, createdAt: '2026-10-13T02:01:25Z', contentSummary: CONT }),
  turn({ turnId: 't-b3', turnIndex: 3, member: MEMBER_B, createdAt: '2026-10-13T02:01:30Z', totalTokens: 50000, inputTokens: 35000, inputMessagesTokens: 42000, contextWindowPct: 38 }),
  turn({ turnId: 't-s1', turnIndex: 4, member: MEMBER_A, isSubagent: true, agentName: '派发-调研', subagentName: '调研员', subagentSessionId: 'sub-a', subagentType: 'research', createdAt: '2026-10-13T02:00:15Z', totalTokens: 5000, inputMessagesTokens: 4000, contextWindowPct: 7 }),
  turn({ turnId: 't-s2', turnIndex: 4, member: MEMBER_B, isSubagent: true, agentName: '派发-调研', subagentName: '调研员', subagentSessionId: 'sub-b', subagentType: 'research', createdAt: '2026-10-13T02:01:15Z', totalTokens: 3000, inputMessagesTokens: 2500, contextWindowPct: 5 }),
  // 无类型子代理：回落 agentName（旧口径兜底）
  turn({ turnId: 't-s3', turnIndex: 5, member: MEMBER_A, isSubagent: true, agentName: 'unique-编译器', subagentName: 'unique-编译器', subagentSessionId: 'sub-c', createdAt: '2026-10-13T02:00:35Z', totalTokens: 2000, inputMessagesTokens: 1500, contextWindowPct: 3 }),
];

const agentContextLimits: Record<string, number> = {
  'root:ses-ma': 128000,
  'root:ses-mb': 128000,
  'sub-a': 64000,
  'sub-b': 64000,
};

const fetchUrls: string[] = [];
vi.stubGlobal('fetch', vi.fn(async (url: string) => {
  fetchUrls.push(url);
  return { ok: true, json: async () => ({ limit: 200000 }) };
}));

let root: Root | null = null;

async function render(props: { onNavigateToTurn?: (turnId: string, memberTaskId?: string | null) => void } = {}) {
  fetchUrls.length = 0;
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(ContextTracker, {
      turns,
      sessionModel: null,
      agentContextLimits,
      onNavigateToTurn: props.onNavigateToTurn,
    }));
  });
  await act(async () => { await new Promise(r => setTimeout(r, 20)) });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function text(el: Element | Document = document.body): string {
  return (el as Element).textContent ?? '';
}

/** 图例胶囊的组详情按钮（chevron）：label[data-legend] 的同级 button */
function detailBtnOf(container: Element, legend: string): HTMLButtonElement {
  const label = container.querySelector(`[data-legend="${legend}"]`) as HTMLElement | null;
  expect(label, `图例 ${legend} 应存在`).toBeTruthy();
  const btn = label!.parentElement!.querySelector('button') as HTMLButtonElement | null;
  expect(btn, `图例 ${legend} 的详情按钮应存在`).toBeTruthy();
  return btn!;
}

describe('ContextTracker run 泛化（泳道视角：session 即 agent）', () => {
  it('root 按成员分组（chip 名 = 成员短名）+ 子代理 sid 池化 + 同名编号；上限服务端预算不再拉 config', async () => {
    const container = await render();

    const t = text(container);
    // root 胶囊：成员短名命名（非 agentName "build"——两成员同名会撞名）
    expect(t).toContain('成员A');
    expect(t).toContain('成员B');
    // 无类型子代理回落 agentName（派发描述兜底）
    expect(t).toContain('unique-编译器');
    expect(t).not.toContain('派发-调研');
    // 类型组详情（渐进披露）：同名类型 research 的实例编号 #1（A，先起）/#2（B）
    //——弹窗经 Portal 挂 body，断言走 body 域
    await act(async () => { detailBtnOf(container, 'research').click() });
    await act(async () => { await new Promise(r => setTimeout(r, 20)) });
    expect(text()).toContain('research #1');
    expect(text()).toContain('research #2');
    // agentContextLimits 已给 → 不再 fetch /api/config/context-windows
    expect(fetchUrls.filter(u => u.includes('/api/config/context-windows'))).toHaveLength(0);
  });

  it('组构成下钻（胶囊 chevron = 组视角）：右侧弹窗承载——趋势小图 + 概览卡 + 实例排行 + 组级 Σ + 行即实例切换器', async () => {
    const container = await render();

    await act(async () => { detailBtnOf(container, 'research').click() });
    await act(async () => { await new Promise(r => setTimeout(r, 20)) });

    // 右侧滑出抽屉打开（弹窗替代旧内联面板的「打开即滚动定位」契约——
    // 入口与详情再无距离问题）；弹窗经 Portal 挂 body，断言走 body 域
    const dialog = document.querySelector('[data-agent-detail]');
    expect(dialog).toBeTruthy();
    // 弹窗内容三件套：独立增长趋势小图 + 概览卡 + 下钻数字
    expect(dialog!.querySelector('svg[data-chart="agent-trend"]')).toBeTruthy();
    expect(dialog!.querySelector('[data-agent-row]')).toBeTruthy();
    expect(dialog!.querySelector('.px-2.py-1.rounded.border')).toBeTruthy();

    // 组级 Σ 摘要（2 实例：sub-a 5000 + sub-b 3000）
    const t = text();
    expect(t).toContain('2 个实例');
    expect(t).toContain('Σ 2 轮');
    expect(t).toContain('Σ 峰值 6.5K');

    // 构成清单：实例行带成员归因徽标（sub-a→成员A、sub-b→成员B）
    const rows = Array.from(document.querySelectorAll('[data-agent-instances] button'));
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('成员A');
    expect(rows[1].textContent).toContain('成员B');
    // 峰值降序：首行 = 高峰实例
    expect(rows[0].textContent).toContain('research #1');

    // 行即实例切换器：点第二行 → 选中态迁移（首行失焦、AgentDetail 随行切换）
    await act(async () => { (rows[1] as HTMLButtonElement).click() });
    await act(async () => { await new Promise(r => setTimeout(r, 20)) });
    const rows2 = Array.from(document.querySelectorAll('[data-agent-instances] button'));
    expect(rows2[0].className).not.toContain('bg-accent/50');
    expect(rows2[1].className).toContain('bg-accent/50');
    expect(text()).toContain('research #2');

    // 单实例组（成员 root）无构成清单，直开上下文详情
    await act(async () => { detailBtnOf(container, '成员A').click() });
    await act(async () => { await new Promise(r => setTimeout(r, 20)) });
    expect(document.querySelector('[data-agent-instances]')).toBeNull();

    // 关闭（弹窗右上 ✕）：抽屉卸载，detail 归零
    await act(async () => { (document.querySelector('[data-slot="dialog-close"]') as HTMLButtonElement).click() });
    await act(async () => { await new Promise(r => setTimeout(r, 20)) });
    expect(document.querySelector('[data-agent-detail]')).toBeNull();
  });

  it('详情弹窗趋势小图（逐轮轴）：主曲线 + 缓存读份额带 + /compact 标记 + 轮号刻度', async () => {
    const container = await render();

    await act(async () => { detailBtnOf(container, '成员A').click() });
    await act(async () => { await new Promise(r => setTimeout(r, 20)) });

    const svg = document.querySelector('svg[data-chart="agent-trend"]') as SVGSVGElement | null;
    expect(svg, '趋势小图应存在').toBeTruthy();
    const texts = Array.from(svg!.querySelectorAll('text')).map(t => t.textContent ?? '');
    // x 轴 = agent 自身轮序，标全局轮号（与关键事件行 #N 对位）：成员A 两数据轮 #0/#3
    expect(texts.some(t => t === '#0')).toBe(true);
    expect(texts.some(t => t === '#3')).toBe(true);
    // 主曲线（stroke 线）与面积/缓存份额带（fill 带）
    expect(svg!.querySelectorAll('path[fill="none"]').length).toBeGreaterThanOrEqual(1);
    expect(svg!.querySelector('path[fill="#eab308"]')).toBeTruthy();
    expect(svg!.querySelector('path[opacity="0.12"]')).toBeTruthy();
    // /compact 标记：紫色纵虚线（命令轮 0 token 不在数据轮里——时间序回落
    // 到其后首数据轮 #3）+ ⚡
    expect(svg!.querySelector('line[stroke="#a855f7"]')).toBeTruthy();
    expect(texts.includes('⚡')).toBe(true);
    // 关键事件点（start/peak 圆点）落在曲线上
    expect(svg!.querySelectorAll('circle').length).toBeGreaterThanOrEqual(2);
    // 弹窗头部 = 组视角（成员A 单实例组）
    expect(text(document.querySelector('[data-agent-detail]')!)).toContain('上下文详情');
  });

  it('图例按类型分组（root 一键 + 类型条目 ×N），类型整组显隐联动 + 仅 Root 快捷', async () => {
    const container = await render();

    // 分组图例：root 按成员会话（成员短名）、子代理按类型聚合（×N 计数）——
    // 规范键序（root 在前、同层字典序），与配色分配同序
    const chips = Array.from(container.querySelectorAll('[data-legend]'));
    expect(chips.map(c => c.getAttribute('data-legend'))).toEqual(['成员A', '成员B', 'research', 'unique-编译器']);
    expect(chips[2]!.textContent).toContain('×2');

    // 3 个单轮子代理 → 3 个在场点；点掉 research 类型 → 该组 2 个点整组消失
    // （圈定图表 svg——缩放按钮的 lucide 图标也含 circle）
    const circles = () => container.querySelectorAll('svg[data-chart="growth"] circle').length;
    expect(circles()).toBe(3);
    await act(async () => { (chips[2]!.querySelector('input') as HTMLElement).click() });
    expect(circles()).toBe(1);
    await act(async () => { (chips[2]!.querySelector('input') as HTMLElement).click() });
    expect(circles()).toBe(3);

    // 仅 Root 快捷开关（画布内玻璃分段控件）：子代理整层收起
    const onlyRoot = Array.from(container.querySelectorAll('[data-quick-filter] button')).find(b => b.textContent?.includes('仅 Root'));
    expect(onlyRoot).toBeTruthy();
    await act(async () => { (onlyRoot as HTMLElement).click() });
    expect(circles()).toBe(0);
  });

  it('子代理实例也进聚焦口径：Top-K 按峰值全 agent 排名，类型条目仍整组收起/展开', async () => {
    // 2 root（各 2 轮，35K/50K）+ 13 个同类型子代理（各 1 轮，1.5K 并列）=
    // 15 agent 超阈值 → 聚焦模式：Top-8 = 2 root + 6 个子代理（并列取稳定序
    // 前 6）；类型条目整组显隐联动不受影响（旧「无阈值全显」决策由大 run
    // 聚焦模式取代——百级成员曲线墙不可读，「全部」仍是显式回全显的口）
    const foldTurns: TurnRowItem[] = [
      turn({ turnId: 'f-a0', turnIndex: 0, member: MEMBER_A, createdAt: '2026-10-13T04:00:00Z', totalTokens: 30000, inputMessagesTokens: 25000, contextWindowPct: 20 }),
      turn({ turnId: 'f-a1', turnIndex: 1, member: MEMBER_A, createdAt: '2026-10-13T04:00:40Z', totalTokens: 40000, inputMessagesTokens: 35000, contextWindowPct: 28 }),
      turn({ turnId: 'f-b0', turnIndex: 0, member: MEMBER_B, createdAt: '2026-10-13T04:01:00Z', totalTokens: 50000, inputMessagesTokens: 42000, contextWindowPct: 33 }),
      turn({ turnId: 'f-b1', turnIndex: 1, member: MEMBER_B, createdAt: '2026-10-13T04:01:40Z', totalTokens: 60000, inputMessagesTokens: 50000, contextWindowPct: 40 }),
      ...Array.from({ length: 13 }, (_, i) => turn({
        turnId: `f-s${i}`, turnIndex: i, member: i % 2 ? MEMBER_B : MEMBER_A,
        isSubagent: true, agentName: `派发-${i}`, subagentName: '调研员', subagentSessionId: `fold-sub-${i}`,
        subagentType: 'research', createdAt: `2026-10-13T04:02:${String(10 + i).padStart(2, '0')}Z`,
        totalTokens: 2000, inputMessagesTokens: 1500, contextWindowPct: 2,
      })),
    ];
    const foldContainer = document.createElement('div');
    document.body.appendChild(foldContainer);
    root = createRoot(foldContainer);
    await act(async () => {
      root!.render(createElement(ContextTracker, {
        turns: foldTurns,
        sessionModel: null,
        agentContextLimits: { 'root:ses-ma': 128000, 'root:ses-mb': 128000 },
      }));
    });
    await act(async () => { await new Promise(r => setTimeout(r, 20)) });

    // 聚焦默认：root 曲线 2 条 + 6 个子代理在场点，无折叠提示
    expect(foldContainer.querySelectorAll('path[fill="none"]')).toHaveLength(2);
    expect(foldContainer.querySelectorAll('svg[data-chart="growth"] circle')).toHaveLength(6);
    expect(text(foldContainer)).not.toContain('已折叠');
    const researchChip = Array.from(foldContainer.querySelectorAll('[data-legend]'))
      .find(c => c.getAttribute('data-legend') === 'research');
    expect(researchChip).toBeTruthy();
    expect((researchChip!.querySelector('input') as HTMLInputElement).checked).toBe(true);

    // 「全部」= 显式回全显：13 个在场点齐
    const quickAll = Array.from(foldContainer.querySelectorAll('[data-quick-filter] button'))
      .find(b => b.textContent === '全部') as HTMLButtonElement;
    await act(async () => { quickAll.click() });
    expect(foldContainer.querySelectorAll('svg[data-chart="growth"] circle')).toHaveLength(13);

    // 点 research 条目 → 整组收起（只剩 2 条 root 曲线，在场点清零）
    await act(async () => { (researchChip!.querySelector('input') as HTMLElement).click() });
    await act(async () => { await new Promise(r => setTimeout(r, 20)) });
    expect(foldContainer.querySelectorAll('path[fill="none"]')).toHaveLength(2);
    expect(foldContainer.querySelectorAll('svg[data-chart="growth"] circle')).toHaveLength(0);

    // 再点 → 整组恢复
    await act(async () => { (researchChip!.querySelector('input') as HTMLElement).click() });
    await act(async () => { await new Promise(r => setTimeout(r, 20)) });
    expect(foldContainer.querySelectorAll('svg[data-chart="growth"] circle')).toHaveLength(13);
  });

  it('/compact 逐成员独立归因：A 卡详情 -67%、B 卡详情 -17%（pre/post 不跨成员错配）', async () => {
    const container = await render();

    const eventRows = () => Array.from(document.querySelectorAll('.px-2.py-1.rounded.border'))
      .map(r => r.textContent ?? '');

    await act(async () => { detailBtnOf(container, '成员A').click() });
    await act(async () => { await new Promise(r => setTimeout(r, 20)) });
    // A 详情事件行：自己的 -67%，无 B 的 -17%
    expect(eventRows().some(r => r.includes('↓-67%'))).toBe(true);
    expect(eventRows().some(r => r.includes('↓-17%'))).toBe(false);

    await act(async () => { detailBtnOf(container, '成员B').click() });
    await act(async () => { await new Promise(r => setTimeout(r, 20)) });
    // B 详情事件行：自己的 -17%，无 A 的 -67%（若压缩检测跨成员错配即失守）
    expect(eventRows().some(r => r.includes('↓-17%'))).toBe(true);
    expect(eventRows().some(r => r.includes('↓-67%'))).toBe(false);
  });

  it('→ Turns 跳转带 member 归因（组详情面板 = 成员会话）', async () => {
    const onNavigateToTurn = vi.fn();
    const container = await render({ onNavigateToTurn });

    await act(async () => { detailBtnOf(container, '成员A').click() });
    await act(async () => { await new Promise(r => setTimeout(r, 20)) });
    const btns = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-agent-detail] button')).filter(b => b.textContent === '→ Turns');
    expect(btns.length).toBeGreaterThanOrEqual(1);
    await act(async () => { btns[0]!.click() });
    expect(onNavigateToTurn).toHaveBeenCalled();
    const [turnId, memberTaskId] = onNavigateToTurn.mock.calls[0]!;
    expect(typeof turnId).toBe('string');
    expect(['ses-ma', 'ses-mb']).toContain(memberTaskId);
  });

  it('Agent 概览面板退役：页面无概览网格，卡片收编进组详情弹窗（数字 + → Turns 带归因）', async () => {
    const onNavigateToTurn = vi.fn();
    const container = await render({ onNavigateToTurn });

    // 面板退役：页面再无概览表/卡网格（数字全归弹窗，页面只留曲线形状）
    expect(container.querySelector('[data-agent-table]')).toBeNull();
    expect(container.querySelector('[data-agent-row]')).toBeNull();

    // 卡片收编进弹窗：成员B 胶囊 chevron → 弹窗内概览卡（root 徽标 +
    // 平均/缓存命中首屏数字）
    await act(async () => { detailBtnOf(container, '成员B').click() });
    await act(async () => { await new Promise(r => setTimeout(r, 20)) });
    const dialog = document.querySelector('[data-agent-detail]') as HTMLElement | null;
    expect(dialog).toBeTruthy();
    const card = dialog!.querySelector('[data-agent-row]') as HTMLElement | null;
    expect(card).toBeTruthy();
    expect(card!.textContent).toContain('成员B');
    expect(card!.textContent).toContain('root');
    expect(card!.textContent).toContain('平均');
    expect(card!.textContent).toContain('缓存命中');

    // 常亮语义随面板平移：关成员B 胶囊（图中隐藏）→ 弹窗内卡片不变灰
    //（弹窗数据不随图中显隐变化，显隐语义只在图与胶囊表达）
    const chipB = container.querySelector('[data-legend="成员B"]') as HTMLElement;
    await act(async () => { (chipB.querySelector('input') as HTMLElement).click() });
    await act(async () => { await new Promise(r => setTimeout(r, 20)) });
    const cardAgain = document.querySelector('[data-agent-detail] [data-agent-row]') as HTMLElement | null;
    expect(cardAgain).toBeTruthy();
    expect(cardAgain!.className).not.toContain('opacity-45');
    expect(cardAgain!.textContent).toContain('成员B');

    // 卡内 → Turns 带 member 归因（成员B 组 = ses-mb，stopPropagation 不触发弹窗行为）
    const turnBtn = cardAgain!.querySelector('button') as HTMLElement | null;
    expect(turnBtn).toBeTruthy();
    await act(async () => { turnBtn!.click() });
    expect(onNavigateToTurn).toHaveBeenCalled();
    expect(onNavigateToTurn.mock.calls[0]![1]).toBe('ses-mb');
  });

  it('回放步进轴 = 合并时间序全局排名（turnIndex 撞步不混帧）', async () => {
    const container = await render();

    const replayBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('回放'));
    expect(replayBtn).toBeTruthy();
    await act(async () => { (replayBtn as HTMLElement).click() });
    await act(async () => { await new Promise(r => setTimeout(r, 50)) });

    // 11 轮成员归因 → 全局排名 0..10；若误用各成员本地 turnIndex（最大 5），
    // 或同 index 撞帧混轮，该断言即失守
    const bodyText = text();
    expect(bodyText).toContain('Turn 0/10');
  });

  it('千轮级曲线经 LTTB 降采样渲染：SVG 段数收敛到像素级（锯齿消除）', async () => {
    // 2000 轮振荡序列（逐轮 token 振荡是「吱吱扭扭」的来源）
    const denseTurns: TurnRowItem[] = Array.from({ length: 2000 }, (_, i) => turn({
      turnId: `d-${i}`, turnIndex: i, createdAt: new Date(Date.UTC(2026, 9, 20, 0, 0, 0) + i * 30_000).toISOString(),
      totalTokens: 30000 + (i % 40) * 500, inputTokens: 20000, inputMessagesTokens: 25000 + (i % 40) * 400,
      contextWindowPct: 20,
    }));
    const denseContainer = document.createElement('div');
    document.body.appendChild(denseContainer);
    root = createRoot(denseContainer);
    await act(async () => {
      root!.render(createElement(ContextTracker, { turns: denseTurns, sessionModel: 'glm-4.7' }));
    });
    await act(async () => { await new Promise(r => setTimeout(r, 20)) });

    const path = denseContainer.querySelector('svg[data-chart="growth"] path[fill="none"]') as SVGPathElement | null;
    expect(path).toBeTruthy();
    const d = path!.getAttribute('d') ?? '';
    // 2000 轮 → ~550 渲染点（1 点/2px）：段数远小于轮数，降采样确实介入
    const segCount = (d.match(/C /g) ?? []).length;
    expect(segCount).toBeLessThanOrEqual(560);
    expect(segCount).toBeGreaterThan(100);
  });

  it('时间窗缩放（Perf 同款）：图框恒定 + Ctrl+滚轮光标锚定缩放 + 拖拽平移窗口 + 适配复位', async () => {
    const container = await render();

    const vp = container.querySelector('[data-viewport="growth"]') as HTMLElement | null;
    const svg = container.querySelector('svg[data-chart="growth"]') as SVGSVGElement | null;
    const zoomLabel = () => (container.querySelector('[data-zoom-label]') as HTMLElement | null)?.textContent ?? '';
    // x 轴刻度标签（y = baselineY + 16）：时间窗起点/跨度的可观测投影
    const tickTexts = () => Array.from(svg!.querySelectorAll('text'))
      .filter(t => t.getAttribute('y') === '436')
      .map(t => t.textContent)
      .join('|');
    expect(vp).toBeTruthy();
    expect(svg).toBeTruthy();
    // 相机退役：无 transform 载体——缩放不再整图放缩，只作用于时间轴
    expect(container.querySelector('[data-camera="growth"]')).toBeNull();
    // viewport 恒定（overflow-hidden 零滚动条），svg 图框恒定（happy-dom 无
    // 布局 → 缺省世界 1200×460）
    expect(vp!.className).toContain('run-viewport');
    expect(vp!.className).toContain('overflow-hidden');
    expect(svg!.getAttribute('width')).toBe('1200');
    expect(zoomLabel()).toBe('100%');
    const fullTicks = tickTexts();
    expect(fullTicks).toBeTruthy();

    // Ctrl + 滚轮上（deltaY<0 放大）：事件被取消（preventDefault 生效，不被
    // 浏览器页面缩放劫持）+ 时间窗收窄（倍率 112%）+ 图框不动（width 仍
    // 1200——与相机模型的整图 scale 是本质区别）
    //（happy-dom 的 WheelEvent init 不透传 ctrlKey/clientX，defineProperty 直塞）
    let canceled = true;
    await act(async () => {
      const evt = new WheelEvent('wheel', { cancelable: true, deltaY: -100 });
      Object.defineProperty(evt, 'ctrlKey', { value: true });
      Object.defineProperty(evt, 'clientX', { value: 600 });
      Object.defineProperty(evt, 'clientY', { value: 200 });
      canceled = vp!.dispatchEvent(evt);
    });
    expect(canceled).toBe(false);
    expect(zoomLabel()).toBe('112%');
    expect(svg!.getAttribute('width')).toBe('1200');
    // 窗口收窄 → 刻度变细（fixture 全程 80s < 10min，秒级格式始终在场；
    // 窗口起点推进是平移的回归锚点）
    expect(tickTexts()).not.toBe(fullTicks);

    // 普通滚轮：不缩放、不吞事件（画布内是拖拽手势域，不是滚动）
    let plainCanceled = false;
    await act(async () => {
      const evt = new WheelEvent('wheel', { deltaY: 120, cancelable: true });
      plainCanceled = !vp!.dispatchEvent(evt);
    });
    expect(plainCanceled).toBe(false);
    expect(zoomLabel()).toBe('112%');
    const zoomedTicks = tickTexts();

    // 拖拽平移：窗口整体平移（倍率/窗宽不变），窗口起点推进 → 刻度推进
    await act(async () => {
      vp!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 400, clientY: 200, button: 0 }));
    });
    await act(async () => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 450, clientY: 220 }));
    });
    await act(async () => {
      window.dispatchEvent(new MouseEvent('pointerup', {}));
    });
    expect(zoomLabel()).toBe('112%');
    expect(tickTexts()).not.toBe(zoomedTicks);
    expect(svg!.getAttribute('width')).toBe('1200');

    // 适配全程：窗口复位（倍率 100%），刻度回到全程视图
    await act(async () => {
      (container.querySelector('[data-zoom-fit]') as HTMLElement).click();
    });
    expect(zoomLabel()).toBe('100%');
    expect(tickTexts()).toBe(fullTicks);
  });

  it('悬浮弹窗为 HTML 层：点右侧放置、右缘自动翻左；原地点按命中点跳转该轮', async () => {
    // 3 轮单 root：t1 落 (610, ~198)、t2 落右缘 (1160, ~135)——恒等相机下坐标
    // 可解析推得（yMax=60K、时间轴 0..120s 均分）
    const hoverTurns: TurnRowItem[] = [
      turn({ turnId: 'h-0', turnIndex: 0, createdAt: '2026-10-13T03:00:00Z', totalTokens: 22000, inputTokens: 20000, inputMessagesTokens: 20000 }),
      turn({ turnId: 'h-1', turnIndex: 1, createdAt: '2026-10-13T03:01:00Z', totalTokens: 38000, inputTokens: 35000, inputMessagesTokens: 35000 }),
      turn({ turnId: 'h-2', turnIndex: 2, createdAt: '2026-10-13T03:02:00Z', totalTokens: 48000, inputTokens: 45000, inputMessagesTokens: 45000 }),
    ];
    const onNav = vi.fn();
    const hoverContainer = document.createElement('div');
    document.body.appendChild(hoverContainer);
    root = createRoot(hoverContainer);
    await act(async () => {
      root!.render(createElement(ContextTracker, {
        turns: hoverTurns,
        sessionModel: 'glm-4.7',
        onNavigateToTurn: onNav,
      }));
    });
    await act(async () => { await new Promise(r => setTimeout(r, 20)) });

    // 悬浮走视口鼠标事件：client → 相机逆变换（恒等相机 + 零布局 rect →
    // client 坐标即 svg 用户坐标，无需 CTM）
    const vp = hoverContainer.querySelector('[data-viewport="growth"]') as HTMLElement | null;
    expect(vp).toBeTruthy();
    const tip = () => hoverContainer.querySelector('[data-tooltip="growth"]') as HTMLElement | null;
    const leftOf = () => parseFloat((tip()?.style.left ?? '0'));

    // 悬浮中段点 t1 (610, 198)：弹窗出现在点右侧（不遮点与曲线）
    await act(async () => { vp!.dispatchEvent(new MouseEvent('mousemove', { clientX: 610, clientY: 198, bubbles: true })) });
    expect(tip()).toBeTruthy();
    expect(tip()!.textContent).toContain('build');
    expect(tip()!.textContent).toContain('Cache');
    expect(leftOf()).toBeGreaterThan(610);

    // 悬浮右缘点 t2 (1160, 135)：弹窗翻到点左侧（不溢出、不遮点）
    await act(async () => { vp!.dispatchEvent(new MouseEvent('mousemove', { clientX: 1160, clientY: 135, bubbles: true })) });
    expect(tip()).toBeTruthy();
    expect(leftOf()).toBeLessThan(1160);
    expect(leftOf()).toBeGreaterThanOrEqual(0);

    // 原地点按命中点 → 跳转该轮（无位移 = 点按，与拖拽平移互斥）
    await act(async () => { vp!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 1160, clientY: 135, button: 0 })) });
    await act(async () => { window.dispatchEvent(new MouseEvent('pointerup', {})) });
    expect(onNav).toHaveBeenCalledWith('h-2', null);

    // 移到空白区（远离一切数据点）：弹窗消失
    await act(async () => { vp!.dispatchEvent(new MouseEvent('mousemove', { clientX: 5, clientY: 5, bubbles: true })) });
    expect(tip()).toBeNull();
  });

  it('单会话旧口径回归：member 缺省 → 单 root（卡名回落 agentName），回放轴仍 turnIndex', async () => {
    fetchUrls.length = 0;
    const legacyTurns: TurnRowItem[] = [
      turn({ turnId: 'l-0', turnIndex: 0, createdAt: '2026-10-13T03:00:00Z', totalTokens: 10000, inputTokens: 9000, inputMessagesTokens: 9000 }),
      turn({ turnId: 'l-1', turnIndex: 5, createdAt: '2026-10-13T03:01:00Z', totalTokens: 20000, inputTokens: 18000, inputMessagesTokens: 18000 }),
      turn({ turnId: 'l-2', turnIndex: 9, createdAt: '2026-10-13T03:02:00Z', totalTokens: 30000, inputTokens: 26000, inputMessagesTokens: 26000 }),
    ];
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(createElement(ContextTracker, { turns: legacyTurns, sessionModel: 'glm-4.7' }));
    });
    await act(async () => { await new Promise(r => setTimeout(r, 20)) });

    const t = text(container);
    // 单 root：agentName 命名（export viewer 同款路径）
    expect(t).toContain('build');
    expect(t).not.toContain('成员A');
    // 组详情（单实例组直开）：主agent 徽标在渐进披露层
    await act(async () => { detailBtnOf(container, 'build').click() });
    await act(async () => { await new Promise(r => setTimeout(r, 20)) });
    expect(text()).toContain('主agent');
    // member 缺省 → agentContextLimits 未给 → 回落 config fetch（session 模型）
    expect(fetchUrls.some(u => u.includes('/api/config/context-windows'))).toBe(true);

    const replayBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('回放'));
    await act(async () => { (replayBtn as HTMLElement).click() });
    await act(async () => { await new Promise(r => setTimeout(r, 50)) });
    // 无 member 归因 → 步进轴 = turnIndex 旧口径（最大 9，而非轮数-1=2）
    expect(text()).toContain('Turn 0/9');
  });

  it('命名单一源（run-actor）：类型别名归一同步到图例、无类型回落派发步骤带徽标、卡片全名不截断', async () => {
    const M = { taskId: 'n-ma', label: '成员X' };
    const namingTurns: TurnRowItem[] = [
      turn({ turnId: 'n-a0', turnIndex: 0, member: M, createdAt: '2026-10-13T03:00:00Z', totalTokens: 20000, inputTokens: 15000, inputMessagesTokens: 16000, contextWindowPct: 12 }),
      turn({ turnId: 'n-s1', turnIndex: 1, member: M, isSubagent: true, agentName: '派发-架构', subagentSessionId: 'n-sub-1', subagentType: 'acme-kernel-architect', createdAt: '2026-10-13T03:00:10Z', totalTokens: 5000, inputMessagesTokens: 4000, contextWindowPct: 6 }),
      turn({ turnId: 'n-s2', turnIndex: 2, member: M, isSubagent: true, agentName: '派发-架构', subagentSessionId: 'n-sub-2', subagentType: 'acme-kernel-architect', createdAt: '2026-10-13T03:00:20Z', totalTokens: 4000, inputMessagesTokens: 3000, contextWindowPct: 5 }),
      turn({ turnId: 'n-s3', turnIndex: 3, member: M, isSubagent: true, agentName: 'Task29 第三次修复精度', subagentSessionId: 'n-sub-3', createdAt: '2026-10-13T03:00:30Z', totalTokens: 3000, inputMessagesTokens: 2000, contextWindowPct: 3 }),
    ];
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(createElement(ContextTracker, {
        turns: namingTurns,
        sessionModel: null,
        agentContextLimits: { 'root:n-ma': 128000, 'n-sub-1': 64000, 'n-sub-2': 64000, 'n-sub-3': 64000 },
      }));
    });
    await act(async () => { await new Promise(r => setTimeout(r, 20)) });

    // 页面无概览网格（面板退役）：命名经图例胶囊（组级）与组详情弹窗（实例级）验证
    expect(container.querySelectorAll('[data-agent-row]')).toHaveLength(0);

    // 图例胶囊组级命名：别名归一同步生效（此前胶囊不套别名）
    expect(container.querySelector('[data-legend="acme-arch"]')).toBeTruthy();
    expect(container.querySelector('[data-legend="成员X"]')).toBeTruthy();

    // 实例级命名收进弹窗：acme-arch 组（2 实例）→ 实例清单行带 #1/#2 编号
    await act(async () => { detailBtnOf(container, 'acme-arch').click() });
    await act(async () => { await new Promise(r => setTimeout(r, 20)) });
    let dialog = document.querySelector('[data-agent-detail]') as HTMLElement | null;
    expect(dialog).toBeTruthy();
    const instRows = Array.from(dialog!.querySelectorAll('[data-agent-instances] button')) as HTMLElement[];
    expect(instRows).toHaveLength(2);
    expect(instRows[0]!.textContent).toContain('acme-arch #1');
    expect(instRows[1]!.textContent).toContain('acme-arch #2');

    // 无类型子代理回落派发步骤全名 + 「派发」徽标只在无类型回落卡上（命名出处
    // 显式，不与类型名裸混）；全名单行展示：nowrap 不截断不换行
    await act(async () => { detailBtnOf(container, 'Task29 第三次修复精度').click() });
    await act(async () => { await new Promise(r => setTimeout(r, 20)) });
    dialog = document.querySelector('[data-agent-detail]') as HTMLElement | null;
    const stepCard = dialog!.querySelector('[data-agent-row]') as HTMLElement | null;
    expect(stepCard).toBeTruthy();
    expect(stepCard!.textContent).toContain('Task29 第三次修复精度');
    expect(stepCard!.textContent).toContain('派发');
    expect(dialog!.textContent!.match(/派发/g)?.length).toBe(1);
    const nameSpan = stepCard!.querySelector('span.whitespace-nowrap');
    expect(nameSpan).toBeTruthy();
    expect(nameSpan!.className).not.toContain('truncate');
    expect(nameSpan!.className).not.toContain('break-words');
  });

  it('图内点选聚焦：原地点击曲线选中（其余变灰、选中加亮），再点同线或点空白取消', async () => {
    // 两条水平线（世界 1200×460、恒等相机、yMax=40K）：
    // 成员M 恒 30K → y=135（x: 60/500/940）；research 恒 10K → y=325（x: 280/720/1160）
    const M = { taskId: 'p-ma', label: '成员M' };
    const flat = (turnId: string, turnIndex: number, createdAt: string) =>
      turn({ turnId, turnIndex, member: M, createdAt, totalTokens: 30000, inputTokens: 20000, inputMessagesTokens: 30000, contextWindowPct: 23 });
    const flatSub = (turnId: string, turnIndex: number, createdAt: string) =>
      turn({ turnId, turnIndex, member: M, isSubagent: true, agentName: 'research', subagentSessionId: 'p-sub-1', subagentType: 'research', createdAt, totalTokens: 10000, inputMessagesTokens: 10000, contextWindowPct: 8 });
    const selectTurns: TurnRowItem[] = [
      flat('p-a0', 0, '2026-10-13T04:00:00Z'),
      flatSub('p-s0', 3, '2026-10-13T04:00:30Z'),
      flat('p-a1', 1, '2026-10-13T04:01:00Z'),
      flatSub('p-s1', 4, '2026-10-13T04:01:30Z'),
      flat('p-a2', 2, '2026-10-13T04:02:00Z'),
      flatSub('p-s2', 5, '2026-10-13T04:02:30Z'),
    ];
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(createElement(ContextTracker, {
        turns: selectTurns,
        sessionModel: null,
        agentContextLimits: { 'root:p-ma': 128000, 'p-sub-1': 64000 },
      }));
    });
    await act(async () => { await new Promise(r => setTimeout(r, 20)) });

    const vp = container.querySelector('[data-viewport="growth"]') as HTMLElement | null;
    expect(vp).toBeTruthy();
    // 线路径序 = stats 序（root 在前）：[0]=成员M、[1]=research
    const paths = () => Array.from(container.querySelectorAll('svg[data-chart="growth"] path[fill="none"]')) as SVGPathElement[];
    expect(paths()).toHaveLength(2);
    const rootG = () => paths()[0]!.parentElement as unknown as SVGGElement;
    const click = async (x: number, y: number) => {
      await act(async () => { vp!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, button: 0 })) });
      await act(async () => { window.dispatchEvent(new MouseEvent('pointerup', { clientX: x, clientY: y })) });
      await act(async () => { await new Promise(r => setTimeout(r, 20)) });
    };

    // 点 research 线中段（x=500 落在其 280..720 点间、y=325；距任何数据点 >50）
    await click(500, 325);
    expect(paths()[1]!.getAttribute('stroke-width')).toBe('2.75');
    expect(rootG().getAttribute('opacity')).toBe('0.12');
    // 图选只在图内表达：胶囊行不随选中亮起（常亮，无 shadow-sm 高亮态）
    const chips = Array.from(container.querySelectorAll('[data-legend]')) as HTMLElement[];
    expect(chips.length).toBeGreaterThan(0);
    expect(chips.every(c => !c.closest('span')!.className.includes('shadow-sm'))).toBe(true);
    // 再点同线 → 取消（互斥开关）
    await click(500, 325);
    expect(paths()[1]!.getAttribute('stroke-width')).toBe('1.25');
    expect(rootG().getAttribute('opacity')).toBe('1');
    // 选中后点空白（y=415 远离两线）→ 清除
    await click(500, 325);
    expect(rootG().getAttribute('opacity')).toBe('0.12');
    await click(500, 415);
    expect(paths()[1]!.getAttribute('stroke-width')).toBe('1.25');
    expect(rootG().getAttribute('opacity')).toBe('1');
  });
});
