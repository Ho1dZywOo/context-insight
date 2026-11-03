"use client"
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Turn 详情加载骨架（点击轮次 → 详情取数期间）：与 run 页加载态同一语法
// ——外壳即真实结构（sticky 导航 + 胶片行 + 指标瓦片 + 输入卡 + 舞台卡），
// 网格与留白类取自 TurnDetail 本体，内容以同形状灰块占位、pulse 逐块
// 启动有时差；卡片入场走淡入 + 底部滑移。骨架不撒谎：每块都对得上加载
// 后的真实区域，加载完成只有内容填充，无结构跳变。纯静态 JSX，零逻辑。
export function TurnDetailSkeleton() {
  return (
    <div className="flex min-h-full flex-col bg-muted/40">
      {/* 导航条骨架：走查圆钮 + 标题/元信息 + 身份药丸 + 胶片行 */}
      <div className="sticky top-0 z-20 border-b border-foreground/[0.07] bg-muted/40 backdrop-blur-xl">
        <div className="flex items-center gap-2.5 px-4 py-2.5" aria-hidden>
          <div className="size-8 animate-pulse rounded-full bg-foreground/[0.05] dark:bg-foreground/[0.09]" />
          <div className="size-8 animate-pulse rounded-full bg-foreground/[0.05] dark:bg-foreground/[0.09]" style={{ animationDelay: "60ms" }} />
          <div className="min-w-0 flex-1">
            <div className="h-4 w-24 animate-pulse rounded bg-foreground/[0.08]" />
            <div className="mt-1.5 h-2.5 w-44 animate-pulse rounded bg-foreground/[0.05]" style={{ animationDelay: "80ms" }} />
          </div>
          <div className="h-6 w-20 animate-pulse rounded-full bg-foreground/[0.05] dark:bg-foreground/[0.09]" style={{ animationDelay: "120ms" }} />
        </div>
        {/* 胶片行：少轮收窄居中的真实形态 */}
        <div className="flex justify-center px-3 pt-1 pb-2" aria-hidden>
          <div className="h-9 w-[45%] animate-pulse rounded bg-foreground/[0.05] dark:bg-foreground/[0.08]" style={{ animationDelay: "160ms" }} />
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-3 px-4 py-4" aria-hidden>
        {/* 指标瓦片：三卡网格与真实同构（标签 / 大数字 / 微条 / 图例） */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {[0, 1, 2].map(i => (
            <div
              key={i}
              className="animate-in fade-in slide-in-from-bottom-4 duration-500 fill-mode-backwards rounded-2xl bg-card p-4"
              style={{ animationDelay: `${i * 70}ms` }}
            >
              <div className="h-3 w-16 animate-pulse rounded bg-foreground/[0.06]" />
              <div className="mt-2 h-7 w-20 animate-pulse rounded bg-foreground/[0.09]" style={{ animationDelay: "60ms" }} />
              <div className="mt-2.5 h-1.5 w-full animate-pulse rounded-full bg-foreground/[0.06]" style={{ animationDelay: "120ms" }} />
              <div className="mt-2 h-3 w-3/4 animate-pulse rounded bg-foreground/[0.05]" style={{ animationDelay: "180ms" }} />
            </div>
          ))}
        </div>

        {/* 输入卡骨架：段头 + 收纳行 + 消息块 */}
        <div
          className="animate-in fade-in slide-in-from-bottom-4 duration-500 fill-mode-backwards rounded-2xl bg-card"
          style={{ animationDelay: "210ms" }}
        >
          <div className="flex items-center gap-2.5 px-4 py-3">
            <div className="h-3 w-14 animate-pulse rounded bg-foreground/[0.06]" />
            <div className="h-3 w-32 animate-pulse rounded bg-foreground/[0.05]" style={{ animationDelay: "60ms" }} />
            <div className="h-px flex-1 bg-foreground/[0.08]" />
          </div>
          <div className="border-t border-foreground/[0.06] px-4 py-3">
            <div className="h-3 w-36 animate-pulse rounded bg-foreground/[0.05]" />
            <div className="mt-2.5 h-9 animate-pulse rounded-xl bg-muted/60" style={{ animationDelay: "60ms" }} />
          </div>
        </div>

        {/* 舞台卡骨架：段头 + 正文/思考块（统一文本块形态） */}
        <div
          className="animate-in fade-in slide-in-from-bottom-4 duration-500 fill-mode-backwards rounded-2xl bg-card"
          style={{ animationDelay: "280ms" }}
        >
          <div className="flex items-center gap-2.5 px-4 pt-3.5 pb-1">
            <div className="h-3 w-16 animate-pulse rounded bg-foreground/[0.06]" />
            <div className="h-px flex-1 bg-foreground/[0.08]" />
          </div>
          <div className="space-y-2 px-4 pb-3.5">
            <div className="h-20 animate-pulse rounded-xl bg-muted/60" />
            <div className="h-14 animate-pulse rounded-xl bg-muted/60" style={{ animationDelay: "90ms" }} />
          </div>
        </div>
      </div>
      <span className="sr-only" role="status">载入轮次详情…</span>
    </div>
  )
}
