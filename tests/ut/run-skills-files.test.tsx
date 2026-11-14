// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// Run 详情 Skills/Files tab IT（design: run-observe-parity 刀D + Skills 页
// 变革 + Files 排版对齐工作台卡片语法）：URL 感知 fetch mock 驱动页面级验证
// ——①?tab=skills 深链（双维度 × 四卡：画像/时间线/排行/明细；成员归因收纳
// 为计数，明细才披露）；②技能维选中披露与 turn 深链跳转闭环；③派发维度
// 同构四卡 + segmented 切换/隐藏；④时间戳缺失按事件序回落（轴不撒谎）；
// ⑤?tab=files 深链（FileReadAnalysis 经 run 端点取数，session 端点零触达）
// ——头卡瓦片 + 类型分组列表 + 文件行展开读取明细；⑥文件名搜索 × 类型筛选
// × 含重叠分段的叠加收窄/复位；⑦循迹复卷（重建/下载/收起）+ 重编汇册回执。

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
    taskId: 'ses_mini_a', framework: 'opencode', rowId: 'row_a', turns: 2,
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

const skillsAll = {
  skills: [
    { skillName: 'rop-skill-x', version: 2, invocationCount: 5, members: ['甲成员', '乙成员'] },
    { skillName: 'rop-skill-y', version: null, invocationCount: 1, members: ['甲成员'] },
    // 会话聚合并未伴随事件级记录（存量数据形态）：技能维须诚实呈现，不伪造 0
    { skillName: 'rop-skill-agg', version: null, invocationCount: 3, members: [] },
  ],
  events: [
    {
      id: 'ev-x-a', skillName: 'rop-skill-x', skillVersion: 2, eventType: 'invoke', success: true,
      errorMessage: null, durationMs: 40, turnIndex: 0, turnId: 'rop-t-a0',
      turnCreatedAt: '2026-10-13T02:00:10.000Z', agentName: 'build', isSubagent: false, subagentSessionId: null,
      turnTokens: { totalTokens: 100, inputTokens: 50, outputTokens: 40, reasoningTokens: 5, cacheReadTokens: 10, cacheWriteTokens: 4 },
      member: { taskId: 'ses_mini_a', label: '成员A' },
    },
    {
      id: 'ev-x-b', skillName: 'rop-skill-x', skillVersion: 2, eventType: 'invoke', success: false,
      errorMessage: 'boom', durationMs: 90, turnIndex: 0, turnId: 'rop-t-b0',
      turnCreatedAt: '2026-10-13T02:02:10.000Z', agentName: 'build', isSubagent: false, subagentSessionId: null,
      turnTokens: { totalTokens: 200, inputTokens: 120, outputTokens: 60, reasoningTokens: 5, cacheReadTokens: 10, cacheWriteTokens: 4 },
      member: { taskId: 'ses_mini_b', label: '成员B' },
    },
    {
      id: 'ev-y-a', skillName: 'rop-skill-y', skillVersion: null, eventType: 'invoke', success: true,
      errorMessage: null, durationMs: 20, turnIndex: 1, turnId: 'rop-t-a1',
      turnCreatedAt: '2026-10-13T02:01:10.000Z', agentName: 'build', isSubagent: false, subagentSessionId: null,
      turnTokens: { totalTokens: 60, inputTokens: 30, outputTokens: 20, reasoningTokens: 5, cacheReadTokens: 10, cacheWriteTokens: 4 },
      member: { taskId: 'ses_mini_a', label: '成员A' },
    },
  ],
  // 派发种群（collector 双源合一后的形状）：两条成员推导（agent-x 执行/验收）
  // + 一条 claude 事件真值；tokens = 子代理会话 token 合计（未入库为 null）
  dispatches: [
    {
      id: 'dp-1', name: 'agent-x', turnId: 'rop-t-a0', at: '2026-10-13T02:00:05.000Z', verify: false,
      member: { taskId: 'ses_mini_a', label: 'agent-x·g0·1', framework: 'opencode' }, source: 'member', tokens: 30000,
    },
    {
      id: 'dp-2', name: 'agent-x', turnId: 'rop-t-b0', at: '2026-10-13T02:02:00.000Z', verify: true,
      member: { taskId: 'ses_mini_b', label: 'agent-x·验收·g0·1', framework: 'opencode' }, source: 'member', tokens: 15000,
    },
    {
      id: 'dp-3', name: 'claude-agent', turnId: 'rop-t-a1', at: '2026-10-13T02:01:00.000Z', verify: false,
      member: { taskId: 'ses_mini_a', label: '成员A', framework: 'opencode-proxy' }, source: 'event', tokens: null,
    },
  ],
  total: 3,
};
// 时间戳缺失变体：时间轴按事件序回落（轴不撒谎——不伪造时间）
const skillsNoTime = {
  ...skillsAll,
  events: skillsAll.events.map(e => ({ ...e, turnCreatedAt: null })),
};

