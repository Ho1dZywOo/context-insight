"use client";
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// run 级对账报告面板：sift JSON 自渲染（五态总览带 + verdict 过滤 + 指令分组
// 列表 + finding 明细带成员归因）。对账任务经 skill-audit-job 的 run 级键驱动
// （cross-tab resume；选中目标即发起，已有结果则直接展示）。finding 的
// transcript 字段 = 受控成员标签文件名，经 _members 映射回成员徽标。

import { useEffect, useMemo, useState, memo } from "react";
import { useSyncExternalStore } from "react";
import { ChevronRightIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  subscribeSkillAudit,
  getSkillAuditSnapshot,
  getSkillAuditServerSnapshot,
  startRunAudit,
  runAuditKey,
  type AuditKind,
  type SkillAuditResult,
} from "@/lib/skill-audit-job";
import {
  ALL_VERDICTS,
  VERDICT_DISPLAY,
  METHOD_TAG,
  NOISE_LABELS,
  LAYER_BADGE,
  filterFindings,
  groupFindingsByInstruction,
  matchFindingLayers,
  EMPTY_FILTER,
} from "@/components/observe/skill-audit/verdictConfig";
import type { AuditFinding, AuditVerdict, AuditLayerInfo, AuditMemberMap } from "@/lib/sift-audit-types";
import { DeclarationCoverageOverview } from "@/components/observe/skill-audit/DeclarationCoverageOverview";
import { PERF_CARD_SM } from "@/components/observe/perf-shared";

const VERDICT_BAR_CLS: Record<AuditVerdict, string> = {
  PASS: "bg-emerald-500",
  FAIL: "bg-red-500",
  "N/A": "bg-orange-400",
  UNRESOLVED: "bg-foreground/25",
  INDETERMINATE: "bg-red-400/70",
};

const VERDICT_TEXT_CLS: Record<AuditVerdict, string> = {
  PASS: "text-emerald-600 dark:text-emerald-400",
  FAIL: "text-red-600 dark:text-red-400",
  "N/A": "text-orange-600 dark:text-orange-400",
  UNRESOLVED: "text-muted-foreground",
  INDETERMINATE: "text-red-500 dark:text-red-400",
};

function memberLabelOf(transcript: string, members: AuditMemberMap | undefined): string {
  const hit = members?.[transcript];
  if (hit) return hit.label ?? hit.taskId;
  return transcript.replace(/\.json$/, "");
}

function fmtTokens(u: Record<string, number>): string {
  const total = (u.input_tokens ?? u.input ?? 0) + (u.output_tokens ?? u.output ?? 0);
  if (total <= 0) return "";
  return total >= 1000 ? `${(total / 1000).toFixed(1)}K tokens` : `${total} tokens`;
}

function fmtCost(u: Record<string, number> | undefined): string {
  const cost = u?.total_cost_usd ?? 0;
  return cost > 0 ? ` · $${cost.toFixed(2)}` : "";
}

function fmtDuration(s: number): string {
  return s >= 120 ? `${Math.round(s / 60)} 分钟` : `${s.toFixed(0)}s`;
}

function verdictCounts(findings: AuditFinding[]): Map<AuditVerdict, number> {
  const by = new Map<AuditVerdict, number>();
  for (const f of findings) by.set(f.verdict, (by.get(f.verdict) ?? 0) + 1);
  return by;
}

// ── finding 行（memo：组展开重渲不波及兄弟行） ────────────────────────────

