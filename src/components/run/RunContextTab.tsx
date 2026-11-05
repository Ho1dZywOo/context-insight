"use client";
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Run Context tab（旧 session 视图 ContextTracker 的 run 泛化，泳道同款
// 视角）：agent = 成员会话 root（session 即 agent，卡名/道名用成员短名——与
// 泳道 root 道同源）+ 子代理（sid 池化）。数据 = /context 端点瘦轮次投影 +
// 服务端预算的每 agent 窗口上限；跨成员水位比较由上下文增长趋势图承载
// （真实时间轴 + 50/80/100% 区带——run 视角的全景轴是运行时间线，与泳道
// 一致）。组件单一源复用 ContextTracker（export viewer 同款）。

import { useEffect, useState } from "react";
import { ContextTracker, type TurnRowItem } from "@/components/observe/ContextTracker";
import { LoadState } from "@/components/ui/loading";
import type { ContextAgentLimit, ContextTurnItem } from "@/lib/observe/collectors/context";
import { useRunDataEpoch } from "@/lib/run/data-epoch";

interface ContextResponse {
  turns: ContextTurnItem[];
  agentLimits: ContextAgentLimit[];
  total: number;
}

export interface RunContextTabProps {
  runId: string;
  onNavigateToTurn?: (turnId: string, memberTaskId?: string | null) => void;
}

export function RunContextTab({ runId, onNavigateToTurn }: RunContextTabProps) {
  const dataEpoch = useRunDataEpoch();
  const [turns, setTurns] = useState<TurnRowItem[]>([]);
  const [limits, setLimits] = useState<Record<string, number> | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false
    fetch(`/api/observe/run/${encodeURIComponent(runId)}/context`)
      .then(r => (r.ok ? r.json() : null))
      .then((d: ContextResponse | null) => {
        if (cancelled) return
        setTurns((d?.turns ?? []) as TurnRowItem[])
        const rec: Record<string, number> = {}
        for (const a of d?.agentLimits ?? []) {
          if (a.contextLimit != null) rec[a.key] = a.contextLimit
        }
        setLimits(rec)
        setLoaded(true)
      })
      .catch(() => {
        if (cancelled) return
        setTurns([]); setLimits(null); setLoaded(true)
      })
    return () => { cancelled = true }
  }, [runId, dataEpoch])

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-background shadow-sm">
      <div className="run-scroll-fade min-h-0 flex-1 overflow-y-auto">
        {!loaded ? (
          <LoadState label="载入上下文数据…" className="min-h-full justify-center" />
        ) : (
          <ContextTracker
            turns={turns}
            sessionModel={null}
            agentContextLimits={limits}
            onNavigateToTurn={onNavigateToTurn}
          />
        )}
      </div>
    </div>
  )
}
