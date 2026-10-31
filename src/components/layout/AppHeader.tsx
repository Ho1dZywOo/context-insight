// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 统一工作台页头（design: docs/design/unified-workbench/design.md §3.3）。
// Sessions × Runs 二合一后 / 是唯一一级入口，双域导航退役；右侧动作
// （导入/数据仓/设置）由各页以 actions 注入。

import type { ReactNode } from "react";
import { BRAND_NAME } from "@/lib/branding";
import { VERSION_DISPLAY } from "@/lib/version";

export function AppHeader({ actions }: { actions?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 flex-wrap">
      <div className="flex items-center gap-2">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">{BRAND_NAME}</h1>
        <span className="text-xs text-muted-foreground">{VERSION_DISPLAY}</span>
      </div>
      {actions ? <div className="flex items-center gap-3">{actions}</div> : null}
    </div>
  );
}
