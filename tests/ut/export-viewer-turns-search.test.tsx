// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// 离线查看器 Turns 搜索 IT（design: Trace 退役——搜索归 Turns，离线侧为
// 客户端搜索）：fetch mock 驱动查看器组件级验证——①搜索胶囊与命中索引
// 驻留（客户端复用 matchTurnSearch 单点：摘要 + 工具参数/结果同口径）；
// ②点命中打开 Turn 详情且命中索引不消失；③✕ 退出回会话块；④#数字直达
// 会话内轮次。

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import SessionExportViewer from '@/components/export-view/SessionExportViewer';

const nav = vi.hoisted(() => ({ replace: vi.fn() }));
const searchState = vi.hoisted(() => ({ current: '?tab=turns' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: nav.replace, back: () => {}, refresh: () => {} }),
  usePathname: () => '/export-view/ses_v1',
  useSearchParams: () => new URLSearchParams(searchState.current),
}));

const sessionData = {
  sessionId: 'ses_v1', taskId: 'ses_v1', label: '离线会话', query: '构建演示项目',
  framework: 'claude-jsonl', frameworkVersion: null, parentId: null, directory: null,
  summaryAdditions: 0, summaryDeletions: 0, summaryFiles: 0, model: 'glm-4.7', sourcePath: null,
  startTime: '2026-10-20T10:00:00.000Z', endTime: '2026-10-20T10:05:00.000Z',
  wallMs: 300000, activeMs: 200000, inactiveMs: 100000, user: null,
  totalTokens: 260, totalInputTokens: 160, totalOutputTokens: 100, totalReasoningTokens: 10,
  totalCacheReadTokens: 0, totalCacheWriteTokens: 0, totalCost: 0, totalLatencyMs: 5000,
  llmActiveMs: null, totalToolCallCount: 1, totalLlmCallCount: 2, totalSkillLoadCount: 0,
  totalSubagentCount: 0, agents: [], skills: [],
};

const rowBase = {
  role: 'assistant', agentName: null, isSubagent: false, subagentName: null, subagentSessionId: null,
  parentExecutionId: null, totalTokens: 60, inputTokens: 60, outputTokens: 0, reasoningTokens: 0,
  cacheReadTokens: 0, cacheWriteTokens: 0, inputMessagesCount: 1, inputMessagesTokens: 60,
  contextWindowPct: 12, latencyMs: 800, completedAt: null, model: 'glm-4.7', finishReason: null,
  skillEvents: [],
};
// t0 = 用户轮（来源：用户引入）；t1 带工具参数命中面（argsJson 内嵌文件路径）
// ——验证离线客户端搜索覆盖工具层字段；t2 用户轮摘要同含关键词——两路命中
// 供来源过滤收窄用例
const viewerTurns = [
  { ...rowBase, turnId: 'rop-v-t0', turnIndex: 0, role: 'user', contentSummary: '开始解析需求', createdAt: '2026-10-20T10:00:10.000Z', toolCalls: [] },
  {
    ...rowBase, turnId: 'rop-v-t1', turnIndex: 1, contentSummary: '执行构建', createdAt: '2026-10-20T10:01:10.000Z',
    reasoningTokens: 40,
    toolCalls: [{ toolCallId: 'tc1', toolName: 'Read', argsJson: '{"file_path":"/src/main.ts"}', resultJson: null, state: 'completed', durationMs: 100 }],
  },
  { ...rowBase, turnId: 'rop-v-t2', turnIndex: 2, role: 'user', contentSummary: '评审 main.ts 的改动', createdAt: '2026-10-20T10:02:10.000Z', toolCalls: [] },
  {
    ...rowBase, turnId: 'rop-v-t3', turnIndex: 3, contentSummary: '构建失败，排查退出码', createdAt: '2026-10-20T10:03:10.000Z',
    toolCalls: [{ toolCallId: 'tc3', toolName: 'Bash', argsJson: '{"cmd":"make build"}', resultJson: null, state: 'error', durationMs: 50, errorMessage: 'make: exit status 1' }],
  },
];

const detailBase = {
  role: 'assistant', content: null, contentJson: null,
  inputMessagesJson: '[{"role":"user","content":"构建"}]', inputMessagesCount: 1, inputMessagesTokens: 60,
  contextWindowPct: 12, agentName: null, subagentName: null, isSubagent: false,
  totalTokens: 60, inputTokens: 60, outputTokens: 0, reasoningTokens: 0,
  cacheReadTokens: 0, cacheWriteTokens: 0, latencyMs: 800, ttftMs: null,
  completedAt: null, model: 'glm-4.7', modelId: null, providerId: null, finishReason: null,
  toolCalls: [], skillEvents: [],
};

