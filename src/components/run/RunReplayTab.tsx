"use client";
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Run Replay tab（design: docs/design/run-first-architecture/design.md §3.4，刀I3）。
// 对话全量回放（ChatReplayView，双面板逐 turn 重放）挂入 run 工作台：数据约束
// 是单会话（回放按成员会话展开），多成员 run 经 RunMemberPicker 选成员，solo/
// 单成员自动定向；富轮次取数走 run 成员视图端点 member-turns
// （includeContent + includeToolDetail，session 页同参），组件零 fork。
// 默认隐藏（?a / NEXT_PUBLIC_SHOW_ADVANCED_TABS 展开，对齐 session 页先例）。

import { useEffect, useState } from "react";
import { RunMemberPicker } from "@/components/run/RunMemberPicker";
import { ChatReplayView } from "@/components/observe/ChatReplayView";
import { LoadState } from "@/components/ui/loading";
import { runMemberUrlFor } from "@/lib/observe/member-url";
import type { RunMemberRow } from "@/lib/run/member-rows";
import { useRunDataEpoch } from "@/lib/run/data-epoch";

export interface RunReplayTabProps {
  runId: string;
  members: RunMemberRow[];
  member: string | null;
  onMemberChange: (member: string | null) => void;
  onOpenTurn: (turnId: string) => void;
}

interface MemberTurnItem {
  turnId: string;
  turnIndex: number;
  role: string;
  content: string | null;
  contentSummary: string | null;
  agentName: string | null;
  isSubagent: boolean;
  subagentName: string | null;
  subagentSessionId: string | null;
  totalTokens: number;
  inputTokens: number;
  inputMessagesCount: number;
  inputMessagesTokens: number;
  outputTokens: number;
  latencyMs: number;
  createdAt: string | null;
  model: string | null;
  toolCalls: Array<{
    toolCallId: string;
    toolName: string;
    argsJson: string | null;
    resultJson: string | null;
    state: string;
    durationMs: number;
  }>;
  skillEvents: Array<{ skillName: string; eventType: string; success: boolean }>;
}

export function RunReplayTab({ runId, members, member, onMemberChange, onOpenTurn }: RunReplayTabProps) {
  const dataEpoch = useRunDataEpoch();
  const active = members.find(m => m.taskId === member) ?? members[0] ?? null;
  // 成员域结果带成员标记：切换期间（member 不匹配）视为载入中——不在 effect
  // 内同步 setState（级联渲染），状态一律由 fetch 回调驱动
  const [state, setState] = useState<{ member: string; turns: MemberTurnItem[] | null } | null>(null);

  useEffect(() => {
    if (active == null) return;
    let cancelled = false;
    const urlFor = runMemberUrlFor(runId, active.taskId);
    fetch(urlFor("member-turns?includeContent=true&includeToolDetail=true"))
      .then(r => (r.ok ? r.json() : null))
      .then((d: { items?: MemberTurnItem[] } | null) => {
        if (cancelled) return;
        setState({ member: active.taskId, turns: d?.items ?? [] });
      })
      .catch(() => {
        if (cancelled) return;
        setState({ member: active.taskId, turns: null });
      });
    return () => { cancelled = true; };
  }, [runId, active, dataEpoch]);

  const current = state != null && state.member === active?.taskId ? state : null;

  if (active == null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center rounded-xl border bg-white text-xs text-muted-foreground shadow-sm">
        本 run 无成员会话，无回放数据。
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-white shadow-sm">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b bg-white/95 px-4 py-2.5 backdrop-blur">
        <h3 className="mr-1 text-[13px] font-semibold text-[#1f2328]">对话回放</h3>
        <RunMemberPicker members={members} value={active.taskId} onChange={onMemberChange} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {current == null ? (
          <LoadState label="载入回放轮次…" className="min-h-full justify-center" />
        ) : current.turns == null ? (
          <p className="p-6 text-center text-xs text-muted-foreground">回放数据载入失败（稍后重试或检查成员会话数据）。</p>
        ) : current.turns.length === 0 ? (
          <p className="p-6 text-center text-xs text-muted-foreground">该成员会话无轮次记录。</p>
        ) : (
          <ChatReplayView
            turns={current.turns}
            sessionModel={active.model}
            onNavigateToTurn={onOpenTurn}
          />
        )}
      </div>
    </div>
  );
}
