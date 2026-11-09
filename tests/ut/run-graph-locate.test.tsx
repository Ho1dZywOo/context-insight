// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// Graph tab 成员定位 IT（locate 收口架构）：主图节点侧栏的成员会话点击
// 不再跳 solo run 整页，而是走定位管线——会话解析为首轮（pageSize=1 锚点
// 请求）→ turnId 深链（URL ?tab=turns&turn=）→ RunTurnsTab 既有机制
// （详情归属 → 节点自动展开 → 成员分页 → 行居中揭示）。

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
    const items = member === 'ses_mini_a' ? [turnA] : member === 'ses_mini_b' ? [turnB] : [turnA, turnB];
    return json({ items, total: items.length, page: 1, pageSize: Number(p.get('pageSize') ?? 200) });
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

describe('Graph 成员定位（locate 收口）', () => {
  it('侧栏点击成员会话 → 解析首轮深链跳 Turns：URL 落 tab=turns&turn=，行居中揭示；solo 整页跳退役', async () => {
    const revealed: Array<{ id: string; block: string | undefined }> = [];
    const origScroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element, opts?: ScrollIntoViewOptions) {
      const id = this.getAttribute('data-turn-row');
      if (id) revealed.push({ id, block: opts?.block });
    };
    try {
      await renderPage('?tab=graph');
      const nodeGroups = [...document.querySelectorAll('g.run-node')];
      expect(nodeGroups.length).toBeGreaterThan(0);
      // 逐个点节点直到侧栏出现成员A的定位入口（不依赖节点渲染顺序）
      let memberBtn: HTMLElement | null = null;
      for (const g of nodeGroups) {
        await act(async () => {
          (g as unknown as Element).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          await new Promise(r => setTimeout(r, 10));
        });
        memberBtn = ([...document.querySelectorAll('aside button')] as HTMLElement[])
          .find(b => b.textContent?.includes('ses_mini_a')) ?? null;
        if (memberBtn) break;
      }
      expect(memberBtn).toBeTruthy();
      // 旧 solo run 整页链接退役（全页无 /run/solo: 锚点）
      expect(document.querySelector('a[href*="/run/solo:"]')).toBeNull();

      await act(async () => {
        memberBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 40));
      });
      // 会话 → 首轮解析：pageSize=1 锚点请求
      expect(fetchCalls.some(u => u.includes('member=ses_mini_a') && u.includes('pageSize=1'))).toBe(true);
      // 深链落地：navigate 入条目栈（URL 镜像随 pushState 走）到 turns + 首轮选中
      const lastPush = String(ensurePushSpy().mock.calls.at(-1)?.[2] ?? '');
      expect(lastPush).toContain('tab=turns');
      expect(lastPush).toContain('turn=rop-t-a0');
      // Turns 挂载：详情可见 + 目标行居中揭示（详情归属→节点展开→成员分页→行就位）
      await act(async () => { await new Promise(r => setTimeout(r, 80)) });
      expect(document.querySelector('[data-run-tab="turns"]')).toBeTruthy();
      expect(document.getElementById('turn-detail-top')?.textContent).toContain('成员A的开始任务');
      expect(revealed.some(r => r.id === 'rop-t-a0' && r.block === 'center')).toBe(true);
    } finally {
      Element.prototype.scrollIntoView = origScroll;
    }
  });
});
