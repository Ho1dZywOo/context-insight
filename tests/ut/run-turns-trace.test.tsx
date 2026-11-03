// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// Run 详情 Turns tab IT（design: run 级 Turns 变革——Run Player 架构；Trace
// 退役——搜索归 Turns）：URL 感知 fetch mock 驱动页面级验证——①?tab=turns
// 深链（Run 轨节点段 + 代带分组 + 首个内容节点自动展开懒加载 + 选中复用
// TurnDetail）；②节点懒加载（未展开节点的成员不取数，member 过滤是列表
// 唯一取形）；③跨成员搜索驻留（命中索引替换左列、点命中开 player 不消失、
// 已读降透明、退出回节点列表并居中揭示）；④?tab=trace 深链别名落 Turns；
// ⑤一框两语法（#数字直达当前会话轮次 / 未命中提示）。

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Suspense } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { parseAndIndex } from '@/lib/run/reader';
import { buildViewModel } from '@/lib/run/view-model';
import { attachSessionRefs } from '@/lib/run/session-link';
import type { RunImportMeta } from '@/lib/run/run-store';
import RunDetailPage from '@/app/run/[runId]/page';

const nav = vi.hoisted(() => ({ back: vi.fn(), replace: vi.fn() }));
const searchState = vi.hoisted(() => ({ current: '' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: nav.replace, back: nav.back, refresh: () => {} }),
  usePathname: () => '/run/minidemo01',
  useSearchParams: () => new URLSearchParams(searchState.current),
}));

const fixture = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, './data/run/mini-bundle/workflow.json'), 'utf-8'),
) as unknown;
const index = parseAndIndex(fixture);
const viewModel = buildViewModel(index);
attachSessionRefs(viewModel, new Map([
  ['ses_mini_a', {
    taskId: 'ses_mini_a', framework: 'opencode', rowId: 'row_a', turns: 1,
    totalTokens: 100, durationMs: 60000, label: '成员A',
    startTime: '2026-10-13T02:00:12.000Z', endTime: '2026-10-13T02:01:12.000Z',
    cacheReadTokens: 0, contextPeakPct: 72.5, model: 'volc-gateway/glm-4.7',
    totalCost: 0.2, version: null, totalLatencyMs: 60000,
  }],
  ['ses_mini_b', {
    taskId: 'ses_mini_b', framework: 'opencode', rowId: 'row_b', turns: 1,
    totalTokens: 200, durationMs: 30000, label: '成员B',
    startTime: '2026-10-13T02:02:00.000Z', endTime: '2026-10-13T02:02:30.000Z',
    cacheReadTokens: 0, contextPeakPct: 40, model: 'volc-gateway/glm-4.7',
    totalCost: 0.1, version: null, totalLatencyMs: 30000,
  }],
]));
const importMeta: RunImportMeta['data'] = {
  importedAt: '2026-10-15T10:00:00+08:00',
  sourceDir: '/bundle/mini',
  manifestFile: 'workflow.json',
  exportDataComplete: true,
  sessions: { total: 3, imported: 3, existing: 0, missingFile: 0, failed: 0 },
  failures: [],
  warnings: [],
};

const turnA = {
  turnId: 'rop-t-a0', turnIndex: 0, role: 'user', contentSummary: '成员A的开始任务',
  agentName: null, isSubagent: false, subagentName: null, subagentSessionId: null,
  parentExecutionId: null, totalTokens: 60, inputTokens: 60, outputTokens: 0,
  reasoningTokens: 0, latencyMs: 800, createdAt: '2026-10-13T02:00:10.000Z',
  completedAt: null, model: 'glm-4.7', toolCalls: [], skillEvents: [],
  member: { taskId: 'ses_mini_a', label: '成员A' },
};
const turnB = {
  turnId: 'rop-t-b0', turnIndex: 0, role: 'assistant', contentSummary: '成员B的回应',
  agentName: 'build', isSubagent: false, subagentName: null, subagentSessionId: null,
  parentExecutionId: null, totalTokens: 200, inputTokens: 120, outputTokens: 80,
  reasoningTokens: 10, latencyMs: 1500, createdAt: '2026-10-13T02:02:10.000Z',
  completedAt: null, model: 'glm-4.7', toolCalls: [], skillEvents: [],
  member: { taskId: 'ses_mini_b', label: '成员B' },
};
// 成员B 第二页轮次（total=2 的第二行）：锁「加载更多」分页续拉
const turnB2 = {
  ...turnB,
  turnId: 'rop-t-b1', turnIndex: 1, contentSummary: '成员B的第二轮',
};
const turnDetailBase = {
  turnIndex: 0, role: 'user', content: null, contentJson: null,
  inputMessagesJson: '[{"role":"user","content":"历史消息"},{"role":"user","content":"新进问题"}]',
  inputMessagesCount: 2, inputMessagesTokens: 120,
  contextWindowPct: null, agentName: null, subagentName: null, isSubagent: false,
  totalTokens: 60, inputTokens: 60, outputTokens: 0, reasoningTokens: 0,
  cacheReadTokens: 0, cacheWriteTokens: 0, latencyMs: 800, ttftMs: null,
  createdAt: '2026-10-13T02:00:10.000Z', completedAt: null, model: 'glm-4.7',
  modelId: null, providerId: null, finishReason: null,
  toolCalls: [], skillEvents: [],
};

