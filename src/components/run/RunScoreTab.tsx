"use client";
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Run Score tab（design: docs/design/run-first-architecture/design.md §3.4，刀I3）。
// 轨迹评分卡（TrajectoryScoring，本版本限定成员域钻取——run 级融合评分后续
// 版本）挂入 run 工作台：多成员 run 经 RunMemberPicker 选成员，solo/单成员
// 自动定向唯一成员；取数走 run 成员视图端点（刀I1 转发 + 刀I2 urlFor）。
// 壳：浅灰画布 + 顶部成员凹槽轨道（单行不折行）+ 单一滚动容器（滚动权在壳，
// 评分卡内容不再自套滚动）；onJumpToTurn：评分证据 §N → DB turnIndex（1-based）
// → turnId 深链 Turns tab（映射走 turn-digest 轻摘要——只要 turnIndex→turnId，
// 不要 member-turns 全量轮次在大会话上的秒级卡顿）。

import { useEffect, useMemo, useState } from "react";
import { RunMemberPicker } from "@/components/run/RunMemberPicker";
import { TrajectoryScoring } from "@/components/scoring/TrajectoryScoring";
import { runMemberUrlFor } from "@/lib/observe/member-url";
import { buildMainAgentTurnMap, type TurnDigest } from "@/lib/shared/turn-digest";
import type { RunMemberRow } from "@/lib/run/member-rows";

export interface RunScoreTabProps {
  runId: string;
  members: RunMemberRow[];
  member: string | null;
  onMemberChange: (member: string | null) => void;
  onOpenTurn: (turnId: string) => void;
}

export function RunScoreTab({ runId, members, member, onMemberChange, onOpenTurn }: RunScoreTabProps) {
  const active = members.find(m => m.taskId === member) ?? members[0] ?? null;
  const [turnMap, setTurnMap] = useState<Map<number, string>>(() => new Map());

  useEffect(() => {
    if (active == null) return;
    let cancelled = false;
    const urlFor = runMemberUrlFor(runId, active.taskId);
    fetch(urlFor("turn-digest"))
      .then(r => (r.ok ? r.json() : null))
      .then((d: TurnDigest | null) => {
        if (cancelled || !d) return;
        setTurnMap(buildMainAgentTurnMap(d.turns ?? []));
      })
      .catch(() => {
        /* 映射取不到只损失跳转，评分卡本体不受影响 */
      });
    return () => { cancelled = true; };
  }, [runId, active]);

  const urlFor = useMemo(
    () => (active == null ? null : runMemberUrlFor(runId, active.taskId)),
    [runId, active],
  );

  if (active == null || urlFor == null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center rounded-2xl bg-muted/30 text-xs text-muted-foreground">
        本 run 无成员会话，无评分数据。
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl bg-muted/30" data-run-score>
      <div className="flex shrink-0 items-center gap-3 px-4 pt-3.5">
        <h3 className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">评分卡</h3>
        <RunMemberPicker members={members} value={active.taskId} onChange={onMemberChange} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 pt-3">
        <TrajectoryScoring
          taskId={active.taskId}
          framework={active.framework}
          embedded
          urlFor={urlFor}
          onJumpToTurn={turnIndex => {
            const id = turnMap.get(turnIndex);
            if (id) onOpenTurn(id);
          }}
        />
      </div>
    </div>
  );
}
