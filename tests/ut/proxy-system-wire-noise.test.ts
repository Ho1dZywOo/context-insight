// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. Do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// wire 捕获 system 组件噪声治理 IT（全管线：jsonl → adapter → turn-split → DB）：
// cpx 逐请求落盘 system 数组（无 message.id 可去重）——token 倒计时（wire 簿记）
// 与逐字重复的静态注入曾全部物化为 system 轮（真机捕获实测：4213 个 system 轮
// 里 4140 条是倒计时）。修复后：倒计时零落库、重复注入首现保留一次、独立系统
// 事件（告警/hook/CLAUDE.md）不误伤；user/assistant 轮与聚合不受影响。
import { describe, it, expect, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prisma } from '../setup';
import { POST } from '@/app/api/ingest/import-file/route';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-noise-it-'));
const SID = 'wire-noise-it-sid';

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/ingest/import-file', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const ENV = '# Environment\nYou have been invoked in the following environment: /tmp/wire-noise-it';
const sys = (content: string | Array<{ type: string; text: string }>, round: number, at: string) => ({
  type: 'system', message: { role: 'system', content }, timestamp: at, source: 'claude-proxy',
  x_lake: { schema: 'cc-wire-input', version: 1, data: { roundIndex: round, kind: 'system' } },
});

// 三轮请求的 wire 捕获（真机三载体形态）：静态 Environment 以「提示全文 +
// 倒计时尾行」的拼接字符串随行（同值/变值倒计时各现）、纯倒计时字符串、
// 倒计时单块数组；Context 告警与 hook 注入各一次（真实系统事件，须保留）
const CAPTURE = [
  { type: 'user', message: { role: 'user', content: '帮我看下部署问题' }, timestamp: '2026-10-27T13:13:19.448Z', source: 'claude-proxy', x_lake: { schema: 'cc-wire-input', version: 1, data: { roundIndex: 0, kind: 'user' } } },
  sys(`${ENV}\n<total_tokens>14948175 tokens left</total_tokens>`, 0, '2026-10-27T13:13:19.448Z'),
  sys('<total_tokens>14948175 tokens left</total_tokens>', 0, '2026-10-27T13:13:19.500Z'),
  { type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: '收到，先看日志' }], model: 'glm-5.2', usage: { input_tokens: 100, output_tokens: 20 } }, timestamp: '2026-10-27T13:13:36.000Z', source: 'claude-proxy' },
  sys(`${ENV}\n<total_tokens>14948175 tokens left</total_tokens>`, 1, '2026-10-27T13:13:36.134Z'),
  sys([{ type: 'text', text: '<total_tokens>14948175 tokens left</total_tokens>' }], 1, '2026-10-27T13:13:36.200Z'),
  sys([{ type: 'text', text: '<total_tokens>14946870 tokens left</total_tokens>' }], 2, '2026-10-27T13:13:50.000Z'),
  sys('[SYSTEM NOTIFICATION - NOT USER INPUT] Context low · 25% remaining.', 2, '2026-10-27T13:13:50.000Z'),
  sys('tool.call hook additional context: lint 输出正常', 2, '2026-10-27T13:13:51.000Z'),
  sys(`${ENV}\n<total_tokens>14946870 tokens left</total_tokens>`, 2, '2026-10-27T13:14:02.000Z'),
  { type: 'assistant', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: '根因找到，改一行配置' }], model: 'glm-5.2', usage: { input_tokens: 120, output_tokens: 18 } }, timestamp: '2026-10-27T13:14:10.000Z', source: 'claude-proxy' },
];

const CAPTURE_FILE = path.join(TMP, `cpx-${SID}.jsonl`);
fs.writeFileSync(CAPTURE_FILE, CAPTURE.map(l => JSON.stringify(l)).join('\n'));

afterAll(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  await prisma.session.deleteMany({ where: { taskId: SID } });
  await prisma.$disconnect();
});

describe('wire 捕获 system 组件噪声治理（import-file → DB 全管线）', () => {
  it('token 倒计时零落库、重复注入去重、真实系统事件保留', async () => {
    const res = await POST(req({ source: 'claude-jsonl', sessionId: SID, filePath: CAPTURE_FILE }));
    expect(res.status).toBe(200);

    const s = await prisma.session.findFirst({ where: { taskId: SID } });
    expect(s?.framework).toBe('claude-code-proxy');
    const turns = await prisma.turn.findMany({ where: { sessionId: s!.id }, orderBy: { turnIndex: 'asc' } });
    const roles = turns.map(t => t.role);

    // 簿记与重复不落库：倒计时 0 条、Environment 恰 1 条
    expect(turns.filter(t => (t.contentSummary ?? '').includes('tokens left')).length).toBe(0);
    expect(turns.filter(t => (t.contentSummary ?? '').startsWith('# Environment')).length).toBe(1);
    // 真实系统事件保留：Context 告警 + hook 注入各 1 条
    expect(turns.filter(t => (t.contentSummary ?? '').startsWith('[SYSTEM NOTIFICATION')).length).toBe(1);
    expect(turns.filter(t => (t.contentSummary ?? '').startsWith('tool.call hook')).length).toBe(1);
    // 对话主干不受影响：user 1 / assistant 2 / system 3（Environment + 告警 + hook）
    expect(roles.filter(r => r === 'user').length).toBe(1);
    expect(roles.filter(r => r === 'assistant').length).toBe(2);
    expect(roles.filter(r => r === 'system').length).toBe(3);
    // 时间线顺序：Environment 在 user 后，告警/hook 在首个 assistant 后
    expect(roles).toEqual(['user', 'system', 'assistant', 'system', 'system', 'assistant']);
  });
});