const fetchCalls: string[] = [];
vi.stubGlobal('fetch', vi.fn(async (url: string) => {
  fetchCalls.push(url);
  const u = new URL(url, 'http://localhost');
  const json = (body: unknown) => ({ ok: true, json: async () => body });
  if (u.pathname === '/api/observe/session' && u.searchParams.get('taskId') === 'ses_v1') {
    return json(sessionData);
  }
  if (u.pathname === '/api/observe/session/turns') {
    return json({ items: viewerTurns, total: viewerTurns.length, page: 1, pageSize: 200 });
  }
  if (u.pathname === '/api/observe/session/turns/rop-v-t0') {
    return json({ ...detailBase, turnId: 'rop-v-t0', turnIndex: 0, content: '开始解析需求', contentSummary: '开始解析需求', createdAt: '2026-10-20T10:00:10.000Z' });
  }
  if (u.pathname === '/api/observe/session/turns/rop-v-t1') {
    return json({
      ...detailBase, turnId: 'rop-v-t1', turnIndex: 1, content: '执行构建：读取 /src/main.ts', contentSummary: '执行构建', createdAt: '2026-10-20T10:01:10.000Z',
      toolCalls: viewerTurns[1].toolCalls,
    });
  }
  if (u.pathname === '/api/observe/wire-rounds' || u.searchParams.has('delta')) {
    return json({ rounds: [], total: 0 });
  }
  if (u.pathname === '/api/observe/session/file-reads') {
    return json({ files: [], totalReads: 0 });
  }
  return json({ items: [], total: 0 });
}));

let root: Root | null = null;

