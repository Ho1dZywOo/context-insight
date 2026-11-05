// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 统一工作台工具栏（IDE chrome）：分区标题 + 动作位，固定高度不滚动——
// 滚动只发生在内容区。品牌块仅移动档出现（桌面档品牌在侧栏 AppShell）。

import type { ReactNode } from "react";
import { BRAND_NAME } from "@/lib/branding";
import { BrandMark } from "@/components/BrandMark";

export function AppHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border/40 bg-background/60 px-4 lg:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex items-center gap-2 lg:hidden">
          <BrandMark size="sm" />
          <span className="text-sm font-semibold tracking-tight">{BRAND_NAME}</span>
        </span>
        <h1 className="truncate text-base font-semibold tracking-tight text-foreground">{title}</h1>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}
