"use client";
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software you can redistribute it and/or modify it under the terms and
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Run Audit tab：四域审计（Skill / Agent / Workflow / Run），全部站在 run 层面。
// 左栏 = 域导航 + 当前域的目标列表；右栏 = 对账内容（选中目标 → sift 对账报告，
// 未选 → 域导览）。skill/agent 域 = 目标注册表（跨成员合并 + 成员归因）；workflow
// 域 = 成员主 agent 编排组合声明（root 切段，恒单成员）；run 域 = 编排规程声明
// × 全 run 成员整会话（sift 宽松对账，源 bundle 在盘走 --run 原生）。对账结果经
// skill-audit-job 的 run 级键缓存（cross-tab resume + sessionStorage）。solo run
// 走同一组件（单成员退化，无需特判）。

import { useEffect, useMemo, useRef, useState, memo } from "react";
import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { BoxesIcon, BotIcon, FileSearchIcon, SparklesIcon, WorkflowIcon } from "lucide-react";
import {
  subscribeSkillAudit,
  getSkillAuditSnapshot,
  getSkillAuditServerSnapshot,
  getSkillAuditVersion,
  hydrateRunAuditFromStorage,
  runAuditKey,
  type AuditKind,
} from "@/lib/skill-audit-job";
import { deriveDomainTargets, targetMemberLabels, type RunAuditTarget } from "@/lib/run/audit-registry";
import { runMemberUrlFor } from "@/lib/observe/member-url";
import { buildMainAgentTurnMap, type TurnDigest } from "@/lib/shared/turn-digest";
import type { RunMemberRow } from "@/lib/run/member-rows";
import { AuditReportPanel } from "@/components/run/audit/AuditReportPanel";

type AuditDomain = "skill" | "agent" | "workflow" | "run";

interface SkillsResponse {
  events: Array<{ skillName: string; eventType: string; member: { taskId: string; label: string | null } | null }>;
}

interface SelectedTarget {
  kind: AuditKind
  name: string
  title: string
  members: string[]
}

function fmtInt(n: number): string {
  return n.toLocaleString("en-US")
}

const SPRING = "duration-300 [animation-timing-function:cubic-bezier(0.32,0.72,0,1)]"

const DOMAINS: Array<{ key: AuditDomain; label: string; icon: typeof SparklesIcon; desc: string }> = [
  { key: "skill", label: "Skill", icon: SparklesIcon, desc: "skill 声明 × 涉事成员全体 transcript——按调用段切分对账；源 bundle 在盘时走 sift --run 原生对账。" },
  { key: "agent", label: "Agent", icon: BotIcon, desc: "agent .md 声明 × 涉事成员——按派发段切分对账；源 bundle 在盘时走 sift --run 原生对账。" },
  { key: "workflow", label: "Workflow", icon: WorkflowIcon, desc: "主 agent 编排组合声明（规程层 + 计划层）× 该成员会话 root 段——编排声明是成员私有，恒单成员对账。" },
  { key: "run", label: "Run", icon: BoxesIcon, desc: "编排规程声明 × 全 run 成员整会话——宽松对账不切段，审的是全员编排纪律；源 bundle 在盘时走 sift --run 原生。" },
]

// ── 目标行状态徽标（各域共用：job 快照 → 文案/颜色） ────────────────────────

function jobBadge(job: { running: boolean; percent: number; result: { summary: { fail: number } } | null; error: string | null }): {
  text: string
  cls: string
} {
  if (job.running) return { text: `对账中 ${job.percent}%`, cls: "text-muted-foreground" }
  if (job.result) {
    return job.result.summary.fail > 0
      ? { text: `${job.result.summary.fail} 项失败`, cls: "text-red-600 dark:text-red-400" }
      : { text: "全部通过", cls: "text-emerald-600 dark:text-emerald-400" }
  }
  if (job.error) return { text: "对账失败", cls: "text-red-600 dark:text-red-400" }
  return { text: "未审", cls: "text-muted-foreground/70" }
}

