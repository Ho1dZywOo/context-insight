"use client";
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Turns 左列角色多选筛选条（design: 胶囊形态——角色点 + 标签 + 计数的
// 圆角小胶囊，点选即多选并集、「全部」一键清空；按压回缩与入场都只走
// transform/opacity + 弹簧曲线）。角色归一与行渲染同源
// （RunTurnsNodes.classifyDisplayRole），选项与计数随成员懒加载增量就位，
// 只列出已加载轮次里真实出现过的角色。

import { cn } from "@/lib/utils";
import { ROLE_DOT, classifyDisplayRole, type TurnsBlockTurn } from "@/components/run/RunTurnsNodes";

/** 角色固定优先序（chip 排列；未登记角色按出现序追加在后） */
export const ROLE_FILTER_ORDER: readonly string[] = [
  "user",
  "assistant",
  "system",
  "tool_result",
  "command",
  "continuation",
  "compaction",
];

export const ROLE_FILTER_LABEL: Record<string, string> = {
  user: "user",
  assistant: "assistant",
  system: "system",
  tool_result: "tool_result",
  command: "命令",
  continuation: "续接",
  compaction: "压缩",
};

export interface RoleFilterOption {
  role: string;
  label: string;
  count: number;
}

/** 已加载轮次 → 角色选项（计数>0 才出现）：主链轮走行渲染同源归一（命令/
 *  续接/压缩由文本与 agentName 推导，命令附注行不计数），子代理轮按泳道
 *  行的原始 role 口径计数——筛选条上的数字即列表里会被留下来的行数 */
export function deriveRoleOptions(turns: TurnsBlockTurn[]): RoleFilterOption[] {
  const counts = new Map<string, number>();
  for (const t of turns) {
    const role = t.isSubagent ? t.role : classifyDisplayRole(t);
    if (!role) continue;
    counts.set(role, (counts.get(role) ?? 0) + 1);
  }
  const ordered = [...ROLE_FILTER_ORDER.filter(r => counts.has(r))];
  for (const r of counts.keys()) {
    if (!ROLE_FILTER_ORDER.includes(r)) ordered.push(r);
  }
  return ordered.map(role => ({ role, label: ROLE_FILTER_LABEL[role] ?? role, count: counts.get(role) ?? 0 }));
}

/** 多选状态机：在集合中点入/点出单个角色（返回新集合，身份变更即触发
 *  会话块按筛选重渲） */
export function toggleRoleFilter(prev: ReadonlySet<string>, role: string): Set<string> {
  const next = new Set(prev);
  if (next.has(role)) next.delete(role);
  else next.add(role);
  return next;
}

const CHIP_BASE =
  "inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-full border px-2 py-[3px] text-[11px] transition-[transform,background-color,border-color,color] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-[0.96]";
const CHIP_ACTIVE = "border-primary/40 bg-primary/10 font-medium text-primary";
const CHIP_IDLE = "border-foreground/[0.08] text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground";

export function RunTurnsRoleFilter({ options, total, selected, onToggle, onReset }: {
  /** 已加载轮次派生的角色选项（空数组 = 无轮次，整条不渲染） */
  options: RoleFilterOption[];
  /** 已加载轮次总数（「全部」chip 计数） */
  total: number;
  selected: ReadonlySet<string>;
  onToggle: (role: string) => void;
  onReset: () => void;
}) {
  if (options.length === 0) return null;
  const active = selected.size > 0;
  return (
    <div
      data-role-filter
      className="role-filter-in flex shrink-0 items-center gap-1 overflow-x-auto border-b border-foreground/[0.07] px-3 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <button
        type="button"
        data-role-chip="all"
        aria-pressed={!active}
        className={cn(CHIP_BASE, active ? CHIP_IDLE : CHIP_ACTIVE)}
        onClick={onReset}
      >
        全部<span className="tabular-nums opacity-70">{total}</span>
      </button>
      {options.map(o => (
        <button
          key={o.role}
          type="button"
          data-role-chip={o.role}
          aria-pressed={selected.has(o.role)}
          className={cn(CHIP_BASE, selected.has(o.role) ? CHIP_ACTIVE : CHIP_IDLE)}
          onClick={() => onToggle(o.role)}
        >
          <span className={cn("size-1.5 shrink-0 rounded-full", ROLE_DOT[o.role] ?? "bg-slate-300")} aria-hidden />
          {o.label}
          <span className="tabular-nums opacity-70">{o.count}</span>
        </button>
      ))}
    </div>
  );
}
