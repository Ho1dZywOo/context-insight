"use client"
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details on how to use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 文件读取观测（run 工作台 Files tab 与离线查看器共用，不 fork）。功能面：
// 跨成员归并汇总（文件/读取/含重叠/冗余率）、文件名关键字搜索、按扩展名
// 类型分组与类型筛选、按重叠过滤、文件行展开读取明细（成员 × 子代理复合
// 分组、turn 深链）、循迹复卷（单文件按时间戳逐行重建 + 下载）、重编汇册
// （整目录 zip + 统计回执）。
// 性能：文件行与复卷行列表均 memo——展开/收起/复卷等状态变化只重渲受影
// 响的那一行，其余行浅比较跳过（大量文件 + 已复卷长文本不再全表重渲）；
// 搜索关键字 deferred（敲键不阻塞输入）；复卷长文本与文件行逐行
// content-visibility 跳过屏外渲染。

import { useCallback, useDeferredValue, useEffect, useMemo, useState, memo } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import {
  BookOpenIcon,
  ChevronRightIcon,
  DownloadIcon,
  FileTextIcon,
  FolderArchiveIcon,
  InfoIcon,
  LayersIcon,
  PercentIcon,
  ScrollTextIcon,
  SearchIcon,
  XIcon,
} from "lucide-react"
import { PerfSegmented, PERF_CARD_CLS, PERF_CARD_SM } from "@/components/observe/perf-shared"
import { useRunHostCaps } from "@/lib/run/host-caps"

interface ReadEntry {
  turnId: string
  turnIndex: number
  agent: string
  prompt: string | null
  subagentSessionId: string | null
  llmOutput: string | null
  range: {
    type: "full" | "partial"
    start: number
    end: number | null
  }
  member?: { taskId: string; label: string | null } | null
}

interface FileAnalysis {
  path: string
  displayPath: string
  reads: ReadEntry[]
  totalReads: number
  overlappingReads: number
  totalLinesRead: number
  uniqueLinesRead: number
  redundancyRate: number
}

interface FileReadsResponse {
  files: FileAnalysis[]
  summary: {
    totalFiles: number
    totalReads: number
    filesWithOverlap: number
    redundancyRate: number
  }
}

interface RestoreLine {
  n: number
  content: string | null
  source: "read" | "write" | "gap"
}

interface RestoreResponse {
  path: string
  lines: RestoreLine[]
  maxLine: number
  opsUsed: number
}

interface FileReadAnalysisProps {
  taskId: string
  /** 自取数端点覆盖（run 合并视图传 run 端点；缺省 = session 语义，零回归）。
   *  三 URL 均自带查询串；fileRestore 由组件追加 &filePath= */
  endpoints?: { fileReads: string; fileRestore: string; dirRestore: string }
  /** 读取明细里的 turn 跳转（查看器接线；run 侧未接时 #序号 退化为纯文本） */
  onNavigateToTurn?: (turnId: string) => void
}

const RESTORE_NOTE =
  "按时间顺序拼合本会话中该文件的读写片段，后写入者覆盖先前内容。局部改写（str_replace）未纳入，未被读取的行标注为「未采集」，故重建结果未必等于任一时刻的真实文件。"

function basename(p: string) {
  const i = p.lastIndexOf("/")
  return i >= 0 ? p.slice(i + 1) : p
}

function dirname(p: string) {
  const i = p.lastIndexOf("/")
  return i > 0 ? p.slice(0, i) : i === 0 ? "/" : ""
}

function extOf(p: string) {
  const name = basename(p)
  const i = name.lastIndexOf(".")
  return i > 0 ? name.slice(i + 1).toLowerCase() : ""
}

function fmtInt(n: number) {
  return n.toLocaleString("en-US")
}

function typeOrder(aKey: string, aCount: number, bKey: string, bCount: number) {
  if (aKey === "other") return 1
  if (bKey === "other") return -1
  return bCount - aCount || aKey.localeCompare(bKey)
}

function rangeLabel(r: ReadEntry["range"]) {
  return r.type === "full"
    ? r.start > 0
      ? `[full from line ${r.start}]`
      : "[full read]"
    : `[lines ${r.start}-${r.end})`
}

