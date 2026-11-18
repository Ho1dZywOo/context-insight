// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. Do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// IT：framework 显示词表单点（session-format）。现场缺陷（claude-code-proxy
// 会话 5295af91）：contextBay 导入列表 type 列裸等值比较，-proxy 变体全分支
// 失配恒显「—」——此前 codex 同款漏分支已修过一次（只补分支未根治）。组件
// 渲染回归锁在 lake-session-table-badge.test.tsx。

import { describe, it, expect } from 'vitest';
import {
  FRAMEWORK_LABELS,
  FRAMEWORK_BADGE_VARIANTS,
  frameworkDisplayName,
} from '@/lib/shared/session-format';
import { BRAND_NAME } from '@/lib/branding';

describe('framework 显示词表单点', () => {
  it('已知框架 → 词表名', () => {
    expect(frameworkDisplayName('opencode')).toBe('OpenCode');
    expect(frameworkDisplayName('claude-code')).toBe('Claude Code');
    expect(frameworkDisplayName('cannbot')).toBe('CANNBot');
    expect(frameworkDisplayName('dsh')).toBe('DSH');
    expect(frameworkDisplayName('codex')).toBe('Codex');
  });

  it('-proxy 捕获变体：剥后缀显示 agent 名（type 列「—」缺陷回归锁）', () => {
    expect(frameworkDisplayName('claude-code-proxy')).toBe('Claude Code');
    expect(frameworkDisplayName('opencode-proxy')).toBe('OpenCode');
    expect(frameworkDisplayName('codex-proxy')).toBe('Codex');
    expect(frameworkDisplayName('cannbot-proxy')).toBe('CANNBot');
    expect(frameworkDisplayName('dsh-proxy')).toBe('DSH');
  });

  it('品牌 sourceType 显示品牌名', () => {
    expect(frameworkDisplayName('context-insight')).toBe(BRAND_NAME);
  });

  it('未知框架诚实回落剥后缀原始串；null → null', () => {
    expect(frameworkDisplayName('future-agent')).toBe('future-agent');
    expect(frameworkDisplayName('future-agent-proxy')).toBe('future-agent');
    expect(frameworkDisplayName(null)).toBeNull();
    expect(frameworkDisplayName(undefined)).toBeNull();
  });

  it('词表与徽标配色键一致（有显示名的 agent 都有配色）', () => {
    expect(Object.keys(FRAMEWORK_LABELS).length).toBeGreaterThan(0);
    for (const key of Object.keys(FRAMEWORK_LABELS)) {
      expect(FRAMEWORK_BADGE_VARIANTS[key]).toBeDefined();
    }
  });
});
