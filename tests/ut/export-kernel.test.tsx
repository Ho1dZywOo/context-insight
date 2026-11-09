// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 离线内核 IT（run 工作台自身即离线查看器）：成员富轮仓是四个动态合成器
// 的单一数据源——①run turns 分页（member 过滤 + offset/page 切片 +
// errorDigest 预算，与服务端 collector 同口径）②turns/search（服务端同一
// matchTurnSearch 单点 + 成员归因）③turns/by-index（#N 跨成员）④turn 详情
// （形状映射 + 输入窗口重建——与 turn-detail 处理器同一 input-reconstruct
// 纯函数，离线详情不再是缺口）。fetch 拦截链按序应答，键契约锁死。

import { describe, it, expect, vi } from 'vitest';
import {
  createOfflineFetch,
  synthesizeRunTurns,
  synthesizeSearch,
  synthesizeByIndex,
  type OfflineMemberTurns,
  type MemberTurnItem,
} from '@/export-view/offline-kernel';
import { urlKeyOf } from '@/lib/observe/export-html';

const itemBase = {
  role: 'assistant', agentName: null, isSubagent: false, subagentName: null, subagentSessionId: null,
  subagentType: null, dispatchStep: null, parentExecutionId: null,
  totalTokens: 60, inputTokens: 60, outputTokens: 20, reasoningTokens: 0,
  cacheReadTokens: 0, cacheWriteTokens: 0, inputMessagesCount: 1, inputMessagesTokens: 100,
  contextWindowPct: 12, systemOverheadTokens: 0, latencyMs: 800, turnMs: 800,
  completedAt: null, model: 'glm-4.7', ttftMs: null, modelId: null, providerId: null,
  contextWindowLimit: 128000, finishReason: null, skillEvents: [],
};
const item = (over: Partial<MemberTurnItem> & { turnId: string; turnIndex: number; createdAt: string }): MemberTurnItem => ({
  ...itemBase,
  content: null, contentJson: null, contentSummary: null,
  toolCalls: [],
  ...over,
} as MemberTurnItem);

// m1：t0 用户提问 → t1 助手带工具调用（args 含文件路径）→ t2 助手错误轮
// （state=error + resultJson 带 Exit code 标记）
const m1Turns: MemberTurnItem[] = [
  item({
    turnId: 't0', turnIndex: 0, role: 'user', createdAt: '2026-10-20T10:00:10.000Z',
    content: '构建演示项目', contentSummary: '开始解析需求', inputMessagesTokens: 0, totalTokens: 20,
  }),
  item({
    turnId: 't1', turnIndex: 1, createdAt: '2026-10-20T10:01:10.000Z',
    content: '读取 /src/main.ts', contentSummary: '执行构建',
    toolCalls: [{ toolCallId: 'tc1', toolName: 'Read', dispatchBridgeId: null, argsJson: '{"file_path":"/src/main.ts"}', resultJson: 'file content', state: 'completed', durationMs: 100, isSkillRelated: false }],
  }),
  item({
    turnId: 't2', turnIndex: 2, createdAt: '2026-10-20T10:03:10.000Z',
    contentSummary: '构建失败', finishReason: null,
    toolCalls: [{ toolCallId: 'tc2', toolName: 'Bash', dispatchBridgeId: null, argsJson: '{"cmd":"make"}', resultJson: 'Exit code 2', state: 'error', errorType: 'exit', errorMessage: 'make: exit 2', durationMs: 50, isSkillRelated: false }],
  }),
];
const m2Turns: MemberTurnItem[] = [
  item({
    turnId: 'u1', turnIndex: 1, createdAt: '2026-10-20T09:00:00.000Z',
    content: '成员二：main.ts 复核', contentSummary: '复核', totalTokens: 30,
  }),
];

