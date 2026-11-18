// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { BRAND_NAME, isBrandSourceType } from '../branding';

/** DB 侧 proxy 判定的唯一形式：Session.version 带 -proxy 后缀（统一分类器
 * proxy-classify.ts 导入时写入）。UI 徽标 / API 门禁一律用本谓词，不再各写
 * endsWith 字符串比较。 */
export function isProxyVersion(version: string | null | undefined): boolean {
  return version?.endsWith('-proxy') ?? false;
}

// framework（agent 归属：claude-code / opencode / codex）与捕获格式正交：proxy 捕获
// 文件（claude / opencode / codex，version 带 -proxy 后缀，统一分类器
// proxy-classify.ts 写入）都是扩展 claude 格式的 jsonl。
// 凡是"sourcePath 指向 claude 格式 jsonl"的判断（wire 轮次、full-context、
// 增量刷新等）都应走本谓词，而不是单看 framework。
// 方案一（同 sid 双会话）后 proxy 捕获行的 framework 为带 -proxy 后缀的变体
// （claude-code-proxy 等），前缀匹配一并放行。
export function isClaudeFormatSession(
  framework: string | null | undefined,
  version: string | null | undefined
): boolean {
  if (framework?.startsWith('claude-code')) return true;
  return isProxyVersion(version);
}

/** 方案一（同 sid 双会话）：framework 剥离 -proxy 记录后缀 → agent 归属
 * （claude-code-proxy → claude-code）。UI 图标/文案等按 agent 归属呈现时用，
 * proxy 与否的徽标走 isProxyVersion(version)。非后缀值原样返回。 */
export function agentFrameworkOf(framework: string | null | undefined): string | null {
  if (framework == null) return null;
  return framework.endsWith('-proxy') ? framework.slice(0, -'-proxy'.length) : framework;
}

/** framework 显示名词表单点：所有「framework → 给用户看的名字」一律经
 *  frameworkDisplayName——组件内联裸等值是两度现场缺陷源（codex 曾漏分支、
 *  -proxy 变体全分支失配致导入列表 type 列恒「—」）。此前 AssetList /
 *  OverviewPanels / LakeSessionTable 各持一份副本且已漂移（label 不一致、
 *  OverviewPanels 缺 cannbot/dsh 分支）。新框架接入 = 词表加一行。 */
export const FRAMEWORK_LABELS: Readonly<Record<string, string>> = {
  opencode: 'OpenCode',
  'claude-code': 'Claude Code',
  cannbot: 'CANNBot',
  dsh: 'DSH',
  codex: 'Codex',
};

/** type 徽标配色（LakeSessionTable 徽标场景；variant 值域同 Badge 组件词表） */
export const FRAMEWORK_BADGE_VARIANTS: Readonly<Record<string, 'blue' | 'green' | 'orange' | 'purple' | 'slate'>> = {
  opencode: 'blue',
  cannbot: 'green',
  'claude-code': 'orange',
  codex: 'purple',
  dsh: 'slate',
};

/** framework → 显示名：agent 归属经 agentFrameworkOf 剥 -proxy 后缀；品牌
 *  sourceType 值显示品牌名；未知框架诚实回落剥后缀原始串（不吞不编）；
 *  null → null（占位符由消费方决定）。 */
export function frameworkDisplayName(framework: string | null | undefined): string | null {
  if (framework == null) return null;
  if (isBrandSourceType(framework)) return BRAND_NAME;
  const agent = agentFrameworkOf(framework);
  if (agent == null) return null;
  return FRAMEWORK_LABELS[agent] ?? agent;
}
