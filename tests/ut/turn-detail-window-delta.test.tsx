// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License");
// Please refer to the License for details. Do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// TurnDetail 窗口瓦片「较上轮」徽标行为锁（口径由 upstream #39 定稿）：
// ① 只显绝对增量（▲/▼）——同比百分比已删（分母是单调累积的存量基数，
// 近零基数恒 +100%，跨轮不可比，是伪装成信息的噪声）；② 比较口径为
// 输入合计（新输入 + 缓存读 + 缓存写）与上一 assistant 轮同口径比较；
// ③ assistant 门——用户/系统轮不显环比；④ 首轮（无上轮）不显徽标。
import { describe, it, expect, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TurnDetail, type TurnDetailData } from '@/components/observe/TurnDetail';

const baseTurn: TurnDetailData = {
  turnId: 't1',
  turnIndex: 2,
  role: 'assistant',
  content: '正文',
  contentJson: null,
  contentSummary: null,
  inputMessagesJson: null,
  inputMessagesCount: 0,
  inputMessagesTokens: 0,
  contextWindowPct: null,
  agentName: 'agent',
  subagentName: null,
  subagentSessionId: null,
  isSubagent: false,
  totalTokens: 524110,
  inputTokens: 524100,
  outputTokens: 10,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  contextWindowLimit: 1000000,
  latencyMs: 100,
  ttftMs: null,
  createdAt: null,
  completedAt: null,
  model: 'test-model',
  modelId: null,
  providerId: null,
  finishReason: null,
  toolCalls: [],
  skillEvents: [],
};

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  host?.remove();
  host = null;
});

function renderDetail(props: { turn: TurnDetailData; prevTotalInputTokens?: number | null }): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(createElement(TurnDetail, {
      turn: props.turn,
      prevTotalInputTokens: props.prevTotalInputTokens ?? null,
    }));
  });
  return host;
}

function deltaBadge(container: HTMLElement): HTMLElement | null {
  for (const el of container.querySelectorAll('span')) {
    if (el.textContent?.includes('较上轮')) return el;
  }
  return null;
}

describe('TurnDetail 窗口瓦片「较上轮」徽标行为锁', () => {
  it('近零基数暴涨：只显绝对增量 ▲ 524.0k，无 (+100%) 同比噪声', () => {
    const el = renderDetail({ turn: baseTurn, prevTotalInputTokens: 100 });
    const badge = deltaBadge(el);
    expect(badge).toBeTruthy();
    expect(badge!.textContent).toBe('较上轮 ▲ 524.0k');
    expect(badge!.textContent).not.toContain('%');
    expect(badge!.textContent).not.toContain('(');
  });

  it('同口径：输入合计含缓存读/写（新输入 100k + 缓存读 400k + 缓存写 1k → ▲ 401.0k）', () => {
    const el = renderDetail({
      turn: { ...baseTurn, inputTokens: 100000, cacheReadTokens: 400000, cacheWriteTokens: 1000, totalTokens: 501010 },
      prevTotalInputTokens: 100000,
    });
    expect(deltaBadge(el)!.textContent).toBe('较上轮 ▲ 401.0k');
  });

  it('上下文缩减（如压缩/摘要轮）：▼ 如实标出', () => {
    const el = renderDetail({
      turn: { ...baseTurn, inputTokens: 0, totalTokens: 0 },
      prevTotalInputTokens: 100000,
    });
    expect(deltaBadge(el)!.textContent).toBe('较上轮 ▼ 100.0k');
  });

  it('assistant 门：非 assistant 轮不显环比', () => {
    const el = renderDetail({
      turn: { ...baseTurn, role: 'user' },
      prevTotalInputTokens: 100000,
    });
    expect(deltaBadge(el)).toBeNull();
  });

  it('首轮（无同 agent 上轮）不显徽标', () => {
    const el = renderDetail({ turn: baseTurn, prevTotalInputTokens: null });
    expect(deltaBadge(el)).toBeNull();
  });
});
