// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// run-first 刀J2 离线导出 IT：export-html 装配层从 run 成员视图端点取数、按
// session 路径/URL 键存档（export-view entry.tsx 的 fetch 拦截器按 session URL
// 匹配）——键契约是离线 bundle 的存活不变量，锁死映射防漂移。

import { describe, it, expect, vi, afterEach } from 'vitest';
import { gatherExportData, assembleEmbeddedHtml, urlKeyOf } from '@/lib/observe/export-html';

const json = (body: unknown) => ({ ok: true, json: () => Promise.resolve(body) });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('run-first 刀J2：离线导出装配（run 取数 → session 键存档）', () => {
  it('gatherExportData：核心端点取 run 成员视图 URL，按 session 路径键存档', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', (u: string) => {
      calls.push(u);
      if (u.endsWith('/member-detail')) {
        return Promise.resolve(json({
          taskId: 'exp-t1',
          skills: [{ skillName: 's1' }],
          agents: [{ agentName: 'a1', isSubagent: true }],
        }));
      }
      return Promise.resolve(json({ ok: true }));
    });

    const { data, param } = await gatherExportData('solo:exp-t1', 'exp-t1', 'claude-code');

    // 取数侧：全部走 run 成员视图端点（member 闸由 solo 单成员自动满足）
    expect(calls).toContain('/api/observe/run/solo%3Aexp-t1/member-detail');
    expect(calls).toContain('/api/observe/run/solo%3Aexp-t1/member-turns');
    expect(calls).toContain('/api/observe/run/solo%3Aexp-t1/bridges');
    expect(calls).toContain('/api/observe/run/solo%3Aexp-t1/workflow');
    expect(calls).toContain('/api/observe/run/solo%3Aexp-t1/file-reads');
    expect(calls).toContain('/api/observe/executions?taskId=exp-t1');
    expect(calls).toContain('/api/observe/stats?taskId=exp-t1');
    expect(calls.some(u => u.includes('/api/observe/session'))).toBe(false);

    // 存档侧：键 = session 路径（离线拦截器按 path 匹配，容忍 query 差异）
    expect(Object.keys(data)).toContain('/api/observe/session');
    expect(Object.keys(data)).toContain('/api/observe/session/turns');
    expect(Object.keys(data)).toContain('/api/observe/session/bridges');
    expect(Object.keys(data)).toContain('/api/observe/session/workflow');
    expect(Object.keys(data)).toContain('/api/observe/session/file-reads');
    expect(Object.keys(data)).toContain('/api/observe/session/skill-content-audit');
    expect(Object.keys(data)).toContain('/api/observe/session/llm-workflow-extract');
    expect((data['/api/observe/session'] as { taskId: string }).taskId).toBe('exp-t1');

    // per-参数端点：键 = 完整 session URL 归一化（与 entry.tsx urlKey 一致）
    expect(Object.keys(param)).toContain(urlKeyOf('/api/observe/session/skill-content?taskId=exp-t1&skillName=s1'));
    expect(Object.keys(param)).toContain(
      urlKeyOf('/api/observe/session/agent-content?taskId=exp-t1&agentName=a1&framework=claude-code'),
    );
  });

  it('assembleEmbeddedHtml：数据全局内联，</script 序列鲁棒转义', () => {
    const html = assembleEmbeddedHtml(
      'body{}',
      'console.log(1)',
      'exp-t1',
      'claude-code',
      { data: { '/api/observe/session': { evil: '</script><b>x' } }, param: {}, skillAudits: {} },
    );
    expect(html).toContain('window.__EXPORT_TASK_ID = "exp-t1";');
    expect(html).toContain('window.__EXPORT_FRAMEWORK = "claude-code";');
    expect(html).toContain('window.__EXPORT_DATA =');
    expect(html).toContain('window.__EXPORT_PARAM =');
    expect(html).toContain('window.__EXPORT_SKILL_AUDITS =');
    expect(html).toContain('<\\/script>');
    expect(html).not.toMatch(/<\/script><b>/);
  });

  it('urlKeyOf：path + 排序后 query 归一化（与离线拦截器匹配键一致）', () => {
    expect(urlKeyOf('/api/observe/session/turns?taskId=a&keyword=b')).toBe(
      '/api/observe/session/turns?keyword=b&taskId=a',
    );
    expect(urlKeyOf('/api/observe/session')).toBe('/api/observe/session');
  });
});