const ROW_CLS =
  "flex w-full cursor-pointer flex-col px-3 py-2.5 text-left transition-colors duration-150 active:bg-accent/70"

// ── skill/agent 域目标行（memo：每行独立订阅自己的 job 快照） ───────────────

const TargetRow = memo(function TargetRow({
  runId,
  kind,
  target,
  selected,
  onSelect,
}: {
  runId: string
  kind: AuditKind
  target: RunAuditTarget
  selected: boolean
  onSelect: (t: RunAuditTarget) => void
}) {
  const key = runAuditKey(runId, kind, target.name)
  const job = useSyncExternalStore(subscribeSkillAudit, () => getSkillAuditSnapshot(key), getSkillAuditServerSnapshot)
  const { shown, rest } = targetMemberLabels(target, 2)
  const badge = jobBadge(job)

  return (
    <button
      type="button"
      data-audit-target={`${kind}:${target.name}`}
      onClick={() => onSelect(target)}
      className={cn(ROW_CLS, selected ? "bg-accent/60" : "hover:bg-accent/40")}
    >
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground" title={target.name}>
          {target.name}
        </span>
        <span className={cn("shrink-0 whitespace-nowrap text-[11px] font-medium", badge.cls)}>{badge.text}</span>
      </span>
      <span className="mt-1 flex min-w-0 items-center gap-1">
        {shown.map(m => (
          <span
            key={m}
            className="min-w-0 max-w-[88px] shrink truncate rounded-full bg-foreground/[0.05] px-1.5 py-0.5 text-[10px] leading-4 text-muted-foreground"
            title={m}
          >
            {m}
          </span>
        ))}
        {rest > 0 ? (
          <span
            className="shrink-0 rounded-full bg-foreground/[0.04] px-1.5 py-0.5 text-[10px] leading-4 text-muted-foreground/80"
            title={`另有 ${rest} 个成员`}
          >
            +{rest}
          </span>
        ) : null}
        <span className="ml-auto shrink-0 tabular-nums text-[10px] text-muted-foreground/70" title="涉事事件数">
          {fmtInt(target.eventCount)}
        </span>
      </span>
    </button>
  )
})

// ── workflow 域目标行（成员维度：主 agent 编排声明可恢复性） ─────────────────

const WorkflowRow = memo(function WorkflowRow({
  runId,
  member,
  available,
  selected,
  onSelect,
}: {
  runId: string
  member: RunMemberRow
  available: boolean | null
  selected: boolean
  onSelect: (m: RunMemberRow) => void
}) {
  const key = runAuditKey(runId, "root", member.taskId)
  const job = useSyncExternalStore(subscribeSkillAudit, () => getSkillAuditSnapshot(key), getSkillAuditServerSnapshot)

  const badge = (() => {
    if (!available) return { text: "无可恢复声明", cls: "text-muted-foreground/60" }
    return jobBadge(job)
  })()

  return (
    <button
      type="button"
      data-audit-target={`root:${member.taskId}`}
      disabled={!available}
      onClick={() => onSelect(member)}
      className={cn(
        ROW_CLS,
        available ? (selected ? "bg-accent/60" : "hover:bg-accent/40") : "cursor-not-allowed opacity-60",
      )}
    >
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">主 agent 编排</span>
        <span className={cn("shrink-0 whitespace-nowrap text-[11px] font-medium", badge.cls)}>{badge.text}</span>
      </span>
      <span className="mt-0.5 block truncate text-[11px] text-muted-foreground" title={member.taskId}>
        {member.displayName}
      </span>
    </button>
  )
})

// ── run 域目标行（编排规程声明 × 全 run，声明源成员一行） ────────────────────