const FindingRow = memo(function FindingRow({
  f,
  members,
  layers,
  onOpenTurn,
}: {
  f: AuditFinding;
  members: AuditMemberMap | undefined;
  layers: AuditLayerInfo[] | undefined;
  onOpenTurn?: (memberTaskId: string, turnIndex: number) => void;
}) {
  const v = VERDICT_DISPLAY[f.verdict];
  const noise = f.noise_label ? NOISE_LABELS[f.noise_label] : undefined;
  const method = METHOD_TAG[f.method];
  const matchedLayers = matchFindingLayers(f, layers);
  const taskId = members?.[f.transcript]?.taskId;
  const turnRefs = f.turn_refs ?? [];
  return (
    <div className="flex items-start gap-2.5 px-4 py-2.5 sm:px-5">
      <span className={cn("mt-0.5 shrink-0 text-xs font-semibold", VERDICT_TEXT_CLS[f.verdict])} title={v.hint}>
        {v.icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[11.5px] leading-5 text-foreground/90">{f.evidence}</p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] leading-4">
          <span className="rounded-full bg-foreground/[0.05] px-1.5 py-0.5 font-medium text-muted-foreground">
            {memberLabelOf(f.transcript, members)}
          </span>
          {matchedLayers.map(l => (
            <span
              key={l.kind}
              className={cn("rounded-full border px-1.5 py-0.5", LAYER_BADGE[l.kind].cls)}
              title={`${l.label}（${l.source}）· ${LAYER_BADGE[l.kind].hint}`}
            >
              {l.label}
            </span>
          ))}
          {method ? (
            <span className={cn("rounded-full bg-foreground/[0.04] px-1.5 py-0.5", method.cls)} title={method.hint}>
              {method.label}
            </span>
          ) : null}
          {noise ? (
            <span className={cn("rounded-full border px-1.5 py-0.5", noise.cls)} title={(f.noise_reasons ?? []).join("；")}>
              {noise.label}
            </span>
          ) : null}
          {turnRefs.length > 0 ? (
            <span className="tabular-nums">
              {turnRefs.map(t => {
                const canJump = !!onOpenTurn && !!taskId;
                return canJump ? (
                  <button
                    key={t}
                    type="button"
                    data-audit-turn-link={`${taskId}:${t}`}
                    title={`跳转到 turn #${t}`}
                    onClick={() => onOpenTurn!(taskId!, t)}
                    className="cursor-pointer px-0.5 font-medium text-teal-600 underline-offset-2 hover:underline dark:text-teal-400"
                  >
                    #{t}
                  </button>
                ) : (
                  <span key={t} className="px-0.5 text-muted-foreground/70" title="离线查看器无 turn 定位数据">
                    #{t}
                  </span>
                );
              })}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
});

// ── 指令组（memo：headline + 计数 + 成员分布 + 展开明细） ──────────────────

const InstructionGroup = memo(function InstructionGroup({
  group,
  members,
  layers,
  onOpenTurn,
  expanded,
  onToggle,
}: {
  group: { key: string; findings: AuditFinding[] };
  members: AuditMemberMap | undefined;
  layers: AuditLayerInfo[] | undefined;
  onOpenTurn?: (memberTaskId: string, turnIndex: number) => void;
  expanded: boolean;
  onToggle: (key: string) => void;
}) {
  const counts = useMemo(() => verdictCounts(group.findings), [group.findings]);
  const worst = group.findings[0]?.verdict ?? "UNRESOLVED";
  const headline =
    group.findings.find(f => f.headline)?.headline ?? group.findings[0]?.instruction_text ?? "(空)";
  const failMembers = useMemo(() => {
    const seen: string[] = [];
    for (const f of group.findings) {
      if (f.verdict !== "FAIL") continue
      const label = memberLabelOf(f.transcript, members)
      if (!seen.includes(label)) seen.push(label)
    }
    return seen
  }, [group.findings, members])

  return (
    <div className="[contain-intrinsic-size:auto_52px] [content-visibility:auto]">
      <button
        type="button"
        onClick={() => onToggle(group.key)}
        className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40 sm:px-5"
      >
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/50 transition-transform duration-200 [transition-timing-function:cubic-bezier(0.32,0.72,0,1)]",
            expanded && "rotate-90",
          )}
        />
        <span className={cn("shrink-0 text-xs font-semibold", VERDICT_TEXT_CLS[worst])} title={VERDICT_DISPLAY[worst].hint}>
          {VERDICT_DISPLAY[worst].icon}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-foreground/90" title={group.findings[0]?.instruction_text}>
          {headline}
        </span>
        {failMembers.length > 0 ? (
          <span className="hidden shrink-0 items-center gap-1 sm:flex">
            {failMembers.slice(0, 2).map(m => (
              <span
                key={m}
                className="max-w-[110px] truncate rounded-full border border-red-500/25 bg-red-500/[0.07] px-1.5 py-0.5 text-[10px] leading-4 text-red-600 dark:text-red-400"
                title={`该成员判定失败：${m}`}
              >
                {m}
              </span>
            ))}
            {failMembers.length > 2 ? (
              <span className="text-[10px] leading-4 text-red-600/70 dark:text-red-400/70">+{failMembers.length - 2}</span>
            ) : null}
          </span>
        ) : null}
        <span
          className="flex shrink-0 items-center gap-1.5"
          title={[...counts.entries()].filter(([, n]) => n > 0).map(([v, n]) => `${n} ${VERDICT_DISPLAY[v].label}`).join(" · ")}
        >
          <span className="flex h-[3px] w-9 shrink-0 gap-px overflow-hidden rounded-full">
            {ALL_VERDICTS.map(v => {
              const n = counts.get(v) ?? 0;
              return n > 0 ? <span key={v} className={cn("h-full", VERDICT_BAR_CLS[v])} style={{ flex: n }} /> : null;
            })}
          </span>
          <span className="tabular-nums text-[11px] text-muted-foreground">{group.findings.length}</span>
        </span>
      </button>
      {expanded ? (
        <div className="animate-in fade-in slide-in-from-bottom-1 duration-200 divide-y divide-foreground/[0.05] border-t border-foreground/[0.05]">
          {group.findings.map((f, i) => (
            <FindingRow key={`${f.transcript}-${f.seq ?? i}`} f={f} members={members} layers={layers} onOpenTurn={onOpenTurn} />
          ))}
        </div>
      ) : null}
    </div>
  );
});

// ── 报告面板 ────────────────────────────────────────────────────────────────

export interface AuditReportPanelProps {
  runId: string;
  kind: AuditKind;
  /** job 键名：skill/agent = 目标名；root = 成员 taskId。 */
  name: string;
  /** 展示标题。 */
  title: string;
  /** 涉事成员 taskId（root = 单成员）。 */
  members: string[];
  /** finding turn 深链：成员 taskId + turn 序号（由外壳解析成 turnId 后切 Turns）。 */
  onOpenTurn?: (memberTaskId: string, turnIndex: number) => void;
  onClose: () => void;
}

export function AuditReportPanel({ runId, kind, name, title, members, onOpenTurn, onClose }: AuditReportPanelProps) {
  const key = runAuditKey(runId, kind, name);
  const job = useSyncExternalStore(subscribeSkillAudit, () => getSkillAuditSnapshot(key), getSkillAuditServerSnapshot);
  const [verdictFilter, setVerdictFilter] = useState<AuditVerdict | null>(null);
  const [memberFilter, setMemberFilter] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  // 运行态计时（秒级 tick，仅 running 时挂表）
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!job.running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [job.running]);

  useEffect(() => {
    if (!job.running && job.result == null && job.error == null) {
      startRunAudit({ runId, kind, name, members });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const result = job.result;
  const findings = useMemo(() => result?.findings ?? [], [result]);
  // 五态计数与总判定数以 report.summary 为权威（sift 侧与报告 HTML 同源）；
  // 过滤/分组明细按 findings 现算。
  const counts = useMemo(() => {
    const by = new Map<AuditVerdict, number>();
    if (result) {
      by.set("PASS", result.summary.pass);
      by.set("FAIL", result.summary.fail);
      by.set("N/A", result.summary.na);
      by.set("UNRESOLVED", result.summary.unresolved ?? 0);
      by.set("INDETERMINATE", result.summary.indeterminate ?? 0);
    }
    return by;
  }, [result]);
  // 成员分布（跨成员对账的聚合视图）：每成员判定数与失败数，可点选收窄
  const memberStats = useMemo(() => {
    if (!result) return [] as Array<{ transcript: string; label: string; fail: number; total: number }>;
    const by = new Map<string, { transcript: string; label: string; fail: number; total: number }>();
    for (const f of findings) {
      const e = by.get(f.transcript) ?? {
        transcript: f.transcript,
        label: memberLabelOf(f.transcript, result._members),
        fail: 0,
        total: 0,
      };
      e.total += 1;
      if (f.verdict === "FAIL") e.fail += 1;
      by.set(f.transcript, e);
    }
    return [...by.values()].sort((a, b) => b.fail - a.fail || a.label.localeCompare(b.label));
  }, [findings, result]);
  const shown = useMemo(() => {
    let out =
      verdictFilter == null
        ? findings
        : filterFindings(findings, { ...EMPTY_FILTER, verdicts: new Set([verdictFilter]) });
    if (memberFilter != null) out = out.filter(f => f.transcript === memberFilter);
    return out;
  }, [findings, verdictFilter, memberFilter]);
  // 失败组置顶（默认视图一眼见问题指令；过滤态全部同 verdict 时退化为稳定声明序）
  const groups = useMemo(() => {
    const gs = groupFindingsByInstruction(shown);
    return gs
      .map((g, i) => ({ g, i, fails: g.findings.reduce((n, f) => (f.verdict === "FAIL" ? n + 1 : n), 0) }))
      .sort((a, b) => b.fails - a.fails || a.i - b.i)
      .map(({ g }) => g);
  }, [shown]);
  const total = result?.summary.total ?? findings.length;

  const toggleGroup = (g: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });
  };

  return (
    <Card
      data-audit-report={name}
      className={cn(
        PERF_CARD_SM,
        // 与左栏卡同款分层投影：卡片浮在浅灰画布上，边界靠高低差而非描边
        "shadow-[0_1px_2px_rgba(0,0,0,0.04),0_12px_32px_-22px_rgba(0,0,0,0.26)]",
        "animate-in fade-in slide-in-from-bottom-2 fill-mode-backwards duration-300 [animation-timing-function:cubic-bezier(0.32,0.72,0,1)]",
      )}
    >
      <CardContent className="flex flex-col gap-3">
        {/* 头行：标题 + 对账范围 + 重跑/关闭 */}
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex h-7 items-center gap-1.5 rounded-full bg-foreground/[0.05] px-2.5">
            <span
              className={cn(
                "text-[11px] font-semibold",
                result
                  ? result.summary.fail > 0
                    ? VERDICT_TEXT_CLS.FAIL
                    : VERDICT_TEXT_CLS.PASS
                  : "text-muted-foreground",
              )}
            >
              {result ? (result.summary.fail > 0 ? `${result.summary.fail} 项失败` : "全部通过") : job.error ? "对账失败" : "对账中"}
            </span>
            {result ? (
              <span className="text-[11px] text-muted-foreground">/ {total} 条判定</span>
            ) : null}
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground" title={title}>
              {title}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {result?.run
                ? `run 溯源 · 命中 ${result.run.matchedSessionCount} 会话 / ${result.run.targetCallCount} 次调用`
                : members.length > 1
                  ? `跨 ${members.length} 个成员对账`
                  : "单成员对账"}
              {result?.duration_seconds != null ? ` · ${fmtDuration(result.duration_seconds)}` : ""}
              {result?.token_usage != null ? ` · ${fmtTokens(result.token_usage)}${fmtCost(result.token_usage)}` : ""}
            </p>
          </div>
          <span className="ml-auto" />
          <button
            type="button"
            title="重跑对账"
            className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground/80 transition-colors hover:bg-foreground/[0.08] hover:text-foreground"
            onClick={() => startRunAudit({ runId, kind, name, members })}
          >
            <RefreshCwIcon className="size-3" />
          </button>
          <button
            type="button"
            title="关闭"
            className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground/80 transition-colors hover:bg-foreground/[0.08] hover:text-foreground"
            onClick={onClose}
          >
            <XIcon className="size-3" />
          </button>
        </div>

        {/* 运行态：阶段行 + 进度条 + 计时（停滞超阈值给慢批次提示） */}
        {job.running ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <p className="min-w-0 truncate text-[13px] font-medium text-foreground/90" title={job.progress ?? undefined}>
                {job.progress ?? "sift 对账启动中…"}
              </p>
              <span className="shrink-0 text-[13px] font-semibold tabular-nums text-foreground">{job.percent}%</span>
            </div>
            <div className="h-[3px] overflow-hidden rounded-full bg-foreground/[0.07]">
              <div
                className="h-full rounded-full bg-foreground/55 transition-[width] duration-500 [transition-timing-function:cubic-bezier(0.32,0.72,0,1)]"
                style={{ width: `${Math.max(job.percent, 3)}%` }}
              />
            </div>
            <div className="flex items-center gap-2">
              {job.startedAt != null ? (
                <span className="shrink-0 tabular-nums text-[10.5px] text-muted-foreground/80">
                  {Math.floor((now - job.startedAt) / 60000)}:{String(Math.floor(((now - job.startedAt) / 1000) % 60)).padStart(2, "0")}
                </span>
              ) : null}
              {job.lastProgressAt != null && now - job.lastProgressAt > 90_000 ? (
                <p className="min-w-0 flex-1 truncate text-[10.5px] text-muted-foreground/70" title="LLM 单批判定可达 20 分钟，属正常等待">
                  当前批次较慢——LLM 单批判定可达 20 分钟，属正常等待
                </p>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* 错误态 */}
        {job.error != null && !job.running ? (
          <div className="rounded-xl bg-red-500/[0.06] px-3.5 py-2.5 text-xs leading-5 text-red-600 dark:text-red-400">
            {job.error}
          </div>
        ) : null}

        {/* 结果态：五态总览带 + verdict 过滤 + 指令分组列表 */}
        {result && !job.running ? (
          <>
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-5">
              {ALL_VERDICTS.map((v, i) => {
                const n = counts.get(v) ?? 0;
                return (
                  <button
                    key={v}
                    type="button"
                    title={VERDICT_DISPLAY[v].hint}
                    onClick={() => setVerdictFilter(cur => (cur === v ? null : v))}
                    className={cn(
                      "min-w-0 animate-in fade-in slide-in-from-bottom-2 fill-mode-backwards duration-300 [animation-timing-function:cubic-bezier(0.32,0.72,0,1)] cursor-pointer rounded-xl bg-foreground/[0.04] px-3 py-2 text-left transition-colors hover:bg-foreground/[0.07] dark:bg-foreground/[0.07]",
                      verdictFilter === v && "bg-foreground/[0.09] dark:bg-foreground/[0.11]",
                      n === 0 && "opacity-60",
                    )}
                    style={{ animationDelay: `${i * 40}ms` }}
                  >
                    <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                      <span className={VERDICT_TEXT_CLS[v]}>{VERDICT_DISPLAY[v].icon}</span>
                      {VERDICT_DISPLAY[v].label}
                    </div>
                    <div className={cn("mt-0.5 text-[18px] font-semibold leading-7 tracking-tight tabular-nums", VERDICT_TEXT_CLS[v])}>
                      {n}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* 五态比例条（同屏同源同口径：与瓦片计数一致） */}
            {total > 0 ? (
              <div className="flex h-1.5 gap-0.5 overflow-hidden rounded-full">
                {ALL_VERDICTS.map(v => {
                  const n = counts.get(v) ?? 0;
                  if (n === 0) return null;
                  return (
                    <div
                      key={v}
                      className={cn("h-full rounded-full transition-[width] duration-500", VERDICT_BAR_CLS[v])}
                      style={{ width: `${(n / total) * 100}%` }}
                      title={`${VERDICT_DISPLAY[v].label} ${n}`}
                    />
                  );
                })}
              </div>
            ) : null}

            {/* 成员分布（跨成员对账才有）：每成员 失败/判定 计数，点选收窄明细 */}
            {memberStats.length > 1 ? (
              <div data-audit-member-stats className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] font-medium text-muted-foreground">成员分布</span>
                {memberStats.map(m => (
                  <button
                    key={m.transcript}
                    type="button"
                    title={`该成员判定 ${m.total} 条${m.fail > 0 ? `，其中失败 ${m.fail} 条` : "，全部通过"}——点击${memberFilter === m.transcript ? "取消" : "仅看"}该成员`}
                    onClick={() => setMemberFilter(cur => (cur === m.transcript ? null : m.transcript))}
                    className={cn(
                      "max-w-[160px] cursor-pointer truncate rounded-full border px-2 py-0.5 text-[10.5px] leading-4 transition-colors",
                      m.fail > 0
                        ? "border-red-500/25 bg-red-500/[0.06] text-red-600 dark:text-red-400"
                        : "border-foreground/[0.08] bg-foreground/[0.03] text-muted-foreground",
                      memberFilter === m.transcript && "border-foreground/25 bg-foreground/[0.09] text-foreground dark:bg-foreground/[0.14]",
                    )}
                  >
                    {m.label}
                    <span className="ml-1 tabular-nums opacity-80">{m.fail}/{m.total}</span>
                  </button>
                ))}
              </div>
            ) : null}

            {result.warnings && result.warnings.length > 0 ? (
              <div
                className="flex items-start gap-1.5 rounded-lg bg-orange-500/[0.07] px-2.5 py-1.5 text-[11px] leading-5 text-orange-700 dark:text-orange-300"
                title={result.warnings.join("\n")}
              >
                <span className="shrink-0">⚠</span>
                <p className="min-w-0 flex-1">
                  {result.warnings[0]}
                  {result.warnings.length > 1 ? `（+${result.warnings.length - 1} 条）` : ""}
                </p>
              </div>
            ) : null}

            <DeclarationCoverageOverview
              textCoverage={result.text_coverage}
              skillBody={result.skill_body}
              coverage={result.coverage}
              layers={result._layers}
            />

            <div
              className={cn(
                "rounded-xl border border-foreground/[0.06]",
                (verdictFilter != null || memberFilter != null) && "border-foreground/[0.12]",
              )}
            >
              <div className="flex items-center gap-2 border-b border-foreground/[0.06] bg-muted/40 px-4 py-1.5 sm:px-5">
                <span className="text-[11px] font-medium text-muted-foreground">
                  {verdictFilter != null ? `${VERDICT_DISPLAY[verdictFilter].label} 判定` : "按指令聚合"}
                  {memberFilter != null
                    ? ` · ${memberLabelOf(memberFilter, result._members)}`
                    : ""}
                </span>
                <span className="tabular-nums text-[11px] text-muted-foreground/70">
                  {groups.length} 组 · {shown.length} 条
                </span>
                {verdictFilter != null || memberFilter != null ? (
                  <button
                    type="button"
                    className="ml-auto cursor-pointer text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                    onClick={() => {
                      setVerdictFilter(null);
                      setMemberFilter(null);
                    }}
                  >
                    清除过滤
                  </button>
                ) : null}
              </div>
              <div className="divide-y divide-foreground/[0.06]">
                {groups.length === 0 ? (
                  <p className="px-4 py-6 text-center text-xs text-muted-foreground">
                    {total === 0 ? "报告无判定条目（声明指令均未触发判定）" : "当前过滤条件下没有判定"}
                  </p>
                ) : (
                  groups.map(g => (
                    <InstructionGroup
                      key={g.key}
                      group={g}
                      members={result._members}
                      layers={result._layers}
                      onOpenTurn={onOpenTurn}
                      expanded={expandedGroups.has(g.key)}
                      onToggle={toggleGroup}
                    />
                  ))
                )}
              </div>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

export type { SkillAuditResult };