// ── 复卷原文行列表（memo：行集合不变时，父级任何状态更新都不再触碰这块重 DOM） ──

const RestoreLines = memo(function RestoreLines({ lines }: { lines: RestoreLine[] }) {
  return (
    <>
      {lines.map(l => (
        <div
          key={l.n}
          title={l.source === "gap" ? "未被读取采集的行" : undefined}
          className="flex gap-3 [contain-intrinsic-size:auto_20px] [content-visibility:auto]"
        >
          <span className="w-10 shrink-0 select-none text-right tabular-nums text-muted-foreground/50">
            {l.n}
          </span>
          <span
            className={cn(
              "whitespace-pre",
              l.content === null ? "italic text-muted-foreground/60" : "text-foreground/85",
            )}
          >
            {l.content ?? `--line ${l.n} not found --`}
          </span>
        </div>
      ))}
    </>
  )
})

// ── 读取明细（成员 × 子代理复合分组 + turn 深链；展开时才挂载） ──

const ReadGroups = memo(function ReadGroups({ reads, onNavigateToTurn }: {
  reads: ReadEntry[]
  onNavigateToTurn?: (turnId: string) => void
}) {
  const groups = useMemo(() => {
    const out: { key: string; agent: string; prompt: string | null; reads: ReadEntry[]; member: ReadEntry["member"] }[] = []
    const groupMap = new Map<string, { agent: string; prompt: string | null; reads: ReadEntry[]; member: ReadEntry["member"] }>()
    for (const read of reads) {
      // 分组键：成员 × 子代理 复合（run 合并视图——成员根/子代理读取各归
      // 各组，不塌进单个 root 组）；session 无 member → 键退化为 subagentSessionId ?? "root"
      const key = read.member ? `${read.member.taskId}/${read.subagentSessionId ?? "root"}` : (read.subagentSessionId ?? "root")
      let g = groupMap.get(key)
      if (!g) {
        g = { agent: read.agent, prompt: read.prompt, reads: [], member: read.member ?? null }
        groupMap.set(key, g)
        out.push({ key, ...g })
      }
      g.reads.push(read)
    }
    return out
  }, [reads])

  return (
    <>
      {groups.map(group => (
        <div key={group.key} className="space-y-1">
          <div className="flex items-center gap-2 text-[11px]">
            {group.member ? (
              <span
                className="shrink-0 truncate rounded bg-primary/[0.07] px-1.5 py-px text-[10px] leading-4 text-foreground/70"
                title={group.member.taskId}
              >
                {group.member.label ?? group.member.taskId}
              </span>
            ) : null}
            <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px]">
              {group.agent}
            </Badge>
            {group.prompt && (
              <span className="min-w-0 truncate text-muted-foreground" title={group.prompt}>
                &ldquo;{group.prompt.length > 30 ? group.prompt.slice(0, 30) + "…" : group.prompt}&rdquo;
              </span>
            )}
          </div>
          <div className="ml-1 space-y-0.5 border-l border-foreground/[0.07] pl-3">
            {group.reads.map((read, idx) => (
              <div key={idx} className="flex items-center gap-2 text-[11px]">
                <span
                  title={onNavigateToTurn ? "跳转 turn 现场" : undefined}
                  className={cn(
                    "shrink-0 font-mono tabular-nums",
                    onNavigateToTurn ? "cursor-pointer text-primary hover:underline" : "text-muted-foreground",
                  )}
                  onClick={(e) => {
                    e.stopPropagation()
                    onNavigateToTurn?.(read.turnId)
                  }}
                >
                  #{read.turnIndex}
                </span>
                {read.llmOutput && (
                  <span className="min-w-0 truncate text-muted-foreground" title={read.llmOutput}>
                    {read.llmOutput.length > 40 ? read.llmOutput.slice(0, 40) + "…" : read.llmOutput}
                  </span>
                )}
                <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/80">
                  {rangeLabel(read.range)}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  )
})

// ── 文件行（memo：展开/复卷等状态以原语 prop 下放，只有受影响的行重渲） ──

const FileRow = memo(function FileRow({
  file,
  index,
  expanded,
  restoring,
  restoredData,
  restoreErrorMsg,
  maxReads,
  onToggle,
  onRestore,
  onClearRestored,
  onNavigateToTurn,
}: {
  file: FileAnalysis
  index: number
  expanded: boolean
  restoring: boolean
  restoredData: RestoreResponse | null
  restoreErrorMsg: string | null
  maxReads: number
  onToggle: (path: string) => void
  onRestore: (path: string) => void
  onClearRestored: (path: string) => void
  onNavigateToTurn?: (turnId: string) => void
}) {
  const gapCount = useMemo(
    () => (restoredData ? restoredData.lines.filter(l => l.source === "gap").length : 0),
    [restoredData],
  )

  function download() {
    if (!restoredData) return
    const text = restoredData.lines
      .map(l => (l.content === null ? `--line ${l.n} not found --` : l.content))
      .join("\n")
    const base = basename(file.path) || "restored"
    const dot = base.lastIndexOf(".")
    const stem = dot > 0 ? base.slice(0, dot) : base
    const ext = dot > 0 ? base.slice(dot) : ""
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = window.document.createElement("a")
    a.href = url
    a.download = `${stem}.restored${ext}`
    window.document.body.appendChild(a)
    a.click()
    window.document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <div
      data-file-row={file.path}
      className="animate-in fade-in slide-in-from-bottom-1 fill-mode-backwards duration-300 [animation-timing-function:cubic-bezier(0.32,0.72,0,1)] [contain-intrinsic-size:auto_68px] [content-visibility:auto]"
      style={{ animationDelay: `${Math.min(index * 30, 240)}ms` }}
    >
      <div
        className="group flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/40 sm:px-5"
        onClick={() => onToggle(file.path)}
      >
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/50 transition-transform duration-200 [transition-timing-function:cubic-bezier(0.32,0.72,0,1)]",
            expanded && "rotate-90",
          )}
        />
        <span className="hidden shrink-0 rounded-md bg-foreground/[0.05] px-1.5 py-0.5 font-mono text-[9px] uppercase leading-4 text-muted-foreground sm:inline">
          {extOf(file.displayPath) || "file"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-sm font-medium text-foreground" title={file.displayPath}>
              {basename(file.displayPath)}
            </span>
            <span className="hidden min-w-0 truncate font-mono text-[11px] text-muted-foreground/80 lg:inline">
              {dirname(file.displayPath) || "/"}
            </span>
          </div>
          <div
            className="mt-1.5 h-1 max-w-[260px] overflow-hidden rounded-full bg-foreground/[0.06]"
            title={`${fmtInt(file.totalReads)} 次读取`}
          >
            <div
              className="h-full rounded-full bg-foreground/[0.18] transition-[width] duration-500"
              style={{ width: `${Math.max((file.totalReads / maxReads) * 100, 2)}%` }}
            />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2.5 text-[11px] tabular-nums text-muted-foreground">
          <span>{fmtInt(file.totalReads)} 读取</span>
          {file.overlappingReads > 0 && (
            <span className="font-medium text-red-600 dark:text-red-400">
              {fmtInt(file.overlappingReads)} 重叠
            </span>
          )}
        </div>
        <button
          type="button"
          data-file-restore={file.path}
          title="循迹复卷：按时间戳逐行重建该文件的全部内容"
          className={cn(
            "inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-[color,background-color,border-color,transform] duration-200 [transition-timing-function:cubic-bezier(0.32,0.72,0,1)] active:scale-95",
            restoredData
              ? "border-teal-500 bg-teal-500/20 text-teal-700 dark:text-teal-200"
              : "border-teal-500/50 bg-teal-500/10 text-teal-600 hover:border-teal-500 hover:bg-teal-500/20 dark:text-teal-300",
          )}
          onClick={(e) => {
            e.stopPropagation()
            if (restoredData) {
              onClearRestored(file.path)
            } else if (!restoring) {
              onRestore(file.path)
            }
          }}
        >
          <ScrollTextIcon className="size-3.5" />
          {restoring ? "复卷中…" : restoredData ? "已复卷·收起" : "循迹复卷"}
        </button>
      </div>

      {(restoring || restoredData != null || restoreErrorMsg != null) && (
        <div
          data-file-restore-panel={file.path}
          className="animate-in fade-in slide-in-from-bottom-1 duration-200 mx-4 mb-3 mt-1 rounded-xl border border-teal-400/30 bg-teal-500/[0.05] p-3.5 sm:mx-5"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex min-w-0 items-center gap-1.5 text-xs font-medium text-teal-600 dark:text-teal-400">
              <ScrollTextIcon className="size-3.5 shrink-0" />
              <span className="truncate">
                循迹复卷 · {fmtInt(restoredData?.lines.length ?? 0)} 行
                {restoredData && restoredData.opsUsed > 0 && (
                  <span className="font-normal text-muted-foreground">
                    （{fmtInt(restoredData.opsUsed)} 次读写，{fmtInt(gapCount)} 行未采集）
                  </span>
                )}
              </span>
              <span title={RESTORE_NOTE}>
                <InfoIcon className="size-3.5 shrink-0 cursor-help text-muted-foreground" />
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-1">
              {restoredData != null && (
                <button
                  type="button"
                  data-restore-download={file.path}
                  title="下载重建后的文件内容（未采集行如实标注）"
                  className="inline-flex cursor-pointer items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium text-teal-600 transition-[background-color] duration-200 hover:bg-teal-500/15 dark:text-teal-300"
                  onClick={download}
                >
                  <DownloadIcon className="size-3.5" />
                  下载
                </button>
              )}
              <button
                type="button"
                title="收起"
                className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground/80 transition-colors hover:bg-foreground/[0.08] hover:text-foreground"
                onClick={() => onClearRestored(file.path)}
              >
                <XIcon className="size-3" />
              </button>
            </span>
          </div>
          <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
            按时间顺序拼合本会话中该文件的读写片段，后写入者覆盖先前内容。局部改写（str_replace）未纳入，未被读取的行标注为「未采集」，故重建结果未必等于任一时刻的真实文件。
          </p>
          {restoreErrorMsg != null && (
            <p className="mt-1.5 text-xs text-destructive">
              Error: {restoreErrorMsg}
            </p>
          )}
          {restoredData != null && (
            <pre className="mt-2.5 max-h-96 overflow-auto rounded-lg border border-foreground/[0.06] bg-background p-3 font-mono text-xs leading-5">
              <RestoreLines lines={restoredData.lines} />
            </pre>
          )}
        </div>
      )}

      {expanded && (
        <div className="animate-in fade-in slide-in-from-bottom-1 duration-200 mx-4 mb-3 mt-1 rounded-xl bg-muted/40 p-3.5 sm:mx-5">
          <p className="text-[11px] tabular-nums text-muted-foreground">
            {file.totalLinesRead > 0 ? (
              <>
                读取 {fmtInt(file.totalLinesRead)} 行 · 去重 {fmtInt(file.uniqueLinesRead)} 行 · 冗余{" "}
                {(file.redundancyRate * 100).toFixed(1)}%
              </>
            ) : (
              "全部为整段读取 · 行级指标不适用"
            )}
          </p>
          <div className="mt-2.5 space-y-3">
            <ReadGroups reads={file.reads} onNavigateToTurn={onNavigateToTurn} />
          </div>
        </div>
      )}
    </div>
  )
})

export function FileReadAnalysis({ taskId, endpoints, onNavigateToTurn }: FileReadAnalysisProps) {
  // 宿主能力门控：离线档案不做 zip 重编（逐文件还原已随档案离线可用）
  const { offline } = useRunHostCaps()
  const [data, setData] = useState<FileReadsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<"all" | "overlap">("all")
  const [typeFilter, setTypeFilter] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set())
  const [restoring, setRestoring] = useState<Set<string>>(new Set())
  const [restored, setRestored] = useState<Map<string, RestoreResponse>>(new Map())
  const [restoreError, setRestoreError] = useState<Map<string, string>>(new Map())

  const [restoringAll, setRestoringAll] = useState(false)
  const [allError, setAllError] = useState<string | null>(null)
  const [allDone, setAllDone] = useState<{ count: number; totalLines: number; gapLines: number } | null>(null)

  const restoreContent = useCallback(async (path: string) => {
    setRestoring(prev => new Set(prev).add(path))
    setRestoreError(prev => { const n = new Map(prev); n.delete(path); return n })
    try {
      const restoreBase = endpoints?.fileRestore ?? `/api/observe/session/file-restore?taskId=${encodeURIComponent(taskId)}`
      const r = await fetch(`${restoreBase}${restoreBase.includes("?") ? "&" : "?"}filePath=${encodeURIComponent(path)}`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const d: RestoreResponse = await r.json()
      setRestored(prev => new Map(prev).set(path, d))
    } catch (e) {
      setRestoreError(prev => new Map(prev).set(path, e instanceof Error ? e.message : String(e)))
    } finally {
      setRestoring(prev => { const n = new Set(prev); n.delete(path); return n })
    }
  }, [taskId, endpoints])

  const clearRestored = useCallback((path: string) => {
    setRestored(prev => { const n = new Map(prev); n.delete(path); return n })
    setRestoreError(prev => { const n = new Map(prev); n.delete(path); return n })
  }, [])

  const toggleExpanded = useCallback((path: string) => {
    setExpandedFiles(prev => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }, [])

  async function restoreAll() {
    setRestoringAll(true)
    setAllError(null)
    setAllDone(null)
    try {
      const r = await fetch(endpoints?.dirRestore ?? `/api/observe/session/dir-restore?taskId=${encodeURIComponent(taskId)}`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const blob = await r.blob()
      const url = URL.createObjectURL(blob)
      const a = window.document.createElement("a")
      a.href = url
      const cd = r.headers.get("Content-Disposition") || ""
      const m = cd.match(/filename="?([^"]+)"?/)
      a.download = m ? decodeURIComponent(m[1]) : `session_${taskId}_restored.zip`
      window.document.body.appendChild(a)
      a.click()
      window.document.body.removeChild(a)
      URL.revokeObjectURL(url)
      setAllDone({
        count: Number(r.headers.get("X-Restored-Count") ?? 0),
        totalLines: Number(r.headers.get("X-Restored-Total-Lines") ?? 0),
        gapLines: Number(r.headers.get("X-Restored-Gap-Lines") ?? 0),
      })
    } catch (e) {
      setAllError(e instanceof Error ? e.message : String(e))
    } finally {
      setRestoringAll(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    fetch(endpoints?.fileReads ?? `/api/observe/session/file-reads?taskId=${encodeURIComponent(taskId)}`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then(d => {
        if (!cancelled) {
          setData(d)
          setLoading(false)
          setError(null)
        }
      })
      .catch(e => {
        if (!cancelled) {
          setError(e.message)
          setLoading(false)
        }
      })
    return () => { cancelled = true }
  }, [taskId, endpoints])

  // 过滤管线（deferred：搜索敲键不阻塞输入）；重叠维度 × 类型 × 文件名关键字叠加。
  // 类型 chips 的计数取全量口径（与分段控件同源——不随其他过滤收窄漂移）
  const deferredQuery = useDeferredValue(query)
  const filteredFiles = useMemo(() => {
    if (!data) return []
    const q = deferredQuery.trim().toLowerCase()
    return data.files.filter(f => {
      if (filter === "overlap" && f.overlappingReads === 0) return false
      if (typeFilter != null && (extOf(f.displayPath) || "other") !== typeFilter) return false
      if (q && !f.displayPath.toLowerCase().includes(q)) return false
      return true
    })
  }, [data, filter, typeFilter, deferredQuery])

  const typeChips = useMemo(() => {
    if (!data) return []
    const by = new Map<string, number>()
    for (const f of data.files) {
      const k = extOf(f.displayPath) || "other"
      by.set(k, (by.get(k) ?? 0) + 1)
    }
    return [...by.entries()]
      .map(([key, count]) => ({ key, ext: key === "other" ? "" : key, count }))
      .sort((a, b) => typeOrder(a.key, a.count, b.key, b.count))
  }, [data])

  const groups = useMemo(() => {
    const by = new Map<string, FileAnalysis[]>()
    for (const f of filteredFiles) {
      const k = extOf(f.displayPath) || "other"
      const arr = by.get(k) ?? []
      arr.push(f)
      by.set(k, arr)
    }
    return [...by.entries()]
      .map(([key, files]) => ({
        key,
        ext: key === "other" ? "" : key,
        files,
        totalReads: files.reduce((s, f) => s + f.totalReads, 0),
      }))
      .sort((a, b) => typeOrder(a.key, a.files.length, b.key, b.files.length))
  }, [filteredFiles])

  const maxReads = useMemo(
    () => filteredFiles.reduce((m, f) => Math.max(m, f.totalReads), 1),
    [filteredFiles],
  )

  // 各类型组在平铺序列中的起始序号（行入场动画的错峰延迟用）
  const groupOffsets = useMemo(() => {
    let i = 0
    return groups.map(g => {
      const off = i
      i += g.files.length
      return off
    })
  }, [groups])

  if (loading) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="flex flex-col gap-4">
          <Card className={cn(PERF_CARD_CLS, "animate-in fade-in slide-in-from-bottom-2 fill-mode-backwards duration-300 [animation-timing-function:cubic-bezier(0.32,0.72,0,1)]")}>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2.5">
                <div className="h-7 w-[210px] animate-pulse rounded-full bg-foreground/[0.06]" />
                <div className="h-[26px] w-[124px] animate-pulse rounded-full bg-foreground/[0.06]" />
                <span className="ml-auto" />
                <div className="h-7 w-[92px] animate-pulse rounded-full bg-foreground/[0.06]" />
              </div>
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                {[0, 1, 2, 3].map(i => (
                  <div key={i} className="h-[58px] animate-pulse rounded-xl bg-foreground/[0.04]" />
                ))}
              </div>
            </CardContent>
          </Card>
          <Card className={cn(PERF_CARD_SM, "animate-in fade-in slide-in-from-bottom-2 fill-mode-backwards duration-300 [animation-timing-function:cubic-bezier(0.32,0.72,0,1)] [animation-delay:60ms]")}>
            <div className="divide-y divide-foreground/[0.06]">
              {[0, 1, 2, 3, 4, 5].map(i => (
                <div key={i} className="flex items-center gap-3 px-4 py-3 sm:px-5">
                  <div className="size-3.5 shrink-0 animate-pulse rounded-full bg-foreground/[0.06]" />
                  <div className="min-w-0 flex-1">
                    <div className="h-3.5 w-44 max-w-full animate-pulse rounded-md bg-foreground/[0.06]" />
                    <div className="mt-1.5 h-1 w-full max-w-[260px] animate-pulse rounded-full bg-foreground/[0.05]" />
                  </div>
                  <div className="h-3.5 w-16 shrink-0 animate-pulse rounded-md bg-foreground/[0.06]" />
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
        <span className="flex size-10 items-center justify-center rounded-full bg-foreground/[0.04]">
          <FileTextIcon className="size-5 text-muted-foreground/60" />
        </span>
        <p className="text-sm font-medium text-foreground/80">文件读取数据载入失败</p>
        <p className="text-xs text-destructive">{error}</p>
      </div>
    )
  }

  if (!data || data.files.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
        <span className="flex size-10 items-center justify-center rounded-full bg-foreground/[0.04]">
          <FileTextIcon className="size-5 text-muted-foreground/60" />
        </span>
        <p className="text-sm font-medium text-foreground/80">没有文件读取记录</p>
        <p className="text-xs text-muted-foreground">本会话内没有可分析的文件读取行为</p>
      </div>
    )
  }

  const tiles = [
    { stat: "files", label: "文件", value: fmtInt(data.summary.totalFiles), Icon: FileTextIcon, danger: false },
    { stat: "reads", label: "读取", value: fmtInt(data.summary.totalReads), Icon: BookOpenIcon, danger: false },
    { stat: "overlap", label: "含重叠", value: fmtInt(data.summary.filesWithOverlap), Icon: LayersIcon, danger: data.summary.filesWithOverlap > 0 },
    { stat: "redundancy", label: "冗余率", value: `${(data.summary.redundancyRate * 100).toFixed(1)}%`, Icon: PercentIcon, danger: false },
  ]

  const q = deferredQuery.trim()

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="flex flex-col gap-4">
        {/* 头卡：检索/过滤（上）与指标带（下）发丝分区；重编汇册为唯一实心主操作（全局动作右置） */}
        <Card className={cn(PERF_CARD_CLS, "animate-in fade-in slide-in-from-bottom-2 fill-mode-backwards duration-300 [animation-timing-function:cubic-bezier(0.32,0.72,0,1)]")}>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <div className="flex h-7 w-[210px] items-center gap-1.5 rounded-full border border-foreground/[0.09] bg-muted/40 pl-2.5 pr-1.5 transition-colors focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/15">
                <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <input
                  data-file-search
                  aria-label="按文件名过滤"
                  className="h-full min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/70"
                  placeholder="搜索文件名…"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Escape") setQuery("")
                  }}
                />
                {query && (
                  <button
                    type="button"
                    data-file-search-clear
                    title="清空"
                    className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground/80 transition-colors hover:bg-foreground/[0.08] hover:text-foreground"
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => setQuery("")}
                  >
                    <XIcon className="size-3" />
                  </button>
                )}
              </div>
              <PerfSegmented
                value={filter}
                options={[
                  { value: "all", label: `全部 ${fmtInt(data.files.length)}` },
                  { value: "overlap", label: `含重叠 ${fmtInt(data.summary.filesWithOverlap)}` },
                ]}
                onChange={v => setFilter(v)}
                ariaLabel="文件过滤"
              />
              <span className="ml-auto" />
              {!offline && (
                <button
                  type="button"
                  data-dir-restore
                  title="重编汇册：按时间戳逐行重建本会话工作目录下全部被读/写过的文件，保留路径树打包下载 zip"
                  className={cn(
                    "inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium text-white transition-[background-color,transform,opacity] duration-200 [transition-timing-function:cubic-bezier(0.32,0.72,0,1)] active:scale-95",
                    allDone || allError
                      ? "bg-teal-600/80 hover:bg-teal-600 dark:bg-teal-500/80 dark:hover:bg-teal-500"
                      : "bg-teal-500 hover:bg-teal-600 dark:bg-teal-600 dark:hover:bg-teal-500",
                    restoringAll && "cursor-wait opacity-80",
                  )}
                  onClick={() => {
                    if (restoringAll) return
                    if (allDone || allError) { setAllDone(null); setAllError(null); return }
                    restoreAll()
                  }}
                >
                  <FolderArchiveIcon className="size-3.5" />
                  {restoringAll ? "重编中…" : "重编汇册"}
                </button>
              )}
            </div>
            {typeChips.length > 1 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  data-type-chip="all"
                  className={cn(
                    "inline-flex cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] transition-[color,background-color,transform] duration-200 [transition-timing-function:cubic-bezier(0.32,0.72,0,1)] active:scale-95",
                    typeFilter == null
                      ? "bg-foreground/[0.09] font-medium text-foreground"
                      : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground",
                  )}
                  onClick={() => setTypeFilter(null)}
                >
                  全部 <span className="tabular-nums">{fmtInt(data.files.length)}</span>
                </button>
                {typeChips.map(t => (
                  <button
                    key={t.key}
                    type="button"
                    data-type-chip={t.key}
                    className={cn(
                      "inline-flex cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] transition-[color,background-color,transform] duration-200 [transition-timing-function:cubic-bezier(0.32,0.72,0,1)] active:scale-95",
                      typeFilter === t.key
                        ? "bg-foreground/[0.09] font-medium text-foreground"
                        : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground",
                    )}
                    onClick={() => setTypeFilter(cur => (cur === t.key ? null : t.key))}
                  >
                    <span className="font-mono uppercase">{t.ext || "其他"}</span>
                    <span className="tabular-nums">{fmtInt(t.count)}</span>
                  </button>
                ))}
              </div>
            )}
            {/* 指标带：发丝分区之下的 inset 瓦片（与总览头同一排版语法——小标签上/大数字下） */}
            <div className="border-t border-foreground/[0.06] pt-3">
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                {tiles.map((t, i) => (
                  <div
                    key={t.stat}
                    data-stat={t.stat}
                    className={cn(
                      "min-w-0 animate-in fade-in slide-in-from-bottom-2 fill-mode-backwards duration-300 [animation-timing-function:cubic-bezier(0.32,0.72,0,1)] rounded-xl bg-foreground/[0.04] px-3 py-2.5 transition-colors dark:bg-foreground/[0.07]",
                      t.danger && "bg-red-500/[0.08] dark:bg-red-500/[0.14]",
                    )}
                    style={{ animationDelay: `${i * 50}ms` }}
                  >
                    <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                      <t.Icon className="size-3.5 shrink-0" aria-hidden />
                      {t.label}
                    </div>
                    <div
                      title={t.value}
                      className={cn(
                        "mt-0.5 truncate text-[18px] font-semibold leading-7 tracking-tight tabular-nums",
                        t.danger && "text-red-600 dark:text-red-400",
                      )}
                    >
                      {t.value}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            {(allDone || allError) && (
              <div data-dir-restore-result className="animate-in fade-in slide-in-from-bottom-1 duration-200 border-t border-foreground/[0.06] pt-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex min-w-0 items-center gap-1.5 text-xs font-medium text-teal-600 dark:text-teal-400">
                    <FolderArchiveIcon className="size-3.5 shrink-0" />
                    <span className="truncate">
                      {allError ? "重编失败" : `已打包下载 ${fmtInt(allDone?.count ?? 0)} 个文件`}
                      {allDone && (
                        <span className="font-normal text-muted-foreground">
                          （共 {fmtInt(allDone.totalLines)} 行，{fmtInt(allDone.gapLines)} 行未采集）
                        </span>
                      )}
                    </span>
                  </span>
                  <button
                    type="button"
                    title="关闭"
                    className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground/80 transition-colors hover:bg-foreground/[0.08] hover:text-foreground"
                    onClick={() => { setAllDone(null); setAllError(null) }}
                  >
                    <XIcon className="size-3" />
                  </button>
                </div>
                <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                  按时间顺序逐行拼合本会话内每个被读、被写文件的内容，后写入者覆盖先前。局部改写（str_replace）未纳入，未被读到的行标注「未采集」并写入 zip。
                </p>
                {allError && (
                  <p className="mt-1 text-xs text-destructive">Error: {allError}</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* 列表卡：类型分组头 + 发丝分隔的文件行——文件名优先，路径/读取量次级 */}
        <Card className={cn(PERF_CARD_SM, "animate-in fade-in slide-in-from-bottom-2 fill-mode-backwards duration-300 [animation-timing-function:cubic-bezier(0.32,0.72,0,1)] [animation-delay:60ms]")}>
          {groups.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-1 py-12 text-center">
              <SearchIcon className="size-5 text-muted-foreground/50" />
              <p className="text-sm text-foreground/80">
                {q ? `没有文件名包含「${q}」的文件` : "当前条件下没有文件"}
              </p>
              <p className="text-xs text-muted-foreground">换个关键字，或清除过滤条件</p>
            </div>
          ) : (
            <div className="divide-y divide-foreground/[0.06]">
              {groups.map((g, gi) => (
                <div key={g.key}>
                  <div data-file-group={g.key} className="flex items-center gap-2 bg-muted/40 px-4 py-1.5 sm:px-5">
                    <span className="rounded-md bg-foreground/[0.05] px-1.5 py-0.5 font-mono text-[9px] uppercase leading-4 text-muted-foreground">
                      {g.ext || "其他"}
                    </span>
                    <span className="text-[11px] tabular-nums text-muted-foreground">
                      {fmtInt(g.files.length)} 个文件 · {fmtInt(g.totalReads)} 次读取
                    </span>
                  </div>
                  <div className="divide-y divide-foreground/[0.06]">
                    {g.files.map((file, fi) => (
                      <FileRow
                        key={file.path}
                        file={file}
                        index={groupOffsets[gi] + fi}
                        expanded={expandedFiles.has(file.path)}
                        restoring={restoring.has(file.path)}
                        restoredData={restored.get(file.path) ?? null}
                        restoreErrorMsg={restoreError.get(file.path) ?? null}
                        maxReads={maxReads}
                        onToggle={toggleExpanded}
                        onRestore={restoreContent}
                        onClearRestored={clearRestored}
                        onNavigateToTurn={onNavigateToTurn}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