const RunRow = memo(function RunRow({
  runId,
  declarer,
  memberCount,
  probing,
  selected,
  onSelect,
}: {
  runId: string
  declarer: RunMemberRow | null
  memberCount: number
  probing: boolean
  selected: boolean
  onSelect: () => void
}) {
  const key = declarer ? runAuditKey(runId, "run", declarer.taskId) : null
  const job = useSyncExternalStore(
    subscribeSkillAudit,
    () => getSkillAuditSnapshot(key ?? "__none__"),
    getSkillAuditServerSnapshot,
  )

  const badge = (() => {
    if (!declarer) return probing
      ? { text: "探测声明…", cls: "text-muted-foreground/60" }
      : { text: "无可恢复声明", cls: "text-muted-foreground/60" }
    return jobBadge(job)
  })()

  return (
    <button
      type="button"
      data-audit-target={declarer ? `run:${declarer.taskId}` : "run:none"}
      disabled={!declarer}
      onClick={onSelect}
      className={cn(
        "flex w-full cursor-pointer flex-col gap-1 px-3 py-3 text-left transition-colors duration-150 active:bg-accent/70",
        declarer ? (selected ? "bg-accent/60" : "hover:bg-accent/40") : "cursor-not-allowed opacity-60",
      )}
    >
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">主 agent 编排 × 全 run</span>
        <span className={cn("shrink-0 whitespace-nowrap text-[11px] font-medium", badge.cls)}>{badge.text}</span>
      </span>
      <span className="mt-1 block text-[11px] leading-4 text-muted-foreground">
        {declarer
          ? `声明源 ${declarer.displayName} · ${memberCount} 个成员整会话（宽松对账，不切段）`
          : probing
            ? "正在探测各成员的编排声明可恢复性…"
            : "本 run 无可恢复的编排规程声明（无主 agent Skill invoke / 无 turn0 注入）"}
      </span>
    </button>
  )
})

// ── 右栏域导览（未选目标时的空态：域语义 + 统计瓦片 + 引导） ─────────────────

