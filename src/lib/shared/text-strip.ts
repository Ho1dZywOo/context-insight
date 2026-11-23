// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License).
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 摘要/预览共用的噪声剥离：thinking 块吃掉 200 字符摘要预算、
// <system-reminder> 前缀显示为 XML 标签噪音——ingest 侧（turn-split/
// phase-split 的 contentSummary）与显示侧（LlmOutputView 折叠预览）同口径。

// 定长截断的 UTF-16 安全版：substring/slice 按码元切，切点落在代理对中间
// 会留下半个字符（孤立 \udXXX），Prisma 引擎反序列化即报
// "unexpected end of hex escape" 导致整批写入失败。落库文本一律走这里。
export function truncateUtf16Safe(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) return text;
  const last = text.charCodeAt(maxUnits - 1);
  if (last >= 0xD800 && last <= 0xDBFF) return text.substring(0, maxUnits - 1);
  return text.substring(0, maxUnits);
}

export function stripThinkingAndReminder(text: string | null): string | null {
  return text
    ?.replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, '')
    .replace(/^<system-reminder>[\s\S]*?<\/system-reminder>\s*/, '') || null;
}

// 剥掉全部 <system-reminder> 壳段（全局，不限前缀）：会话标签/预览口径——
// claude-code 的上下文注入块在此全视为噪声，取真实提示文本。注意与时间线
// 口径的分工：时间线侧按指纹剥除（adapters/injections，未知块保留可见，
// 前向兼容），此处只服务标签/Query 预览（listSessions firstQuery 与
// data-service previewText 共用，两处曾各持一份局部实现且一处只剥首个
// 前缀块——多块混排消息的块 2 残留成了标签头，现场裸奔 <system-reminder>）。
export function stripSystemReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, '').trim();
}
