// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Context 视角的 agent 分组/图例/配色单一源（ContextTracker 与
// ContextReplayDialog 共同消费，独立模块斩断两组件间的循环依赖）：
// ①agent 分组键：root 按成员会话（session 即 agent）、subagent 按 sid 池化；
// ②图例分组键：root 一键一会话、subagent 按类型（`subagentType ?? agentName`，
//   与泳道图例同键）——趋势曲线按类型聚合显隐/高亮，百级子代理折叠成类型条目；
// ③类型配色：黄金角度色相序列（泳道 colorOf 同款思想），起点 210° 蓝——
//   solo 会话 root 即泳道 root 蓝；任意键数不回绕撞色，键序规范排序（root
//   键在前、同层字典序）——与调用方数组顺序无关，数据不变则配色稳定，
//   图例/曲线/回放三处同色。

export interface ContextTurnKeySource {
  isSubagent: boolean
  subagentSessionId: string | null
  turnIndex: number
  member?: { taskId: string; label: string | null } | null
}

/** agent 分组键（无 member 归因回落单 root——session/export 路径旧口径） */
export function contextAgentKeyOf(t: ContextTurnKeySource): string {
  if (t.isSubagent) return t.subagentSessionId ?? `anon-${t.turnIndex}`
  return t.member ? `root:${t.member.taskId}` : "root"
}

export interface ContextLegendAgent {
  sessionId: string
  agentName: string
  isRoot: boolean
  subagentType: string | null
}

/** 图例分组键：root 按会话、subagent 按类型（泳道图例同键） */
export function contextLegendKeyOf(a: ContextLegendAgent): string {
  return a.isRoot ? `root:${a.sessionId}` : `type:${a.subagentType ?? a.agentName}`
}

/** 图例键 → 颜色（黄金角度色相序列）。键序规范排序（root 键在前、同层按
 *  字典序）——与调用方数组顺序无关：趋势图（stats 按 peak 排序）与回放（首现
 *  序）传入同一 agent 集即得同一配色，跨组件同色有保证 */
export function contextColorMapOf(agents: ContextLegendAgent[]): Map<string, string> {
  const keys = new Set(agents.map(contextLegendKeyOf))
  const sorted = [...keys].sort((a, b) => {
    const ra = a.startsWith("root:")
    const rb = b.startsWith("root:")
    if (ra !== rb) return ra ? -1 : 1
    return a.localeCompare(b)
  })
  const m = new Map<string, string>()
  sorted.forEach((k, i) => m.set(k, `hsl(${Math.round((210 + i * 137.508) % 360)} 65% 55%)`))
  return m
}
