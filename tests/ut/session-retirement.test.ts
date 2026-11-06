// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// run-first 刀J2 退役锁（design: docs/design/run-first-architecture/design.md §六）：
// session 页面/路由/API 家族退役后不得回归——run 是唯一观测基本单元，session
// 能力以 run 成员视图转发 + lib 处理器平移形态存活。文件系统哨兵 + 源码扫描。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const src = path.resolve(__dirname, '../../src');

const srcExists = (rel: string): boolean => fs.existsSync(path.join(src, rel));

describe('run-first 刀J2：session 面退役锁', () => {
  it('页面与路由已退役：/session/[taskId] 页、/api/observe/session/*、auto-refresh(-stream) 均不存在', () => {
    expect(srcExists('app/session')).toBe(false);
    expect(srcExists('app/api/observe/session')).toBe(false);
    expect(srcExists('app/api/observe/auto-refresh')).toBe(false);
    expect(srcExists('app/api/observe/auto-refresh-stream')).toBe(false);
  });

  it('session 处理器平移至 lib/observe/session-handlers（run 转发与测试的唯一来源）', () => {
    expect(srcExists('lib/observe/session-handlers/detail.ts')).toBe(true);
    expect(srcExists('lib/observe/session-handlers/turns.ts')).toBe(true);
    expect(srcExists('lib/observe/session-handlers/turn-detail.ts')).toBe(true);
    expect(srcExists('lib/observe/session-handlers/scorecard.ts')).toBe(true);
    expect(srcExists('lib/observe/session-handlers/export-md.ts')).toBe(true);
  });

  it('CLI client 全部走 run 端点（不再调用 session observe API）', () => {
    const client = fs.readFileSync(path.join(src, 'cli/client.ts'), 'utf-8');
    expect(client).not.toContain('/api/observe/session');
  });

  it('compare 页限定 solo run 输入（无 session 端点取数）', () => {
    const page = fs.readFileSync(path.join(src, 'app/compare/page.tsx'), 'utf-8');
    expect(page).not.toContain('/api/observe/session');
    expect(page).toContain('soloRunIdOf');
  });

  it('离线导出查看器 = run 工作台自身（entry 挂载 run 页组件，不再有平行查看器实现）', () => {
    expect(srcExists('components/export-view/SessionExportViewer.tsx')).toBe(false);
    expect(srcExists('components/export-view/session-view.ts')).toBe(false);
    const entry = fs.readFileSync(path.join(src, 'export-view/entry.tsx'), 'utf-8');
    expect(entry).toContain('app/run/[runId]/page');
    expect(srcExists('export-view/offline-kernel.ts')).toBe(true);
  });
});
