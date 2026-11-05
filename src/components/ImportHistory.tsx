"use client"
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 导入历史存储模块（localStorage）：ImportDialog 导入完成即落条目，供导入
// 进度/故障排查回溯。曾挂首页的 Recent Imports 面板已退役（被回收站面板
// 接替——删除的资产先归档可恢复，见 src/lib/recycle.ts），本文件只保留
// 存取助手。

export interface ImportHistoryEntry {
  taskId: string
  importedAt: string
  turnCount: number
  status: "success" | "error"
  query: string | null
  filePath: string | null
  sourceType?: string
  framework?: string | null
  version?: string | null
  /** 资产类型（统一工作台）：缺省 = 会话（旧版条目）；run 条目删除只清历史，不走 delete-session */
  kind?: "session" | "run"
}

const STORAGE_KEY = "context-import-history"
const MAX_ENTRIES = 20

export function saveImportHistory(entries: ImportHistoryEntry[]) {
  try {
    const existing: ImportHistoryEntry[] = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]")
    const merged = [...entries, ...existing].slice(0, MAX_ENTRIES)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
  } catch {}
}

export function getImportHistory(): ImportHistoryEntry[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]")
  } catch {
    return []
  }
}
