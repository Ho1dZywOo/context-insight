// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 契约原则 1 块级静态注入的适配器 IT + wire 重放副件去重 IT。
//
// 现场依据（solo:8ae4a944）两条：
//   ① 主会话与每个子代理的首条 user 消息都是「3 个静态 reminder 块
//     （CLAUDE.md 回显/gitStatus 快照/署名规则）+ 1 个任务文本块」——
//     时间线与会话标签裸奔 XML 噪声；
//   ② cpx 捕获侧进程重启的 multiset 失守 → 背景事件通知 byte-identical
//     重放副本进时间线（一个代理的完成通知被放大成 32 条）。
// 本文件验证读侧两条修复：静态块按指纹剥除（未知块保留）、注入行重放
// 副件首现保留。桥链对齐（任务文本提取与时间线剥除互不干扰）一并锁定。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSession, collectSubagentLinkageMaps } from '../../../src/lib/ingest/adapters/claude-jsonl.ts';
import { firstHumanQueryText } from '../../../src/lib/ingest/data-service.ts';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-static-strip-'));
  file = path.join(dir, 'sess-static.jsonl');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeLines(lines: object[]): void {
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}

const ts = (s: number) => new Date(Date.parse('2026-03-01T00:00:00Z') + s * 1000).toISOString();
const userLine = (content: unknown, opts: { source?: string; ts?: number } = {}) => ({
  type: 'user',
  message: { role: 'user', content },
  timestamp: ts(opts.ts ?? 0),
  ...(opts.source ? { source: opts.source } : {}),
});
const assistantLine = (text: string, i = 1) => ({
  type: 'assistant',
  message: { role: 'assistant', id: 'msg-' + i, content: [{ type: 'text', text }], model: 'glm-5.2', usage: { input_tokens: 10, output_tokens: 5 } },
  timestamp: ts(i),
});

// 复刻现场首条消息：3 个静态 reminder 块 + 任务文本块
const CLAUDE_MD = '<system-reminder>\nCodebase and user instructions are shown below. Be sure to adhere to them.\nContents of /repo/CLAUDE.md (project instructions).\n</system-reminder>';
const GIT_STATUS = '<system-reminder>\nAs you answer the user\'s questions, you can use the following context:\n# gitStatus\nCurrent branch: main\n</system-reminder>';
const ATTRIBUTION = '<system-reminder>\nAttribution for git commits and pull requests you create:\n- Include "Co-Authored-By: Claude"\n</system-reminder>';
const BOOTSTRAP_BLOCKS = [
  { type: 'text', text: CLAUDE_MD },
  { type: 'text', text: GIT_STATUS },
  { type: 'text', text: ATTRIBUTION },
];
const TASK = '请根据skill完成deep seek v4新模型适配';

describe('块级静态注入剥除（契约原则 1）', () => {
  it('多块混排首条消息：3 静态块剥除，任务文本保留为 user 轮，label 取到真实提示', () => {
    writeLines([
      userLine([...BOOTSTRAP_BLOCKS, { type: 'text', text: TASK }]),
      assistantLine('开始适配'),
    ]);
    const rows = readSession(file, 'sess-static');
    const users = rows.filter(r => r.role === 'user');
    expect(users.length).toBe(1);
    expect(users[0]!.content).toBe(TASK);
    expect(users[0]!.content).not.toContain('system-reminder');
    expect(users[0]!.content).not.toContain('CLAUDE.md');
    // label 链（data-service:876 firstHumanQueryText ?? rawInteractions[0].content）
    expect(firstHumanQueryText(rows)).toBe(TASK);
  });

  it('纯静态注入消息（剥后无实质文本）整条 drop，不进时间线', () => {
    writeLines([
      userLine(BOOTSTRAP_BLOCKS),
      userLine(TASK),
      assistantLine('收到'),
    ]);
    const rows = readSession(file, 'sess-static');
    const users = rows.filter(r => r.role === 'user');
    expect(users.length).toBe(1);
    expect(users[0]!.content).toBe(TASK);
  });

  it('字符串形态多 span 剥除（native claude 常用）：已知 span 全剥、未知 span 与正文保留', () => {
    const content = `${GIT_STATUS}\n\n<system-reminder>\n未知新注入类型，保留可见\n</system-reminder>\n\n${TASK}`;
    writeLines([userLine(content), assistantLine('ok')]);
    const rows = readSession(file, 'sess-static');
    const users = rows.filter(r => r.role === 'user');
    expect(users[0]!.content).not.toContain('gitStatus');
    expect(users[0]!.content).not.toContain('As you answer');
    expect(users[0]!.content).toContain('<system-reminder>\n未知新注入类型，保留可见\n</system-reminder>');
    expect(users[0]!.content).toContain(TASK);
  });

  it('真实用户正文内嵌 reminder 样本（未知头行）不误伤', () => {
    const content = [
      { type: 'text', text: '帮我看看这个协议消息是什么：' },
      { type: 'text', text: '<system-reminder>\nThe user stepped away from the conversation\n</system-reminder>' },
    ];
    writeLines([userLine(content), assistantLine('这是离开提示注入')]);
    const rows = readSession(file, 'sess-static');
    const users = rows.filter(r => r.role === 'user');
    expect(users.length).toBe(1);
    expect(users[0]!.content).toContain('stepped away');
    expect(users[0]!.content).toContain('帮我看看');
  });

  it('native 与 claude-proxy 同口径（框架语义）；codex-proxy 无指纹不剥', () => {
    writeLines([
      userLine([...BOOTSTRAP_BLOCKS, { type: 'text', text: TASK }], { source: 'claude-proxy' }),
      userLine([...BOOTSTRAP_BLOCKS, { type: 'text', text: 'codex 任务' }], { source: 'codex-proxy', ts: 5 }),
    ]);
    const rows = readSession(file, 'sess-static');
    const users = rows.filter(r => r.role === 'user');
    expect(users.map(u => u.content)).toEqual([TASK, expect.stringContaining('CLAUDE.md')]);
    expect(users[1]!.content).toContain('codex 任务');
  });
});

