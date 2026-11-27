// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with
// the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See the LICENSE in the root of the software repository for the full text of the License.

"use client";

// Run 工作台页头右翼的内容（单行应用栏的右段）：同步态 chip + 图标动作组（刷新 /
// 导出 Markdown / 导出离线 HTML）+ 上传主操作。动作在不在场由入参决定（null =
// 不渲染）：离线档案没有服务端协作动作，MD 导出 solo 专属——本组件不读宿主
// 能力，只按入参摆。全空即整个右区不渲染，空间归 tab 导航。
// 密度：本区挂在页头的 @container 里，页头宽度不足时文字先让位——chip 与上传
// 钮收成纯图标（全称进 title / aria-label），空间让给同行导航；tab 导航是页头
// 主职能，动作文字是次职能。阈值与类名单点在 RunWorkbenchHeader。

import { FileTextIcon, GlobeIcon, Loader2Icon, RefreshCwIcon, UploadIcon, WifiIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { HEADER_TEXT_SHOW, HEADER_UPLOAD_PADDING } from "@/components/run/header/RunWorkbenchHeader";

/** 同步态（页头刷新钮与 chip 的共同驱动）：idle = 手动刷新；auto = 自动同步
 *  已开启（源有新数据时增量导入）；syncing = 正在同步 */
export type RunSyncState = "idle" | "auto" | "syncing";

export interface RunHeaderActionsProps {
  /** 刷新能力；null = 不提供（离线档案） */
  refresh: { sync: RunSyncState; enabled: boolean; onRefresh: () => void } | null;
  /** 导出 Markdown；null = 不提供 */
  markdown: { pending: boolean; onExport: () => void } | null;
  /** 导出离线 HTML；null = 不提供 */
  html: { pending: boolean; onExport: () => void } | null;
  /** 上传数据仓主操作；null = 不提供 */
  upload: { label: string; disabled: boolean; onOpen: () => void } | null;
}

const ICON_BUTTON =
  "flex size-7 cursor-pointer items-center justify-center rounded-full transition-colors hover:bg-foreground/[0.06] disabled:cursor-default disabled:opacity-45 dark:hover:bg-foreground/[0.12]";

export function RunHeaderActions({ refresh, markdown, html, upload }: RunHeaderActionsProps) {
  if (!refresh && !markdown && !html && !upload) return null;
  const sync = refresh?.sync ?? "idle";
  return (
    <div data-run-header-actions className="flex shrink-0 items-center gap-1.5">
      {sync !== "idle" ? (
        <span
          className={cn(
            "flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium",
            sync === "syncing"
              ? "bg-blue-500/[0.08] text-blue-600 dark:bg-blue-500/[0.14] dark:text-blue-400"
              : "bg-emerald-500/[0.08] text-emerald-600 dark:bg-emerald-500/[0.14] dark:text-emerald-400",
          )}
          title={sync === "syncing" ? "同步中…" : "自动同步已开启：源有新数据时自动增量导入"}
        >
          {sync === "syncing" ? <Loader2Icon className="size-3 animate-spin" /> : <WifiIcon className="size-3" />}
          <span className={HEADER_TEXT_SHOW}>{sync === "syncing" ? "同步中…" : "自动同步"}</span>
        </span>
      ) : null}
      {refresh || markdown || html ? (
        <div className="flex items-center gap-0.5 rounded-full bg-foreground/[0.04] p-1 dark:bg-foreground/[0.08]">
          {refresh ? (
            <button
              type="button"
              className={ICON_BUTTON}
              onClick={refresh.onRefresh}
              disabled={sync === "syncing" || !refresh.enabled}
              title={sync === "syncing" ? "同步中…" : sync === "auto" ? "自动同步已开启 · 点击立即刷新" : "立即刷新"}
            >
              {sync === "syncing" ? (
                <Loader2Icon className="size-3.5 animate-spin text-blue-500" />
              ) : sync === "auto" ? (
                <span className="relative flex size-3.5 items-center justify-center text-emerald-500 dark:text-emerald-400">
                  <WifiIcon className="size-3.5" />
                  <span className="absolute -right-0.5 -top-0.5 size-1.5 animate-pulse rounded-full bg-emerald-500" aria-hidden />
                </span>
              ) : (
                <RefreshCwIcon className="size-3.5" />
              )}
            </button>
          ) : null}
          {markdown ? (
            <button type="button" className={ICON_BUTTON} onClick={markdown.onExport} disabled={markdown.pending} title="导出 Markdown">
              {markdown.pending ? <Loader2Icon className="size-3.5 animate-spin" /> : <FileTextIcon className="size-3.5" />}
            </button>
          ) : null}
          {html ? (
            <button type="button" className={ICON_BUTTON} onClick={html.onExport} disabled={html.pending} title="导出离线 HTML">
              {html.pending ? <Loader2Icon className="size-3.5 animate-spin" /> : <GlobeIcon className="size-3.5" />}
            </button>
          ) : null}
        </div>
      ) : null}
      {upload ? (
        <button
          type="button"
          className={cn(
            "flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full bg-foreground text-xs font-medium text-background transition-opacity hover:opacity-85 disabled:cursor-default disabled:opacity-45",
            HEADER_UPLOAD_PADDING,
          )}
          onClick={upload.onOpen}
          disabled={upload.disabled}
          title={upload.label}
          aria-label={upload.label}
        >
          <UploadIcon className="size-3.5" />
          <span className={cn("whitespace-nowrap", HEADER_TEXT_SHOW)}>{upload.label}</span>
        </button>
      ) : null}
    </div>
  );
}
