// @vitest-environment happy-dom
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 数据纪元增量刷新 IT（run 工作台主链路回归锁）：
// 「立即刷新」→ refresh-session 增量导入 → 页面重载后 tab 不重挂——
//   ① Turns 列表按已载边界 offset 续拉（新轮追加，首页不被替换重取）
//   ② 选中轮详情原地刷新（内容在位更新，不闪骨架）
//   ③ 阅读态保持：手动展开的非首节点不回缩（重挂判别器——重挂会把展开态
//      惰性初始化回「仅首节点」，展开丢失即重挂）。此前刷新把数据纪元当
//      身份 key 整树重挂，自动同步每 5s 清场一次阅读位置——本用例锁死该缺陷。

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
    // 有源成员：刷新按钮可达（refreshTargets = 有 sourcePath 的成员）
    sourcePath: '/tmp/mini/ses_mini_a.jsonl',
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
// 刷新后新增轮（offset=1 续拉到位的增量）
const turnA1 = {
  ...turnA,
  turnId: 'rop-t-a1', turnIndex: 1, contentSummary: '成员A的新一轮',
  createdAt: '2026-10-13T02:03:10.000Z',
};
const turnB = {
  turnId: 'rop-t-b0', turnIndex: 0, role: 'assistant', contentSummary: '成员B的回应',
  agentName: 'build', isSubagent: false, subagentName: null, subagentSessionId: null,
  parentExecutionId: null, totalTokens: 200, inputTokens: 120, outputTokens: 80,
  reasoningTokens: 10, latencyMs: 1500, createdAt: '2026-10-13T02:02:10.000Z',
  completedAt: null, model: 'glm-4.7', toolCalls: [], skillEvents: [],
  member: { taskId: 'ses_mini_b', label: '成员B' },
};
const turnDetailBase = {
  turnIndex: 0, role: 'user', content: null, contentJson: null,
  inputMessagesJson: null, inputMessagesCount: 0, inputMessagesTokens: 0,
  contextWindowPct: null, agentName: null, subagentName: null, isSubagent: false,
  totalTokens: 60, inputTokens: 60, outputTokens: 0, reasoningTokens: 0,
  cacheReadTokens: 0, cacheWriteTokens: 0, latencyMs: 800, ttftMs: null,
  createdAt: '2026-10-13T02:00:10.000Z', completedAt: null, model: 'glm-4.7',
  modelId: null, providerId: null, finishReason: null,
  toolCalls: [], skillEvents: [],
};

const fetchCalls: string[] = [];
vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
  fetchCalls.push(`${init?.method ?? 'GET'} ${url}`);
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
  if (u.pathname === '/api/ingest/refresh-session') {
    return json({ addedTurns: 1, updatedTurns: 0, fullRebuild: false });
  }
  if (u.pathname === '/api/observe/run/minidemo01/turns') {
    const member = p.get('member');
    const offset = Number(p.get('offset') ?? '0');
    if (member === 'ses_mini_a') {
      // offset 续拉（数据纪元增量）：返回新增轮；首页仍只回旧轮
      if (offset >= 1) return json({ items: [turnA1], total: 2 });
      return json({ items: [turnA], total: 1, page: 1, pageSize: Number(p.get('pageSize') ?? 200) });
    }
    if (member === 'ses_mini_b') {
      if (offset >= 1) return json({ items: [], total: 1 });
      return json({ items: [turnB], total: 1, page: 1, pageSize: Number(p.get('pageSize') ?? 200) });
    }
    return json({ items: [turnA, turnB], total: 2, page: 1, pageSize: Number(p.get('pageSize') ?? 200) });
  }
  if (u.pathname === '/api/observe/run/minidemo01/bridges') {
    return json({ items: [], total: 0 });
  }
  if (u.pathname === '/api/observe/turn/rop-t-a0') {
    return json({ ...turnDetailBase, turnId: 'rop-t-a0', taskId: 'ses_mini_a', contentSummary: '成员A的开始任务', content: '成员A的开始任务' });
  }
  return json({ items: [], total: 0 });
}));

let root: Root | null = null;

async function renderPage(initialSearch = '') {
  searchState.current = initialSearch;
  nav.replace.mockClear();
  fetchCalls.length = 0;
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
  await settle(40);
}

async function settle(ms = 20) {
  await act(async () => { await new Promise(r => setTimeout(r, ms)) });
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('数据纪元增量刷新（刷新不重挂，阅读态保持）', () => {
  it('立即刷新：Turns offset 续拉新轮 + 选中详情原地刷新 + 手动展开节点不回缩 + 首页不被替换重取', async () => {
    await renderPage('?tab=turns&turn=rop-t-a0');

    // 基线：选中轮详情 + 行就位
    expect(document.querySelector('[data-turn-row="rop-t-a0"]')).toBeTruthy();
    expect(document.body.textContent).toContain('成员A的开始任务');
    const detailFetchesBefore = fetchCalls.filter(c => c === 'GET /api/observe/turn/rop-t-a0').length;
    const aFirstPageFetches = () => fetchCalls.filter(c => c.includes('member=ses_mini_a') && c.includes('page=1')).length;
    expect(aFirstPageFetches()).toBe(1);

    // 展开一个非首节点（成员B 所在），建立阅读态——重挂会把展开态惰性初始化
    // 回「仅首节点」，B 的行消失即重挂（判别器）
    let expandedB = document.querySelector('[data-turn-row="rop-t-b0"]');
    for (const node of [...document.querySelectorAll('[data-node]')]) {
      if (expandedB) break;
      await act(async () => {
        (node.querySelector('button') as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 20));
      });
      expandedB = document.querySelector('[data-turn-row="rop-t-b0"]');
    }
    expect(expandedB).toBeTruthy();

    // 立即刷新
    await act(async () => {
      (document.querySelector('button[title="立即刷新"]') as HTMLElement)
        .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 60));
    });
    await settle(40);

    // ① 增量导入已发（仅成员A：唯一有源成员）
    expect(fetchCalls).toContain('POST /api/ingest/refresh-session');
    // ② Turns 列表按 offset=已载边界 续拉（新轮到达，未重挂替换）
    expect(fetchCalls.some(c => c.includes('GET /api/observe/run/minidemo01/turns') && c.includes('member=ses_mini_a') && c.includes('offset=1'))).toBe(true);
    expect(aFirstPageFetches()).toBe(1);
    expect(document.querySelector('[data-turn-row="rop-t-a1"]')).toBeTruthy();
    // ③ 选中轮详情原地刷新（不重挂走首取路径，刷新路径在位更新）
    expect(fetchCalls.filter(c => c === 'GET /api/observe/turn/rop-t-a0').length).toBeGreaterThan(detailFetchesBefore);
    expect(document.body.textContent).toContain('成员A的开始任务');
    // ④ 阅读态保持（重挂判别器）：B 节点展开不回缩 + 选中行原位
    expect(document.querySelector('[data-turn-row="rop-t-b0"]')).toBeTruthy();
    expect(document.querySelector('[data-turn-row="rop-t-a0"]')).toBeTruthy();
  });
});
