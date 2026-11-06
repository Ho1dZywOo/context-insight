// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// run 工作台离线导出 IT（run 工作台自身即离线查看器）：gather 按工作台
// 同一 URL 构造器取数（run 级端点 + runMemberUrlFor 成员视图）、成员富轮仓
// 与静态档案分离、对账结果 sessionStorage 迁移——URL/键契约是离线内核
// fetch 应答的存活不变量，锁死映射防漂移。

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { gatherRunExportData, assembleEmbeddedHtml, urlKeyOf } from '@/lib/observe/export-html';

const sessionRef = {
  taskId: 'exp-t1', framework: 'claude-code', rowId: 'row-1', turns: 3, totalTokens: 120,
  durationMs: 1000, label: 'l', startTime: null, endTime: null,
  cacheReadTokens: 0, sourcePath: null,
};
const memberRef = {
  memberId: 'm1', kind: 'execute', role: 'execute', name: 'n', note: null,
  sessionId: 'exp-t1', location: null, startedAt: null, finishedAt: null,
  session: sessionRef,
};
const viewModel = {
  runId: 'run:exp', name: 'exp', status: 'passed', exportDataComplete: true,
  startedAt: null, finishedAt: null, generations: [1],
  nodes: [{
    key: 'n-a-g1', nodeId: 'a', generation: 1, label: 'a', taskType: 'agent',
    status: 'passed', executionState: 'executed', carriedFromGeneration: null,
    attempts: [{
      ordinal: 1, status: 'passed', startedAt: null, finishedAt: null, outputText: null,
      verification: { type: 't', status: 's', reason: null },
      executeMember: memberRef, verifyMember: null,
    }],
    pendingMembers: [],
    retryPolicy: null, runOnFailure: null, predecessorKeys: [], parentKey: null, hasSubgraph: false,
  }],
  rollbacks: [],
  views: [{
    id: 'main', title: '主图', parentKey: null, nodeKeys: ['n-a-g1'], ranks: {},
    edges: [], edgeChains: [], rollbackLinks: [],
    layout: { bands: [], positions: {}, width: 0, height: 0 },
  }],
  warnings: [],
};

const json = (body: unknown) => ({ ok: true, json: () => Promise.resolve(body) });
let calls: string[] = [];

