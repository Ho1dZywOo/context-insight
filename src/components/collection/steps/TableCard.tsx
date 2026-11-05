// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

"use client";

// 导入向导步骤表的卡片外壳：定宽纪律单点——table-fixed（列宽由首行定，
// 内容不再参与宽度协商）+ 横向禁溢出 + 定高纵向滚动。此前各表内联复制
// 外壳，本地会话表漏掉 table-fixed（auto 布局 + 单元格基语 nowrap 默认）
// → 长内容把表撑破卡片右缘。列内可变文本一律配 truncate span。

import type { ReactNode } from "react";
import { Table } from "@/components/ui/table";

export function TableCard({ children }: { children: ReactNode }) {
  return (
    <div className="max-h-[320px] overflow-y-auto overflow-x-hidden rounded-xl border border-border/40">
      <Table className="table-fixed">{children}</Table>
    </div>
  );
}