// 与产品同口径的钟面读数（测试期望值镜像用户可见语义，时区中立）
const clockOf = (ts: string): string => {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const evOf = (id: string, turnCreatedAt: string) => ({
  id, skillName: 'rop-skill-x', skillVersion: 1, eventType: 'invoke', success: true,
  errorMessage: null, durationMs: 40, turnIndex: 0, turnId: 'rop-t-a0',
  turnCreatedAt, agentName: 'build', isSubagent: false, subagentSessionId: null,
  turnTokens: { totalTokens: 100, inputTokens: 50, outputTokens: 40, reasoningTokens: 5, cacheReadTokens: 10, cacheWriteTokens: 4 },
  member: { taskId: 'ses_mini_a', label: '成员A' },
});

// 单事件变体（客户现场：单技能单调用——时间线无跨度）
const skillsSingle = {
  skills: [{ skillName: 'rop-skill-x', version: 1, invocationCount: 1, members: ['甲成员'] }],
  events: [evOf('ev-x-single', '2026-10-13T02:05:06.000Z')],
  dispatches: [],
  total: 1,
};

// 同秒簇变体（同秒 3 连发：显示粒度上无跨度）
const skillsSameSecond = {
  skills: [{ skillName: 'rop-skill-x', version: 1, invocationCount: 3, members: ['甲成员'] }],
  events: [
    evOf('ev-x-s1', '2026-10-13T02:05:06.100Z'),
    evOf('ev-x-s2', '2026-10-13T02:05:06.300Z'),
    evOf('ev-x-s3', '2026-10-13T02:05:06.500Z'),
  ],
  dispatches: [],
  total: 3,
};

// 跨秒小跨度变体（09.9 → 10.1：比例编码成立，但中点刻度与末端同文须去重）
const skillsCrossSecond = {
  skills: [{ skillName: 'rop-skill-x', version: 1, invocationCount: 2, members: ['甲成员'] }],
  events: [
    evOf('ev-x-c1', '2026-10-13T02:05:09.900Z'),
    evOf('ev-x-c2', '2026-10-13T02:05:10.100Z'),
  ],
  dispatches: [],
  total: 2,
};

const fileReadsAll = {
  files: [
    {
      path: '/repo/rop-shared.md', displayPath: '/repo/rop-shared.md',
      reads: [
        { turnId: 'rop-t-a0', turnIndex: 0, agent: 'root', prompt: null, subagentSessionId: null, llmOutput: null, range: { type: 'full', start: 0, end: 9 }, member: { taskId: 'ses_mini_a', label: '甲成员' } },
        { turnId: 'rop-t-b0', turnIndex: 0, agent: 'root', prompt: null, subagentSessionId: null, llmOutput: null, range: { type: 'full', start: 0, end: 4 }, member: { taskId: 'ses_mini_b', label: '乙成员' } },
      ],
      totalReads: 2, overlappingReads: 1, totalLinesRead: 15, uniqueLinesRead: 10, redundancyRate: 1 / 3,
    },
    {
      // 整段读取且无重叠：行级指标如实标「不适用」；含重叠过滤下应被滤除
      path: '/repo/rop-solo.ts', displayPath: '/repo/rop-solo.ts',
      reads: [
        { turnId: 'rop-t-a1', turnIndex: 1, agent: 'root', prompt: null, subagentSessionId: null, llmOutput: null, range: { type: 'full', start: 0, end: 3 }, member: { taskId: 'ses_mini_a', label: '甲成员' } },
      ],
      totalReads: 1, overlappingReads: 0, totalLinesRead: 0, uniqueLinesRead: 0, redundancyRate: 0,
    },
  ],
  summary: { totalFiles: 2, totalReads: 3, filesWithOverlap: 1, redundancyRate: 1 / 3 },
};

// 覆盖度载荷：默认成员（ses_mini_a）可用全集；其余成员降级（数据源缺失明示）。
// cov-agent-z = 派发子代理（不在 skills 注入段）——skills 维应剔除、agents 维独占
const coverageOk = {
  taskId: 'ses_mini_a', framework: 'opencode', hasAvailableList: true, listFormat: 'xml',
  degradedReason: null, usedSkillCount: 1,
  items: [
    { name: 'rop-skill-x', description: '', origin: null, status: 'invoked', invokeCount: 2, loadCount: 0, dispatchCount: 0 },
    { name: 'rop-skill-unused', description: '声明未用', origin: null, status: 'unused', invokeCount: 0, loadCount: 0, dispatchCount: 0 },
    { name: 'cov-agent-z', description: '', origin: null, status: 'dispatched', invokeCount: 0, loadCount: 0, dispatchCount: 3 },
  ],
  stats: { availableTotal: 2, invoked: 1, loaded: 0, dispatched: 1, unused: 1, extra: 0, total: 3 },
};
const coverageDegraded = {
  taskId: 'ses_mini_b', framework: 'opencode', hasAvailableList: false, listFormat: null,
  degradedReason: 'opencode 原生会话的系统提示只在运行时请求、不落盘，skills 全集不可恢复；经 cpx 代理捕获重跑该会话即可获得全集',
  usedSkillCount: 0, items: [], stats: { availableTotal: 0, invoked: 0, loaded: 0, dispatched: 0, unused: 0, extra: 0, total: 0 },
};

const fetchCalls: string[] = [];
// skills 载荷变体开关：默认带时间戳；置 noTime 切事件序回落用例
const skillsVariant = vi.hoisted(() => ({ current: null as null | { skills: unknown[]; events: unknown[]; dispatches?: unknown[]; total: number } }));

vi.stubGlobal('fetch', vi.fn(async (url: string) => {
  fetchCalls.push(url);
  const u = new URL(url, 'http://localhost');
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
  if (u.pathname === '/api/observe/run/minidemo01/skills') {
    return json(skillsVariant.current);
  }
  if (u.pathname === '/api/observe/run/minidemo01/skill-coverage') {
    return json(u.searchParams.get('member') === 'ses_mini_a' ? coverageOk : coverageDegraded);
  }
  if (u.pathname === '/api/observe/run/minidemo01/file-reads') {
    return json(fileReadsAll);
  }
  if (u.pathname === '/api/observe/run/minidemo01/file-restore') {
    return json({
      path: u.searchParams.get('filePath'),
      lines: [
        { n: 1, content: 'const x = 1', source: 'read' },
        { n: 2, content: 'const y = 2', source: 'write' },
        { n: 3, content: null, source: 'gap' },
      ],
      maxLine: 3,
      opsUsed: 4,
    });
  }
  if (u.pathname === '/api/observe/run/minidemo01/dir-restore') {
    return {
      ok: true,
      blob: async () => new Blob(['zip']),
      headers: new Headers({
        'Content-Disposition': 'attachment; filename="mini_restored.zip"',
        'X-Restored-Count': '2',
        'X-Restored-Total-Lines': '6',
        'X-Restored-Gap-Lines': '1',
      }),
    };
  }
  return json({ items: [], total: 0 });
}));

let root: Root | null = null;

// history.pushState 间谍（条目栈 URL 镜像断言锚）：懒建 + renderPage 复位。
// 调用形态 (state, unused, url)——url 断言取第三参
let pushSpy: ReturnType<typeof vi.spyOn> | null = null;
function ensurePushSpy() {
  if (!pushSpy) pushSpy = vi.spyOn(window.history, 'pushState');
  return pushSpy;
}

async function renderPage(initialSearch = '') {
  searchState.current = initialSearch;
  // history 条目栈测试基建：重置当前条目 state（同文件跨用例防标残留）
  window.history.replaceState(null, '', `/run/minidemo01${initialSearch}`);
  ensurePushSpy().mockClear();
  nav.replace.mockClear();
  fetchCalls.length = 0;
  if (!skillsVariant.current) skillsVariant.current = skillsAll;
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
});

