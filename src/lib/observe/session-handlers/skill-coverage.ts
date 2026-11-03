// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { readAvailableSkills } from '@/lib/ingest/adapters/claude-jsonl-full-context';
import type { SkillsListFormat } from '@/lib/ingest/adapters/system-structure';
import { aggregateUsedSkills, buildCoverage } from '@/lib/skill-coverage';
import { isProxyVersion, isClaudeFormatSession, agentFrameworkOf } from '@/lib/shared/session-format';
import { withRouteLog } from '@/lib/api-route';

/** 非 claude 格式来源的降级文案：按会话实际框架给针对性原因 + 行动指引
 *  （经 cpx 代理捕获的会话 wire 原样落盘系统提示，全集确定性恢复）。
 *  此前一条长句把 opencode/codex 两框架原因一锅端，用户要在长句里找跟
 *  自己相关的那半句——细化 = 只说本框架的原因，并给出可做的事。 */
function degradedReasonForNonClaudeSource(framework: string | null): string {
  const agent = agentFrameworkOf(framework);
  if (agent === 'opencode' || agent === 'cannbot') {
    return `${agent} 原生会话的系统提示只在运行时请求、不落盘，skills 全集不可恢复；经 cpx 代理捕获重跑该会话即可获得全集`;
  }
  if (agent === 'codex') {
    return 'codex 原生会话的 rollout 布局里系统提示在 developer 消息内，读取暂未接入，skills 全集暂不可恢复；经 cpx 代理捕获重跑该会话即可获得全集';
  }
  return '该来源的会话系统提示不落盘，skills 全集不可恢复；经 cpx 代理捕获（wire 原样落盘）重跑该会话即可获得全集';
}

export const GET = withRouteLog('observe/session/skill-coverage', async (request: NextRequest) => {
  const { searchParams } = request.nextUrl;
  const taskId = searchParams.get('taskId');
  const framework = searchParams.get('framework');

  if (!taskId) {
    return NextResponse.json(
      { error: 'Missing required query param: taskId' },
      { status: 400 }
    );
  }

  const session = await prisma.session.findFirst({
    where: framework ? { taskId, framework } : { taskId },
    select: { id: true, taskId: true, framework: true, version: true, sourcePath: true },
  });

  if (!session) {
    return NextResponse.json(
      { error: `Session not found for taskId: "${taskId}"` },
      { status: 404 }
    );
  }

  const events = await prisma.skillEvent.findMany({
    where: { turn: { sessionId: session.id } },
    select: { skillName: true, eventType: true, success: true },
  });
  const used = aggregateUsedSkills(events);

  let available: Array<{ name: string; description: string; origin: string | null }> | null = null;
  let listFormat: SkillsListFormat | null = null;
  let degradedReason: string | null = null;

  // 覆盖度门禁（按全集确定性）：
  // - proxy 捕获（claude/opencode/codex，version 带 -proxy）：wire verbatim
  //   系统提示落盘，全集确定性恢复
  // - native claude-code：jsonl 的 type:system 行落盘系统注入（含 skills
  //   全集列表），同样确定性可解析（实测 native 会话 system 行含完整列表）
  // - native opencode / cannbot：系统提示只在运行时请求，db 不落盘 → 不可恢复
  // - native codex：rollout 布局里系统提示在 developer 消息内，读取暂未
  //   接入 → 暂不可恢复
  // 降级文案按会话实际框架分流（见 degradedReasonForNonClaudeSource）：
  // 只说本框架的原因 + 行动指引（经 cpx 代理捕获重跑可得全集）。
  const isProxy = isProxyVersion(session.version);
  const isClaudeSource = isClaudeFormatSession(session.framework, session.version);

  if (!isClaudeSource) {
    degradedReason = degradedReasonForNonClaudeSource(session.framework);
  } else if (!session.sourcePath) {
    degradedReason = '源文件不可用（sourcePath 缺失或文件已移走）；重新导入该会话可恢复';
  } else {
    const parsed = readAvailableSkills(session.sourcePath);
    if (parsed) {
      available = parsed.skills;
      listFormat = parsed.format;
    } else {
      degradedReason = isProxy
        ? 'proxy 捕获中未找到可用 skills 全集（系统提示未含 skills 注入段）'
        : '未在会话中找到可用 skills 全集注入（native 会话未注入 skills 列表，如未配置 skills）';
    }
  }

  const coverage = buildCoverage(available, used);

  return NextResponse.json({
    taskId: session.taskId,
    framework: session.framework,
    hasAvailableList: available != null,
    listFormat,
    degradedReason,
    usedSkillCount: used.length,
    ...coverage,
  });
});
