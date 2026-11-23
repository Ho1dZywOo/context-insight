// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// claude-jsonl 子代理关联映射（collectSubagentLinkageMaps）+ meta 规范 id
// 语义声明（idSource）的适配器 IT。与 cpx claude-linkage 的 meta 契约
//（claudeAgentId / task / idSource 幂等升级写）互为镜像：捕获端写什么，
// 这里读什么、解析成哪条精确连接键。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listSubagentSessions, collectSubagentLinkageMaps } from '../../src/lib/ingest/adapters/claude-jsonl.ts';

let dir: string;
let mainFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-linkage-maps-'));
  mainFile = path.join(dir, 'cpx-sess1.jsonl');
  fs.writeFileSync(mainFile, '');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// 会话的子代理目录（beforeEach 里再拼——dir 是 mkdtemp 产物，模块顶层不可用）
const subsDir = (): string => path.join(dir, 'sess1', 'subagents');

function writeSub(id: string, lines: object[], meta?: object): void {
  fs.mkdirSync(subsDir(), { recursive: true });
  fs.writeFileSync(path.join(subsDir(), `${id}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  if (meta) fs.writeFileSync(path.join(subsDir(), `${id}.meta.json`), JSON.stringify(meta));
}

const claudeMeta = (over: Record<string, unknown>) => ({
  toolUseId: 'toolu_x', name: '研究', agentType: 'Explore',
  ...over,
  x_lake: { schema: 'cc-subagent-meta', version: 1, data: { toolUseId: 'toolu_x', name: '研究', agentType: 'Explore', subagentSessionId: 'sub-aaa', ...over } },
});

describe('collectSubagentLinkageMaps：三条精确连接键', () => {
  it('新契约 claude meta：toolUseId / claudeAgentId / task 三键齐发，规范 id 恒为文件名', () => {
    writeSub('sub-aaa', [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '任务全文' }] }, timestamp: '2026-03-01T00:00:00Z' },
    ], claudeMeta({ claudeAgentId: 'a98641f58960793f1', task: '任务全文', idSource: 'fileStem' }));

    const subs = listSubagentSessions(mainFile, 'sess1');
    expect(subs[0]!.id).toBe('sub-aaa'); // claudeAgentId 不顶替规范 id
    expect(subs[0]!.claudeAgentId).toBe('a98641f58960793f1');
    expect(subs[0]!.task).toBe('任务全文');

    const maps = collectSubagentLinkageMaps(mainFile, 'sess1');
    expect(maps.toolUseIdToSessionId.get('toolu_x')).toBe('sub-aaa');
    expect(maps.claudeAgentIdToSessionId.get('a98641f58960793f1')).toBe('sub-aaa');
    expect(maps.taskToSessionId.get('任务全文')).toBe('sub-aaa');
  });

  it('老捕获（meta 三字段全空、无 task）：任务键回捕获文件回读', () => {
    writeSub('sub-orphan', [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '孤儿派发的任务文本\n' }] }, timestamp: '2026-03-01T00:00:00Z' },
      { type: 'assistant', message: { role: 'assistant', content: [] } },
    ], { toolUseId: null, name: null, agentType: null, x_lake: { schema: 'cc-subagent-meta', version: 1, data: { toolUseId: null, name: null, agentType: null, subagentSessionId: 'sub-orphan' } } });

    const maps = collectSubagentLinkageMaps(mainFile, 'sess1');
    expect(maps.taskToSessionId.get('孤儿派发的任务文本')).toBe('sub-orphan');
    expect(maps.toolUseIdToSessionId.size).toBe(0);
  });

  it('首条任务文本跳过 system-reminder 块（与 cpx 子任务提取同语义）', () => {
    writeSub('sub-rem', [
      { type: 'user', message: { role: 'user', content: [
        { type: 'text', text: '<system-reminder>注入的上下文</system-reminder>' },
        { type: 'text', text: '  真实任务  ' },
      ] }, timestamp: '2026-03-01T00:00:00Z' },
    ], { toolUseId: null, x_lake: { schema: 'cc-subagent-meta', version: 1, data: { toolUseId: null, subagentSessionId: 'sub-rem' } } });

    const maps = collectSubagentLinkageMaps(mainFile, 'sess1');
    expect(maps.taskToSessionId.get('真实任务')).toBe('sub-rem');
    expect(maps.taskToSessionId.has('<system-reminder>注入的上下文</system-reminder>')).toBe(false);
  });

  it('codex legacy meta（agentId 存在、无 idSource）：规范 id 回填语义不变', () => {
    writeSub('sub-placeholder', [
      { type: 'user', message: { role: 'user', content: 'task' }, timestamp: '2026-03-01T00:00:00Z' },
    ], { toolUseId: 'call_1', name: '任务', agentType: null, agentId: 'ses_real_id', x_lake: { schema: 'cc-subagent-meta', version: 1, data: { toolUseId: 'call_1', name: '任务', agentType: null, subagentSessionId: 'sub-placeholder', agentId: 'ses_real_id' } } });

    const subs = listSubagentSessions(mainFile, 'sess1');
    expect(subs[0]!.id).toBe('ses_real_id'); // 文件名占位 → 真身回填（旧行为）
    expect(subs[0]!.claudeAgentId).toBeNull();
    const maps = collectSubagentLinkageMaps(mainFile, 'sess1');
    expect(maps.toolUseIdToSessionId.get('call_1')).toBe('ses_real_id');
  });

  it('codex 新契约（idSource: agentId）：显式声明真身 id，行为与 legacy 一致', () => {
    writeSub('sub-placeholder2', [
      { type: 'user', message: { role: 'user', content: 'task' }, timestamp: '2026-03-01T00:00:00Z' },
    ], { toolUseId: 'call_2', name: '任务', agentType: null, agentId: 'ses_real_2', idSource: 'agentId', x_lake: { schema: 'cc-subagent-meta', version: 1, data: { toolUseId: 'call_2', name: '任务', agentType: null, subagentSessionId: 'sub-placeholder2', agentId: 'ses_real_2', idSource: 'agentId' } } });

    expect(listSubagentSessions(mainFile, 'sess1')[0]!.id).toBe('ses_real_2');
  });

  it('同任务文本重复出现：首个子会话胜出（Map setIfAbsent）', () => {
    fs.mkdirSync(subsDir(), { recursive: true });
    for (const sid of ['sub-first', 'sub-second']) {
      fs.writeFileSync(path.join(subsDir(), `${sid}.jsonl`), JSON.stringify({ type: 'user', message: { role: 'user', content: '同任务' }, timestamp: '2026-03-01T00:00:00Z' }) + '\n');
      fs.writeFileSync(path.join(subsDir(), `${sid}.meta.json`), JSON.stringify({ toolUseId: null, x_lake: { schema: 'cc-subagent-meta', version: 1, data: { toolUseId: null, subagentSessionId: sid } } }));
    }
    const maps = collectSubagentLinkageMaps(mainFile, 'sess1');
    expect(maps.taskToSessionId.get('同任务')).toBe('sub-first');
  });
});
