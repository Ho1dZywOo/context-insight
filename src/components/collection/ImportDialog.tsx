// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

"use client";

// 统一导入向导（design: docs/design/unified-workbench/design.md §4）。
// 「选择即类型」：用户不预先选会话/Run——
// - 本地：路径输入 + Browse 同一目录表（可导入文件绿=会话直导、bundle 目录
//   绿=run job 并存）；手动路径经 import-flow 探测分发（目录含 workflow.json
//   → bundle job，否则走会话通路：jsonl 单文件直导 / 扫描选择）
// - 数据仓：两阶段（顶层目录注册表 → 目录内对象表；统一布局：每个目录
//   会话与 bundle 同格呈现，可混选导入）
// - 导入步：统一逐项状态（会话并发 4 / bundle job 轮询），本地单 bundle 走
//   富 job 视图
// 取代 LocalFileImport 与 BundleImport（刀 2 退役）。

import { useCallback, useEffect, useRef, useState } from "react";
import { BRAND_NAME, BRAND_SLUG, BRAND_SOURCE_TYPE, BAY_NAME } from "@/lib/branding";
import { serverLakeConfigStatus, type LakeTokenReason } from "@/lib/lake-token-prompt";
import { LakeTokenDialog } from "@/components/LakeTokenDialog";
import { HEADER_PILL } from "@/components/layout/header-actions";
import { saveImportHistory, type ImportHistoryEntry } from "@/components/ImportHistory";
import { lakeErrorMessage } from "@/components/ingest/lake-ui";
import type { DirEntry } from "@/components/ingest/browse";
import { IMPORT_SOURCES_UI } from "@/lib/ingest/adapters/import-ui";
import { ASSET_KINDS } from "@/lib/collection/registry";
import { detectLocalImportKind } from "@/lib/collection/import-flow";
import { BrowseStep } from "./steps/BrowseStep";
import { LakeDirsStep, type LakeDirCard } from "./steps/LakeDirsStep";
import { LakeSessionTable, lakeEntryKey, type LakeSession } from "./steps/LakeSessionTable";
import { LakeBundleTable, type LakeBundleItem } from "./steps/LakeBundleTable";
import { ImportProgress, type BundleJobState, type ImportProgressItem } from "./steps/ImportProgress";
import { formatTime, formatTokens } from "./steps/format";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DownloadIcon, FolderIcon, GlobeIcon, LoaderIcon, SearchIcon } from "lucide-react";
import { toast } from "sonner";

type Step = "input" | "browse" | "select" | "lake" | "importing";
type SourceMode = "local" | "lake";
// 本地会话格式（jsonl 伞形 / sqlite 双库）——run 是探测分发结果，不占此联合
type LocalFormat = "jsonl" | "opencode-db" | typeof BRAND_SOURCE_TYPE;

interface SessionPreview {
  id: string;
  /** 数据仓导入的记录类——同 sid 双记录（capture/native）两条 preview 共享
   *  id，按 recording 区分归属（本地导入 preview 无值） */
  recording?: "capture" | "native";
  /** 条目所属具体源（sessions 扫描响应按成员标记；伞形扫描的批量导入按它发） */
  source?: string;
  createdAt: string;
  endedAt: string | null;
  firstQuery: string | null;
  turnCount: number;
  totalTokens: number | null;
}

/** 统一导入逐项状态：kind 区分会话（并发 await）与 run（job 轮询） */
interface UnifiedImportItem {
  kind: "session" | "run";
  /** 状态更新/列表渲染定位键：会话 = sid 或 sid@recording；run = runId（本地 job 阶段 = 目录路径） */
  key: string;
  /** 会话项真实 sid（流入 ImportHistory taskId / 列表 label 等共享路径） */
  sessionId?: string;
  /** 会话项记录类（数据仓导入） */
  recording?: "capture" | "native";
  /** 会话项所在范式目录（数据仓导入） */
  paradigm?: string | null;
  /** run 项 runId */
  runId?: string;
  /** run 项展示名 */
  name?: string | null;
  /** run 项 job 轮询句柄 */
  jobId?: string | null;
  /** 历史条目 File Path：本地路径或数据仓引用（创建时定型） */
  sourcePath?: string | null;
  status: "pending" | "importing" | "success" | "error";
  message?: string | null;
  framework?: string | null;
  version?: string | null;
}

// imported:false has three distinct causes — label them accurately instead of
// blanket "Already exists" (which hid file-missing behind an exists message)
function importResultMessage(data: { imported?: boolean; reason?: string; error?: string }): string {
  if (data.imported) return data.reason === "imported-empty" ? "Imported (empty capture — turns appear via refresh)" : "Imported";
  if (data.reason === "no-interactions") return "No parseable records (empty or unrecognized file)";
  return "Already exists (merged)";
}

/** preview 归属匹配：id 相等且记录类一致（本地导入双方均无 recording）——
 *  同 sid 双记录两条 preview 共享 id，只按 id 查会永远命中第一条 */
function previewOf(previews: SessionPreview[], s: { sessionId?: string; recording?: "capture" | "native" }): SessionPreview | undefined {
  return previews.find(p => p.id === s.sessionId && (p.recording ?? undefined) === (s.recording ?? undefined));
}

const LAKE_CREDENTIAL_CODES = ["no-credentials", "auth-failed", "forbidden"];