async function renderViewer(initialSearch = '?tab=turns') {
  searchState.current = initialSearch;
  fetchCalls.length = 0;
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(SessionExportViewer, { params: Promise.resolve({ taskId: 'ses_v1' }) }));
  });
  await act(async () => { await new Promise(r => setTimeout(r, 40)) });
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('离线查看器 Turns 搜索（客户端 matchTurnSearch 同口径）', () => {
  it('搜索驻留：摘要与工具参数同口径命中、点命中开详情不消失、✕ 退出回会话块', async () => {
    await renderViewer('?tab=turns');
    const panel = document.querySelector('[data-export-panel="true"]') ?? document;
    const input = panel.querySelector('input[placeholder="搜索本 run…"]') as HTMLInputElement;
    expect(input).toBeTruthy();

    // 工具参数命中（argsJson 内的 main.ts）——字段标签 + 工具名 + 上下文；
    // t2 摘要同含关键词 → 两路命中（工具参数 + 摘要）
    await act(async () => {
      setInputValue(input, 'main.ts');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 20));
    });
    const hits = document.querySelector('[data-turns-hits]')!;
    expect(hits).toBeTruthy();
    expect(hits.textContent).toContain('main.ts');
    expect(hits.textContent).toContain('工具参数');
    expect(hits.textContent).toContain('Read');
    expect(hits.textContent).toContain('评审 main.ts 的改动');
    // 客户端搜索零网络请求（离线档案无服务端搜索端点）
    expect(fetchCalls.some(u => u.includes('turns/search'))).toBe(false);
    // 玻璃浮层覆盖左列：会话块常驻挂载（玻璃后虚化）但被 inert 盖住
    expect(hits.className).toContain('absolute');
    // 卡片材质与 Turn 播放器顶部导航条同一配方（bg-muted/40 + blur-xl）
    const glassCard = hits.querySelector('[class*="bg-muted/40"]') as HTMLElement | null;
    expect(glassCard?.className).toContain('backdrop-blur-xl');
    expect(document.querySelector('[data-export-turn-list]')?.getAttribute('inert')).not.toBe(null);

    // 过滤面（与 run 工作台同款）：来源收窄——用户引入仅 t2 在列
    await act(async () => {
      const chip = [...document.querySelectorAll('[data-hit-filter]')].find(b => b.textContent?.includes('用户引入'))!;
      chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 20));
    });
    expect(document.querySelector('[data-turns-hits]')!.textContent).toContain('1 个命中 / 共 2');
    expect(document.querySelector('[data-hit="rop-v-t1"]')).toBeNull();
    expect(document.querySelector('[data-hit="rop-v-t2"]')).toBeTruthy();
    await act(async () => {
      const chip = [...document.querySelectorAll('[data-hit-filter]')].find(b => b.textContent?.startsWith('全部'))!;
      chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 20));
    });
    expect(document.querySelector('[data-hit="rop-v-t1"]')).toBeTruthy();

    // 点命中 → 会话轮详情端点直取 + 命中索引不消失（驻留）
    await act(async () => {
      hits.querySelector('[data-hit="rop-v-t1"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 20));
    });
    expect(fetchCalls.some(u => u === '/api/observe/session/turns/rop-v-t1')).toBe(true);
    expect(document.body.textContent).toContain('执行构建');
    expect(document.querySelector('[data-turns-hits]')).toBeTruthy();

    // ✕ 退出：浮层撤除（inert 解除、会话块回交互），命中索引消失
    await act(async () => {
      document.querySelector('[data-hits-exit]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 20));
    });
    expect(document.querySelector('[data-turns-hits]')).toBeNull();
    expect(document.querySelector('[data-export-turn-list]')?.getAttribute('inert')).toBe(null);
    expect(document.body.textContent).toContain('离线会话');

    // 摘要口径命中（正文全文不在列投影——搜你所见：摘要命中）
    await act(async () => {
      setInputValue(input, '解析');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 20));
    });
    const hits2 = document.querySelector('[data-turns-hits]')!;
    expect(hits2.textContent).toContain('开始解析需求');
    expect(hits2.textContent).toContain('摘要');
  });

  it('工具名命中（第六路）：Overview Tool Calls 面板展示的名字可直接搜到——字段标签 + 调用预览', async () => {
    await renderViewer('?tab=turns');
    const panel = document.querySelector('[data-export-panel="true"]') ?? document;
    const input = panel.querySelector('input[placeholder="搜索本 run…"]') as HTMLInputElement;

    // 'Read' 只出现在 toolName（args 的 file_path 不含 read）——纯名字命中，
    // 此前五路匹配下这里零命中（Overview 面板名字搜不到的根因回归锁）
    await act(async () => {
      setInputValue(input, 'Read');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 20));
    });
    const hits = document.querySelector('[data-turns-hits]')!;
    expect(hits).toBeTruthy();
    expect(hits.textContent).toContain('Read');
    // 字段标签落在命中条目内（过滤面 chip 也有「工具名」字样，须按条目断言）
    const hit = document.querySelector('[data-hit="rop-v-t1"]')!;
    expect(hit).toBeTruthy();
    expect(hit.textContent).toContain('工具名');
    // 上下文带调用预览（🔧 Read: {"file_path":…}）
    expect(hit.textContent).toContain('file_path');
  });

  it('全能语法离线同语义：多词 AND（摘要×工具载体）与 error:true 出错轮直列', async () => {
    await renderViewer('?tab=turns');
    const input = document.querySelector('input[placeholder="搜索本 run…"]') as HTMLInputElement;

    // 多词 AND：评审 + main.ts —— t2 摘要两词同在；t1 只有 main.ts 缺「评审」
    // （旧单词法下「评审 main.ts」按字面连串搜索零命中——最大易用性硬伤的
    // 离线侧回归锁）
    await act(async () => {
      setInputValue(input, '评审 main.ts');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 20));
    });
    const hits = document.querySelector('[data-turns-hits]')!;
    expect(hits).toBeTruthy();
    expect(hits.textContent).toContain('1 个命中');
    expect(document.querySelector('[data-hit="rop-v-t2"]')).toBeTruthy();
    expect(document.querySelector('[data-hit="rop-v-t1"]')).toBeNull();

    // error:true —— 不知道错误文本也能直列出错轮（离线档案工具错误面透传，
    // 此前列投影不含 errorMessage，离线侧错误路永久降级）
    await act(async () => {
      setInputValue(input, 'error:true');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 20));
    });
    const hits2 = document.querySelector('[data-turns-hits]')!;
    expect(hits2.textContent).toContain('1 个命中');
    expect(document.querySelector('[data-hit="rop-v-t3"]')).toBeTruthy();
    expect(document.querySelector('[data-hit="rop-v-t1"]')).toBeNull();
  });

  it('一框两语法：#数字直达会话内轮次；未命中给提示', async () => {
    await renderViewer('?tab=turns');
    const input = document.querySelector('input[placeholder="搜索本 run…"]') as HTMLInputElement;

    // #9 不存在 → 提示（不换选、零请求）
    await act(async () => {
      setInputValue(input, '#9');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 20));
    });
    expect(document.querySelector('[data-search-note]')?.textContent).toContain('未找到第 9 轮');

    // #0 → 直达会话第 0 轮（详情端点直取）
    await act(async () => {
      setInputValue(input, '#0');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 20));
    });
    expect(fetchCalls.some(u => u === '/api/observe/session/turns/rop-v-t0')).toBe(true);
    expect(document.body.textContent).toContain('开始解析需求');
    expect(document.querySelector('[data-search-note]')).toBeNull();
  });
});
