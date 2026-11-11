// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

"use client";

// 统一导入向导 · 数据仓范式目录内的会话表（自 LocalFileImport 数据仓步平移）。
// 选择键 = sid@recording（同 sid 双记录两条目各自独立勾选）；baseline 置顶，
// 其余按提交时间倒序；过滤/全选作用于当前视图。

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { isProxyVersion } from "@/lib/shared/session-format";
import { SearchIcon } from "lucide-react";
import { formatTime } from "./format";
import { TableCard } from "./TableCard";

export interface LakeSession {
  sid: string;
  fileCount: number;
  author: string;
  submitter: string;
  description: string;
  commitTime: string;
  framework?: string | null;
  ccVersion?: string | null;
  producer?: string | null;
  /** 所在顶层范式目录（目录即注册表）；存量区根级会话为 null */
  paradigm?: string | null;
  /** 范式 baseline 会话（位置即身份：<paradigm>/baseline/<sid>/，路径推导） */
  isBaseline?: boolean;
  /** 任务结果标注（cc-session-meta 可选字段 opGen，上传时勾选） */
  opGen?: 'success' | 'failure' | null;
  /** 记录类（同 sid 双记录）：native = <sid>.native/ 原生 claude 会话；capture = 裸 <sid>/ */
  recording?: 'capture' | 'native';
}

/** 同 sid 双记录：列表选择键 = sid@recording（捕获与原生各占一条目） */
export function lakeEntryKey(s: Pick<LakeSession, 'sid' | 'recording'>): string {
  return `${s.sid}@${s.recording ?? 'capture'}`;
}

interface LakeSessionTableProps {
  sessions: LakeSession[];
  paradigm: string;
  scope: string;
  selected: Set<string>;
  onToggle: (key: string) => void;
  onSetAll: (keys: string[], select: boolean) => void;
}

export function LakeSessionTable({ sessions, paradigm, scope, selected, onToggle, onSetAll }: LakeSessionTableProps) {
  const [filter, setFilter] = useState("");

  const q = filter.toLowerCase();
  const scoped = sessions.filter(s => (s.paradigm ?? "__none__") === paradigm);
  const filtered = scoped
    .filter(s =>
      !q || s.description?.toLowerCase().includes(q)
      || (s.submitter?.toLowerCase().includes(q) ?? false)
      || s.sid.toLowerCase().includes(q)
      || (s.framework?.toLowerCase().includes(q) ?? false)
    )
    .slice()
    // baseline 会话（该范式评分基准）置顶，其余按提交时间倒序
    .sort((a, b) => Number(b.isBaseline === true) - Number(a.isBaseline === true) || (b.commitTime || "").localeCompare(a.commitTime || ""));
  const allFilteredSelected = filtered.length > 0 && filtered.every(s => selected.has(lakeEntryKey(s)));

  return (
    <div className="space-y-3 overflow-hidden">
      <p className="text-xs text-muted-foreground">
        当前远端：{scope} · 范式目录 <span className="font-medium text-foreground">{paradigm === "__none__" ? "根目录" : paradigm}</span>
      </p>
      <div className="flex items-center gap-2">
        <Input
          placeholder="Search by query, user, commit message, or task ID..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="flex-1"
        />
        <SearchIcon className="size-4 text-muted-foreground shrink-0" />
      </div>
      <div className="flex items-center gap-2 mb-2">
        <Checkbox checked={allFilteredSelected} onCheckedChange={() => {
          // 键与行选择一致（lakeEntryKey）：同 sid 双记录两条目各自独立勾选
          onSetAll(filtered.map(lakeEntryKey), !allFilteredSelected);
        }} />
        <span className="text-sm text-muted-foreground">
          {q ? `${filtered.length} of ${scoped.length} shown` : `${scoped.length} sessions`}
        </span>
      </div>
      <TableCard>
        <TableHeader>
            <TableRow>
              <TableHead className="w-[36px] px-2"></TableHead>
              <TableHead className="w-[170px] px-2">First Query</TableHead>
              <TableHead className="w-[120px] px-2">Type</TableHead>
              <TableHead className="w-[64px] px-2">任务结果</TableHead>
              <TableHead className="w-[90px] px-2">用户名</TableHead>
              <TableHead className="w-[110px] px-2">时间</TableHead>
              <TableHead className="px-2">提交信息</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground py-4">
                  {q ? "No sessions match your search" : "该范式下暂无会话"}
                </TableCell>
              </TableRow>
            )}
            {filtered.map(s => (
              <TableRow key={lakeEntryKey(s)} className={selected.has(lakeEntryKey(s)) ? "bg-primary/5" : ""}>
                <TableCell className="px-2 w-[36px]">
                  <Checkbox checked={selected.has(lakeEntryKey(s))} onCheckedChange={() => onToggle(lakeEntryKey(s))} />
                </TableCell>
                <TableCell className="px-2 text-xs py-2 align-middle">
                  <span className="block truncate" title={s.description || s.sid}>
                    {s.isBaseline && <Badge variant="purple" className="px-1 text-[10px] mr-1">baseline</Badge>}
                    {s.description || <span className="text-muted-foreground">{s.sid}</span>}
                  </span>
                </TableCell>
                <TableCell className="px-2 text-xs py-2 align-middle">
                  {/* 同 sid 双记录：捕获条目走 proxy/框架徽标；原生条目靠同 sid
                      两条目并排即可区分，不加额外徽标。框架族全覆盖
                      （claude/opencode/cannbot/codex/dsh）——codex 曾漏分支，
                      捕获上传成功但 type 列恒显「—」（客户实测） */}
                  <span className="inline-flex items-center gap-0.5">
                    {s.framework === "opencode" ? (
                      <Badge variant="blue" className="px-1 text-[10px]">OpenCode</Badge>
                    ) : s.framework === "cannbot" ? (
                      <Badge variant="green" className="px-1 text-[10px]">CANNBot</Badge>
                    ) : s.framework === "claude-code" ? (
                      <Badge variant="orange" className="px-1 text-[10px]">Claude</Badge>
                    ) : s.framework === "codex" ? (
                      <Badge variant="purple" className="px-1 text-[10px]">Codex</Badge>
                    ) : s.framework === "dsh" ? (
                      <Badge variant="slate" className="px-1 text-[10px]">DSH</Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                    {(s.producer === "cpx" || isProxyVersion(s.ccVersion ?? null)) && (
                      <Badge variant="yellow" className="px-1 text-[10px]">proxy</Badge>
                    )}
                  </span>
                </TableCell>
                <TableCell className="px-2 text-xs py-2 align-middle">
                  {s.opGen === 'success' ? (
                    <Badge variant="green" className="px-1 text-[10px]">成功</Badge>
                  ) : s.opGen === 'failure' ? (
                    <Badge variant="red" className="px-1 text-[10px]">失败</Badge>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="px-2 text-xs py-2 align-middle">
                  <span className="block truncate" title={s.submitter ?? ""}>
                    {s.submitter || "—"}
                  </span>
                </TableCell>
                <TableCell className="px-2 text-xs whitespace-nowrap py-2 align-middle">
                  {s.commitTime ? formatTime(s.commitTime) : "—"}
                </TableCell>
                <TableCell className="px-2 text-xs py-2 align-middle">
                  <span className="block truncate" title={s.sid}>
                    {s.fileCount} files · {s.sid}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
      </TableCard>
      {selected.size === 0 && (
        <p className="text-sm text-muted-foreground">Select at least one session to import</p>
      )}
    </div>
  );
}
