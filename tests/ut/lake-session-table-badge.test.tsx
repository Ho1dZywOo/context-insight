// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.
// @vitest-environment happy-dom
// lake 会话表框架徽标回归锁：框架族全覆盖（claude/opencode/cannbot/codex/
// dsh）。codex 曾漏分支——客户实测 codex 捕获上传 contextBay 成功，但数据
// 源列表 type 列恒显「—」（识别不出来）。
import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { LakeSessionTable, type LakeSession } from '../../src/components/collection/steps/LakeSessionTable';

function session(framework: string | null | undefined, sid: string): LakeSession {
  return {
    sid,
    fileCount: 1,
    author: 'tester',
    submitter: 'tester',
    description: `desc-${sid}`,
    commitTime: '2026-11-11T00:00:00Z',
    framework,
    ccVersion: null,
    producer: 'cpx',
    paradigm: 'others',
    isBaseline: false,
    opGen: null,
    recording: 'capture',
  };
}

function renderTableHtml(sessions: LakeSession[]): string {
  return renderToString(
    createElement(LakeSessionTable, {
      sessions,
      paradigm: 'others',
      scope: 'others',
      selected: new Set<string>(),
      onToggle: () => {},
      onSetAll: () => {},
    }),
  );
}

describe('LakeSessionTable 框架徽标（type 列）', () => {
  it('五个框架族都有徽标（Type 列不缺位）', () => {
    const html = renderTableHtml([
      session('claude-code', 'sid-claude'),
      session('opencode', 'sid-oc'),
      session('cannbot', 'sid-cannbot'),
      session('codex', 'sid-codex'),
      session('dsh', 'sid-dsh'),
    ]);
    expect(html).toContain('>Claude</span>');
    expect(html).toContain('>OpenCode</span>');
    expect(html).toContain('>CANNBot</span>');
    expect(html).toContain('>Codex</span>');
    expect(html).toContain('>DSH</span>');
  });

  it('codex 会话渲染 Codex 徽标（回归锁：此前漏分支显「—」）', () => {
    const html = renderTableHtml([session('codex', 'sid-codex')]);
    expect(html).toContain('>Codex</span>');
    // Type 单元格内不再有占位符（任务结果列的「—」与此无关，见断言粒度）
    const typeCell = html.split('inline-flex items-center gap-0.5')[1]?.split('</td>')[0] ?? '';
    expect(typeCell).toContain('>Codex</span>');
    expect(typeCell).not.toContain('>—<');
  });

  it('未知框架仍回落「—」', () => {
    const html = renderTableHtml([session('mystery-agent', 'sid-mystery')]);
    expect(html).toContain('>—<');
  });
});
