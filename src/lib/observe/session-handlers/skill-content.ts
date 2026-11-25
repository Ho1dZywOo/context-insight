// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { selectSkillContent } from '@/lib/skill-content';
import { MAIN_AGENT_WORKFLOW_NAME } from '@/lib/sift-audit';
import { withRouteLog } from '@/lib/api-route';
import { collectSkillContentCandidates } from '@/lib/observe/collectors/skill-content';

export const GET = withRouteLog('observe/session/skill-content', async (request: NextRequest) => {
  const { searchParams } = request.nextUrl;
  const taskId = searchParams.get('taskId');
  const framework = searchParams.get('framework');
  const skillName = searchParams.get('skillName');

  if (!taskId) {
    return NextResponse.json(
      { error: 'Missing required query param: taskId' },
      { status: 400 }
    );
  }
  if (!skillName) {
    return NextResponse.json(
      { error: 'Missing required query param: skillName' },
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

  // 主 agent 编排 sentinel（MAIN_AGENT_WORKFLOW_NAME）：声明本体在对账时由 LLM
  // 选择式提取产出（llm-workflow-extract），此处不再同步恢复确定性预览（已退役）。
  // 诚实返回空——前端（SkillDetail 的 LLM 提取行）走 llm-workflow-extract job 端点预览。
  if (skillName === MAIN_AGENT_WORKFLOW_NAME) {
    return NextResponse.json(
      { skillName, content: null, source: null, length: 0, fullRead: false, maxLine: null, evidence: null },
      { status: 200 },
    );
  }

  const { toolCalls, turns } = await collectSkillContentCandidates(prisma, session.id);

  const result = selectSkillContent(toolCalls, skillName, turns);

  if (!result) {
    return NextResponse.json(
      { skillName, content: null, source: null, length: 0, fullRead: false, maxLine: null, evidence: null },
      { status: 200 }
    );
  }

  return NextResponse.json({ skillName, ...result });
});
