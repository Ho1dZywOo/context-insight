// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

"use client";

// 统一导入向导 · 本地目录浏览步（design: docs/design/unified-workbench/design.md §4）。
// 双绿并存：可导入文件（绿，点击直导 = 会话）与 bundle 目录（绿，点击即导 =
// run job）在同一张表；普通目录点击导航。过滤/排序状态内聚（进入新目录由
// 父组件换 entries 即重置——过滤词对新目录无意义）。

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { sortDirEntries, type DirEntry } from "@/components/ingest/browse";
import { BRAND_NAME, isBrandSourceType } from "@/lib/branding";
import {
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  FileIcon,
  FolderGit2Icon,
  FolderIcon,
  LoaderIcon,
} from "lucide-react";
import { formatSize, formatTime } from "./format";

interface BrowseStepProps {
  entries: DirEntry[];
  currentDir: string | null;
  parentDir: string | null;
  loading: boolean;
  error: string | null;
  onEntryClick: (entry: DirEntry) => void;
  onGoUp: () => void;
  onBack: () => void;
}

export function BrowseStep({ entries, currentDir, parentDir, loading, error, onEntryClick, onGoUp, onBack }: BrowseStepProps) {
  const [filter, setFilter] = useState("");
  const [sortAsc, setSortAsc] = useState(false);

  // 进入新目录重置过滤（旧词对新目录无意义）；排序方向跨目录保留（旧弹窗
  // 语义）。render 期状态调整（React 官方 reset-on-prop-change 模式），不用
  // effect 级联触发
  const [prevDir, setPrevDir] = useState(currentDir);
  if (prevDir !== currentDir) {
    setPrevDir(currentDir);
    setFilter("");
  }

  const query = filter.trim().toLowerCase();
  const filtered = query
    ? entries.filter(e => e.name.toLowerCase().includes(query))
    : entries;
  const importableTotal = entries.filter(e => e.isImportableFile).length;
  const bundleTotal = entries.filter(e => e.isBundleDir).length;

  return (
    <div className="space-y-3 overflow-hidden">
      <div className="flex items-center gap-2 rounded-xl border border-border/50 bg-foreground/[0.02] px-3 py-2.5 text-xs font-medium">
        <FolderIcon className="size-4 text-blue-500 shrink-0" />
        <span className="flex-1 min-w-0 truncate font-mono text-muted-foreground">{currentDir}</span>
      </div>
      {parentDir && (
        <Button variant="ghost" size="sm" onClick={onGoUp} className="gap-1.5">
          <ArrowUpIcon className="size-3.5" />
          Parent directory
        </Button>
      )}
      {loading ? (
        <div className="flex items-center gap-2 py-4">
          <LoaderIcon className="size-4 animate-spin" />
          <span className="text-sm text-muted-foreground">Loading directory...</span>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <Input
              placeholder="Filter by file name or session ID..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="flex-1"
            />
            {query && (
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {filtered.length} of {entries.length} shown
              </span>
            )}
          </div>
          <div className="max-h-[320px] overflow-y-auto overflow-x-hidden rounded-xl border border-border/40">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[40px]"></TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead className="w-[150px]">
                    <span
                      role="button"
                      className="inline-flex items-center gap-0.5 cursor-pointer select-none hover:text-foreground"
                      title={sortAsc ? "按修改时间升序（点击改为降序）" : "按修改时间降序（点击改为升序）"}
                      onClick={() => setSortAsc(v => !v)}
                    >
                      Modified
                      {sortAsc
                        ? <ChevronUpIcon className="size-3.5" />
                        : <ChevronDownIcon className="size-3.5" />}
                    </span>
                  </TableHead>
                  <TableHead className="w-[80px]">Size</TableHead>
                  <TableHead className="w-[100px]">Type</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground py-4">
                      {query ? "No entries match your filter" : "Empty directory"}
                    </TableCell>
                  </TableRow>
                )}
                {sortDirEntries(filtered, sortAsc).map(entry => (
                  <TableRow
                    key={entry.fullPath}
                    className="cursor-pointer hover:bg-foreground/[0.04]"
                    onClick={() => onEntryClick(entry)}
                  >
                    <TableCell>
                      {entry.isBundleDir
                        ? <FolderGit2Icon className="size-4 text-emerald-500" />
                        : entry.isDir
                          ? <FolderIcon className="size-4 text-blue-500" />
                          : entry.isImportableFile
                            ? <FileIcon className="size-4 text-emerald-500" />
                            : <FileIcon className="size-4 text-muted-foreground" />
                      }
                    </TableCell>
                    <TableCell className="text-sm">
                      <div className="flex items-center gap-1">
                        <span
                          className={`flex-1 min-w-0 truncate${entry.isBundleDir || entry.isImportableFile ? " font-medium text-emerald-600 dark:text-emerald-400" : ""}`}
                          title={entry.name}
                        >
                          {entry.name}
                        </span>
                        {entry.isDir && <ChevronRightIcon className="size-3.5 text-muted-foreground shrink-0" />}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap tabular-nums">
                      {entry.mtime ? formatTime(new Date(entry.mtime).toISOString()) : "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground tabular-nums">
                      {entry.isDir ? "" : formatSize(entry.size)}
                    </TableCell>
                    <TableCell className="text-xs">
                      {entry.isBundleDir ? (
                        <span className="text-emerald-500 dark:text-emerald-400">Bundle</span>
                      ) : entry.isDir ? (
                        <span className="text-blue-500 dark:text-blue-400">Directory</span>
                      ) : entry.isImportableFile ? (
                        <span className="text-emerald-500 dark:text-emerald-400">
                          {isBrandSourceType(entry.importableType) ? BRAND_NAME : entry.importableType === "opencode-db" ? "SQLite DB" : entry.importableType === "codex-jsonl" ? "Codex" : entry.importableType === "dsh-native" ? "DSH" : "JSONL"}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">{entry.name.includes('.') ? entry.name.split('.').pop()! : "File"}</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onBack}>
          Back
        </Button>
        <span className="text-xs text-muted-foreground">
          {query
            ? `${filtered.filter(e => e.isImportableFile).length} of ${importableTotal} importable files · ${filtered.filter(e => e.isBundleDir).length} of ${bundleTotal} bundle dirs`
            : `${importableTotal} importable files · ${bundleTotal} bundle directories`}
        </span>
      </div>
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
