// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This file is licensed under the CANN Open Software License Agreement Version 2.0.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { resolveWorkflowSkillName, MAIN_AGENT_WORKFLOW_NAME } from '@/lib/sift-audit';
import { hasWorkflowExtractCandidates } from '@/lib/llm-workflow-extract';
import { withRouteLog } from '@/lib/api-route';

/**
 * 主 agent 编排 对账目标的可用性 + 真名：
 *
 * - available：session 有可供 LLM 选择的声明候选（规程或计划任一非空，
 *   hasWorkflowExtractCandidates 廉价探测——确定性、零 LLM 调用）→ 可发起
 *   root 对账。声明本体由对账时的 LLM 选择式提取产出（llm-workflow-extract），
 *   探测不预跑 LLM；有候选 ≠ LLM 必然选出可用两层，失败在对账流里诚实暴露。
 *   两层候选皆无 → available=false。
 *
 * - name：workflow skill 真名（主 agent Skill invoke 的 skillName，如
 *   ops-registry-invoke-glacier）。无 invoke → 回退合成名 MAIN_AGENT_WORKFLOW_NAME。
 *
 * - source：恒 null——声明来源（规程层/计划层各取哪份文件）在对账时的 LLM 选择
 *   之后才可知，探测期不可预知（旧确定性路可在探测期同步恢复声明故有 source）。
 *
 * 返回：{ available, name, source }。available=true 时 name 非 null、source 为 null；
 * available=false 时 name=null、source=null。
 */
export const GET = withRouteLog('observe/session/main-agent-workflow', async (request: Request) => {
  const { searchParams } = new URL(request.url);
  const taskId = searchParams.get('taskId');
  const framework = searchParams.get('framework');

  if (!taskId) {
    return NextResponse.json({ error: 'Missing taskId' }, { status: 400 });
  }

  const session = await prisma.session.findFirst({
    where: framework ? { taskId, framework } : { taskId },
  });
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  // available：声明候选是否存在（规程或计划任一）——root 对账可发起性
  if (!(await hasWorkflowExtractCandidates(session.id, prisma))) {
    return NextResponse.json({ available: false, name: null, source: null });
  }

  // name：主 agent Skill invoke 的 skillName（workflow skill 真名）
  const name = (await resolveWorkflowSkillName(session.id, prisma)) ?? MAIN_AGENT_WORKFLOW_NAME;
  return NextResponse.json({ available: true, name, source: null });
});