const members: OfflineMemberTurns[] = [
  { member: { taskId: 'exp-t1', label: 'alpha' }, sessionId: 'exp-t1', framework: 'claude-code', items: m1Turns },
  { member: { taskId: 'exp-t2', label: 'beta' }, sessionId: 'exp-t2', framework: 'opencode', items: m2Turns },
];

const q = (s: string) => new URLSearchParams(s);

describe('合成器①：run turns 分页（MergedTurnItem 投影）', () => {
  it('跨成员按事件时间混排 + member 归因 + offset/page 切片', () => {
    const all = synthesizeRunTurns(members, q('page=1&pageSize=2'));
    expect(all.total).toBe(4);
    expect(all.items.map(i => i.turnId)).toEqual(['u1', 't0']);
    expect(all.items[0].member).toEqual({ taskId: 'exp-t2', label: 'beta' });

    const p2 = synthesizeRunTurns(members, q('page=2&pageSize=2'));
    expect(p2.items.map(i => i.turnId)).toEqual(['t1', 't2']);

    const off = synthesizeRunTurns(members, q('offset=1&pageSize=2'));
    expect(off.items.map(i => i.turnId)).toEqual(['t0', 't1']);

    const scoped = synthesizeRunTurns(members, q('member=exp-t1&pageSize=200'));
    expect(scoped.total).toBe(3);
    expect(scoped.items.every(i => i.member?.taskId === 'exp-t1')).toBe(true);
  });

  it('includeErrorDigest=true 才附错误摘要（error 轮，Exit code 原文口径）', () => {
    const withDigest = synthesizeRunTurns(members, q('page=1&pageSize=200&includeErrorDigest=true'));
    const t2 = withDigest.items.find(i => i.turnId === 't2');
    expect(t2?.errorDigest?.total).toBe(1);
    expect(t2?.errorDigest?.messages[0]).toEqual({ toolName: 'Bash', message: 'exit 2' });

    const plain = synthesizeRunTurns(members, q('page=1&pageSize=200'));
    expect(plain.items.find(i => i.turnId === 't2')?.errorDigest).toBeUndefined();
  });

  it('includeToolResult=false 剥离 toolCalls.resultJson（重负载字段不进轻列表）', () => {
    const plain = synthesizeRunTurns(members, q('page=1&pageSize=200'));
    const t1 = plain.items.find(i => i.turnId === 't1');
    expect(t1?.toolCalls[0]).not.toHaveProperty('resultJson');
    const rich = synthesizeRunTurns(members, q('page=1&pageSize=200&includeToolResult=true'));
    expect(rich.items.find(i => i.turnId === 't1')?.toolCalls[0].resultJson).toBe('file content');
  });
});

describe('合成器②：turns/search（服务端同一 matchTurnSearch 单点）', () => {
  it('工具参数六路匹配 + 成员归因', () => {
    const hit = synthesizeSearch(members, 'main.ts');
    expect(hit.total).toBe(2);
    expect(hit.items.map(i => i.turnId).sort()).toEqual(['t1', 'u1']);
    const t1 = hit.items.find(i => i.turnId === 't1');
    expect(t1?.member).toEqual({ taskId: 'exp-t1', label: 'alpha' });
  });

  it('content 命中面 + error:true 布尔算子（出错轮排查）', () => {
    expect(synthesizeSearch(members, '构建演示项目').items.map(i => i.turnId)).toEqual(['t0']);
    expect(synthesizeSearch(members, 'error:true').total).toBe(1);
    expect(synthesizeSearch(members, 'error:true').items[0].turnId).toBe('t2');
  });
});

describe('合成器③：turns/by-index（#N 跨成员解析，成员序）', () => {
  it('同号轮跨成员并列 + contentSummary 摘要', () => {
    const r = synthesizeByIndex(members, 1);
    expect(r.items).toEqual([
      { turnId: 't1', memberTaskId: 'exp-t1', memberLabel: 'alpha', contentSummary: '执行构建' },
      { turnId: 'u1', memberTaskId: 'exp-t2', memberLabel: 'beta', contentSummary: '复核' },
    ]);
  });
  it('缺号返回空（404 语义由端点层表达）', () => {
    expect(synthesizeByIndex(members, 9).items).toEqual([]);
  });
});

