// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

"use client";

// 统一导入向导 · 本地扫描后的会话选择表（自 ImportDialog 内联块平移）。
// 过滤/全选内聚（与数据仓 LakeSessionTable 同构）；卡片宽 620px 的信息
// 预算按辨识度分配：First Query 弹性为主辨识列，起止时间合并为单列
// （起值可见、止值入 title），轮次与 token 合并为规模列。

import { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SearchIcon } from "lucide-react";
import { formatTime, formatTokens } from "./format";
import { TableCard } from "./TableCard";

export interface LocalSessionItem {
  id: string;
  createdAt: string;
  endedAt: string | null;
  firstQuery: string | null;
  turnCount: number;
  totalTokens: number | null;
}

interface LocalSessionTableProps {
  sessions: LocalSessionItem[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onSetAll: (ids: string[], select: boolean) => void;
}

export function LocalSessionTable({ sessions, selected, onToggle, onSetAll }: LocalSessionTableProps) {
  const [filter, setFilter] = useState("");

  const q = filter.trim().toLowerCase();
  const filtered = q
    ? sessions.filter(s =>
        s.firstQuery?.toLowerCase().includes(q)
        || s.id.toLowerCase().includes(q))
    : sessions;
  const allFilteredSelected = filtered.length > 0 && filtered.every(s => selected.has(s.id));

  return (
    <div className="space-y-3 overflow-hidden">
      <div className="flex items-center gap-2">
        <Input
          placeholder="Search by keyword or session ID..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="flex-1"
        />
        <SearchIcon className="size-4 text-muted-foreground shrink-0" />
      </div>
      <div className="flex items-center gap-2 mb-2">
        <Checkbox checked={allFilteredSelected} onCheckedChange={() => {
          // 全选作用于当前过滤视图（与数据仓列表同款语义）
          onSetAll(filtered.map(s => s.id), !allFilteredSelected);
        }} />
        <span className="text-sm text-muted-foreground">
          {q ? `${filtered.length} of ${sessions.length} shown` : `Select all (${sessions.length} sessions)`}
        </span>
      </div>
      <TableCard>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[36px] px-2"></TableHead>
            <TableHead className="w-[116px] px-2">Session ID</TableHead>
            <TableHead className="px-2">First Query</TableHead>
            <TableHead className="w-[112px] px-2">时间</TableHead>
            <TableHead className="w-[104px] px-2">规模</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="text-center text-muted-foreground py-4">
                {q ? "No sessions match your search" : "No sessions found"}
              </TableCell>
            </TableRow>
          )}
          {filtered.map(s => (
            <TableRow key={s.id} className={selected.has(s.id) ? "bg-primary/5" : ""}>
              <TableCell className="w-[36px] px-2">
                <Checkbox checked={selected.has(s.id)} onCheckedChange={() => onToggle(s.id)} />
              </TableCell>
              <TableCell className="px-2">
                {/* 会话 ID 可见可搜（搜索框匹配 id 子串）：codex 等 jsonl 源
                    firstQuery 常为空，ID 是唯一可靠辨识位 */}
                <span
                  className="block font-mono text-xs text-muted-foreground truncate cursor-pointer hover:text-foreground"
                  title={`${s.id}（点击复制）`}
                  role="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    void navigator.clipboard?.writeText(s.id).catch(() => { /* 无剪贴板权限时静默 */ })
                  }}
                >
                  {s.id}
                </span>
              </TableCell>
              <TableCell className="px-2 text-xs">
                <span className="block truncate" title={s.firstQuery ?? ""}>
                  {s.firstQuery ?? <span className="text-muted-foreground">(empty)</span>}
                </span>
              </TableCell>
              <TableCell
                className="px-2 text-xs whitespace-nowrap tabular-nums"
                title={`起 ${formatTime(s.createdAt)} · 止 ${s.endedAt ? formatTime(s.endedAt) : "进行中"}`}
              >
                {formatTime(s.createdAt)}
              </TableCell>
              <TableCell
                className="px-2 text-xs whitespace-nowrap tabular-nums"
                title={`${s.turnCount} turns${s.totalTokens != null ? ` · ${s.totalTokens} tokens` : ""}`}
              >
                {s.turnCount}t{s.totalTokens != null ? ` · ${formatTokens(s.totalTokens)}` : ""}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </TableCard>
    </div>
  );
}
