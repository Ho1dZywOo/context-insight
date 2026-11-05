// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 统一工作台页头（design: docs/design/unified-workbench/design.md §3.3）。
// Sessions × Runs 二合一后 / 是唯一一级入口，双域导航退役；右侧动作
// （导入/数据仓/设置）由各页以 actions 注入（结构类单点：HEADER_PILL）。
// iOS large-title 形态：品牌瓦（BrandMark，与 run 详情页同源）+ 大字名 +
// 一行说明（含版本），层级靠字阶不靠色。

import type { ReactNode } from "react";
import { BRAND_NAME, BAY_NAME } from "@/lib/branding";
import { VERSION_DISPLAY } from "@/lib/version";
import { BrandMark } from "@/components/BrandMark";

export function AppHeader({ actions }: { actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex items-center gap-3">
        <BrandMark size="lg" />
        <div className="flex flex-col gap-0.5">
          <h1 className="text-3xl font-bold tracking-tight text-foreground">{BRAND_NAME}</h1>
          <p className="text-xs text-muted-foreground">
            会话级可观测工作台 · {BAY_NAME} 观测 · {VERSION_DISPLAY}
          </p>
        </div>
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </header>
  );
}
