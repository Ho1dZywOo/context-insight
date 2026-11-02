// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

"use client";

// 统一导入向导 · 目录内 bundle 包表（统一布局：与该目录会话表同格呈现）。
// 选择键 = runId；按上传/提交时间倒序。

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SearchIcon } from "lucide-react";
import { formatTime } from "./format";

export interface LakeBundleItem {
  runId: string;
  name: string | null;
  status: string | null;
  exportDataComplete: boolean | null;
  memberCount: number | null;
  sessionCount: number | null;
  submitter: string | null;
  /** 所在顶层目录（位置即身份；根级为 null） */
  paradigm: string | null;
  uploadedAt: string | null;
  commitTime: string | null;
  fileCount: number | null;
  imported: boolean;
}

const LAKE_STATUS_VARIANT: Record<string, "green" | "red" | "orange" | "gray"> = {
  passed: "green",
  failed: "red",
  running: "orange",
};

interface LakeBundleTableProps {
  bundles: LakeBundleItem[];
  /** 目录展示名（表头上下文） */
  dirLabel: string;
  scope: string;
  selected: Set<string>;
  onToggle: (runId: string) => void;
  onSetAll: (runIds: string[], select: boolean) => void;
}

export function LakeBundleTable({ bundles, dirLabel, scope, selected, onToggle, onSetAll }: LakeBundleTableProps) {
  const [filter, setFilter] = useState("");

  const q = filter.toLowerCase();
  const filtered = bundles
    .filter(b => !q
      || (b.name?.toLowerCase().includes(q) ?? false)
      || b.runId.toLowerCase().includes(q)
      || (b.submitter?.toLowerCase().includes(q) ?? false)
      || (b.status?.toLowerCase().includes(q) ?? false))
    .slice()
    .sort((a, b) => (b.uploadedAt ?? b.commitTime ?? "").localeCompare(a.uploadedAt ?? a.commitTime ?? ""));
  const allFilteredSelected = filtered.length > 0 && filtered.every(b => selected.has(b.runId));

  return (
    <div className="space-y-3 overflow-hidden">
      <p className="text-xs text-muted-foreground">
        当前远端：{scope} · 目录 <span className="font-medium text-foreground">{dirLabel}</span> 的 Run 包
      </p>
      <div className="flex items-center gap-2">
        <Input
          placeholder="Search by name, run ID, submitter, or status..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="flex-1"
        />
        <SearchIcon className="size-4 text-muted-foreground shrink-0" />
      </div>
      <div className="flex items-center gap-2 mb-2">
        <Checkbox checked={allFilteredSelected} onCheckedChange={() => {
          onSetAll(filtered.map(b => b.runId), !allFilteredSelected);
        }} />
        <span className="text-sm text-muted-foreground">
          {q ? `${filtered.length} of ${bundles.length} shown` : `${bundles.length} bundles`}
        </span>
      </div>
      <div className="max-h-[320px] overflow-y-auto overflow-x-hidden border rounded-lg">
        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[36px] px-2"></TableHead>
              <TableHead className="w-[170px] px-2">Run</TableHead>
              <TableHead className="w-[90px] px-2">状态</TableHead>
              <TableHead className="w-[110px] px-2">规模</TableHead>
              <TableHead className="w-[90px] px-2">提交人</TableHead>
              <TableHead className="w-[110px] px-2">时间</TableHead>
              <TableHead className="px-2">提交信息</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground py-4">
                  {q ? "No bundles match your search" : "该目录暂无 bundle 包——先在工作台上传"}
                </TableCell>
              </TableRow>
            )}
            {filtered.map(b => (
              <TableRow key={b.runId} className={selected.has(b.runId) ? "bg-primary/5" : ""}>
                <TableCell className="px-2 w-[36px]">
                  <Checkbox checked={selected.has(b.runId)} onCheckedChange={() => onToggle(b.runId)} />
                </TableCell>
                <TableCell className="px-2 text-xs py-2 align-middle">
                  <span className="block truncate" title={b.name || b.runId}>
                    {b.imported && <Badge variant="purple" className="px-1 text-[10px] mr-1">已导入</Badge>}
                    {b.name || <span className="text-muted-foreground">{b.runId}</span>}
                  </span>
                </TableCell>
                <TableCell className="px-2 text-xs py-2 align-middle">
                  <Badge variant={LAKE_STATUS_VARIANT[b.status ?? ""] ?? "gray"}>{b.status ?? "—"}</Badge>
                </TableCell>
                <TableCell className="px-2 text-xs py-2 align-middle whitespace-nowrap">
                  {b.memberCount ?? "—"} 成员 · {b.sessionCount ?? "—"} 会话
                </TableCell>
                <TableCell className="px-2 text-xs py-2 align-middle truncate" title={b.submitter ?? ""}>
                  {b.submitter ?? "—"}
                </TableCell>
                <TableCell className="px-2 text-xs py-2 align-middle whitespace-nowrap">
                  {(b.uploadedAt ?? b.commitTime) ? formatTime(b.uploadedAt ?? b.commitTime!) : "—"}
                </TableCell>
                <TableCell className="px-2 text-xs py-2 align-middle">
                  <span className="block truncate" title={b.runId}>
                    {b.fileCount ?? "—"} files · {b.runId}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {selected.size === 0 && (
        <p className="text-sm text-muted-foreground">Select at least one bundle to import</p>
      )}
    </div>
  );
}