describe('Run 详情 Skills/Files tab（run-observe-parity 刀D）', () => {
  it('?tab=skills 深链：四卡渲染（画像/时间线/排行/明细占位），成员归因收纳为计数不铺徽标', async () => {
    await renderPage('?tab=skills');

    const tab = document.querySelector('[data-run-tab="skills"]');
    expect(tab).toBeTruthy();
    // 聚合观测恒为全成员融合（skills 端点无 member 参数）
    expect(fetchCalls.some(u => u.includes('/skills') && !u.includes('member='))).toBe(true);
    const text = tab!.textContent ?? '';

    // ① 画像：总量瓦片（标签上/值下）——技能/调用/失败/峰值
    expect(tab!.querySelector('[data-stat="skills"]')?.textContent).toContain('3');
    expect(tab!.querySelector('[data-stat="calls"]')?.textContent).toContain('3');
    expect(tab!.querySelector('[data-stat="fails"]')?.textContent).toContain('1');
    expect(tab!.querySelector('[data-stat="top"]')?.textContent).toContain('rop-skill-x');
    // 调用构成图例（invoke 全量 + 失败计数由瓦片承载）
    expect(text).toContain('invoke');

    // ② 调用时间线：泳道 + 调用点（成功绿/失败红——技能主色为绿，与覆盖度「已调用」同源）
    const tlSvg = tab!.querySelector('svg[data-skill-timeline]');
    expect(tlSvg).toBeTruthy();
    const dots = tlSvg!.querySelectorAll('circle[data-skill-dot]');
    expect(dots.length).toBe(3);
    const failDot = [...dots].find(d => d.getAttribute('fill') === '#dc2626');
    expect(failDot).toBeTruthy();
    expect([...dots].some(d => d.getAttribute('fill') === '#10b981')).toBe(true);

    // ③+④ 排行/明细双列同构：同高卡身 + 头部固定 + 内部滚动（滚动窗口与滚动条对齐）
    const panels = tab!.querySelectorAll('[data-panel]');
    expect(panels.length).toBe(2);
    expect([...panels].every(p => p.getAttribute('class')?.includes('h-[468px]'))).toBe(true);

    // ③ 热点排行：计数 + 成员数；成员名不在主视图（收纳，不铺徽标墙）
    const rows = tab!.querySelectorAll('[data-skill-row]');
    expect(rows.length).toBe(3);
    expect(rows[0]!.textContent).toContain('rop-skill-x');
    expect(rows[0]!.textContent).toContain('2 成员');
    expect(text).not.toContain('成员A');
    expect(text).not.toContain('成员B');

    // ⑤ 覆盖度卡（skills 口径）：有声明未调用的可见性（默认成员定向 + 多成员
    // 内联选择），与调用时间线同排双列、等高对齐（h-full 撑满）
    expect(text).toContain('Skill 覆盖度');
    expect(text).toContain('rop-skill-unused');
    expect(text).toContain('未使用');
    const covSelect = tab!.querySelector('select[aria-label="覆盖度成员"]');
    expect(covSelect).toBeTruthy();
    expect(tlSvg!.closest('div.grid')?.contains(covSelect!)).toBe(true);
    expect(tlSvg!.closest('[data-slot="card"]')?.getAttribute('class')).toContain('h-full');
    // 卡面同源：覆盖度卡与时间线/排行/明细共用 PERF_CARD_CLS（含底部投影）
    expect(covSelect!.closest('[data-slot="card"]')?.getAttribute('class')).toContain('h-full');
    expect(covSelect!.closest('[data-slot="card"]')?.getAttribute('class')).toContain('shadow-');
    // 口径拆分：派发子代理（cov-agent-z）不进技能维；环分母随拆分重算（1/2 而非混排 1/3）
    expect(text).not.toContain('cov-agent-z');
    expect(text).toContain('/ 2 未使用');

    // ④ 明细占位（未选中）
    expect(text).toContain('选择技能查看调用明细');

    // session 遗产退役负向锁：页面级成员选择器 / SkillSummary 表（覆盖度为独立卡回归，不在此列）
    expect([...tab!.querySelectorAll('button')].find(b => b.textContent?.startsWith('全部'))).toBeUndefined();
    expect(text).not.toContain('Skill Summary');
    expect(text).not.toContain('Invocations');
  });

  it('Skills 选中披露与跳转闭环：排行行 → 明细逐调用带成员归因；时间线点/明细箭头落 turn 深链', async () => {
    await renderPage('?tab=skills');

    const tab = document.querySelector('[data-run-tab="skills"]')!;

    // 排行行点击 → 明细：聚合行 + 逐调用序列（成员归因在这里披露，一行一个）
    const rowX = tab.querySelector('[data-skill-row="rop-skill-x"]') as HTMLElement;
    expect(rowX).toBeTruthy();
    await act(async () => {
      rowX.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    const detailText = tab.textContent ?? '';
    expect(detailText).toContain('2 次调用 · 2 成员');
    expect(detailText).toContain('成员A');
    expect(detailText).toContain('成员B');
    // 失败计数红标 + 逐调用跳转箭头（data-skill-jump）
    expect(detailText).toContain('失败 1');
    const jumps = tab.querySelectorAll('[data-skill-jump]');
    expect(jumps.length).toBe(2);

    // 明细箭头跳转 → Turns 深链（navigate 入条目栈，URL 镜像随 pushState 走）；悬停提示不带括号注记
    ensurePushSpy().mockClear();
    const jumpB = [...jumps].find(j => j.getAttribute('data-skill-jump') === 'rop-t-b0') as HTMLElement;
    expect(jumpB.getAttribute('title')).toBe('跳转 turn 现场');
    await act(async () => {
      jumpB.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(ensurePushSpy().mock.calls.length).toBeGreaterThan(0);
    const last = String(ensurePushSpy().mock.calls.at(-1)?.[2] ?? '');
    expect(last).toContain('tab=turns');
    expect(last).toContain('turn=rop-t-b0');

    // 时间线点直跳（不经明细）：绿点落其 turn
    ensurePushSpy().mockClear();
    const dotY = tab.querySelector('circle[data-skill-dot="rop-skill-y"]') as unknown as Element;
    await act(async () => {
      dotY.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    const viaDot = String(ensurePushSpy().mock.calls.at(-1)?.[2] ?? '');
    expect(viaDot).toContain('turn=rop-t-a1');

    // 收起明细：成员名退场（收纳状态可逆）
    const rowX2 = tab.querySelector('[data-skill-row="rop-skill-x"]') as HTMLElement;
    await act(async () => {
      rowX2.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(tab.textContent ?? '').not.toContain('成员A');
  });

  it('Skills 会话聚合行：无事件级记录时诚实呈现（不伪造 0 成员 / Σ 0 tok）', async () => {
    await renderPage('?tab=skills');
    const tab = document.querySelector('[data-run-tab="skills"]')!;

    // 排行：聚合计数在（3），成员/token 列为 — （缺数据不冒充零值）
    const rowAgg = tab.querySelector('[data-skill-row="rop-skill-agg"]') as HTMLElement;
    expect(rowAgg).toBeTruthy();
    expect(rowAgg.textContent).toContain('3');
    expect(rowAgg.textContent).toContain('—');

    // 选中披露：会话聚合并无事件级调用记录（不给 0 成员 · Σ 0 tok 的误导行）
    await act(async () => {
      rowAgg.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    const detail = tab.textContent ?? '';
    expect(detail).toContain('3 次调用（会话聚合，无事件级记录）');
    expect(detail).not.toContain('0 成员');
    expect(detail).not.toContain('Σ 0 tok');
  });

  it('Skills 时间戳缺失：时间轴按事件序回落（轴不撒谎，不伪造时间）', async () => {
    skillsVariant.current = skillsNoTime;
    try {
      await renderPage('?tab=skills');
      const tab = document.querySelector('[data-run-tab="skills"]')!;
      const text = tab.textContent ?? '';
      expect(text).toContain('事件序');
      expect(text).not.toContain('run 时刻');
      // 点仍渲染（3 次），跳转闭环不受影响
      expect(tab.querySelectorAll('circle[data-skill-dot]').length).toBe(3);
    } finally {
      skillsVariant.current = skillsAll;
    }
  });

  // ── 时间线轴几何（显示粒度三态：可分辨 / 同一秒内 / 时间戳缺失） ──────────
  // 判别点：刻度永不同文重复（客户现场：单次调用时间线出现三枚 15:56:08）。

  it('时间线轴·可分辨跨度：三枚刻度全不同文（现状锁）', async () => {
    await renderPage('?tab=skills');
    const svg = document.querySelector('svg[data-skill-timeline][data-dim="calls"]')!;
    const labels = [...svg.querySelectorAll('text[data-skill-tick]')].map(t => t.textContent);
    expect(labels).toHaveLength(3);
    expect(new Set(labels).size).toBe(3);
  });

  it('时间线轴·单事件：刻度收拢为一枚时刻、点居中（不再三枚同文 + 贴边）', async () => {
    skillsVariant.current = skillsSingle;
    try {
      await renderPage('?tab=skills');
      const tab = document.querySelector('[data-run-tab="skills"]')!;
      expect(tab.textContent).toContain('run 时刻（同一秒内）');
      const svg = tab.querySelector('svg[data-skill-timeline][data-dim="calls"]')!;
      const ticks = [...svg.querySelectorAll('text[data-skill-tick]')];
      expect(ticks).toHaveLength(1);
      expect(ticks[0]!.textContent).toBe(clockOf('2026-10-13T02:05:06.000Z'));
      expect(ticks[0]!.getAttribute('text-anchor')).toBe('middle');
      const dots = svg.querySelectorAll('circle[data-skill-dot]');
      expect(dots).toHaveLength(1);
      expect(Number(dots[0]!.getAttribute('cx'))).toBe(148 + (720 - 148 - 14) / 2);
    } finally {
      skillsVariant.current = skillsAll;
    }
  });

  it('时间线轴·同秒簇：一枚刻度、点按序铺开（毫秒差不夸大成全程宽度）', async () => {
    skillsVariant.current = skillsSameSecond;
    try {
      await renderPage('?tab=skills');
      const tab = document.querySelector('[data-run-tab="skills"]')!;
      expect(tab.textContent).toContain('run 时刻（同一秒内）');
      const svg = tab.querySelector('svg[data-skill-timeline][data-dim="calls"]')!;
      const ticks = [...svg.querySelectorAll('text[data-skill-tick]')];
      expect(ticks).toHaveLength(1);
      expect(ticks[0]!.textContent).toBe(clockOf('2026-10-13T02:05:06.100Z'));
      const dots = [...svg.querySelectorAll('circle[data-skill-dot]')];
      expect(dots).toHaveLength(3);
      // 事件序几何：ord/(n-1) 均分图区宽（148 / 427 / 706），同秒毫秒差不伪称全程比例
      expect(dots.map(d => Number(d.getAttribute('cx')))).toEqual([148, 148 + 279, 148 + 558]);
    } finally {
      skillsVariant.current = skillsAll;
    }
  });

  it('时间线轴·跨秒小跨度：位置=真实比例，中点刻度与末端同文则去重', async () => {
    skillsVariant.current = skillsCrossSecond;
    try {
      await renderPage('?tab=skills');
      const tab = document.querySelector('[data-run-tab="skills"]')!;
      expect(tab.textContent).toContain('run 时刻');
      expect(tab.textContent).not.toContain('run 时刻（同一秒内）');
      const svg = tab.querySelector('svg[data-skill-timeline][data-dim="calls"]')!;
      const ticks = [...svg.querySelectorAll('text[data-skill-tick]')];
      expect(ticks).toHaveLength(2);
      expect(ticks.map(t => t.textContent)).toEqual([
        clockOf('2026-10-13T02:05:09.900Z'),
        clockOf('2026-10-13T02:05:10.100Z'),
      ]);
      const dots = [...svg.querySelectorAll('circle[data-skill-dot]')];
      expect(dots.map(d => Number(d.getAttribute('cx')))).toEqual([148, 148 + 558]);
    } finally {
      skillsVariant.current = skillsAll;
    }
  });

  it('Skills 派发维度：segmented 切换 + 四卡同构（画像/时间线/排行/明细）+ 成员归因披露 + turn 深链', async () => {
    await renderPage('?tab=skills');
    const tab = document.querySelector('[data-run-tab="skills"]')!;

    // 维度切换出现（有派发数据）；默认技能维
    const segBtn = [...tab.querySelectorAll('button')].find(b => b.textContent === '派发');
    expect(segBtn).toBeTruthy();
    expect(tab.querySelector('svg[data-skill-timeline]')?.getAttribute('data-dim')).toBe('calls');

    await act(async () => {
      segBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    // ① 画像：派发/子代理/验收/峰值瓦片
    expect(tab.querySelector('[data-stat="dispatches"]')?.textContent).toContain('3');
    expect(tab.querySelector('[data-stat="agents"]')?.textContent).toContain('2');
    expect(tab.querySelector('[data-stat="verify"]')?.textContent).toContain('1');
    expect(tab.querySelector('[data-stat="top"]')?.textContent).toContain('agent-x');
    // 构成图例：正式/验收
    const pText = tab.textContent ?? '';
    expect(pText).toContain('正式');
    expect(pText).toContain('验收');
    // ⑤ Agent 覆盖度（agents 口径）：派发子代理独占——cov-agent-z 只在派发维出现，
    // skills 侧的声明全集（rop-skill-unused）不混入
    expect(pText).toContain('Agent 覆盖度');
    expect(pText).toContain('cov-agent-z');
    expect(pText).toContain('累计派发');
    expect(pText).not.toContain('rop-skill-unused');

    // ② 派发时间线：紫点（3 次），点可跳
    const svg = tab.querySelector('svg[data-skill-timeline][data-dim="dispatch"]');
    expect(svg).toBeTruthy();
    const dots = svg!.querySelectorAll('circle[data-skill-dot]');
    expect(dots.length).toBe(3);
    expect([...dots].every(d => d.getAttribute('fill') === '#7c3aeb')).toBe(true);

    // ③ 派发排行：agent 分组；行尾与技能行同构（N 成员 · token 合计），
    // 验收计数收进条形叠层（data-verify-seg），不再占用横线占位列
    const rows = tab.querySelectorAll('[data-skill-row]');
    expect(rows.length).toBe(2);
    expect(rows[0]!.textContent).toContain('agent-x');
    expect(rows[0]!.textContent).toContain('2 成员');
    expect(rows[0]!.textContent).toContain('45.0K');
    expect(tab.querySelector('[data-skill-row="agent-x"] [data-verify-seg]')).toBeTruthy();
    // 子代理会话未入库（dp-3 tokens null）→ token 列诚实显示 —，不伪造 0
    expect(rows[1]!.textContent).toContain('claude-agent');
    expect(rows[1]!.textContent).toContain('1 成员');
    expect(rows[1]!.textContent).toContain('—');
    expect(tab.querySelector('[data-skill-row="claude-agent"] [data-verify-seg]')).toBeNull();

    // ④ 排行点击 → 明细：Σ token 汇总 + 逐次派发披露成员全标签与子代理 token + 跳转箭头
    const rowX = tab.querySelector('[data-skill-row="agent-x"]') as HTMLElement;
    await act(async () => {
      rowX.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    const detail = tab.textContent ?? '';
    expect(detail).toContain('2 次派发 · 2 成员 · Σ 45.0K tok');
    expect(detail).toContain('验收 1');
    expect(detail).toContain('agent-x·g0·1');
    expect(detail).toContain('agent-x·验收·g0·1');
    expect(detail).toContain('30.0K');
    expect(detail).toContain('15.0K');
    const jumps = tab.querySelectorAll('[data-skill-jump]');
    expect(jumps.length).toBe(2);

    // 明细箭头跳转 → Turns 深链
    ensurePushSpy().mockClear();
    const jumpB = [...jumps].find(j => j.getAttribute('data-skill-jump') === 'rop-t-b0') as HTMLElement;
    await act(async () => {
      jumpB.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(String(ensurePushSpy().mock.calls.at(-1)?.[2])).toContain('turn=rop-t-b0');

    // 时间线点直跳（不经明细）
    ensurePushSpy().mockClear();
    const dotY = svg!.querySelector('circle[data-skill-dot="claude-agent"]') as unknown as Element;
    await act(async () => {
      dotY.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(String(ensurePushSpy().mock.calls.at(-1)?.[2])).toContain('turn=rop-t-a1');

    // 切回技能维：派发视图退场、技能瓦片回归
    const segSkills = [...tab.querySelectorAll('button')].find(b => b.textContent === '技能')!;
    await act(async () => {
      segSkills.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(tab.querySelector('[data-stat="skills"]')?.textContent).toContain('3');
    expect(tab.querySelector('svg[data-skill-timeline]')?.getAttribute('data-dim')).toBe('calls');
  });

  it('Skills 无派发数据：维度切换隐藏（solo 常态只见技能）', async () => {
    skillsVariant.current = { ...skillsAll, dispatches: [] };
    try {
      await renderPage('?tab=skills');
      const tab = document.querySelector('[data-run-tab="skills"]')!;
      expect([...tab.querySelectorAll('button')].find(b => b.textContent === '派发')).toBeUndefined();
      expect(tab.querySelector('svg[data-skill-timeline]')?.getAttribute('data-dim')).toBe('calls');
    } finally {
      skillsVariant.current = skillsAll;
    }
  });

  it('?tab=files 深链：run 端点取数（session 端点零触达）+ 头卡瓦片与文件行展开', async () => {
    await renderPage('?tab=files');

    const tab = document.querySelector('[data-run-tab="files"]');
    expect(tab).toBeTruthy();
    expect(fetchCalls).toContain('/api/observe/run/minidemo01/file-reads');
    expect(fetchCalls.some(u => u.startsWith('/api/observe/session/'))).toBe(false);

    // 头卡指标瓦片（标签上/值下）：跨成员归并入四指标；含重叠 > 0 着红
    expect(tab!.querySelector('[data-stat="files"]')?.textContent).toContain('2');
    expect(tab!.querySelector('[data-stat="reads"]')?.textContent).toContain('3');
    const overlapTile = tab!.querySelector('[data-stat="overlap"]')!;
    expect(overlapTile.textContent).toContain('1');
    expect(overlapTile.innerHTML).toContain('text-red-600');
    expect(tab!.querySelector('[data-stat="redundancy"]')?.textContent).toContain('33.3%');

    // 文件行：文件名优先，路径/读取量次级；重叠红字；列表按类型分组
    const sharedRow = tab!.querySelector('[data-file-row="/repo/rop-shared.md"]')!;
    expect(sharedRow.textContent).toContain('rop-shared.md');
    expect(sharedRow.textContent).toContain('/repo');
    expect(sharedRow.textContent).toContain('2 读取');
    expect(sharedRow.textContent).toContain('1 重叠');
    expect(tab!.querySelector('[data-file-row="/repo/rop-solo.ts"]')).toBeTruthy();
    expect(tab!.querySelector('[data-file-group="md"]')?.textContent).toContain('1 个文件');
    expect(tab!.querySelector('[data-file-group="ts"]')?.textContent).toContain('1 次读取');

    // 展开文件行：行级指标 + 读取分组按成员×子代理复合键（刀F）——各成员组头带成员徽标
    await act(async () => {
      sharedRow.firstElementChild!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    const expanded = sharedRow.textContent ?? '';
    expect(expanded).toContain('读取 15 行 · 去重 10 行 · 冗余 33.3%');
    expect(expanded).toContain('甲成员');
    expect(expanded).toContain('乙成员');
    expect(expanded).toContain('#0');

    // 整段读取的文件：行级指标如实标「不适用」
    const soloRow = tab!.querySelector('[data-file-row="/repo/rop-solo.ts"]')!;
    await act(async () => {
      soloRow.firstElementChild!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(soloRow.textContent).toContain('全部为整段读取 · 行级指标不适用');
  });

  it('Files 过滤组合：文件名搜索 + 类型筛选 + 含重叠分段（三者叠加收窄）', async () => {
    await renderPage('?tab=files');
    const tab = document.querySelector('[data-run-tab="files"]')!;
    expect(tab.querySelectorAll('[data-file-row]').length).toBe(2);

    // 文件名搜索：关键字即时收窄；无命中空态明示；✕ 一键复原
    const searchInput = tab.querySelector('[data-file-search]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(searchInput, 'solo');
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(tab.querySelector('[data-file-row="/repo/rop-shared.md"]')).toBeNull();
    expect(tab.querySelector('[data-file-row="/repo/rop-solo.ts"]')).toBeTruthy();
    await act(async () => {
      setter.call(searchInput, 'zzz');
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(tab.textContent).toContain('没有文件名包含「zzz」的文件');
    await act(async () => {
      tab.querySelector('[data-file-search-clear]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(tab.querySelectorAll('[data-file-row]').length).toBe(2);

    // 类型筛选：点类型 chip 仅该类型在列（分组头随行收窄）；再点同 chip 复位；「全部」同路
    await act(async () => {
      tab.querySelector('[data-type-chip="ts"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(tab.querySelector('[data-file-row="/repo/rop-shared.md"]')).toBeNull();
    expect(tab.querySelector('[data-file-group="md"]')).toBeNull();
    expect(tab.querySelector('[data-file-row="/repo/rop-solo.ts"]')).toBeTruthy();
    await act(async () => {
      tab.querySelector('[data-type-chip="ts"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(tab.querySelectorAll('[data-file-row]').length).toBe(2);
    await act(async () => {
      tab.querySelector('[data-type-chip="ts"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      tab.querySelector('[data-type-chip="all"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(tab.querySelectorAll('[data-file-row]').length).toBe(2);

    // 含重叠分段与搜索叠加收窄
    await act(async () => {
      setter.call(searchInput, 'rop');
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      const seg = [...tab.querySelectorAll('button')].find(b => b.textContent === '含重叠 1')!;
      seg.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(tab.querySelector('[data-file-row="/repo/rop-solo.ts"]')).toBeNull();
    expect(tab.querySelector('[data-file-row="/repo/rop-shared.md"]')).toBeTruthy();
  });

  it('Files 工作台：含重叠过滤 + 循迹复卷（重建/下载/收起）+ 重编汇册回执', async () => {
    // happy-dom 的 Blob URL 侧信道用桩替换（下载行为本身不在此断言范围）
    const origCreateObjectURL = URL.createObjectURL;
    const origRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:mock');
    URL.revokeObjectURL = vi.fn(() => {});
    try {
      await renderPage('?tab=files');
      const tab = document.querySelector('[data-run-tab="files"]')!;

      // 分段过滤：切「含重叠」仅重叠文件在列，切回「全部」复位
      await act(async () => {
        const seg = [...tab.querySelectorAll('button')].find(b => b.textContent === '含重叠 1')!;
        seg.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      expect(tab.querySelector('[data-file-row="/repo/rop-solo.ts"]')).toBeNull();
      expect(tab.querySelector('[data-file-row="/repo/rop-shared.md"]')).toBeTruthy();
      await act(async () => {
        const seg = [...tab.querySelectorAll('button')].find(b => b.textContent === '全部 2')!;
        seg.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      expect(tab.querySelector('[data-file-row="/repo/rop-solo.ts"]')).toBeTruthy();

      // 循迹复卷：点击即取数重建——行内容落版，未采集行如实标注（与下载口径同源）
      const sharedRow = tab.querySelector('[data-file-row="/repo/rop-shared.md"]')!;
      await act(async () => {
        sharedRow.querySelector('[data-file-restore="/repo/rop-shared.md"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 10));
      });
      expect(fetchCalls.some(u => u.includes('/file-restore') && u.includes('filePath=%2Frepo%2Frop-shared.md'))).toBe(true);
      const panel = tab.querySelector('[data-file-restore-panel="/repo/rop-shared.md"]')!;
      expect(panel.textContent).toContain('循迹复卷 · 3 行');
      expect(panel.textContent).toContain('4 次读写');
      expect(panel.textContent).toContain('1 行未采集');
      expect(panel.textContent).toContain('const x = 1');
      expect(panel.textContent).toContain('--line 3 not found --');

      // 下载重建内容（teal 恢复域动作）
      await act(async () => {
        panel.querySelector('[data-restore-download="/repo/rop-shared.md"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      expect(URL.createObjectURL).toHaveBeenCalled();

      // 再点复卷钮收起面板
      await act(async () => {
        sharedRow.querySelector('[data-file-restore="/repo/rop-shared.md"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      expect(tab.querySelector('[data-file-restore-panel="/repo/rop-shared.md"]')).toBeNull();

      // 重编汇册：整目录 zip 下载 + 回执明示（文件数 / 行数 / 未采集行数），✕ 关闭
      await act(async () => {
        tab.querySelector('[data-dir-restore]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 10));
      });
      expect(fetchCalls.some(u => u.includes('/dir-restore'))).toBe(true);
      const result = tab.querySelector('[data-dir-restore-result]')!;
      expect(result.textContent).toContain('已打包下载 2 个文件');
      expect(result.textContent).toContain('共 6 行');
      expect(result.textContent).toContain('1 行未采集');
      await act(async () => {
        result.querySelector('button[title="关闭"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      expect(tab.querySelector('[data-dir-restore-result]')).toBeNull();
    } finally {
      URL.createObjectURL = origCreateObjectURL;
      URL.revokeObjectURL = origRevokeObjectURL;
    }
  });
});