const fetchCalls: string[] = [];
// 详情延迟解析开关：验证点击轮次后的加载骨架（取数期间 → 详情落地）
const slowDetail = { current: false, resolve: null as null | ((v: unknown) => void) };
// 补拉段失败开关：验证自动拉齐中断后的「加载更多」手动重试
const restFail = { current: false };

vi.stubGlobal('fetch', vi.fn(async (url: string) => {
  fetchCalls.push(url);
  const u = new URL(url, 'http://localhost');
  const p = u.searchParams;
  const json = (body: unknown) => ({ ok: true, json: async () => body });
  if (u.pathname === '/api/observe/run/minidemo01') {
    return json({
      run: {
        runId: 'minidemo01', name: index.manifest.name ?? null, status: viewModel.status,
        exportDataComplete: true, startedAt: null, finishedAt: null, import: importMeta,
      },
      viewModel,
    });
  }
  if (u.pathname === '/api/observe/run/minidemo01/turns') {
    const member = p.get('member');
    // 成员B 分两段（total=2）：首页 1 轮 + offset 补拉 1 轮，供「自动拉齐/
    //  中断重试」用例；首轮仍是 rop-t-b0。restFail 打开时补拉段失败
    if (member === 'ses_mini_b') {
      const offset = Number(p.get('offset') ?? -1);
      if (offset >= 1) {
        if (restFail.current) return { ok: false, json: async () => ({}) };
        return json({ items: [turnB2], total: 2, page: 1, pageSize: Number(p.get('pageSize') ?? 200), offset });
      }
      return json({ items: [turnB], total: 2, page: 1, pageSize: Number(p.get('pageSize') ?? 200), offset: null });
    }
    const items = member === 'ses_mini_a' ? [turnA] : [turnA, turnB];
    return json({ items, total: items.length, page: Number(p.get('page') ?? 1), pageSize: Number(p.get('pageSize') ?? 200), offset: null });
  }
  if (u.pathname === '/api/observe/run/minidemo01/bridges') {
    return json({ items: [], total: 0 });
  }
  if (u.pathname === '/api/observe/run/minidemo01/turns/search') {
    // 跨成员命中（时间升序：a0 起源在前）——limit/total 护栏由端点契约保证，
    // 这里给足两成员命中 + 过滤面数据（来源/工具/thinking）供驻留面板用例
    return json({ items: [
      { turnId: 'rop-t-a0', turnIndex: 0, role: 'user', agentName: null, isSubagent: false,
        subagentName: null, subagentSessionId: null, contentSummary: '成员A的开始任务', matchContext: '成员A的开始任务',
        matchField: 'content', createdAt: '2026-10-13T02:00:10.000Z', hasDispatchBridge: false,
        reasoningTokens: 0, toolNames: [],
        member: { taskId: 'ses_mini_a', label: '成员A' } },
      { turnId: 'rop-t-b0', turnIndex: 0, role: 'assistant', agentName: 'build', isSubagent: false,
        subagentName: null, subagentSessionId: null, contentSummary: '成员B的回应', matchContext: '成员B的回应',
        matchField: 'content', createdAt: '2026-10-13T02:02:10.000Z', hasDispatchBridge: false,
        reasoningTokens: 80, toolNames: ['read', 'bash'],
        member: { taskId: 'ses_mini_b', label: '成员B' } },
    ], total: 2 });
  }
  if (u.pathname === '/api/observe/turn/rop-t-a0' || u.pathname === '/api/observe/turn/rop-t-b0' || u.pathname === '/api/observe/turn/rop-t-b1') {
    if (slowDetail.current) {
      return { ok: true, json: () => new Promise(res => { slowDetail.resolve = res }) };
    }
    if (u.pathname.endsWith('rop-t-b1')) {
      return json({ ...turnDetailBase, turnId: 'rop-t-b1', taskId: 'ses_mini_b', contentSummary: '成员B的第二轮', content: '成员B的第二轮', role: 'assistant' });
    }
    return json(u.pathname.endsWith('rop-t-b0')
      ? { ...turnDetailBase, turnId: 'rop-t-b0', taskId: 'ses_mini_b', contentSummary: '成员B的回应', content: '成员B的回应', role: 'assistant' }
      : { ...turnDetailBase, turnId: 'rop-t-a0', taskId: 'ses_mini_a', contentSummary: '成员A的开始任务', content: '成员A的开始任务' });
  }
  return json({ items: [], total: 0 });
}));

