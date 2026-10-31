"use client"
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { SkillAuditTab } from "@/components/observe/SkillAuditTab"
import type { AuditKind } from "@/lib/skill-audit-job"

/**
 * 离线导出查看器的 Audit 板块容器：sift 对账目标列表 + 报告（SkillAuditTab，
 * 离线读导出时嵌入的对账结果，无后端时不发起新对账）。线上工作台的 Audit
 * 走 run 级四域审计（RunAuditTab），不再经本容器。原 workflow 子板块
 * （LLM 会话行为分析）已退役。
 */
interface Props {
  taskId: string
  framework?: string
  skillEvents: { skillName: string; eventType: string }[]
  /** 主 agent 编排 对账目标是否可用（组合声明任一层可恢复）。 */
  hasMainAgentWorkflow?: boolean
  /** 主 agent 编排 的真名（扫盘反查的 identifier）；未取/回退时由 SkillAuditTab 用合成名。 */
  mainAgentWorkflowName?: string | null
  onJumpToTurn?: (turn: number) => void
  /** Skill 子 tab 当前选中（受控 {name, kind}），转发给 SkillAuditTab。 */
  skillSelected: { name: string; kind: AuditKind } | null
  onSkillSelectedChange: (s: { name: string; kind: AuditKind } | null) => void
}

export function AuditBoardTab({
  taskId,
  framework,
  skillEvents,
  hasMainAgentWorkflow,
  mainAgentWorkflowName,
  onJumpToTurn,
  skillSelected,
  onSkillSelectedChange,
}: Props) {
  return (
    <SkillAuditTab
      taskId={taskId}
      framework={framework}
      skillEvents={skillEvents}
      hasMainAgentWorkflow={hasMainAgentWorkflow}
      mainAgentWorkflowName={mainAgentWorkflowName}
      selected={skillSelected}
      onSelectedChange={onSkillSelectedChange}
      onJumpToTurn={onJumpToTurn}
    />
  )
}