describe('注入行 wire 重放副件去重（捕获侧重启失守的读侧自愈）', () => {
  // 真机 task-notification 格式：<summary>Agent "…" …</summary> + <status>
  const notif = (agent: string) => `<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification>\n<summary>Agent "${agent}" finished (${agent.length}00K tokens)</summary>\n<status>completed</status>\n</task-notification>\n</system-reminder>`;

  it('byte-identical 背景事件重放副本：首现保留，重放跳过', () => {
    writeLines([
      userLine([{ type: 'text', text: notif('Stage1') }], { ts: 0 }),
      assistantLine('知道了', 1),
      // cpx 重启重放：同一通知原样再落一行（现场 32 条/代理的形态）
      userLine([{ type: 'text', text: notif('Stage1') }], { ts: 60 }),
      assistantLine('继续', 2),
    ]);
    const rows = readSession(file, 'sess-static');
    const events = rows.filter(r => r.role === 'system');
    expect(events.length).toBe(1);
    expect(events[0]!.content).toContain('Stage1');
  });

  it('内容不同的通知各保留（SendMessage 续跑轮次是真事件，token/result 必变）', () => {
    writeLines([
      userLine([{ type: 'text', text: notif('R1') }], { ts: 0 }),
      assistantLine('知道了', 1),
      userLine([{ type: 'text', text: notif('R2') }], { ts: 60 }),
      assistantLine('继续', 2),
    ]);
    const rows = readSession(file, 'sess-static');
    const events = rows.filter(r => r.role === 'system');
    expect(events.length).toBe(2);
    expect(events[0]!.content).toContain('R1');
    expect(events[1]!.content).toContain('R2');
  });

  it('真实用户输入 byte-identical 重复不去重（人类重复是真实事件，契约保持 user）', () => {
    writeLines([
      userLine('继续'),
      assistantLine('好的', 1),
      userLine('继续'),
      assistantLine('好的', 2),
    ]);
    const rows = readSession(file, 'sess-static');
    expect(rows.filter(r => r.role === 'user').length).toBe(2);
  });
});

describe('桥链对齐：时间线剥除不影响任务文本提取（file 级真源）', () => {
  it('子捕获首条带静态块：collectSubagentLinkageMaps 仍按任务文本命中（桥不断）', () => {
    // 主捕获文件必须存在（会话目录推导的锚点）
    writeLines([userLine(TASK), assistantLine('开始')]);
    const subsDir = path.join(dir, 'sess-static', 'subagents');
    fs.mkdirSync(subsDir, { recursive: true });
    fs.writeFileSync(path.join(subsDir, 'sub-bridge.jsonl'), JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [...BOOTSTRAP_BLOCKS, { type: 'text', text: TASK }] },
      timestamp: ts(0),
    }) + '\n');
    fs.writeFileSync(path.join(subsDir, 'sub-bridge.meta.json'), JSON.stringify({
      toolUseId: null, name: null, agentType: null,
      x_lake: { schema: 'cc-subagent-meta', version: 1, data: { toolUseId: null, name: null, agentType: null, subagentSessionId: 'sub-bridge' } },
    }));

    const maps = collectSubagentLinkageMaps(file, 'sess-static');
    expect(maps.taskToSessionId.get(TASK)).toBe('sub-bridge');
    // 静态块本身不当任务键
    expect(maps.taskToSessionId.has(CLAUDE_MD)).toBe(false);
  });
});
