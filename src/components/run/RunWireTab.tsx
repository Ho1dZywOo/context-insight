"use client";
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Run Wire tab（design: docs/design/run-first-architecture/design.md §3.4，刀I3）。
// Wire 轮次（proxy 捕获原始 wire 逐轮重放）挂入 run 工作台：数据约束是单会话
// （wire 捕获属于具体成员），多成员 run 经 RunMemberPicker 选执行目标（solo/
// 单成员自动定向唯一成员）；取数走 run 成员视图端点（刀I1 转发 + 刀I2 urlFor），
// 组件本身零 fork。默认隐藏（调试视图，?a / NEXT_PUBLIC_SHOW_ADVANCED_TABS 展开，
// 对齐 session 页先例）。

import { RunMemberPicker } from "@/components/run/RunMemberPicker";
import { WireRounds } from "@/components/observe/WireRounds";
import { runMemberUrlFor } from "@/lib/observe/member-url";
import type { RunMemberRow } from "@/lib/run/member-rows";

export interface RunWireTabProps {
  runId: string;
  members: RunMemberRow[];
  member: string | null;
  onMemberChange: (member: string | null) => void;
}

export function RunWireTab({ runId, members, member, onMemberChange }: RunWireTabProps) {
  const active = members.find(m => m.taskId === member) ?? members[0] ?? null;
  if (active == null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center rounded-xl border bg-white text-xs text-muted-foreground shadow-sm">
        本 run 无成员会话，无 wire 数据。
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-white shadow-sm">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b bg-white/95 px-4 py-2.5 backdrop-blur">
        <h3 className="mr-1 text-[13px] font-semibold text-[#1f2328]">Wire 轮次</h3>
        <RunMemberPicker members={members} value={active.taskId} onChange={onMemberChange} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <WireRounds taskId={active.taskId} framework={active.framework} urlFor={runMemberUrlFor(runId, active.taskId)} />
      </div>
    </div>
  );
}
