// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

"use client";

// 统一导入向导 · 导入进度步（design: docs/design/unified-workbench/design.md §4）。
// 双模型：会话/批量 bundle 项走逐项列表（pending → importing → success/error），
// 本地单 bundle job 走富视图（validate/store/import 阶段 + 当前 sid + 警告）。
// 展示项由向导编排层装饰好（label/框架徽标字段），本组件纯渲染。

import { Badge } from "@/components/ui/badge";
import { agentFrameworkOf, isProxyVersion } from "@/lib/shared/session-format";
import { LoaderIcon } from "lucide-react";

/** 本地 bundle 导入 job 状态（POST 返回 jobId 后 1s 轮询） */
export interface BundleJobState {
  jobId: string;
  runId: string;
  step: "validate" | "store" | "import" | "done" | "error";
  total: number;
  imported: number;
  existing: number;
  missingFile: number;
  failed: number;
  currentSid: string | null;
  error: string | null;
  warnings: string[];
}

export interface ImportProgressItem {
  key: string;
  kind: "session" | "run";
  label: string;
  /** 会话项记录类（同 sid 双记录）：native/capture 标注 */
  recording?: "capture" | "native";
  status: "pending" | "importing" | "success" | "error";
  message?: string | null;
  framework?: string | null;
  version?: string | null;
}

interface ImportProgressProps {
  items: ImportProgressItem[];
  job: BundleJobState | null;
}

export function ImportProgress({ items, job }: ImportProgressProps) {
  // 本地单 bundle job：富视图（阶段 + 当前成员 + 警告），不走逐项列表
  if (job) {
    const busy = job.step !== "done" && job.step !== "error";
    const importedSoFar = job.imported + job.existing;
    return (
      <div className="space-y-2 max-h-[300px] overflow-y-auto">
        <div className="flex items-center gap-2 text-xs text-muted-foreground pb-1 border-b">
          <LoaderIcon className={`size-3.5 ${busy ? "animate-spin" : "hidden"}`} />
          <span>
            Progress: {importedSoFar}/{job.total}
            {job.step === "validate" ? " · 校验 manifest..." : job.step === "store" ? " · 写入 manifest..." : ""}
          </span>
        </div>
        {job.currentSid && busy && (
          <div className="text-sm border-b pb-1.5">
            <span className="flex-1 truncate font-mono text-xs">{job.currentSid}</span>
          </div>
        )}
        <div className="text-sm space-y-1">
          {job.step === "error" ? (
            <p className="text-red-600 dark:text-red-400 break-words whitespace-pre-wrap">{job.error}</p>
          ) : job.step === "done" ? (
            <p className="text-emerald-600 dark:text-emerald-400">
              完成：新导入 {job.imported} · 已存在 {job.existing}
              {job.missingFile > 0 ? ` · 缺文件 ${job.missingFile}` : ""}
              {job.failed > 0 ? ` · 失败 ${job.failed}` : ""}
            </p>
          ) : (
            <p className="text-muted-foreground">
              {job.step === "import" ? "导入成员会话..." : "处理 manifest..."}
            </p>
          )}
          {job.warnings.map(w => (
            <p key={w} className="text-xs text-amber-600 dark:text-amber-400 break-words" title={w}>⚠ {w}</p>
          ))}
        </div>
      </div>
    );
  }

  const doneCount = items.filter(s => s.status === "success" || s.status === "error").length;
  const allDone = items.length > 0 && doneCount === items.length;

  return (
    <div className="space-y-2 max-h-[300px] overflow-y-auto">
      <div className="flex items-center gap-2 text-xs text-muted-foreground pb-1 border-b">
        <LoaderIcon className={`size-3.5 ${allDone ? "hidden" : "animate-spin"}`} />
        <span>Progress: {doneCount}/{items.length}</span>
      </div>
      {items.map(s => (
        <div key={s.key} className="text-sm border-b pb-1.5 last:border-0">
          <div className="flex items-center gap-2">
            <span className="flex-1 truncate" title={s.label}>
              {s.kind === "run" && <Badge variant="purple" className="px-1 text-[10px] mr-1">Run</Badge>}
              {s.label}
              {s.recording && <span className="text-muted-foreground"> ·{s.recording === "native" ? "native" : "capture"}</span>}
            </span>
            {s.status === "pending" && <span className="text-muted-foreground">Waiting</span>}
            {s.status === "importing" && (
              <span className="text-blue-600 dark:text-blue-400 flex items-center gap-1">
                <LoaderIcon className="size-3 animate-spin" />
                Importing...
              </span>
            )}
            {s.status === "success" && (
              <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                {s.kind === "session" && (
                  <>
                    {/* 捕获行 framework 带 -proxy 后缀——剥后缀归一进白名单
                        （同 ImportHistory），proxy 徽标仍走 version */}
                    {(() => {
                      const agentFw = agentFrameworkOf(s.framework ?? null);
                      if (agentFw === "cannbot") return <Badge variant="green">CANNBot</Badge>;
                      if (agentFw === "opencode") return <Badge variant="blue">OpenCode</Badge>;
                      if (agentFw === "claude-code") return <Badge variant="orange">Claude</Badge>;
                      if (agentFw === "dsh") return <Badge variant="purple">DSH</Badge>;
                      if (agentFw === "codex") return <Badge variant="slate">Codex</Badge>;
                      return null;
                    })()}
                    {isProxyVersion(s.version ?? null) && <Badge variant="yellow">proxy</Badge>}
                  </>
                )}
                {s.message}
              </span>
            )}
            {s.status === "error" && <Badge variant="red">Failed</Badge>}
          </div>
          {s.status === "error" && s.message && (
            <div className="mt-1 text-xs text-red-600 dark:text-red-400 break-words whitespace-pre-wrap">{s.message}</div>
          )}
        </div>
      ))}
    </div>
  );
}