export function ImportDialog() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("input");
  const [error, setError] = useState<string | null>(null);
  const [sourceMode, setSourceMode] = useState<SourceMode>("local");
  const [localFormat, setLocalFormat] = useState<LocalFormat>("jsonl");
  const [filePath, setFilePath] = useState("/");

  // 会话扫描/选择（本地通路）
  const [sessions, setSessions] = useState<SessionPreview[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [sessionFilter, setSessionFilter] = useState("");
  const [sessionsLoading, setSessionsLoading] = useState(false);

  // 本地目录浏览
  const [dirEntries, setDirEntries] = useState<DirEntry[]>([]);
  const [currentDir, setCurrentDir] = useState<string | null>(null);
  const [parentDir, setParentDir] = useState<string | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);

  // bundle job（本地单目录直导）
  const [starting, setStarting] = useState(false);
  const [job, setJob] = useState<BundleJobState | null>(null);

  // 数据仓（两阶段：null = 目录选择；'__none__' = 根目录资产；其余 = 顶层目录。
  // 统一布局：每个目录内会话与 bundle 同格呈现）
  const [lakeSessions, setLakeSessions] = useState<LakeSession[]>([]);
  const [lakeBundles, setLakeBundles] = useState<LakeBundleItem[]>([]);
  const [lakeScope, setLakeScope] = useState("");
  const [lakeRemoteInfo, setLakeRemoteInfo] = useState<{ address: string; branch: string }>({ address: "", branch: "main" });
  const [lakeParadigms, setLakeParadigms] = useState<string[]>([]);
  const [lakeBundleError, setLakeBundleError] = useState<string | null>(null);
  const [lakeDir, setLakeDir] = useState<string | null>(null);
  const [lakeSelected, setLakeSelected] = useState<Set<string>>(new Set());
  const [lakeLoading, setLakeLoading] = useState(false);

  // 统一导入项 + 轮询
  const [importItems, setImportItems] = useState<UnifiedImportItem[]>([]);
  const itemsRef = useRef<UnifiedImportItem[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const batchPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 数据仓凭据引导弹窗（列表/导入的凭据类失败弹出；保存走服务端，全机生效）
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);
  const [tokenReason, setTokenReason] = useState<LakeTokenReason>("no-credentials");

  useEffect(() => { itemsRef.current = importItems; }, [importItems]);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (batchPollRef.current) clearInterval(batchPollRef.current);
    };
  }, []);

  function resetState() {
    setStep("input");
    setError(null);
    setSourceMode("local");
    setLocalFormat("jsonl");
    setFilePath("/");
    setSessions([]);
    setSelectedIds(new Set());
    setSessionFilter("");
    setSessionsLoading(false);
    setDirEntries([]);
    setCurrentDir(null);
    setParentDir(null);
    setBrowseLoading(false);
    setStarting(false);
    setJob(null);
    setLakeSessions([]);
    setLakeBundles([]);
    setLakeParadigms([]);
    setLakeBundleError(null);
    setLakeDir(null);
    setLakeSelected(new Set());
    setLakeLoading(false);
    setImportItems([]);
    itemsRef.current = [];
    if (batchPollRef.current) {
      clearInterval(batchPollRef.current);
      batchPollRef.current = null;
    }
  }

  function updateItem(key: string, patch: Partial<UnifiedImportItem>) {
    setImportItems(prev => prev.map(s => (s.key === key ? { ...s, ...patch } : s)));
  }

  // ---------------------------------------------------------------- 本地浏览

  async function browseDirectory(dirPath: string) {
    setBrowseLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/ingest/browse-directory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dirPath }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to browse directory");
        setBrowseLoading(false);
        return;
      }
      if (!data.isDirectory) {
        const parent = data.parentPath ?? (dirPath.split("/").slice(0, -1).join("/") || "/");
        browseDirectory(parent);
        return;
      }
      setDirEntries(data.entries ?? []);
      setCurrentDir(data.currentPath);
      setParentDir(data.parentPath);
      setStep("browse");
      setBrowseLoading(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
      setBrowseLoading(false);
    }
  }

  // 双绿目录表点击分发：bundle 目录 → run job；普通目录 → 导航；可导入文件 →
  // 会话（jsonl 族直导 / 其余回填输入步）
  function handleDirEntryClick(entry: DirEntry) {
    if (entry.isBundleDir) {
      void startImport(entry.fullPath);
      return;
    }
    if (entry.isDir) {
      browseDirectory(entry.fullPath);
      return;
    }
    if (entry.isImportableFile) {
      // jsonl 族条目（claude / codex / dsh）单文件直导都走伞形源：服务端
      // 内容探测落具体源，sessionId 按该源规则服务端推导（DSH 取父目录名）
      if (entry.importableType === "claude-jsonl" || entry.importableType === "codex-jsonl" || entry.importableType === "dsh-native") {
        handleDirectImportJsonl(entry);
      } else {
        setFilePath(entry.fullPath);
        if (entry.importableType) {
          setLocalFormat(entry.importableType as "opencode-db" | typeof BRAND_SOURCE_TYPE);
        }
        setStep("input");
      }
    }
  }

  function handleBrowseFromInput() {
    browseDirectory(filePath.trim() || "/");
  }

  function handleQuickJump(dirPath: string) {
    setFilePath(dirPath);
    browseDirectory(dirPath);
  }

  // jsonl 单文件直导走伞形源（'jsonl'）：claude/codex 由服务端内容探测识别，
  // sessionId 由解析后源的命名规则推导（响应回传 taskId 对账）
  async function handleDirectImportJsonl(entry: DirEntry) {
    const tempKey = entry.fullPath;
    setFilePath(entry.fullPath);
    setLocalFormat("jsonl");
    setStep("importing");
    setImportItems([{ kind: "session", key: tempKey, sessionId: entry.name, sourcePath: entry.fullPath, status: "importing" }]);
    try {
      const res = await fetch(ASSET_KINDS.session.localImportEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "jsonl", filePath: entry.fullPath }),
      });
      const data = await res.json();
      const sid: string = res.ok ? (data.taskId ?? entry.name) : entry.name;
      if (res.ok && data.query) {
        setSessions([{ id: sid, createdAt: new Date().toISOString(), endedAt: null, firstQuery: data.query, turnCount: 0, totalTokens: null }]);
      }
      updateItem(tempKey, {
        sessionId: sid,
        status: res.ok ? "success" : "error",
        message: res.ok ? importResultMessage(data) : (data.error ?? "Import failed"),
        framework: data.framework ?? undefined,
        version: data.version ?? undefined,
      });
    } catch (e) {
      updateItem(tempKey, { status: "error", message: e instanceof Error ? e.message : "Network error" });
    }
  }

  // ---------------------------------------------------------------- bundle job

  function startPolling(jobId: string) {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/ingest/import-bundle/status?jobId=${encodeURIComponent(jobId)}`);
        if (!res.ok) return; // job 过期等——保留最后状态，用户可重开
        const data = await res.json();
        setJob(data.job);
        if (data.job.step === "done" || data.job.step === "error") {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          // 同步逐项状态（历史条目 status 事实源；富视图渲染走 job 状态）
          updateItem(data.job.runId, data.job.step === "done"
            ? { status: "success" }
            : { status: "error", message: data.job.error ?? "Import failed" });
          // 数据刷新统一走 Done 的 window.location.reload()（关闭弹窗即整页
          // 取新；旧 router.refresh 中途静默刷新不再必要）
        }
      } catch {
        /* 轮询失败下轮重试 */
      }
    }, 1000);
  }

  // 本地 bundle 目录导入：POST 立即返回 jobId → 轮询到终态（富 job 视图）
  async function startImport(target: string) {
    setError(null);
    setStarting(true);
    setFilePath(target);
    try {
      const res = await fetch(ASSET_KINDS.run.localImportEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dirPath: target }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? `Import failed (${res.status})`);
        return;
      }
      setImportItems([{ kind: "run", key: data.runId, runId: data.runId, name: null, jobId: data.jobId, sourcePath: target, status: "importing" }]);
      setJob({
        jobId: data.jobId,
        runId: data.runId,
        step: "validate",
        total: 0,
        imported: 0,
        existing: 0,
        missingFile: 0,
        failed: 0,
        currentSid: null,
        error: null,
        warnings: [],
      });
      setStep("importing");
      startPolling(data.jobId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setStarting(false);
    }
  }

  // ---------------------------------------------------------------- 会话通路（本地）

  // 手动路径加载：jsonl 单文件直导跳过探测；其余先探测（目录含 bundle 清单
  // → run job），再落会话通路（扫描 → 选择步）
  async function handleLoadLocal() {
    const p = filePath.trim();
    if (!p) {
      setError("Please enter a file path");
      return;
    }
    setError(null);
    const directImport = IMPORT_SOURCES_UI[localFormat]?.directFileImport
      && (p.endsWith(".jsonl") || p.endsWith(".jsonl.gz") || p.endsWith(".jsonl.7z"));
    if (!directImport) {
      if ((await detectLocalImportKind(p)) === "run") {
        await startImport(p);
        return;
      }
    }
    await handleLoadSessions();
  }

  async function handleLoadSessions() {
    setSessionsLoading(true);
    try {
      // jsonl 单文件直导：伞形源，服务端内容探测 + sessionId 推导（响应回传
      // taskId 对账）——claude 压缩三形态 / codex rollout 跳过选择步骤直接导入
      const directImport = IMPORT_SOURCES_UI[localFormat]?.directFileImport
        && (filePath.trim().endsWith(".jsonl") || filePath.trim().endsWith(".jsonl.gz") || filePath.trim().endsWith(".jsonl.7z"));
      if (directImport) {
        const p = filePath.trim();
        const fileName = p.split("/").pop() ?? p;
        setStep("importing");
        setImportItems([{ kind: "session", key: p, sessionId: fileName, sourcePath: p, status: "importing" }]);
        try {
          const res = await fetch(ASSET_KINDS.session.localImportEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ source: localFormat, filePath: p }),
          });
          const data = await res.json();
          const sid: string = res.ok ? (data.taskId ?? fileName) : fileName;
          if (res.ok && data.query) {
            setSessions([{ id: sid, createdAt: new Date().toISOString(), endedAt: null, firstQuery: data.query, turnCount: 0, totalTokens: null }]);
          }
          updateItem(p, {
            sessionId: sid,
            status: res.ok ? "success" : "error",
            message: res.ok ? importResultMessage(data) : (data.error ?? "Import failed"),
            framework: data.framework ?? undefined,
            version: data.version ?? undefined,
          });
        } catch (e) {
          updateItem(p, { status: "error", message: e instanceof Error ? e.message : "Network error" });
        }
        return;
      }
      const res = await fetch("/api/ingest/import-file/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: localFormat, filePath: filePath.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to load sessions");
        return;
      }
      setSessions(data.sessions ?? []);
      if (data.sessions?.length === 0) {
        setError("No sessions found in this database");
        return;
      }
      setSessionFilter("");
      setStep("select");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setSessionsLoading(false);
    }
  }

  function toggleSelection(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // select 步的过滤结果：keyword 匹配 firstQuery，或 sessionID 子串（大小写不敏感）
  const sessionQuery = sessionFilter.trim().toLowerCase();
  const filteredSessions = sessionQuery
    ? sessions.filter(s =>
        s.firstQuery?.toLowerCase().includes(sessionQuery)
        || s.id.toLowerCase().includes(sessionQuery))
    : sessions;

  function toggleAll() {
    // 全选作用于当前过滤视图（与数据仓列表同款语义）
    if (filteredSessions.length > 0 && filteredSessions.every(s => selectedIds.has(s.id))) {
      setSelectedIds(prev => {
        const next = new Set(prev);
        for (const s of filteredSessions) next.delete(s.id);
        return next;
      });
    } else {
      setSelectedIds(prev => new Set([...prev, ...filteredSessions.map(s => s.id)]));
    }
  }

  async function handleImportSelected() {
    if (selectedIds.size === 0) return;
    setStep("importing");

    const ids = Array.from(selectedIds);
    setImportItems(ids.map(id => ({ kind: "session" as const, key: id, sessionId: id, status: "pending" as const })));

    const CONCURRENCY = 4;
    let nextIndex = 0;

    async function importOne(sessionId: string) {
      updateItem(sessionId, { status: "importing" });
      try {
        // 批量按条目自带的具体 source 发（伞形扫描的目录可能混合 claude/
        // codex 条目；sqlite 扫描条目同样带成员标记）
        const entrySource = sessions.find(s => s.id === sessionId)?.source;
        const res = await fetch(ASSET_KINDS.session.localImportEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: entrySource ?? localFormat, sessionId, filePath: filePath.trim() }),
        });
        const data = await res.json();
        if (!res.ok) {
          updateItem(sessionId, { status: "error", message: data.error ?? "Import failed" });
        } else {
          updateItem(sessionId, { status: "success", message: importResultMessage(data), framework: data.framework ?? undefined, version: data.version ?? undefined });
        }
      } catch (e) {
        updateItem(sessionId, { status: "error", message: e instanceof Error ? e.message : "Network error" });
      }
    }

    // Concurrent pool: run up to CONCURRENCY imports at a time
    const workers = Array.from({ length: Math.min(CONCURRENCY, ids.length) }, async () => {
      while (nextIndex < ids.length) {
        const idx = nextIndex++;
        await importOne(ids[idx]);
      }
    });
    await Promise.all(workers);
  }

  // ---------------------------------------------------------------- 数据仓

  // 预检服务端单源配置（未配置 → LakeTokenDialog 引导，保存后经 onSaved 自动
  // 重试本函数），再并行拉会话列表（范式注册表）+ bundle 列表（专区）。
  // bundle 侧失败非致命（凭据类除外）：降级为无专区 + 软提示，会话导入不受阻
  async function handleOpenLake() {
    const server = await serverLakeConfigStatus();
    if (!server.configured) {
      setTokenReason("unconfigured");
      setTokenDialogOpen(true);
      return;
    }
    setLakeRemoteInfo({ address: server.address, branch: server.branch });
    setLakeLoading(true);
    setError(null);
    setLakeSessions([]);
    setLakeBundles([]);
    setLakeParadigms([]);
    setLakeBundleError(null);
    setLakeDir(null);
    setLakeSelected(new Set());
    setLakeScope(`${server.address || "服务端配置"} · 分支 ${server.branch}`);
    try {
      const [listRes, bundleRes] = await Promise.all([
        fetch("/api/ingest/lake", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: ASSET_KINDS.session.lakeListAction }),
        }),
        fetch("/api/ingest/lake", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: ASSET_KINDS.run.lakeListAction }),
        }),
      ]);
      const listData = await listRes.json();
      if (!listRes.ok) {
        // 凭据类失败（私有仓未配置/令牌无效）→ 弹引导配置
        if (LAKE_CREDENTIAL_CODES.includes(listData.code ?? "")) {
          setTokenReason(listData.code as LakeTokenReason);
          setTokenDialogOpen(true);
        }
        throw new Error(lakeErrorMessage(listData));
      }
      setLakeSessions(listData.sessions ?? []);
      // 全仓顶层目录即范式注册表（统一布局：会话与 bundle 同住各目录）；
      // 根级会话目录（缺省上传位，<sid>/ 形态）不是目录卡——按会话清单剔除
      const rootFolders = new Set((listData.sessions ?? []).filter((s: LakeSession) => !s.paradigm).map((s: LakeSession) => s.sid + (s.recording === "native" ? ".native" : "")));
      setLakeParadigms(((listData.dirs ?? []) as string[]).filter(d => !rootFolders.has(d)));

      // bundle 清单（全仓锚定扫描，条目自带所在目录）：读取失败非致命——
      // 会话浏览不受阻，黄字提示
      const bundleData = await bundleRes.json().catch(() => ({}));
      if (!bundleRes.ok) {
        if (LAKE_CREDENTIAL_CODES.includes(bundleData.code ?? "")) {
          setTokenReason(bundleData.code as LakeTokenReason);
          setTokenDialogOpen(true);
          throw new Error(lakeErrorMessage(bundleData));
        }
        setLakeBundleError(`Bundle 清单读取失败：${lakeErrorMessage(bundleData)}`);
      } else {
        setLakeBundles((bundleData.items ?? []) as LakeBundleItem[]);
      }
      setStep("lake");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setLakeLoading(false);
    }
  }

  // 顶层目录注册表卡片：根目录（根级资产）+ 各顶层目录（会话与 bundle 计数同格）
  const lakeBundleDir = (b: Pick<LakeBundleItem, "paradigm">): string => b.paradigm ?? "__none__";
  const lakeCards: LakeDirCard[] = [];
  {
    const rootSessions = lakeSessions.filter(s => !s.paradigm);
    const rootBundles = lakeBundles.filter(b => lakeBundleDir(b) === "__none__");
    if (rootSessions.length > 0 || rootBundles.length > 0) {
      lakeCards.push({ name: "__none__", label: "根目录", sessionCount: rootSessions.length, bundleCount: rootBundles.length });
    }
  }
  for (const p of lakeParadigms) {
    lakeCards.push({
      name: p,
      label: p,
      sessionCount: lakeSessions.filter(s => s.paradigm === p).length,
      bundleCount: lakeBundles.filter(b => b.paradigm === p).length,
      hasBaseline: lakeSessions.some(s => s.isBaseline && s.paradigm === p),
    });
  }

  function pickLakeDir(card: LakeDirCard) {
    setLakeDir(card.name);
    setLakeSelected(new Set());
  }

  function setLakeSelection(keys: string[], select: boolean) {
    setLakeSelected(prev => {
      const next = new Set(prev);
      for (const k of keys) {
        if (select) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  }

  function lakeRefOf(path: string): string {
    const addr = lakeRemoteInfo.address.replace(/^https?:\/\//, "");
    return `${BAY_NAME}@${addr}@${lakeRemoteInfo.branch}:${path}`;
  }

  // 数据仓选择批量导入（统一布局：同目录可混选会话 + bundle 包）。选择键
  // 分域——会话 = sid@recording 复合键（sessionId 一律真实 sid，复合键外泄
  // 会让删除 404 静默失败），bundle = runId；两类同批导入：会话并发池 +
  // bundle 逐项发起（物化在 POST 内同步完成）→ 统一轮询各 job 到终态
  async function handleImportLakeSelected() {
    if (lakeSelected.size === 0) return;
    const sessionBy = new Map(lakeSessions.map(s => [lakeEntryKey(s), s] as const));
    const bundleBy = new Map(lakeBundles.map(b => [b.runId, b] as const));
    const selectedSessions = Array.from(lakeSelected).map(k => sessionBy.get(k)).filter((s): s is LakeSession => s != null);
    const selectedBundles = Array.from(lakeSelected).map(k => bundleBy.get(k)).filter((b): b is LakeBundleItem => b != null);
    if (selectedSessions.length === 0 && selectedBundles.length === 0) return;

    setStep("importing");
    setError(null);
    setImportItems([
      ...selectedSessions.map(e => ({
        kind: "session" as const,
        key: lakeEntryKey(e),
        sessionId: e.sid,
        recording: e.recording ?? "capture",
        paradigm: e.paradigm ?? null,
        sourcePath: lakeRefOf(`${e.paradigm ? `${e.paradigm}/` : ""}${e.recording === "native" ? `${e.sid}.native` : e.sid}`),
        status: "pending" as const,
      })),
      ...selectedBundles.map(b => ({
        kind: "run" as const,
        key: b.runId,
        runId: b.runId,
        name: b.name,
        jobId: null,
        sourcePath: lakeRefOf(`${b.paradigm ? `${b.paradigm}/` : ""}${b.runId}`),
        status: "pending" as const,
        message: null,
      })),
    ]);

    const importedPreviews: SessionPreview[] = [];

    async function importOneSession(key: string) {
      updateItem(key, { status: "importing" });
      const entry = sessionBy.get(key);
      const sid = entry?.sid ?? key.split("@")[0];
      const recording = entry?.recording ?? "capture";
      try {
        const res = await fetch("/api/ingest/lake", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "import", sid, recording }),
        });
        const data = await res.json();
        const result = res.ok ? data.result : null;
        const ok = Boolean(result);
        if (!res.ok && LAKE_CREDENTIAL_CODES.includes(data.code ?? "")) {
          setTokenReason(data.code as LakeTokenReason);
          setTokenDialogOpen(true);
        }
        updateItem(key, {
          status: ok ? "success" : "error",
          message: ok ? importResultMessage(result) : lakeErrorMessage(data),
          framework: result?.framework ?? undefined,
          version: result?.version ?? undefined,
        });
        if (ok) {
          importedPreviews.push({
            id: sid,
            recording,
            createdAt: new Date().toISOString(),
            endedAt: null,
            firstQuery: result.query ?? null,
            turnCount: 0,
            totalTokens: null,
          });
        }
      } catch (e) {
        updateItem(key, { status: "error", message: e instanceof Error ? e.message : "Network error" });
      }
    }

    // 会话并发池（与本地导入同款）：物化网络下载并行，wall-time ÷N
    const sessionKeys = selectedSessions.map(lakeEntryKey);
    const CONCURRENCY = 4;
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, sessionKeys.length) }, async () => {
      while (nextIndex < sessionKeys.length) {
        await importOneSession(sessionKeys[nextIndex++]);
      }
    });
    await Promise.all(workers);
    setSessions(prev => [...prev, ...importedPreviews]);

    // bundle 逐项发起：paradigm = 列表行所在目录（透传即精确物化，免全仓搜索）
    let anyJob = false;
    for (const b of selectedBundles) {
      updateItem(b.runId, { status: "importing" });
      try {
        const res = await fetch("/api/ingest/lake", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "bundle-import", runId: b.runId, ...(b.paradigm != null ? { paradigm: b.paradigm } : {}) }),
        });
        const data = await res.json();
        if (!res.ok) {
          if (LAKE_CREDENTIAL_CODES.includes(data.code ?? "")) {
            setTokenReason(data.code as LakeTokenReason);
            setTokenDialogOpen(true);
          }
          updateItem(b.runId, { status: "error", message: lakeErrorMessage(data) });
        } else {
          anyJob = true;
          updateItem(b.runId, { jobId: data.jobId });
        }
      } catch (e) {
        updateItem(b.runId, { status: "error", message: e instanceof Error ? e.message : "Network error" });
      }
    }
    if (anyJob) startBatchPolling();
  }

  // 批量 job 轮询：每 tick 拉取所有未终态 job 的状态；本 tick 内全部到终态
  // 即收尾（清定时器 + 刷新），不等下一拍
  function startBatchPolling() {
    if (batchPollRef.current) clearInterval(batchPollRef.current);
    batchPollRef.current = setInterval(async () => {
      const pending = itemsRef.current.filter(s => s.status === "importing" && s.jobId);
      if (pending.length === 0) {
        if (batchPollRef.current) {
          clearInterval(batchPollRef.current);
          batchPollRef.current = null;
        }
        return;
      }
      let finishedNow = 0;
      for (const p of pending) {
        try {
          const res = await fetch(`/api/ingest/import-bundle/status?jobId=${encodeURIComponent(p.jobId!)}`);
          if (!res.ok) continue; // job 过期等——保留最后状态
          const data = await res.json();
          const j = (data.job ?? null) as BundleJobState | null;
          if (!j) continue;
          if (j.step === "done") {
            updateItem(p.key, {
              status: "success",
              message: `新导入 ${j.imported} · 已存在 ${j.existing}`
                + (j.missingFile > 0 ? ` · 缺文件 ${j.missingFile}` : "")
                + (j.failed > 0 ? ` · 失败 ${j.failed}` : ""),
            });
            finishedNow++;
          } else if (j.step === "error") {
            updateItem(p.key, { status: "error", message: j.error ?? "Import failed" });
            finishedNow++;
          }
        } catch {
          /* 轮询失败下轮重试 */
        }
      }
      if (finishedNow === pending.length) {
        if (batchPollRef.current) {
          clearInterval(batchPollRef.current);
          batchPollRef.current = null;
        }
      }
    }, 1000);
  }

  // ---------------------------------------------------------------- 收尾

  const handleDone = useCallback(() => {
    const hasSuccess = importItems.some(s => s.status === "success");
    if (hasSuccess) {
      const entries: ImportHistoryEntry[] = importItems.map(s => {
        if (s.kind === "run") {
          return {
            // taskId = runId（历史条目点击删除只清历史；run 删除在资产表行内）
            taskId: s.runId ?? s.key,
            kind: "run" as const,
            importedAt: new Date().toISOString(),
            turnCount: 0,
            status: s.status === "success" ? "success" as const : "error" as const,
            query: s.name ?? null,
            filePath: s.sourcePath ?? filePath.trim(),
            sourceType: "workflow-bundle",
          };
        }
        const session = previewOf(sessions, s);
        return {
          // taskId 一律真实 sid（复合键外泄会让 delete-session 404 静默失败）
          taskId: s.sessionId ?? s.key,
          importedAt: new Date().toISOString(),
          turnCount: session?.turnCount ?? 0,
          status: s.status === "success" ? "success" as const : "error" as const,
          query: session?.firstQuery ?? null,
          filePath: s.sourcePath ?? filePath.trim(),
          // 数据仓导入（recording 有值）事实源是 lake；本地按所选格式
          sourceType: s.recording ? BRAND_SOURCE_TYPE : localFormat,
          framework: s.framework ?? null,
          version: s.version ?? null,
        };
      });
      saveImportHistory(entries);
      const okSessions = entries.filter(e => e.kind !== "run" && e.status === "success").length;
      const okRuns = entries.filter(e => e.kind === "run" && e.status === "success").length;
      const failCount = entries.length - okSessions - okRuns;
      const okText = [okSessions > 0 ? `${okSessions} sessions` : null, okRuns > 0 ? `${okRuns} runs` : null].filter(Boolean).join(", ");
      if (failCount > 0) {
        toast.warning("Import complete", {
          description: `${okText} imported, ${failCount} failed`,
        });
      } else {
        toast.success("Import complete", {
          description: `${okText} imported.`,
        });
      }
    }
    setOpen(false);
    resetState();
    if (hasSuccess) {
      window.location.reload();
    }
  }, [importItems, sessions, filePath, localFormat]);

  const allDone = importItems.length > 0 && importItems.every(s => s.status === "success" || s.status === "error");
  const hasError = importItems.some(s => s.status === "error");
  // 仅纯会话批次自动关闭（旧双弹窗语义合并：会话流 1s 自动关；run job 视图
  // 留给用户读完警告后手动 Done）
  const sessionOnly = importItems.length > 0 && importItems.every(s => s.kind === "session");

  useEffect(() => {
    if (allDone && !hasError && sessionOnly) {
      const timer = setTimeout(handleDone, 1000);
      return () => clearTimeout(timer);
    }
  }, [allDone, hasError, sessionOnly, handleDone]);

  // 选中目录内的两类资产（统一布局：同目录会话 + bundle 同格呈现）
  const lakeDirSessions = lakeDir != null ? lakeSessions.filter(s => (s.paradigm ?? "__none__") === lakeDir) : [];
  const lakeDirBundles = lakeDir != null ? lakeBundles.filter(b => (b.paradigm ?? "__none__") === lakeDir) : [];

  const quickDirs = IMPORT_SOURCES_UI[localFormat]?.quickDirs ?? [];
  const directFileImport = IMPORT_SOURCES_UI[localFormat]?.directFileImport
    && (filePath.trim().endsWith(".jsonl") || filePath.trim().endsWith(".jsonl.gz") || filePath.trim().endsWith(".jsonl.7z"));
  const doneCount = importItems.filter(s => s.status === "success" || s.status === "error").length;
  const jobFinished = job !== null && (job.step === "done" || job.step === "error");
  const importedSoFar = (job?.imported ?? 0) + (job?.existing ?? 0);

  const displayItems: ImportProgressItem[] = importItems.map(s => {
    if (s.kind === "run") {
      return { key: s.key, kind: "run", label: s.name ?? s.runId ?? s.key, status: s.status, message: s.message };
    }
    const session = previewOf(sessions, s);
    return {
      key: s.key,
      kind: "session",
      label: session?.firstQuery ?? s.sessionId ?? s.key,
      recording: s.recording,
      status: s.status,
      message: s.message,
      framework: s.framework,
      version: s.version,
    };
  });

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) resetState(); }}>
      <DialogTrigger render={
        <button type="button" className={`${HEADER_PILL} bg-primary text-primary-foreground shadow-[0_1px_3px_rgba(0,0,0,0.12)] hover:bg-primary/90`}>
          <DownloadIcon className="size-4" />
          Import
        </button>
      } />
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>导入</DialogTitle>
          <DialogDescription>
            {step === "input" && `导入会话 / Run：本地文件或 ${BAY_NAME}，选择即类型`}
            {step === "browse" && "Browse directories — 绿色条目可直接导入（会话文件 / Bundle 目录）"}
            {step === "select" && "Select sessions to import"}
            {step === "lake" && (lakeDir == null
              ? "选择数据仓顶层目录（会话与 Run 包同格加载）"
              : `选择目录 ${lakeDir === "__none__" ? "（根目录）" : lakeDir} 内的会话 / Run 包导入`)}
            {step === "importing" && (job
              ? (jobFinished
                ? (job.step === "error" ? "Import failed (details above)" : "Import complete")
                : `导入会话 ${importedSoFar}/${job.total}...`)
              : allDone
                ? (hasError ? "Import finished — some items failed (details above)" : "Import complete")
                : `Importing ${doneCount}/${importItems.length}...`)}
          </DialogDescription>
        </DialogHeader>

        {step === "input" && (
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium mb-1.5 block">导入来源</label>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant={sourceMode === "local" ? "default" : "outline"}
                  size="sm"
                  onClick={() => { setSourceMode("local"); setError(null); }}
                >
                  <FolderIcon className="size-3.5 mr-1" />
                  本地
                </Button>
                <Button
                  variant={sourceMode === "lake" ? "default" : "outline"}
                  size="sm"
                  onClick={() => { setSourceMode("lake"); setError(null); void handleOpenLake(); }}
                >
                  <GlobeIcon className="size-3.5 mr-1" />
                  {BAY_NAME}
                </Button>
              </div>
            </div>
            {sourceMode === "local" && (
              <>
                <div>
                  <label className="text-sm font-medium mb-1.5 block">文件格式（Bundle 目录自动识别）</label>
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      variant={localFormat === "jsonl" ? "default" : "outline"}
                      size="sm"
                      onClick={() => { setLocalFormat("jsonl"); setError(null); }}
                    >
                      JSONL (auto)
                    </Button>
                    <Button
                      variant={localFormat === "opencode-db" || localFormat === BRAND_SOURCE_TYPE ? "default" : "outline"}
                      size="sm"
                      onClick={() => { setLocalFormat("opencode-db"); setError(null); }}
                    >
                      SQLite (auto)
                    </Button>
                  </div>
                </div>
                <div>
                  <label className="text-sm font-medium mb-1.5 block">File Path</label>
                  <div className="flex gap-2">
                    <Input
                      placeholder={IMPORT_SOURCES_UI[localFormat]?.placeholder ?? "/path/to/file"}
                      value={filePath}
                      onChange={(e) => setFilePath(e.target.value)}
                      className="flex-1"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleBrowseFromInput}
                      className="gap-1.5 shrink-0"
                      disabled={sessionsLoading || starting}
                    >
                      <FolderIcon className="size-3.5" />
                      Browse
                    </Button>
                  </div>
                  {quickDirs.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 mt-2">
                      <span className="text-xs text-muted-foreground">快捷路径:</span>
                      {quickDirs.map(q => (
                        <Button
                          key={q.path}
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-xs gap-1"
                          onClick={() => handleQuickJump(q.path)}
                          title={q.path}
                        >
                          <FolderIcon className="size-3 text-blue-500" />
                          {q.label}
                        </Button>
                      ))}
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-xs gap-1"
                        onClick={() => handleQuickJump("~")}
                        title="~"
                      >
                        <FolderIcon className="size-3 text-muted-foreground" />
                        主目录
                      </Button>
                    </div>
                  )}
                  <div className="mt-2 text-xs text-muted-foreground space-y-1">
                    {localFormat === "jsonl" && (
                      <>
                        <p>Claude 原生: ~/.claude/projects/&lt;hash&gt;/&lt;id&gt;.jsonl</p>
                        <p>cpx proxy 捕获: ~/.context-insight/proxy/cpx-&lt;sid&gt;.jsonl</p>
                        <p>Codex 原生: ~/.codex/sessions/&lt;年&gt;/&lt;月&gt;/&lt;日&gt;/rollout-&lt;时间戳&gt;-&lt;会话id&gt;.jsonl</p>
                      </>
                    )}
                    {(localFormat === "opencode-db" || localFormat === BRAND_SOURCE_TYPE) && (
                      <>
                        <p>opencode: ~/.local/share/opencode/opencode.db</p>
                        <p>{BRAND_NAME} 导出: {BRAND_SLUG}_session_xxx.db（导入时按库 schema 自动识别）</p>
                      </>
                    )}
                    <p>Run 的 Bundle 目录：含 workflow.json 与 sessions/（manifest.json 同样识别）——输入路径自动识别</p>
                    <p className="text-blue-500 dark:text-blue-400">Click Browse to explore directories — 绿色条目点击即导入</p>
                  </div>
                </div>
              </>
            )}
            {sourceMode === "lake" && lakeLoading && (
              <div className="flex items-center gap-2 py-4 justify-center">
                <LoaderIcon className="size-4 animate-spin" />
                <span className="text-sm text-muted-foreground">读取数据仓目录与会话 / Run 包清单...</span>
              </div>
            )}
            {sourceMode === "lake" && !lakeLoading && !error && (
              <div className="text-sm text-muted-foreground py-4 text-center">
                <GlobeIcon className="size-5 mx-auto mb-2 text-blue-500" />
                <p>从 {BAY_NAME} 数据仓选择顶层目录导入（会话与 Run 包同格加载）</p>
              </div>
            )}
            {sourceMode === "local" && sessionsLoading && (
              <div className="flex items-center gap-2 py-4 justify-center">
                <LoaderIcon className="size-4 animate-spin" />
                <span className="text-sm text-muted-foreground">Loading sessions...</span>
              </div>
            )}
            {starting && (
              <div className="flex items-center gap-2 py-2 justify-center">
                <LoaderIcon className="size-4 animate-spin" />
                <span className="text-sm text-muted-foreground">Validating bundle...</span>
              </div>
            )}
            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          </div>
        )}

        {step === "browse" && (
          <BrowseStep
            entries={dirEntries}
            currentDir={currentDir}
            parentDir={parentDir}
            loading={browseLoading}
            error={error}
            onEntryClick={handleDirEntryClick}
            onGoUp={() => { if (parentDir) browseDirectory(parentDir); }}
            onBack={() => { setStep("input"); setError(null); }}
          />
        )}

        {step === "select" && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Input
                placeholder="Search by keyword or session ID..."
                value={sessionFilter}
                onChange={(e) => setSessionFilter(e.target.value)}
                className="flex-1"
              />
              <SearchIcon className="size-4 text-muted-foreground shrink-0" />
            </div>
            <div className="flex items-center gap-2 mb-2">
              <Checkbox
                checked={filteredSessions.length > 0 && filteredSessions.every(s => selectedIds.has(s.id))}
                onCheckedChange={toggleAll}
              />
              <span className="text-sm text-muted-foreground">
                {sessionQuery ? `${filteredSessions.length} of ${sessions.length} shown` : `Select all (${sessions.length} sessions)`}
              </span>
            </div>
            <div className="max-h-[320px] overflow-y-auto border rounded-lg">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[40px]"></TableHead>
                    <TableHead className="w-[120px]">Session ID</TableHead>
                    <TableHead>Start Time</TableHead>
                    <TableHead>End Time</TableHead>
                    <TableHead className="max-w-[160px]">First Query</TableHead>
                    <TableHead>Turns</TableHead>
                    <TableHead>Tokens</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredSessions.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center text-muted-foreground py-4">
                        {sessionQuery ? "No sessions match your search" : "No sessions found"}
                      </TableCell>
                    </TableRow>
                  )}
                  {filteredSessions.map(s => (
                    <TableRow key={s.id} className={selectedIds.has(s.id) ? "bg-primary/5" : ""}>
                      <TableCell>
                        <Checkbox checked={selectedIds.has(s.id)} onCheckedChange={() => toggleSelection(s.id)} />
                      </TableCell>
                      <TableCell className="w-[120px] max-w-[120px]">
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
                      <TableCell className="text-xs whitespace-nowrap">{formatTime(s.createdAt)}</TableCell>
                      <TableCell className="text-xs whitespace-nowrap">{s.endedAt ? formatTime(s.endedAt) : "—"}</TableCell>
                      <TableCell className="max-w-[160px] text-xs">
                        <span className="block truncate" title={s.firstQuery ?? ""}>
                          {s.firstQuery ?? "(empty)"}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs tabular-nums">{s.turnCount}</TableCell>
                      <TableCell className="text-xs tabular-nums">{s.totalTokens != null ? formatTokens(s.totalTokens) : "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {selectedIds.size === 0 && (
              <p className="text-sm text-muted-foreground">Select at least one session to import</p>
            )}
            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          </div>
        )}

        {step === "lake" && lakeDir == null && (
          <LakeDirsStep
            scope={lakeScope}
            cards={lakeCards}
            bundleError={lakeBundleError}
            error={error}
            onPick={pickLakeDir}
          />
        )}

        {step === "lake" && lakeDir != null && (
          <div className="space-y-4">
            {(lakeDirSessions.length > 0 || lakeDirBundles.length === 0) && (
              <LakeSessionTable
                key={lakeDir}
                sessions={lakeSessions}
                paradigm={lakeDir}
                scope={lakeScope}
                selected={lakeSelected}
                onToggle={(key) => setLakeSelection([key], !lakeSelected.has(key))}
                onSetAll={(keys, select) => setLakeSelection(keys, select)}
              />
            )}
            {lakeDirBundles.length > 0 && (
              <LakeBundleTable
                bundles={lakeDirBundles}
                dirLabel={lakeDir === "__none__" ? "根目录" : lakeDir}
                scope={lakeScope}
                selected={lakeSelected}
                onToggle={(runId) => setLakeSelection([runId], !lakeSelected.has(runId))}
                onSetAll={(runIds, select) => setLakeSelection(runIds, select)}
              />
            )}
          </div>
        )}

        {step === "importing" && (
          <ImportProgress items={displayItems} job={job} />
        )}

        <DialogFooter>
          {step === "input" && sourceMode === "local" && (
            <Button onClick={() => void handleLoadLocal()} disabled={!filePath.trim() || sessionsLoading || starting}>
              {sessionsLoading ? (
                <span className="flex items-center gap-1.5">
                  <LoaderIcon className="size-4 animate-spin" />
                  Loading...
                </span>
              ) : starting ? (
                <span className="flex items-center gap-1.5">
                  <LoaderIcon className="size-4 animate-spin" />
                  Validating...
                </span>
              ) : (
                directFileImport ? "Import" : "Load"
              )}
            </Button>
          )}
          {step === "input" && sourceMode === "lake" && (
            <Button onClick={() => void handleOpenLake()} disabled={lakeLoading}>
              {lakeLoading ? "Fetching..." : `Fetch from ${BAY_NAME}`}
            </Button>
          )}
          {step === "select" && (
            <>
              <Button variant="outline" onClick={() => { setStep("input"); setError(null); }}>
                Back
              </Button>
              <Button onClick={handleImportSelected} disabled={selectedIds.size === 0}>
                Import {selectedIds.size > 0 ? `${selectedIds.size} Selected` : ""}
              </Button>
            </>
          )}
          {step === "lake" && lakeDir == null && (
            <Button variant="outline" onClick={() => { setStep("input"); setError(null); }}>
              Back
            </Button>
          )}
          {step === "lake" && lakeDir != null && (
            <>
              <Button variant="outline" onClick={() => { setLakeDir(null); setLakeSelected(new Set()); }}>
                目录选择
              </Button>
              <Button
                onClick={() => void handleImportLakeSelected()}
                disabled={lakeSelected.size === 0}
              >
                Import {lakeSelected.size > 0 ? `${lakeSelected.size} Selected` : ""}
              </Button>
            </>
          )}
          {step === "importing" && (allDone || jobFinished) && (
            <Button onClick={handleDone}>Done</Button>
          )}
        </DialogFooter>
      </DialogContent>
      {/* 数据仓令牌引导弹窗（叠加在导入弹窗之上；保存成功自动收起） */}
      <LakeTokenDialog
        open={tokenDialogOpen}
        onOpenChange={setTokenDialogOpen}
        reason={tokenReason}
        onSaved={() => {
          if (tokenReason === "unconfigured") {
            setTokenDialogOpen(false);
            void handleOpenLake();
          }
        }}
      />
    </Dialog>
  );
}