let root: Root | null = null;

async function renderPage(initialSearch = '') {
  searchState.current = initialSearch;
  nav.replace.mockClear();
  fetchCalls.length = 0;
  slowDetail.current = false;
  slowDetail.resolve = null;
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      createElement(
        Suspense,
        { fallback: null },
        createElement(RunDetailPage, { params: Promise.resolve({ runId: 'minidemo01' }) }),
      ),
    );
  });
  await act(async () => { await new Promise(r => setTimeout(r, 20)) });
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  restFail.current = false;
});

describe('Run 详情 Turns/Trace tab（Run Player 架构）', () => {
  it('?tab=turns 深链：Run 轨 + 代带节点 + 首个内容节点自动展开（成员懒加载）+ 选中复用 TurnDetail', async () => {
    await renderPage('?tab=turns');

    const turnsTab = document.querySelector('[data-run-tab="turns"]');
    expect(turnsTab).toBeTruthy();
    const text = turnsTab!.textContent ?? '';
    // 主图节点（列表节点头可见）：init/build/publish/gen-sub
    expect(text).toContain('init');
    expect(text).toContain('build');
    expect(text).toContain('gen-sub');
    // Run 轨（节点状态时间线）：全节点以状态段单行呈现（等宽按钮排在
    // 60 节点级 run 上会挤叠），代际发丝分隔在段间
    const railTrack = turnsTab!.querySelector('[data-rail-track]');
    expect(railTrack).toBeTruthy();
    expect(railTrack!.querySelectorAll('button').length).toBe(6);
    // 主图按代排序（g0 组 → g1 组）——代际分界处一枚发丝刻线
    expect(railTrack!.querySelectorAll('.w-px').length).toBe(1);
    // 代带分组头（第 1 次运行 / 回滚 #1）
    expect(text).toContain('第 1 次运行');
    expect(text).toContain('回滚 #1');
    // 首个内容节点（build g0：执行 成员A + 验收 成员B）自动展开
    expect(text).toContain('执行');
    expect(text).toContain('验收');
    expect(text).toContain('成员A的开始任务');
    expect(text).toContain('成员B的回应');

    // 选中成员 A 的轮次 → TurnDetail（全局 turnId 端点直取）
    const turnRow = [...turnsTab!.querySelectorAll('button')].find(b => b.textContent?.includes('成员A的开始任务'));
    expect(turnRow).toBeTruthy();
    await act(async () => {
      turnRow!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(fetchCalls).toContain('/api/observe/turn/rop-t-a0');
    await act(async () => { await new Promise(r => setTimeout(r, 20)) });
    // 选中态：占位文案消失（TurnDetail 播放器接管右侧）
    expect(turnsTab!.textContent).not.toContain('选择一轮开始走查');
    // Run 轨活动锚定：选中轮所属节点（build g0，承载成员A/B）标识簇常驻——
    // 状态点 + 节点名 + 位置计数（主图序列第 4 / 共 6 段）
    const railActive = turnsTab!.querySelector('[data-rail-active]');
    expect(railActive?.textContent).toContain('build');
    expect(railActive?.textContent).toMatch(/4\/6/);
    // 播放器壳契约：导航条标题 + 身份药丸 + 指标瓦片标签 + 分组卡语法（灰画布上的无边框圆角卡）
    const playerText = turnsTab!.textContent ?? '';
    expect(playerText).toContain('Turn #0');
    expect(playerText).toContain('单轮耗时');
    expect(playerText).toContain('Token');
    expect(playerText).toContain('上下文窗口');
    expect(playerText).toContain('user');
    expect(turnsTab!.querySelectorAll('.rounded-2xl').length).toBeGreaterThanOrEqual(4);
  });

  it('节点懒加载：member 过滤是列表唯一取形，未展开节点的成员不取数', async () => {
    await renderPage('?tab=turns');

    await act(async () => { await new Promise(r => setTimeout(r, 20)) });
    // 已展开节点（build g0）的两个成员会话按 member 取数
    expect(fetchCalls.some(u => u.includes('member=ses_mini_a'))).toBe(true);
    expect(fetchCalls.some(u => u.includes('member=ses_mini_b'))).toBe(true);
    // 未展开节点不取数：build g1（未导入会话）、bash 节点（无会话轮次）——
    // 且不存在无 member 的整包合并轮次请求（旧融合时间线取形已退役）
    expect(fetchCalls.some(u => u.includes('/turns?') && !u.includes('member='))).toBe(false);
    expect(fetchCalls.some(u => u.includes('ses_mini_c'))).toBe(false);

    // 展开未运行节点（publish g0）：占位而不取数
    const publishHeader = [...document.querySelectorAll('[data-run-tab="turns"] button')].find(b => b.textContent?.includes('publish'));
    expect(publishHeader).toBeTruthy();
    await act(async () => {
      publishHeader!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await act(async () => { await new Promise(r => setTimeout(r, 20)) });
    expect(document.querySelector('[data-run-tab="turns"]')!.textContent).toContain('本代未运行');
    expect(fetchCalls.some(u => u.includes('/turns?') && !u.includes('member='))).toBe(false);
  });

  it('详情加载节奏：首选立即骨架 → 换轮 180ms 内保留旧内容不闪 → 慢加载让位骨架 → 落地卡片阶梯入场', async () => {
    await renderPage('?tab=turns');
    const turnsTab = document.querySelector('[data-run-tab="turns"]')!;

    // 首选（无旧内容）：骨架立即出场（sr-only 状态 + pulse 占位 + 骨架卡入场）
    slowDetail.current = true;
    const turnRowA = [...turnsTab.querySelectorAll('button')].find(b => b.textContent?.includes('成员A的开始任务'))!;
    await act(async () => {
      turnRowA.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(turnsTab.querySelector('[role="status"]')?.textContent).toContain('载入轮次详情');
    expect(turnsTab.querySelectorAll('.animate-pulse').length).toBeGreaterThan(8);

    await act(async () => {
      slowDetail.resolve!({ ...turnDetailBase, turnId: 'rop-t-a0', taskId: 'ses_mini_a', contentSummary: '成员A的开始任务', content: '成员A的开始任务' });
      await new Promise(r => setTimeout(r, 20));
    });
    expect(document.getElementById('turn-detail-top')?.textContent).toContain('成员A的开始任务');

    // 点击换轮（有旧内容 + 端点挂起）：延迟窗口内保留旧内容，不闪骨架、容器压暗示意
    slowDetail.current = true;
    slowDetail.resolve = null;
    const turnRowB = [...turnsTab.querySelectorAll('button')].find(b => b.textContent?.includes('成员B的回应'))!;
    await act(async () => {
      turnRowB.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(turnsTab.querySelector('[role="status"]')).toBeNull();
    expect(document.getElementById('turn-detail-top')?.textContent).toContain('成员A的开始任务');
    expect(turnsTab.querySelector('.opacity-70')).toBeTruthy();

    // 超过延迟窗口（真慢加载）：旧内容让位给骨架
    await act(async () => { await new Promise(r => setTimeout(r, 240)) });
    expect(turnsTab.querySelector('[role="status"]')).toBeTruthy();
    expect(document.getElementById('turn-detail-top')).toBeNull();

    // 详情落地：播放器接管 + 内容卡阶梯入场（导航条 + 瓦片×3 + 舞台）
    await act(async () => {
      slowDetail.resolve!({ ...turnDetailBase, turnId: 'rop-t-b0', taskId: 'ses_mini_b', contentSummary: '成员B的回应', content: '成员B的回应', role: 'assistant' });
      await new Promise(r => setTimeout(r, 20));
    });
    const detailRoot = document.getElementById('turn-detail-top')!;
    expect(detailRoot.textContent).toContain('成员B的回应');
    expect(detailRoot.querySelectorAll('.animate-in').length).toBeGreaterThanOrEqual(5);
  });

  it('缓存重访零请求零动画；←/→ 走查跨已加载会话即时衔接（不入场）', async () => {
    await renderPage('?tab=turns');
    const turnsTab = document.querySelector('[data-run-tab="turns"]')!;
    const detailFetches = () => fetchCalls.filter(u => u.includes('/api/observe/turn/')).length;

    const turnRowA = [...turnsTab.querySelectorAll('button')].find(b => b.textContent?.includes('成员A的开始任务'))!;
    await act(async () => {
      turnRowA.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 20));
    });
    const turnRowB = [...turnsTab.querySelectorAll('button')].find(b => b.textContent?.includes('成员B的回应'))!;
    await act(async () => {
      turnRowB.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 20));
    });
    expect(document.getElementById('turn-detail-top')?.textContent).toContain('成员B的回应');
    const afterFirstLoads = detailFetches();

    // 缓存重访 A：零新请求、内容直切、无入场动画
    await act(async () => {
      turnRowA.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 20));
    });
    expect(detailFetches()).toBe(afterFirstLoads);
    const revisitRoot = document.getElementById('turn-detail-top')!;
    expect(revisitRoot.textContent).toContain('成员A的开始任务');
    expect(revisitRoot.querySelectorAll('.animate-in').length).toBe(0);

    // ←/→ 走查越会话边界（目标会话已加载）：即时衔接 B 首轮，零请求零入场
    const nextBtn = [...turnsTab.querySelectorAll('[role="button"]')].find(b => b.getAttribute('title') === '下一轮（→）')!;
    expect(nextBtn).toBeTruthy();
    await act(async () => {
      nextBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 20));
    });
    expect(detailFetches()).toBe(afterFirstLoads);
    const walkRoot = document.getElementById('turn-detail-top')!;
    expect(walkRoot.textContent).toContain('成员B的回应');
    expect(walkRoot.querySelectorAll('.animate-in').length).toBe(0);
  });

  it('选中即揭示：外部跳转（走查/深链/Run 轨）左列表居中定位；列表内点击不揭示', async () => {
    const revealed: Array<{ id: string; block: string | undefined }> = [];
    const origScroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element, opts?: ScrollIntoViewOptions) {
      const id = this.getAttribute('data-turn-row') ?? this.getAttribute('data-node');
      if (id) revealed.push({ id, block: opts?.block });
    };
    try {
      await renderPage('?tab=turns');
      const turnsTab = document.querySelector('[data-run-tab="turns"]')!;

      // 列表内点击：零滚动（行已在位，不强制居中）
      const turnRowA = [...turnsTab.querySelectorAll('button')].find(b => b.textContent?.includes('成员A的开始任务'))!;
      await act(async () => {
        turnRowA.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 20));
      });
      expect(revealed.filter(r => r.id === 'rop-t-a0').length).toBe(0);
      // 选中高亮落在 A 行（零滚动不影响选中语义）
      expect(document.querySelector('[data-turn-row="rop-t-a0"]')?.className).toContain('ring-primary/30');

      // ←/→ 走查越会话边界（外部跳转）：目标行居中揭示
      const nextBtn = [...turnsTab.querySelectorAll('[role="button"]')].find(b => b.getAttribute('title') === '下一轮（→）')!;
      await act(async () => {
        nextBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 20));
      });
      expect(revealed.some(r => r.id === 'rop-t-b0' && r.block === 'center')).toBe(true);
      // 高亮跨会话迁移：B 行点亮、A 行熄灭——会话块 memo 不得跳过命中的会话
      expect(document.querySelector('[data-turn-row="rop-t-b0"]')?.className).toContain('ring-primary/30');
      expect(document.querySelector('[data-turn-row="rop-t-a0"]')?.className ?? '').not.toContain('ring-primary/30');

      // 列表内重选当前轮：仍不揭示（列表点击一律零滚动）
      const cntBefore = revealed.filter(r => r.id === 'rop-t-b0').length;
      const turnRowB = [...turnsTab.querySelectorAll('button')].find(b => b.textContent?.includes('成员B的回应'))!;
      await act(async () => {
        turnRowB.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 20));
      });
      expect(revealed.filter(r => r.id === 'rop-t-b0').length).toBe(cntBefore);

      // Run 轨节点点击（publish 初始收起）：节点块居中揭示且不展开——
      // 不出现展开态的「本代未运行」占位，也不取成员分页
      const fetchesBefore = fetchCalls.length;
      const railBtn = [...turnsTab.querySelectorAll('[data-rail-track] button')].find(b => b.getAttribute('title')?.includes('publish'))!;
      await act(async () => {
        railBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 20));
      });
      const revealedNode = revealed
        .filter(r => !r.id.startsWith('rop-t-'))
        .map(r => ({ el: document.querySelector(`[data-node="${r.id}"]`), block: r.block }))
        .find(x => x.el?.textContent?.includes('publish'));
      expect(revealedNode?.block).toBe('center');
      expect(revealedNode?.el?.textContent).not.toContain('本代未运行');
      expect(fetchCalls.length).toBe(fetchesBefore);
    } finally {
      Element.prototype.scrollIntoView = origScroll;
    }
  });

  it('自动拉齐：首页落地后剩余轮次按 offset 自动补齐、计数收敛且无手动入口', async () => {
    await renderPage('?tab=turns');
    const turnsTab = document.querySelector('[data-run-tab="turns"]')!;
    // 补拉请求自动发出（offset 从已载边界续拉）并追加渲染
    expect(fetchCalls.some(u => u.includes('member=ses_mini_b') && u.includes('offset=1'))).toBe(true);
    expect(turnsTab.textContent).toContain('成员B的第二轮');
    // 计数收敛：2/2 轮，手动「加载更多」不出现（不再有第 2 页页码续拉）
    expect(turnsTab.textContent).toContain('2/2 轮');
    expect(fetchCalls.some(u => u.includes('page=2'))).toBe(false);
    expect([...turnsTab.querySelectorAll('button')].some(b => b.textContent === '加载更多')).toBe(false);
  });

  it('补拉中断兜底：「加载更多」手动重试重入链条，从已载边界续拉收敛（回调身份稳定）', async () => {
    restFail.current = true;
    await renderPage('?tab=turns');
    const turnsTab = document.querySelector('[data-run-tab="turns"]')!;
    // 补拉失败中断：计数停在 1/2，手动入口出现
    expect(turnsTab.textContent).toContain('1/2 轮');
    const loadMoreBtn = [...turnsTab.querySelectorAll('button')].find(b => b.textContent === '加载更多')!;
    expect(loadMoreBtn).toBeTruthy();
    restFail.current = false;
    await act(async () => {
      loadMoreBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 20));
    });
    // 重试收敛：全集到齐、入口消失
    expect(turnsTab.textContent).toContain('成员B的第二轮');
    expect(turnsTab.textContent).toContain('2/2 轮');
    expect([...turnsTab.querySelectorAll('button')].some(b => b.textContent === '加载更多')).toBe(false);
  });

  it('详情默认态：LLM Output 常驻展开，LLM Input 折叠一行收纳、按需展开', async () => {
    await renderPage('?tab=turns');
    const turnsTab = document.querySelector('[data-run-tab="turns"]')!;
    const turnRowA = [...turnsTab.querySelectorAll('button')].find(b => b.textContent?.includes('成员A的开始任务'))!;
    await act(async () => {
      turnRowA.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 20));
    });
    const detailRoot = document.getElementById('turn-detail-top')!;
    // 输入卡在场（头行常驻），但消息默认收纳——不出现消息正文
    expect(detailRoot.textContent).toContain('LLM Input');
    expect(detailRoot.textContent).not.toContain('新进问题');
    // 输出常驻展开（第一阅读主体）
    expect(detailRoot.textContent).toContain('成员A的开始任务');
    // 展开「本轮新增」→ 消息可见
    const newSectionRow = [...detailRoot.querySelectorAll('[role="button"]')]
      .find(el => el.textContent?.includes('本轮新增')) as HTMLElement;
    await act(async () => {
      newSectionRow.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 20));
    });
    expect(document.getElementById('turn-detail-top')?.textContent).toContain('新进问题');
  });

  it('深链选中轮：详情归属与成员分页就位后自动揭示对应行（挂起重试）', async () => {
    const revealed: Array<{ id: string; block: string | undefined }> = [];
    const origScroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element, opts?: ScrollIntoViewOptions) {
      const id = this.getAttribute('data-turn-row');
      if (id) revealed.push({ id, block: opts?.block });
    };
    try {
      await renderPage('?tab=turns&turn=rop-t-b0');
      await act(async () => { await new Promise(r => setTimeout(r, 40)) });
      expect(revealed.some(r => r.id === 'rop-t-b0' && r.block === 'center')).toBe(true);
    } finally {
      Element.prototype.scrollIntoView = origScroll;
    }
  });

  it('跨成员搜索驻留：命中索引替换左列、点命中开 player 不消失、已读降透明、✕ 退出回节点列表', async () => {
    const origScroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function () {};
    try {
      await renderPage('?tab=turns');
      const turnsTab = document.querySelector('[data-run-tab="turns"]')!;
      const input = turnsTab.querySelector('input[placeholder="搜索本 run…"]') as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      await act(async () => {
        setter.call(input, '成员');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 20));
      });
      // 服务端全域搜索（limit=50 命中护栏随行）
      expect(fetchCalls.some(u => u.includes('/turns/search') && u.includes('keyword=') && u.includes('limit=50'))).toBe(true);
      // 命中索引以玻璃浮层覆盖左列：节点列表常驻挂载（玻璃后虚化）但被
      // inert 盖住，浮层为覆盖式卡片（absolute + run-glass），首行起源标
      // 记 + 成员徽标
      const hits = turnsTab.querySelector('[data-turns-hits]')!;
      expect(hits).toBeTruthy();
      expect(hits.textContent).toContain('成员B的回应');
      expect(hits.textContent).toContain('起源');
      expect(hits.className).toContain('absolute');
      // 卡片材质与 Turn 播放器顶部导航条同一配方（bg-muted/40 + blur-xl）
      const glassCard = hits.querySelector('[class*="bg-muted/40"]') as HTMLElement | null;
      expect(glassCard?.className).toContain('backdrop-blur-xl');
      expect(turnsTab.querySelector('[data-turn-list]')?.getAttribute('inert')).not.toBe(null);
      expect(turnsTab.textContent).toContain('第 1 次运行');
      // 点命中 → player 打开（全局 turnId 端点直取）+ 命中索引不消失（驻留）
      await act(async () => {
        hits.querySelector('[data-hit="rop-t-b0"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 20));
      });
      expect(fetchCalls).toContain('/api/observe/turn/rop-t-b0');
      expect(document.getElementById('turn-detail-top')?.textContent).toContain('成员B的回应');
      expect(turnsTab.querySelector('[data-turns-hits]')).toBeTruthy();
      // 再点另一命中：前一个已读降透明（当前选中不降）
      await act(async () => {
        turnsTab.querySelector('[data-hit="rop-t-a0"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 20));
      });
      expect(document.getElementById('turn-detail-top')?.textContent).toContain('成员A的开始任务');
      expect(turnsTab.querySelector('[data-hit="rop-t-b0"]')!.className).toContain('opacity-55');
      expect(turnsTab.querySelector('[data-hit="rop-t-a0"]')!.className).not.toContain('opacity-55');
      // 过滤面（旧 Trace 筛选恢复）：按来源收窄——用户引入仅 a0 在列
      await act(async () => {
        const chip = [...turnsTab.querySelectorAll('[data-hit-filter]')].find(b => b.textContent?.includes('用户引入'))!;
        chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 20));
      });
      expect(turnsTab.querySelector('[data-turns-hits]')!.textContent).toContain('1 个命中 / 共 2');
      expect(turnsTab.querySelector('[data-hit="rop-t-b0"]')).toBeNull();
      expect(turnsTab.querySelector('[data-hit="rop-t-a0"]')).toBeTruthy();
      // 工具过滤：read 仅 b0 在列
      await act(async () => {
        const chip = [...turnsTab.querySelectorAll('[data-hit-filter]')].find(b => b.textContent === 'read 1')!;
        chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 20));
      });
      expect(turnsTab.querySelector('[data-hit="rop-t-a0"]')).toBeNull();
      expect(turnsTab.querySelector('[data-hit="rop-t-b0"]')).toBeTruthy();
      // 「全部」复位：两命中回列
      await act(async () => {
        const chip = [...turnsTab.querySelectorAll('[data-hit-filter]')].find(b => b.textContent?.startsWith('全部'))!;
        chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 20));
      });
      expect(turnsTab.querySelector('[data-hit="rop-t-a0"]')).toBeTruthy();
      expect(turnsTab.querySelector('[data-hit="rop-t-b0"]')).toBeTruthy();
      // ✕ 退出：浮层撤除（inert 解除、列表回到可交互），player 内容保留
      await act(async () => {
        turnsTab.querySelector('[data-hits-exit]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 20));
      });
      expect(turnsTab.querySelector('[data-turns-hits]')).toBeNull();
      expect(turnsTab.querySelector('[data-turn-list]')?.getAttribute('inert')).toBe(null);
      expect(turnsTab.textContent).toContain('第 1 次运行');
      expect(document.getElementById('turn-detail-top')?.textContent).toContain('成员A的开始任务');
    } finally {
      Element.prototype.scrollIntoView = origScroll;
    }
  });

  it('搜索驻留退出后：节点列表回位并居中揭示当前选中轮（挂起揭示意图保留）', async () => {
    const revealed: Array<{ id: string; block: string | undefined; flattened: boolean }> = [];
    const origScroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element, opts?: ScrollIntoViewOptions) {
      const id = this.getAttribute('data-turn-row');
      if (id) {
        const list = this.closest('[data-turn-list]');
        revealed.push({ id, block: opts?.block, flattened: list?.classList.contains('turn-list-revealing') ?? false });
      }
    };
    try {
      await renderPage('?tab=turns');
      const turnsTab = document.querySelector('[data-run-tab="turns"]')!;
      const input = turnsTab.querySelector('input[placeholder="搜索本 run…"]') as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      await act(async () => {
        setter.call(input, '成员');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 20));
      });
      await act(async () => {
        turnsTab.querySelector('[data-hit="rop-t-b0"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 20));
      });
      // 驻留期间列表被玻璃浮层覆盖（挂载但 inert）——揭示意图挂起（不滚动）
      expect(revealed.filter(r => r.id === 'rop-t-b0').length).toBe(0);
      // 退出搜索：浮层撤除、inert 解除，挂起意图落地（居中 + 占位块展平的真实几何）
      await act(async () => {
        turnsTab.querySelector('[data-hits-exit]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 20));
      });
      expect(turnsTab.querySelector('[data-turns-hits]')).toBeNull();
      expect(turnsTab.querySelector('[data-turn-list]')?.getAttribute('inert')).toBe(null);
      expect(revealed.some(r => r.id === 'rop-t-b0' && r.block === 'center' && r.flattened)).toBe(true);
    } finally {
      Element.prototype.scrollIntoView = origScroll;
    }
  });

  it('一框两语法：#数字直达当前会话轮次；未命中给提示且不触搜索端点', async () => {
    const origScroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function () {};
    try {
      await renderPage('?tab=turns');
      const turnsTab = document.querySelector('[data-run-tab="turns"]')!;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;
      // 成员B 已自动拉齐到全集（b0/b1 两轮，当前会话 = 成员B），选中 b1
      const turnB2Row = [...turnsTab.querySelectorAll('button')].find(b => b.textContent?.includes('成员B的第二轮'))!;
      expect(turnB2Row).toBeTruthy();
      await act(async () => {
        turnB2Row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 20));
      });
      const input = turnsTab.querySelector('input[placeholder="搜索本 run…"]') as HTMLInputElement;
      // 未加载的序号 → 提示（不取数、不换选）
      await act(async () => {
        setter.set!.call(input, '#9');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 20));
      });
      expect(turnsTab.querySelector('[data-search-note]')?.textContent).toContain('当前会话未找到第 9 轮');
      expect(fetchCalls.some(u => u.includes('/turns/search'))).toBe(false);
      expect(document.getElementById('turn-detail-top')?.textContent).toContain('成员B的第二轮');
      // #0 → 直达当前会话第 0 轮（成员B 的 b0，跨轮换选可见）
      await act(async () => {
        setter.set!.call(input, '#0');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 20));
      });
      expect(document.getElementById('turn-detail-top')?.textContent).toContain('成员B的回应');
      expect(turnsTab.querySelector('[data-search-note]')).toBeNull();
    } finally {
      Element.prototype.scrollIntoView = origScroll;
    }
  });

  it('?tab=trace 深链别名 → Turns（Trace 已退役并入：无 trace 面板与 tab，搜索胶囊在 Turns 头部）', async () => {
    await renderPage('?tab=trace');
    const turnsTab = document.querySelector('[data-run-tab="turns"]');
    expect(turnsTab).toBeTruthy();
    expect(document.querySelector('[data-run-tab="trace"]')).toBeNull();
    expect([...document.querySelectorAll('button')].some(b => b.textContent?.trim() === 'Trace')).toBe(false);
    expect(turnsTab!.querySelector('input[placeholder="搜索本 run…"]')).toBeTruthy();
  });
});
