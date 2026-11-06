// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 嵌入式导出 bundle 的入口：挂载真实 run 工作台（run/[runId] 页组件零改动
// 复用），fetch 由离线内核应答（静态档案 + 动态合成器）。

import React from "react"
import { createRoot } from "react-dom/client"
import { Toaster } from "sonner"
import RunDetailPage from "@/app/run/[runId]/page"
import { RunOfflineHostCapsProvider } from "@/lib/run/host-caps"
import { installOfflineKernel } from "@/export-view/offline-kernel"

// file://下 EventSource/SSE 会报安全错误；导出快照无需实时刷新，no-op 掉
class EventSourceShim {
  onmessage: ((ev: { data: string }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onopen: ((ev: unknown) => void) | null = null
  readyState = 0
  constructor() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}
;(window as unknown as { EventSource: typeof EventSourceShim }).EventSource = EventSourceShim

installOfflineKernel()

// 对账结果迁移（live 导出时从 sessionStorage 捕获），挂载即读——直接展示
// 无需离线重跑
try {
  const audits = (window as unknown as { __EXPORT_AUDITS?: Record<string, string> }).__EXPORT_AUDITS
  if (audits) {
    for (const [k, v] of Object.entries(audits)) {
      try { sessionStorage.setItem(k, v) } catch { /* quota */ }
    }
  }
} catch { /* 隐私模式 sessionStorage 不可用 */ }

// React 19 的 use(promise) 要求 thenable 带 status 字段；native Promise 没有，
// 首次渲染会挂起但根无 Suspense 边界 → 崩溃。构造 fulfilled thenable，use() 同步返回，不挂起。
function makeFulfilledThenable<T>(value: T): Promise<T> {
  const thenable = {
    status: "fulfilled" as const,
    value,
    then(onFulfilled?: (v: T) => unknown) {
      if (typeof onFulfilled === "function") {
        Promise.resolve(value).then(onFulfilled)
      }
      return this
    },
  }
  return thenable as unknown as Promise<T>
}

function ExportRoot() {
  const params = React.useMemo(
    () => makeFulfilledThenable({ runId: window.__EXPORT_RUN_ID ?? "" }),
    [],
  )
  return (
    <React.Suspense fallback={<div className="p-4 text-muted-foreground">Loading…</div>}>
      <RunOfflineHostCapsProvider>
        <RunDetailPage params={params} />
      </RunOfflineHostCapsProvider>
      <Toaster position="bottom-right" richColors closeButton />
    </React.Suspense>
  )
}

const el = document.getElementById("root")
if (el) {
  createRoot(el).render(<ExportRoot />)
}
