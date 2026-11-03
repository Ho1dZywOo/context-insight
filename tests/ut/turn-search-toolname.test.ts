// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 轮次搜索 collector 单测——工具名第六路匹配（跨页签可发现性回归锁）：
// Overview 的 Tool Calls 面板把 toolName 当第一性标签展示（尤其 MCP 工具，
// 名字不出现在 args/result 里）；此前搜索五路不含工具名，搜面板里的名字
// 零命中。锁六点：纯名字命中 / 名字子串（MCP 前缀）/ 载体优先级（args
// 胜名）/ 正文命中去重 / 每次调用一条 / 空载体上下文形态。

import { describe, it, expect } from 'vitest';
import { matchTurnSearch, type TurnSearchRow } from '@/lib/observe/collectors/search';

function row(partial: Partial<TurnSearchRow> & Pick<TurnSearchRow, 'id'>): TurnSearchRow {
  return {
    sessionId: 'ses_x',
    turnIndex: 0,
    role: 'assistant',
    content: null,
    contentSummary: null,
    agentName: null,
    isSubagent: false,
    subagentName: null,
    subagentSessionId: null,
    createdAt_ts: new Date('2026-11-03T08:00:00Z'),
    createdAt: new Date('2026-11-03T08:00:00Z'),
    toolCalls: [],
    ...partial,
  } as TurnSearchRow;
}

describe('matchTurnSearch 工具名路（第六路）', () => {
  it('纯名字命中：MCP 工具名不出现在 args/result 里也可搜到，字段 toolName + 上下文带调用预览', () => {
    const rows = [row({
      id: 't1',
      toolCalls: [{
        toolCallId: 'tc1',
        toolName: 'mcp__codebase-memory-mcp__search_graph',
        dispatchBridgeId: null,
        argsJson: '{"query":"调用图"}',
        resultJson: '{"nodes":3}',
        errorMessage: null,
      }],
    })];
    const items = matchTurnSearch(rows, 'search_graph');
    expect(items).toHaveLength(1);
    expect(items[0].matchField).toBe('toolName');
    expect(items[0].toolName).toBe('mcp__codebase-memory-mcp__search_graph');
    // 上下文 = 🔧 全名 + 载体预览（名字即查询词，预览展示调的是什么）
    expect(items[0].matchContext).toContain('mcp__codebase-memory-mcp__search_graph');
    expect(items[0].matchContext).toContain('query');
  });

  it('名字子串命中：搜 MCP 服务器前缀（codebase-memory）命中同前缀全部工具', () => {
    const rows = [row({
      id: 't1',
      toolCalls: [
        { toolCallId: 'tc1', toolName: 'mcp__codebase-memory-mcp__search_graph', dispatchBridgeId: null, argsJson: null, resultJson: null, errorMessage: null },
        { toolCallId: 'tc2', toolName: 'mcp__codebase-memory-mcp__get_code_snippet', dispatchBridgeId: null, argsJson: null, resultJson: null, errorMessage: null },
        { toolCallId: 'tc3', toolName: 'Read', dispatchBridgeId: null, argsJson: null, resultJson: null, errorMessage: null },
      ],
    })];
    const items = matchTurnSearch(rows, 'codebase-memory');
    // 每次调用一条（两次 search 系调用各一条），无关工具不命中
    expect(items).toHaveLength(2);
    expect(items.every(i => i.matchField === 'toolName')).toBe(true);
    expect(new Set(items.map(i => i.toolName)).size).toBe(2);
    // 空载体：上下文退化为纯名字（不带尾随冒号）
    expect(items[0].matchContext.startsWith('🔧 mcp__codebase-memory-mcp__')).toBe(true);
    expect(items[0].matchContext).not.toMatch(/:\s*$/);
  });

  it('载体优先级：关键词同时命中名字与 args 时走 toolArgs（载体上下文更具体）', () => {
    const rows = [row({
      id: 't1',
      toolCalls: [{
        toolCallId: 'tc1',
        toolName: 'Read',
        dispatchBridgeId: null,
        argsJson: '{"file_path":"/src/readme.md"}',
        resultJson: null,
        errorMessage: null,
      }],
    })];
    const items = matchTurnSearch(rows, 'read');
    expect(items).toHaveLength(1);
    expect(items[0].matchField).toBe('toolArgs');
  });

  it('同 turn 去重：正文已命中则不再出工具名条目（既有语义对第六路同样生效）', () => {
    const rows = [row({
      id: 't1',
      content: '用 Read 工具读取文件',
      toolCalls: [{
        toolCallId: 'tc1',
        toolName: 'Read',
        dispatchBridgeId: null,
        argsJson: null,
        resultJson: null,
        errorMessage: null,
      }],
    })];
    const items = matchTurnSearch(rows, 'read');
    expect(items).toHaveLength(1);
    expect(items[0].matchField).toBe('content');
  });

  it('run 作用域 member 归因对工具名命中同样附挂', () => {
    const rows = [row({
      id: 't1',
      sessionId: 'ses_m1',
      toolCalls: [{
        toolCallId: 'tc1',
        toolName: 'mcp__codebase-memory-mcp__list_projects',
        dispatchBridgeId: null,
        argsJson: null,
        resultJson: null,
        errorMessage: null,
      }],
    })];
    const items = matchTurnSearch(rows, 'list_projects', {
      memberOf: sid => sid === 'ses_m1' ? { taskId: 'task_m1', label: '成员一' } : null,
    });
    expect(items).toHaveLength(1);
    expect(items[0].member).toEqual({ taskId: 'task_m1', label: '成员一' });
  });
});
