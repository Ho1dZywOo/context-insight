// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { selectSkillContent } from '@/lib/skill-content';
import { collectSkillContentCandidates } from '@/lib/observe/collectors/skill-content';
import { withRouteLog } from '@/lib/api-route';
import type { LineEvidence } from '@/lib/skill-evidence';

export interface SkillContentAuditItem {
  skillName: string;
  hasContent: boolean;
  source: 'skill-tool' | 'command' | 'read' | 'shell' | null;
  length: number;
  lines: number;
  /** 是否为完整声明：注入通道恒 true；read/shell 需文件总行数可知且每行都有可靠内容。 */
  fullRead: boolean;
  /** 实际读到的最大文件行号；注入通道为 null。 */
  maxLine: number | null;
  /** 行级证据：覆盖了哪些行、缺哪些行、读取是否被截断（注入通道无行号语义，仅 readCount）。 */
  evidence: LineEvidence;
}

export const GET = withRouteLog('observe/session/skill-content-audit', async (request: NextRequest) => {
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
  });

  if (!session) {
    return NextResponse.json(
      { error: `Session not found for taskId: "${taskId}"` },
      { status: 404 }
    );
  }

  const skillEventsRaw = await prisma.skillEvent.findMany({
    where: { turn: { sessionId: session.id } },
    select: { skillName: true, eventType: true },
  });
  // 仅 dispatch 的 skillName 是被分派的子代理（如 blackbox-designer），非 skill，不参与全文审计。
  const names = Array.from(new Set(
    skillEventsRaw
      .filter(se => se.eventType !== 'dispatch')
      .map(se => se.skillName)
  ));

  const { toolCalls, turns } = await collectSkillContentCandidates(prisma, session.id);

  const items: SkillContentAuditItem[] = names.map(name => {
    const r = selectSkillContent(toolCalls, name, turns);
    const content = r?.content ?? '';
    return {
      skillName: name,
      hasContent: r != null && r.length > 0,
      source: r?.source ?? null,
      length: r?.length ?? 0,
      lines: content.length > 0 ? content.split('\n').length : 0,
      fullRead: r?.fullRead ?? false,
      maxLine: r?.maxLine ?? null,
      evidence: r?.evidence ?? { lineNumbers: [], fileLines: null, gaps: [], truncated: false, conflictLines: [], readCount: 0 },
    };
  });

  return NextResponse.json({ items });
});