describe('fetch 拦截链（静态档案 → 动态合成器 → catch-all）', () => {
  const archive: Record<string, unknown> = {
    [urlKeyOf('/api/observe/run/run%3Aexp/context')]: { contextWindow: 1 },
    [urlKeyOf('/api/observe/run/run%3Aexp/scorecard?taskId=exp-t1&framework=claude-code&member=exp-t1')]: { totalScore: 0.9 },
  };
  const orig = vi.fn(async () => new Response('passthrough'));
  const offlineFetch = createOfflineFetch(members, archive, 'run:exp', orig as unknown as typeof fetch);
  const get = async (u: string) => {
    const res = await offlineFetch(u);
    return { status: res.status, body: await res.json() };
  };

  it('①静态档案精确 URL 键应答（query 顺序容忍）', async () => {
    const r = await get('/api/observe/run/run%3Aexp/context');
    expect(r.body).toEqual({ contextWindow: 1 });
    const sc = await get('/api/observe/run/run%3Aexp/scorecard?framework=claude-code&member=exp-t1&taskId=exp-t1');
    expect(sc.body).toEqual({ totalScore: 0.9 });
  });

  it('②member-turns 任意 query 形态直供富轮仓（Replay 零改动消费）', async () => {
    const r = await get('/api/observe/run/run%3Aexp/member-turns?member=exp-t1&includeContent=true&includeToolDetail=true');
    expect(r.body.items.map((i: { turnId: string }) => i.turnId)).toEqual(['t0', 't1', 't2']);
  });

  it('③④turns/search/by-index 走合成器', async () => {
    const s = await get('/api/observe/run/run%3Aexp/turns/search?keyword=main.ts');
    expect(s.body.total).toBe(2);
    const b = await get('/api/observe/run/run%3Aexp/turns/by-index?index=1');
    expect(b.body.items.length).toBe(2);
  });

  it('⑤turn 详情：输入窗口重建（服务端同一纯函数）+ 工具/形状映射', async () => {
    const r = await get('/api/observe/turn/t1');
    expect(r.body.turnId).toBe('t1');
    expect(r.body.taskId).toBe('exp-t1');
    // 重建的输入窗口：先验用户轮进列表（token 估算 = 字符数/3.5），目标轮自身不在窗口
    const msgs = JSON.parse(r.body.inputMessagesJson);
    expect(msgs).toEqual([{ role: 'user', content: '构建演示项目', tokenCount: Math.round('构建演示项目'.length / 3.5) }]);
    expect(r.body.inputMessagesCount).toBe(1);
    expect(r.body.toolCalls[0]).toMatchObject({ toolName: 'Read', argsJson: '{"file_path":"/src/main.ts"}', state: 'completed' });
    // 用户轮：无输入窗口（非 assistant）
    const r0 = await get('/api/observe/turn/t0');
    expect(r0.body.inputMessagesJson).toBeNull();
    // 未知轮：404
    const miss = await offlineFetch('/api/observe/turn/nope');
    expect(miss.status).toBe(404);
  });

  it('⑥未知 /api/*（auto-refresh 探针/写动作）空 200 防悬挂；非 /api 直通原 fetch', async () => {
    const probe = await offlineFetch('/api/observe/run/run%3Aexp/auto-refresh');
    expect(probe.status).toBe(200);
    await expect(probe.json()).rejects.toThrow();
    await offlineFetch('/api/observe/run/run%3Aexp/audit', { method: 'POST' });
    expect(orig).not.toHaveBeenCalled();
    await offlineFetch('/export-view.js');
    expect(orig).toHaveBeenCalled();
  });
});
