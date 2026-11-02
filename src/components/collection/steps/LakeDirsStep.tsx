// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software that you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

"use client";

// 统一导入向导 · 数据仓顶层目录步（design: docs/design/unified-workbench/design.md §4）。
// 目录即注册表（统一布局）：每个目录同时呈现其会话与 bundle 包计数，选中
// 目录后两类资产同格加载——不按资产类型分区。

import { Button } from "@/components/ui/button";
import { FolderIcon } from "lucide-react";

export interface LakeDirCard {
  /** 选择值：'__none__' = 根目录（根级资产）；其余 = 顶层目录名 */
  name: string;
  /** 展示名 */
  label: string;
  /** 会话条数 */
  sessionCount: number;
  /** bundle 包数 */
  bundleCount: number;
  /** 该目录含 baseline 会话（评分基准置顶标记） */
  hasBaseline?: boolean;
}

interface LakeDirsStepProps {
  scope: string;
  cards: LakeDirCard[];
  /** bundle 清单读取失败（非凭据类黄字提示，不阻断会话浏览） */
  bundleError?: string | null;
  error: string | null;
  onPick: (card: LakeDirCard) => void;
}

export function LakeDirsStep({ scope, cards, bundleError, error, onPick }: LakeDirsStepProps) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">当前远端：{scope}</p>
      {cards.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          数据仓暂无内容
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-2 max-h-[320px] overflow-y-auto">
          {cards.map(c => (
            <Button key={c.name} variant="outline" size="sm" className="justify-between h-auto py-2" onClick={() => onPick(c)}>
              <span className="flex items-center gap-1 min-w-0">
                <FolderIcon className="size-3.5 text-blue-500 shrink-0" />
                <span className="truncate" title={c.label}>{c.label}</span>
              </span>
              <span className="text-xs text-muted-foreground shrink-0 ml-1">
                {c.hasBaseline ? "基准✓ " : ""}
                {c.sessionCount > 0 && <span>{c.sessionCount} 会话</span>}
                {c.sessionCount > 0 && c.bundleCount > 0 && <span className="text-muted-foreground/60"> · </span>}
                {c.bundleCount > 0 && <span>{c.bundleCount} 包</span>}
                {c.sessionCount === 0 && c.bundleCount === 0 && <span>空</span>}
              </span>
            </Button>
          ))}
        </div>
      )}
      {bundleError && (
        <p className="text-xs text-amber-600 dark:text-amber-400">{bundleError}</p>
      )}
      <p className="text-xs text-muted-foreground">
        目录 = 数据仓顶层目录：会话与 Run 包都存放在各目录里，选中目录即按目录加载
      </p>
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
