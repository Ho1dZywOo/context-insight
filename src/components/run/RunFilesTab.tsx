"use client";
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Run Files tab（design: docs/design/run-observe-parity/design.md §5，刀D/刀G）。
// FileReadAnalysis 复用（不 fork）：经 endpoints 覆盖切 run 端点（跨成员
// 文件读取归并/恢复/目录重编汇册）——观测恒为全成员融合，无会话隔离，
// session 端点缺省语义零改动。

import { useMemo } from "react";
import { FileReadAnalysis } from "@/components/observe/FileReadAnalysis";
import { useRunDataEpoch } from "@/lib/run/data-epoch";

export interface RunFilesTabProps {
  runId: string;
}

export function RunFilesTab({ runId }: RunFilesTabProps) {
  const dataEpoch = useRunDataEpoch();
  const endpoints = useMemo(() => {
    const base = `/api/observe/run/${encodeURIComponent(runId)}`;
    return {
      fileReads: `${base}/file-reads`,
      fileRestore: `${base}/file-restore`,
      dirRestore: `${base}/dir-restore`,
    };
  }, [runId, dataEpoch]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl bg-muted/30 ring-1 ring-foreground/[0.06] shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <FileReadAnalysis taskId={runId} endpoints={endpoints} />
    </div>
  );
}