beforeEach(() => {
  calls = [];
  sessionStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('run 工作台离线导出：gather（工作台同一 URL 构造器取数）', () => {
  it('run 级端点 + 成员视图端点全量取数；file-restore 按清单枚举', async () => {
    vi.stubGlobal('fetch', (u: string) => {
      calls.push(u);
      if (u === '/api/observe/run/run%3Aexp') return Promise.resolve(json({ run: { runId: 'run:exp', kind: 'run' }, viewModel }));
      if (u.includes('/file-reads')) return Promise.resolve(json({ files: [{ filePath: '/a/b.ts' }, { filePath: '/a/b.ts' }], summary: {} }));
      if (u.includes('/member-detail')) {
        return Promise.resolve(json({
          taskId: 'exp-t1',
          skills: [{ skillName: 's1' }],
          agents: [{ agentName: 'a1', isSubagent: true }, { agentName: null, isSubagent: false }],
        }));
      }
      if (u.includes('/member-turns')) return Promise.resolve(json({ items: [{ turnId: 't0' }], total: 1 }));
      return Promise.resolve(json({ ok: true }));
    });

    const payload = await gatherRunExportData('run:exp');

    // run 级聚合端点
    for (const ep of ['executions', 'skills', 'bridges', 'context', 'lanes', 'file-reads']) {
      expect(calls).toContain(`/api/observe/run/run%3Aexp/${ep}`);
    }
    // 文件还原：file-reads 清单去重枚举
    expect(calls.filter(u => u.includes('/file-restore'))).toEqual([
      '/api/observe/run/run%3Aexp/file-restore?filePath=%2Fa%2Fb.ts',
    ]);
    // 成员域：富轮仓三投影旗 + 转发端点（与 UI 同一 runMemberUrlFor 构造）
    expect(calls).toContain('/api/observe/run/run%3Aexp/member-turns?includeContent=true&includeToolDetail=true&includeMeta=true&member=exp-t1');
    expect(calls).toContain('/api/observe/run/run%3Aexp/turn-digest?member=exp-t1');
    expect(calls).toContain('/api/observe/run/run%3Aexp/main-agent-workflow?member=exp-t1');
    expect(calls).toContain('/api/observe/run/run%3Aexp/scorecard?taskId=exp-t1&framework=claude-code&member=exp-t1');
    expect(calls).toContain('/api/observe/run/run%3Aexp/mate-agent?member=exp-t1');
    expect(calls).toContain('/api/observe/run/run%3Aexp/skill-content?taskId=exp-t1&skillName=s1&member=exp-t1');
    expect(calls).toContain('/api/observe/run/run%3Aexp/agent-content?taskId=exp-t1&agentName=a1&framework=claude-code&member=exp-t1');
    // 不再触碰退役的 session 端点
    expect(calls.some(u => u.includes('/api/observe/session'))).toBe(false);

    // 静态档案：精确 URL 键（含 run 详情自身）
    expect(Object.keys(payload.archive)).toContain('/api/observe/run/run%3Aexp');
    expect(Object.keys(payload.archive)).toContain(urlKeyOf('/api/observe/run/run%3Aexp/scorecard?taskId=exp-t1&framework=claude-code&member=exp-t1'));
    expect(Object.keys(payload.archive)).toContain(urlKeyOf('/api/observe/run/run%3Aexp/file-restore?filePath=%2Fa%2Fb.ts'));

    // 成员富轮仓：合成器的单一数据源（成员归因 + framework + items 原样）
    expect(payload.memberTurns).toEqual([{
      member: { taskId: 'exp-t1', label: expect.any(String) },
      sessionId: 'exp-t1',
      framework: 'claude-code',
      items: [{ turnId: 't0' }],
    }]);
  });

  it('对账结果迁移：run-audit 前缀全收、_html 剥离、skill-audit 按成员前缀收', async () => {
    vi.stubGlobal('fetch', (u: string) => {
      calls.push(u);
      if (u === '/api/observe/run/run%3Aexp') return Promise.resolve(json({ run: { runId: 'run:exp', kind: 'run' }, viewModel }));
      return Promise.resolve(json({ files: [], summary: {} }));
    });
    sessionStorage.setItem(`run-audit-run:exp-skill-s1`, JSON.stringify({ verdict: 'pass', _html: '<b>big</b>' }));
    sessionStorage.setItem('run-audit-other-run-skill-x', JSON.stringify({ verdict: 'pass' }));
    sessionStorage.setItem(`skill-audit-exp-t1-agent-a1`, JSON.stringify({ ok: 1, _html: 'x' }));
    sessionStorage.setItem('unrelated-key', 'v');

    const payload = await gatherRunExportData('run:exp');
    expect(payload.audits['run-audit-run:exp-skill-s1']).toBe(JSON.stringify({ verdict: 'pass' }));
    expect(payload.audits['skill-audit-exp-t1-agent-a1']).toBe(JSON.stringify({ ok: 1 }));
    expect(Object.keys(payload.audits)).not.toContain('run-audit-other-run-skill-x');
    expect(Object.keys(payload.audits)).not.toContain('unrelated-key');
  });

  it('单端点失败容忍：member-turns 失败记空仓（该成员离线降级不阻塞导出）', async () => {
    vi.stubGlobal('fetch', (u: string) => {
      calls.push(u);
      if (u === '/api/observe/run/run%3Aexp') return Promise.resolve(json({ run: { runId: 'run:exp', kind: 'run' }, viewModel }));
      if (u.includes('/member-turns')) return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'boom' }) });
      if (u.includes('/scorecard')) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ error: 'no' }) });
      return Promise.resolve(json({ ok: true }));
    });
    const payload = await gatherRunExportData('run:exp');
    expect(payload.memberTurns[0].items).toEqual([]);
    // 失败端点不入档案（离线侧该能力缺位而非坏数据）
    expect(Object.keys(payload.archive)).not.toContain(urlKeyOf('/api/observe/run/run%3Aexp/scorecard?taskId=exp-t1&framework=claude-code&member=exp-t1'));
  });
});

describe('run 工作台离线导出：assemble（档案全局内联）', () => {
  it('四个全局 + </script 序列鲁棒转义', () => {
    const html = assembleEmbeddedHtml(
      'body{}',
      'console.log(1)',
      'run:exp',
      '演示 run',
      {
        archive: { '/api/observe/run/run%3Aexp': { evil: '</script><b>x' } },
        memberTurns: [{ member: { taskId: 't', label: null }, sessionId: 't', framework: null, items: [] }],
        audits: {},
      },
    );
    expect(html).toContain('window.__EXPORT_RUN_ID = "run:exp";');
    expect(html).toContain('window.__EXPORT_ARCHIVE =');
    expect(html).toContain('window.__EXPORT_MEMBER_TURNS =');
    expect(html).toContain('window.__EXPORT_AUDITS =');
    expect(html).toContain('演示 run');
    expect(html).toContain('<\\/script>');
    expect(html).not.toMatch(/<\/script><b>/);
  });

  it('urlKeyOf：path + 排序后 query 归一化（与离线内核匹配键一致）', () => {
    expect(urlKeyOf('/api/observe/run/x/turns?member=a&pageSize=200')).toBe(
      '/api/observe/run/x/turns?member=a&pageSize=200',
    );
    expect(urlKeyOf('/api/observe/run/x/turns?pageSize=200&member=a')).toBe(
      '/api/observe/run/x/turns?member=a&pageSize=200',
    );
    expect(urlKeyOf('/api/observe/run/x')).toBe('/api/observe/run/x');
  });
});