function DomainIntro({
  icon: Icon,
  label,
  desc,
  tiles,
}: {
  icon: typeof SparklesIcon
  label: string
  desc: string
  tiles: Array<{ label: string; value: string; danger?: boolean }>
}) {
  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-6">
      <div className={cn("w-full max-w-sm animate-in fade-in slide-in-from-bottom-2 fill-mode-backwards", SPRING)}>
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="flex size-11 items-center justify-center rounded-2xl bg-card shadow-[0_1px_2px_rgba(0,0,0,0.04)] ring-1 ring-foreground/[0.06]">
            <Icon className="size-5 text-muted-foreground/70" />
          </span>
          <div>
            <h3 className="text-sm font-semibold tracking-tight text-foreground">{label} 域</h3>
            <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{desc}</p>
          </div>
        </div>
        <div className="mt-6 grid grid-cols-3 gap-2.5">
          {tiles.map((t, i) => (
            <div
              key={t.label}
              className={cn(
                "min-w-0 animate-in fade-in slide-in-from-bottom-2 fill-mode-backwards rounded-xl bg-card px-3 py-2.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] ring-1 ring-foreground/[0.06]",
                SPRING,
                t.danger && "bg-red-500/[0.08] dark:bg-red-500/[0.14]",
              )}
              style={{ animationDelay: `${60 + i * 50}ms` }}
            >
              <div className="text-[11px] font-medium text-muted-foreground">{t.label}</div>
              <div
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
        <p className="mt-6 text-center text-[11px] text-muted-foreground/70">从左侧选择目标开始对账</p>
      </div>
    </div>
  )
}

// ── 右栏启动卡（选中但未发起：目标信息 + 显式「开始对账」） ─────────────────

function LaunchCard({
  icon: Icon,
  title,
  meta,
  desc,
  onStart,
}: {
  icon: typeof SparklesIcon
  title: string
  meta: string
  desc: string
  onStart: () => void
}) {
  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-6">
      <div className={cn("w-full max-w-sm animate-in fade-in slide-in-from-bottom-2 fill-mode-backwards", SPRING)}>
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="flex size-11 items-center justify-center rounded-2xl bg-card shadow-[0_1px_2px_rgba(0,0,0,0.04)] ring-1 ring-foreground/[0.06]">
            <Icon className="size-5 text-muted-foreground/70" />
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold tracking-tight text-foreground" title={title}>
              {title}
            </h3>
            {meta ? <p className="mt-1 text-[11px] font-medium tabular-nums text-muted-foreground">{meta}</p> : null}
            <p className="mt-2 text-xs leading-5 text-muted-foreground/80">{desc}</p>
          </div>
        </div>
        <Button
          type="button"
          data-audit-start
          onClick={onStart}
          className="mt-6 h-10 w-full rounded-full text-[13px] font-medium transition-transform duration-150 [transition-timing-function:cubic-bezier(0.32,0.72,0,1)] active:scale-[0.98]"
        >
          开始对账
        </Button>
        <p className="mt-4 text-center text-[11px] text-muted-foreground/70">
          对账由 sift 执行 · 结果本会话内缓存，重进直接查看
        </p>
      </div>
    </div>
  )
}

// ── tab 本体 ────────────────────────────────────────────────────────────────

export interface RunAuditTabProps {
  runId: string;
  members: RunMemberRow[];
  /** turn 深链：成员 taskId + turn 序号 → 外壳统一经 turn-digest 解析成 turnId 切 Turns。 */
  onOpenTurn?: (turnId: string, member?: string) => void;
}

export function RunAuditTab({ runId, members, onOpenTurn }: RunAuditTabProps) {
  const [domain, setDomain] = useState<AuditDomain>("skill");
  const [selected, setSelected] = useState<SelectedTarget | null>(null);
  // 选中 ≠ 发起：仅在用户点击「开始对账」后才挂载报告（面板挂载即自动
  // start）；已有结果/运行中/失败态直接展示，保留 cross-tab resume 语义
  const [started, setStarted] = useState(false);
  const [data, setData] = useState<SkillsResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [workflowAvail, setWorkflowAvail] = useState<Map<string, { available: boolean; name: string | null }>>(() => new Map());
  // store 版本订阅：任一目标 job 更新 → 导览瓦片重算。版本号必须进 introTiles
  // 依赖——否则 store 快照变了 useMemo 仍返回旧值，「已审 / 可对账成员」计数
  // 停留在对账完成前的旧值（store 版本没进 deps，仅重渲不重算）。
  const auditVersion = useSyncExternalStore(subscribeSkillAudit, getSkillAuditVersion, () => 0);
  // turn-digest 缓存（成员 taskId → turnIndex→turnId 映射的 promise）：finding
  // 深链用，懒取一次即缓存（refreshEpoch 换代时组件重建、缓存随之失效）
  const turnMapsRef = useRef(new Map<string, Promise<Map<number, string>>>());

  const openTurn = (taskId: string, turnIndex: number) => {
    if (!onOpenTurn) return;
    let p = turnMapsRef.current.get(taskId);
    if (!p) {
      p = fetch(runMemberUrlFor(runId, taskId)("turn-digest"))
        .then(r => (r.ok ? r.json() : null))
        .then((d: TurnDigest | null) => buildMainAgentTurnMap(d?.turns ?? []))
        .catch(() => new Map<number, string>());
      turnMapsRef.current.set(taskId, p);
    }
    void p.then(map => {
      const turnId = map.get(turnIndex);
      if (turnId) onOpenTurn(turnId, taskId);
    });
  };

  useEffect(() => {
    let cancelled = false
    fetch(`/api/observe/run/${encodeURIComponent(runId)}/skills`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: SkillsResponse) => {
        if (cancelled) return
        setData(d)
        setLoaded(true)
      })
      .catch(e => {
        if (cancelled) return
        setLoadError(e instanceof Error ? e.message : String(e))
        setLoaded(true)
      })
    return () => { cancelled = true }
  }, [runId])

  const events = useMemo(() => data?.events ?? [], [data])
  const skillTargets = useMemo(() => deriveDomainTargets(events, "skill"), [events])
  const agentTargets = useMemo(() => deriveDomainTargets(events, "agent"), [events])

  // run 域声明源：首个编排声明可恢复的成员（各成员注入同一份 run 级规程，
  // 取首即可；漂移在 workflow 域按成员对账审视）
  const declarer = useMemo(
    () => members.find(m => workflowAvail.get(m.taskId)?.available) ?? null,
    [members, workflowAvail],
  )
  const declarerKey = declarer?.taskId ?? ""
  const probing = useMemo(
    () => (domain === "workflow" || domain === "run") && members.some(m => !workflowAvail.has(m.taskId)),
    [domain, members, workflowAvail],
  )

  // sessionStorage 恢复（reload / 切 tab 回来）：全部域的既有结果灌回 store
  useEffect(() => {
    if (!loaded) return
    hydrateRunAuditFromStorage(runId, [
      ...skillTargets.map(t => ({ kind: "skill" as const, name: t.name })),
      ...agentTargets.map(t => ({ kind: "agent" as const, name: t.name })),
      ...members.map(m => ({ kind: "root" as const, name: m.taskId })),
      ...(declarerKey ? [{ kind: "run" as const, name: declarerKey }] : []),
    ])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, loaded, declarerKey])

  // 编排声明可恢复性探测：挂载即探（左栏导航的 Run 域目标计数依赖声明源），
  // 每成员一次即缓存，进 workflow/run 域无需等待
  useEffect(() => {
    let cancelled = false
    for (const m of members) {
      if (workflowAvail.has(m.taskId)) continue
      const urlFor = runMemberUrlFor(runId, m.taskId)
      void fetch(urlFor("main-agent-workflow"))
        .then(r => (r.ok ? r.json() : null))
        .then((d: { available?: boolean; name?: string | null } | null) => {
          if (cancelled) return
          setWorkflowAvail(prev => new Map(prev).set(m.taskId, { available: !!d?.available, name: d?.name ?? null }))
        })
        .catch(() => {
          if (cancelled) return
          setWorkflowAvail(prev => new Map(prev).set(m.taskId, { available: false, name: null }))
        })
    }
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, members])

  const targets = useMemo(
    () => (domain === "skill" ? skillTargets : domain === "agent" ? agentTargets : []),
    [domain, skillTargets, agentTargets],
  )

  const introTiles = useMemo(() => {
    if (domain === "run") {
      const audited = declarer && getSkillAuditSnapshot(runAuditKey(runId, "run", declarer.taskId)).result != null
      return [
        { label: "对账范围", value: `${members.length} 成员` },
        { label: "声明源", value: declarer?.displayName ?? "不可用", danger: !declarer && !probing },
        { label: "已审", value: audited ? "1" : "0" },
      ]
    }
    if (domain === "workflow") {
      const ok = [...workflowAvail.values()].filter(v => v.available).length
      return [
        { label: "可对账成员", value: fmtInt(ok) },
        { label: "成员总数", value: fmtInt(members.length) },
        { label: "已审", value: fmtInt(members.filter(m => getSkillAuditSnapshot(runAuditKey(runId, "root", m.taskId)).result != null).length) },
      ]
    }
    const audited = targets.filter(t => getSkillAuditSnapshot(runAuditKey(runId, domain, t.name)).result != null).length
    const memberSet = new Set(targets.flatMap(t => t.members.map(m => m.taskId)))
    return [
      { label: "目标", value: fmtInt(targets.length) },
      { label: "已审", value: fmtInt(audited) },
      { label: "涉事成员", value: fmtInt(memberSet.size) },
    ]
    // auditVersion 是「任一 job 更新即自增」的 store 版本号——它是 memo 失效的
    // 触发器，值本身不进瓦片内容（exhaustive-deps 视其为「不必要依赖」属误报）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domain, targets, members, runId, workflowAvail, declarer, probing, auditVersion])

  const select = (sel: SelectedTarget | null) => {
    setSelected(sel);
    setStarted(false);
  };

  const selectTarget = (t: RunAuditTarget) => {
    if (selected?.kind === domain && selected.name === t.name) {
      select(null);
      return;
    }
    const kind: AuditKind = domain === "agent" ? "agent" : "skill"
    select({ kind, name: t.name, title: t.name, members: t.members.map(m => m.taskId) })
  }

  const selectWorkflowMember = (m: RunMemberRow) => {
    if (selected?.kind === "root" && selected.name === m.taskId) {
      select(null);
      return;
    }
    select({ kind: "root", name: m.taskId, title: "主 agent 编排", members: [m.taskId] })
  }

  const selectRunTarget = () => {
    if (!declarer) return
    if (selected?.kind === "run" && selected.name === declarer.taskId) {
      select(null);
      return;
    }
    select({ kind: "run", name: declarer.taskId, title: "主 agent 编排 × 全 run", members: members.map(m => m.taskId) })
  }

  const activeDomain = DOMAINS.find(d => d.key === domain)!
  const domainCount = (key: AuditDomain): number => {
    if (key === "skill") return skillTargets.length
    if (key === "agent") return agentTargets.length
    if (key === "workflow") return members.length
    return declarer ? 1 : 0
  }

  // 启动卡的目标摘要（域感知：目标名之外的必要上下文一行带齐）
  const launchMeta = useMemo(() => {
    if (!selected) return ""
    if (selected.kind === "skill" || selected.kind === "agent") {
      const t = (selected.kind === "skill" ? skillTargets : agentTargets).find(x => x.name === selected.name)
      return t ? `${t.members.length} 个成员 · ${fmtInt(t.eventCount)} 次${selected.kind === "agent" ? "派发" : "调用"}` : ""
    }
    if (selected.kind === "root") {
      const m = members.find(x => x.taskId === selected.name)
      return m ? `${m.displayName} · 规程层 + 计划层组合声明` : ""
    }
    return declarer ? `声明源 ${declarer.displayName} · 全 run ${members.length} 个成员整会话` : ""
  }, [selected, skillTargets, agentTargets, members, declarer])

  // 已有结局（结果/运行中/失败）的目标选中即直接展示报告——选中只对未审目标弹启动卡
  const selJob = selected ? getSkillAuditSnapshot(runAuditKey(runId, selected.kind, selected.name)) : null
  const showReport =
    !!selected && (started || (selJob != null && (selJob.result != null || selJob.running || selJob.error != null)))

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl bg-muted/30 lg:flex-row" data-run-audit>
      {/* 左栏：域导航 + 目标列表——直接从画布截出的平铺区域，发丝分区隔开左右，不叠卡片 */}
      <aside className="flex max-h-[46vh] min-h-0 w-full shrink-0 flex-col overflow-hidden border-b border-foreground/[0.06] lg:max-h-none lg:w-72 lg:border-b-0 lg:border-r">
        <nav className="shrink-0 border-b border-foreground/[0.06] bg-foreground/[0.025] p-1.5 dark:bg-foreground/[0.045]">
          <div className="flex flex-col gap-1">
            {DOMAINS.map(d => {
              const active = domain === d.key
              return (
                <button
                  key={d.key}
                  type="button"
                  data-audit-domain={d.key}
                  aria-pressed={active}
                  onClick={() => { setDomain(d.key); select(null) }}
                  className={cn(
                    "flex cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left",
                    "transition-[background-color,box-shadow,transform] duration-200 [transition-timing-function:cubic-bezier(0.32,0.72,0,1)] active:scale-[0.98]",
                    active
                      ? "bg-card text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.06),0_6px_16px_-8px_rgba(0,0,0,0.22)] ring-1 ring-foreground/[0.06]"
                      : "text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground",
                  )}
                >
                  <d.icon className={cn("size-4 shrink-0", active ? "text-foreground" : "text-muted-foreground/70")} />
                  <span className={cn("text-[13px]", active && "font-medium")}>{d.label}</span>
                  <span
                    className={cn(
                      "ml-auto shrink-0 tabular-nums text-[11px]",
                      active ? "text-foreground/70" : "text-muted-foreground/80",
                    )}
                  >
                    {fmtInt(domainCount(d.key))}
                  </span>
                </button>
              )
            })}
          </div>
        </nav>

        {/* 目标列表（key=domain：切换域即重放列表入场；禁横向滚动——行内容自适应收缩） */}
        <div
          key={domain}
          className="min-h-0 flex-1 divide-y divide-foreground/[0.06] overflow-y-auto overflow-x-hidden animate-in fade-in slide-in-from-bottom-1 fill-mode-backwards duration-300 [animation-timing-function:cubic-bezier(0.32,0.72,0,1)]"
        >
          {domain === "run" ? (
            <RunRow
              runId={runId}
              declarer={declarer}
              memberCount={members.length}
              probing={probing}
              selected={selected?.kind === "run"}
              onSelect={selectRunTarget}
            />
          ) : domain === "workflow" ? (
            members.map(m => {
              const avail = workflowAvail.get(m.taskId)?.available ?? null
              return (
                <WorkflowRow
                  key={m.taskId}
                  runId={runId}
                  member={m}
                  available={avail}
                  selected={selected?.kind === "root" && selected.name === m.taskId}
                  onSelect={selectWorkflowMember}
                />
              )
            })
          ) : !loaded ? (
            [0, 1, 2].map(i => (
              <div key={i} className="flex items-center gap-2.5 px-3 py-3">
                <div className="size-3.5 shrink-0 animate-pulse rounded-full bg-foreground/[0.06]" />
                <div className="h-3.5 w-36 max-w-full animate-pulse rounded-md bg-foreground/[0.06]" />
                <div className="ml-auto h-3.5 w-12 shrink-0 animate-pulse rounded-md bg-foreground/[0.06]" />
              </div>
            ))
          ) : loadError != null ? (
            <div className="flex flex-col items-center gap-1.5 px-4 py-8 text-center">
              <span className="flex size-9 items-center justify-center rounded-full bg-card shadow-[0_1px_2px_rgba(0,0,0,0.04)] ring-1 ring-foreground/[0.06]">
                <FileSearchIcon className="size-4 text-muted-foreground/60" />
              </span>
              <p className="text-[13px] font-medium text-foreground/80">审计目标载入失败</p>
              <p className="text-xs text-destructive">{loadError}</p>
            </div>
          ) : targets.length === 0 ? (
            <div className="flex flex-col items-center gap-1.5 px-4 py-8 text-center">
              <span className="flex size-9 items-center justify-center rounded-full bg-card shadow-[0_1px_2px_rgba(0,0,0,0.04)] ring-1 ring-foreground/[0.06]">
                <FileSearchIcon className="size-4 text-muted-foreground/60" />
              </span>
              <p className="text-[13px] font-medium text-foreground/80">
                {domain === "skill" ? "无可审计的 skill 目标" : "无可审计的 agent 目标"}
              </p>
              <p className="text-xs text-muted-foreground">
                {domain === "skill" ? "成员会话无 skill invoke/use 事件" : "成员会话无 agent dispatch 事件"}
              </p>
            </div>
          ) : (
            targets.map(t => (
              <TargetRow
                key={t.name}
                runId={runId}
                kind={domain}
                target={t}
                selected={selected?.kind === domain && selected.name === t.name}
                onSelect={selectTarget}
              />
            ))
          )}
        </div>
      </aside>

      {/* 右栏：对账内容（选中目标 → 已有结局直接看报告，未审先弹启动卡；未选 → 域导览） */}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4">
        {selected && showReport ? (
          <AuditReportPanel
            key={`${selected.kind}:${selected.name}`}
            runId={runId}
            kind={selected.kind}
            name={selected.name}
            title={selected.title}
            members={selected.members}
            onOpenTurn={openTurn}
            onClose={() => select(null)}
          />
        ) : selected ? (
          <LaunchCard
            key={`launch:${selected.kind}:${selected.name}`}
            icon={activeDomain.icon}
            title={selected.title}
            meta={launchMeta}
            desc={activeDomain.desc}
            onStart={() => setStarted(true)}
          />
        ) : (
          <DomainIntro key={domain} icon={activeDomain.icon} label={activeDomain.label} desc={activeDomain.desc} tiles={introTiles} />
        )}
      </div>
    </div>
  );
}
