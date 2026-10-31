"use client";
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Run Skills tab：run 原生观测外壳。SkillsPanorama 四卡（画像/调用时间线/
// 热点排行/选中明细），恒为全成员融合端点；定位出口（onOpenTurn）由页面
// 外壳接 Turns 深链管线。session 遗产（Coverage 卡/SkillCharts/成员选择器）
// 已随变革退役——SkillDetail 保留给离线导出查看器。

import { useEffect, useState } from "react";
import { SkillsPanorama, type SkillsPanoramaData, type SkillsMemberRef } from "@/components/observe/SkillsPanorama";

export interface RunSkillsTabProps {
  runId: string;
  /** 覆盖度成员域（页面外壳从 run 视图模型传入） */
  members?: SkillsMemberRef[];
  /** 定位出口：turnId → Turns 深链（工作台外壳收口） */
  onOpenTurn: (turnId: string) => void;
}

export function RunSkillsTab({ runId, members, onOpenTurn }: RunSkillsTabProps) {
  const [data, setData] = useState<SkillsPanoramaData | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/observe/run/${encodeURIComponent(runId)}/skills`)
      .then(r => (r.ok ? r.json() : null))
      .then((d: SkillsPanoramaData | null) => {
        if (cancelled) return;
        setData(d);
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setData(null);
        setLoaded(true);
      });
    return () => { cancelled = true };
  }, [runId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto rounded-2xl bg-muted/30 p-4">
      {!loaded ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-xs text-muted-foreground">载入技能观测…</p>
        </div>
      ) : data == null ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-xs text-muted-foreground">技能观测载入失败（稍后重试或检查成员会话数据）。</p>
        </div>
      ) : (
        <SkillsPanorama runId={runId} data={data} members={members} onOpenTurn={onOpenTurn} />
      )}
    </div>
  );
}
