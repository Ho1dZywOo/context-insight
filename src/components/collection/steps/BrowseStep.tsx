// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
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
// 大目录（如 /tmp 顶层 12 万+ 条目）条目全量返回，渲染走窗口化虚拟滚动——
// 表格行恒定高度，滚动容器只渲染可视窗口附近的行，前后 spacer 行撑起总高。

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TableCard } from "./TableCard";
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

// 行高纪律：虚拟滚动的窗口换算单点（表格行 h-10 = 40px 与此常量必须同步）
const ROW_H = 40;
// 超过该行数才启用窗口化；小列表直接全渲染（行为与既有语义完全一致）
const VIRTUAL_MIN = 200;
// 视口行数上限（TableCard max-h 320px / 40px ≈ 8 行可见）+ 双向 overscan
const VIEWPORT_ROWS = 8 + 2 * 6;

export function BrowseStep({ entries, currentDir, parentDir, loading, error, onEntryClick, onGoUp, onBack }: BrowseStepProps) {
  const [filter, setFilter] = useState("");
  const [sortAsc, setSortAsc] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);

  // 进入新目录重置过滤（旧词对新目录无意义）；排序方向跨目录保留（旧弹窗
  // 语义）。render 期状态调整（React 官方 reset-on-prop-change 模式），不用
  // effect 级联触发
  const [prevDir, setPrevDir] = useState(currentDir);
  if (prevDir !== currentDir) {
    setPrevDir(currentDir);
    setFilter("");
    setScrollTop(0);
  }

  const query = filter.trim().toLowerCase();
  // 计数一次遍历出三值：十万级条目下每键三遍 filter 会顿挫
  const { filtered, importableTotal, bundleTotal } = useMemo(() => {
    const hits: DirEntry[] = [];
    let importable = 0;
    let bundle = 0;
    for (const e of entries) {
      if (e.isImportableFile) importable++;
      if (e.isBundleDir) bundle++;
      if (!query || e.name.toLowerCase().includes(query)) hits.push(e);
    }
    return { filtered: query ? hits : entries, importableTotal: importable, bundleTotal: bundle };
  }, [entries, query]);

  const sorted = useMemo(() => sortDirEntries(filtered, sortAsc), [filtered, sortAsc]);

  const virtualize = sorted.length > VIRTUAL_MIN;
  const startIndex = virtualize ? Math.max(0, Math.floor(scrollTop / ROW_H) - 6) : 0;
  const endIndex = virtualize
    ? Math.min(sorted.length, startIndex + VIEWPORT_ROWS)
    : sorted.length;
  const visible = virtualize ? sorted.slice(startIndex, endIndex) : sorted;

  return (
    <div className="space-y-3 overflow-hidden">
      <div className="flex items-center gap-2 rounded-xl border border-border/50 bg-foreground/[0.02] px-3 py-2.5 text-xs font-medium">
        <FolderIcon className="size-4 text-blue-500 shrink-0" />
        <span className="flex-1 min-w-0 truncate font-mono text-muted-foreground">
          {currentDir || "此电脑（所有盘符）"}
        </span>
      </div>
      {parentDir !== null && (
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
          <TableCard onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
            <TableHeader>
                <TableRow>
                  <TableHead className="w-[40px] sticky top-0 z-[1] bg-background"></TableHead>
                  <TableHead className="sticky top-0 z-[1] bg-background">Name</TableHead>
                  <TableHead className="w-[150px] sticky top-0 z-[1] bg-background">
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
                  <TableHead className="w-[80px] sticky top-0 z-[1] bg-background">Size</TableHead>
                  <TableHead className="w-[100px] sticky top-0 z-[1] bg-background">Type</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground py-4">
                      {query ? "No entries match your filter" : "Empty directory"}
                    </TableCell>
                  </TableRow>
                )}
                {virtualize && startIndex > 0 && (
                  <TableRow style={{ height: startIndex * ROW_H }}>
                    <TableCell colSpan={5} className="p-0 border-0" />
                  </TableRow>
                )}
                {visible.map(entry => (
                  <TableRow
                    key={entry.fullPath}
                    className="h-10 cursor-pointer hover:bg-foreground/[0.04]"
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
                {virtualize && endIndex < sorted.length && (
                  <TableRow style={{ height: (sorted.length - endIndex) * ROW_H }}>
                    <TableCell colSpan={5} className="p-0 border-0" />
                  </TableRow>
                )}
              </TableBody>
          </TableCard>
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
