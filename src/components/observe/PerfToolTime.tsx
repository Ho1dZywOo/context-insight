"use client";
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root directory of the software repository for the full text of the License.

// Perf 工具耗时卡（Perf「成员 × 工具」双维度的工具侧）：左右排版——左
// 工具耗时统计、右下钻详情面板（master-detail；lg 视口断点对半分栏——与
// OverviewPanels/SkillCharts 同门，窄视口面板沉底）。
// 左列与同页热点排行同门语法：inset 分组列表（发丝行分隔 + 微底色容
// 器）、行悬停浮层、chevron 弹性旋转选中、标签上/值下的右对齐统计列、
// 悬停浮现的下钻角标（点击 = 该工具全成员下钻）。行内条 = Σ 执行时长比
// 例条（HTML 行内条，与热点排行/文件读取量同门——非坐标图，坐标图仍纯
// SVG 铁律），条内按成员构成堆叠：Top-3 成员段（悬停给名/量，点段 =
// tool:X member:Y 下钻）+ 灰「其他」段——零点击回答「这个工具的时间
// 花在谁身上」；p50/p95 近秩分位刻度落在条上（慢工具一眼可见，平均会
// 撒谎）。右栏常驻选中工具的成员分解（默认选中 Σ 最高工具，再点同行收
// 起给占位空态）：全量成员按 Σ 降序 + 比例条 + 搜索框双匹配显示名/原始
// taskId，超限折叠「展开全部」——成员是无界维度（solo 1 个 → 大 run 237
// 个），纵向清单 + Top-K + 搜索 + 点击下钻是高基数维度的业界收敛答案。
// 诚实口径：无计时调用（源缺时间且无 wire）计入 untimed 摘要不进分位；
// Task/agent 派发行灰条带「派发」胶囊标（窗口 = 子代理整段执行，不进 Σ
// 工具执行头部口径）；skill 族元调用行（skill / load_skill / 技能派发型
// ——提示词注入而非可执行工具，isSkillRelated 由采集侧 tool-conventions
// 单源判定）带「技能」胶囊标，悬停解释耗时语义。下钻唯一出口 = Turns
// 搜索语法深链（幽灵角标 → tool:X 全成员，成员段/分解行 →
// tool:X member:Y）——Turns 命中索引即调用清单，叙事舞台已渲染工具调用
// 块（参数/结果/错误/时长），零新清单面。

import { useState } from "react";
import { ChevronRightIcon, SearchIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  fmtMs,
  PERF_COLORS,
  perfEntrance,
  PERF_CARD_SM,
} from "@/components/observe/perf-shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { RunToolStats } from "@/lib/observe/collectors/tool-stats";

const SEG_COLORS = ["#2563eb", "#16a34a", "#d97706"]; // 堆叠段：按行内位置（Top-1/2/3）着色不按成员——识别靠悬停与分解面板
const OTHER_COLOR = "#cbd5e1";   // 「其他」聚合段：中性灰（不可点——聚合非成员）
const DISPATCH_COLOR = "#8c959f"; // 与时间构成「重试等待」灰同源
const SKILL_COLOR = "#8b5cf6";   // 与 Token 构成「推理」紫同源（技能 = 提示词注入，语义相邻）
const STACK_TOP = 3;             // 条内堆叠取前 N 成员（其余归「其他」段）
const TOOL_FOLD = 15;            // 工具行折叠阈值（超限折叠 +「展开全部」）
const MEMBER_FOLD = 12;          // 分解面板成员折叠阈值（同上）

interface MemberCell {
  taskId: string;
  label: string;
  calls: number;
  totalMs: number;
  errors: number;
}

export function PerfToolTime({
  stats,
  members,
  totalNonLlmMs,
  onOpenSearch,
}: {
  stats: RunToolStats;
  /** 成员轴（taskId → 显示名）：Turns 载荷的 member.label（与 Perf 泳道命名同口径） */
  members: Array<{ taskId: string; label: string | null }>;
  /** Perf 画像的非 LLM 时间（墙钟 − LLM）：占比分母，null = 画像缺席则只显绝对值 */
  totalNonLlmMs?: number | null;
  /** 下钻出口：Turns 搜索语法深链（唯一出口——命中索引即调用清单） */
  onOpenSearch?: (q: string) => void;
}) {
  const tools = stats.tools;
  const meta = stats.meta;
  const [selected, setSelected] = useState<string | null>(() => tools[0]?.toolName ?? null);
  const [memberQuery, setMemberQuery] = useState("");
  const [showAllTools, setShowAllTools] = useState(false);
  const [showAllMembers, setShowAllMembers] = useState<Set<string>>(new Set());

  // 每工具的成员格全量清单（Σ 降序）：堆叠段与成员分解面板共用单一源；
  // 显示名走 Perf 泳道同源（member.label ?? taskId），无 label 回落原始 ID
  const labelOf = new Map(members.map(m => [m.taskId, m.label ?? m.taskId]));
  const cellsByTool = new Map<string, MemberCell[]>(
    tools.map(t => [
      t.toolName,
      Object.entries(stats.matrix[t.toolName] ?? {})
        .map(([taskId, cell]) => ({
          taskId,
          label: labelOf.get(taskId) ?? taskId,
          calls: cell.calls,
          totalMs: cell.totalMs,
          errors: cell.errors,
        }))
        .sort(
          (a, b) =>
            b.totalMs - a.totalMs || b.calls - a.calls || a.taskId.localeCompare(b.taskId),
        ),
    ]),
  );

  const maxToolMs = Math.max(1, ...tools.map(t => t.totalMs));

  // Σ 工具执行（跨成员累加）/ 非 LLM 墙钟：多成员并发执行时 Σ 工具时长可超
  // 墙钟非 LLM 时间，比率可 >100%——诚实标注、不钳制（轴不撒谎）
  const toolShare = totalNonLlmMs != null && totalNonLlmMs > 0 ? meta.totalToolMs / totalNonLlmMs : null;

  // 选中即换工具清搜索（再点同行收起给占位空态）
  const toggle = (toolName: string) => {
    setMemberQuery("");
    setSelected(prev => (prev === toolName ? null : toolName));
  };

  const toggleSet = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  const visibleTools = showAllTools ? tools : tools.slice(0, TOOL_FOLD);
  // 派生兜底：dataEpoch 刷新后 stats 换新对象但组件不重挂，selected 可能指向已
  // 消失的工具——回落到新的 Σ 最高工具（右栏不退成占位空态）；selected=null 收
  // 起态不回落（点同行收起仍给占位空态）
  const effectiveSelected =
    selected == null
      ? null
      : tools.some(t => t.toolName === selected)
        ? selected
        : tools[0]?.toolName ?? null;
  const selectedTool = tools.find(t => t.toolName === effectiveSelected) ?? null;

  return (
    <Card {...perfEntrance(150, PERF_CARD_SM)} size="sm" data-testid="perf-tool-time">
      <CardHeader>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <div className="flex items-baseline gap-2">
            <CardTitle>工具耗时</CardTitle>
            <span className="text-[11px] text-muted-foreground">
              Σ 执行 {fmtMs(meta.totalToolMs)}
              {toolShare != null ? ` · Σ工具执行/非LLM墙钟 ${Math.round(toolShare * 100)}%` : ""}
              {meta.dispatchMs > 0 ? ` · 派发 ${fmtMs(meta.dispatchMs)} 另计` : ""}
            </span>
          </div>
          {/* 诚实标注：计时来源构成（无计时不进分位——轴不撒谎） */}
          <span className="text-[11px] text-muted-foreground" data-tool-meta>
            {meta.timedCalls} 次有计时
            {meta.wireDerivedCalls > 0 ? ` · wire 回填 ${meta.wireDerivedCalls}` : ""}
            {meta.untimedCalls > 0 ? ` · 无计时 ${meta.untimedCalls}（不进分位）` : ""}
          </span>
        </div>
      </CardHeader>
      <CardContent>
        {/* 左右排版：左工具耗时统计、右下钻详情面板（master-detail；窄视口
            面板沉底——与 OverviewPanels/SkillCharts 的 lg 分栏同门） */}
        <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
          {/* 左：工具耗时统计（热点排行同门 inset 列表） */}
          <div className="min-w-0">
            <div className="divide-y divide-foreground/[0.06] overflow-hidden rounded-xl bg-foreground/[0.03] dark:bg-foreground/[0.06]">
              {visibleTools.map(t => {
                const isSelected = effectiveSelected === t.toolName;
                const cells = cellsByTool.get(t.toolName) ?? [];
                const top = cells.slice(0, STACK_TOP);
                const restMs = cells.slice(STACK_TOP).reduce((s, c) => s + c.totalMs, 0);
                const restCount = cells.length - top.length;
                const errRate = t.calls > 0 ? t.errors / t.calls : 0;
                const barPct = (t.totalMs / maxToolMs) * 100;
                const nameTitle = [
                  `${t.toolName}${t.isDispatch ? "（派发——窗口为子代理整段执行，另计不入 Σ 工具执行）" : t.isSkillRelated ? "（技能加载/调用——提示词注入类元调用，耗时不代表工具执行）" : ""}`,
                  `${t.calls} 次 · 错误 ${t.errors}${t.errors > 0 ? `（${Math.round(errRate * 100)}%）` : ""}`,
                  `Σ ${fmtMs(t.totalMs)} · 均值 ${fmtMs(t.avgMs)} · p50 ${fmtMs(t.p50Ms)} · p95 ${fmtMs(t.p95Ms)} · 最慢 ${fmtMs(t.maxMs)}`,
                  ...(t.timedCalls > 0 ? [] : ["无计时（源缺时间且无 wire）"]),
                  ...(t.errorTypes.length > 0 ? [`错误类型：${t.errorTypes.map(e => `${e.type}×${e.count}`).join(" · ")}`] : []),
                ].filter(Boolean).join("\n");
                return (
                  <div key={t.toolName} data-tool-row={t.toolName} className="group">
                    {/* 行主体：点击 = 选中/收起右侧成员分解面板 */}
                    <div
                      role="button"
                      tabIndex={0}
                      data-tool-toggle={t.toolName}
                      className={cn(
                        "flex cursor-pointer items-center gap-2.5 px-3 py-2.5 transition-colors hover:bg-foreground/[0.04]",
                        isSelected && "bg-foreground/[0.05]",
                      )}
                      onClick={() => toggle(t.toolName)}
                      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") toggle(t.toolName) }}
                    >
                      <ChevronRightIcon
                        className={cn(
                          "mt-0.5 size-3.5 shrink-0 text-muted-foreground/50 transition-transform duration-300 [transition-timing-function:cubic-bezier(0.32,0.72,0,1)]",
                          isSelected && "rotate-90",
                        )}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span className="truncate text-[13px] font-medium" title={nameTitle}>
                            {t.toolName}
                          </span>
                          {(t.isDispatch || t.isSkillRelated) && (
                            <span
                              className="shrink-0 rounded-full px-1.5 py-px text-[10px] font-medium leading-4"
                              style={{
                                color: t.isDispatch ? DISPATCH_COLOR : SKILL_COLOR,
                                backgroundColor: t.isDispatch ? "rgba(140,149,159,0.12)" : "rgba(139,92,246,0.1)",
                              }}
                            >
                              {t.isDispatch ? "派发" : "技能"}
                            </span>
                          )}
                          {t.errors > 0 && (
                            <span className="shrink-0 rounded-full bg-red-500/10 px-1.5 py-px text-[10px] font-medium leading-4 text-red-600" title={`错误 ${t.errors}（${Math.round(errRate * 100)}%）`}>
                              错 {t.errors}
                            </span>
                          )}
                          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                            {t.calls} 次
                          </span>
                        </div>
                        {/* Σ 时长比例条：按成员构成堆叠（Top-3 段 + 灰「其他」段；
                            派发行段统一灰——「另计」信号不丢）+ p50/p95 分位刻度 */}
                        <div
                          className="relative mt-1.5 h-1.5 w-full max-w-[440px] rounded-full bg-muted"
                          title={`Σ ${fmtMs(t.totalMs)} · 为最高工具的 ${barPct.toFixed(0)}%`}
                        >
                          <div
                            className="flex h-full gap-px overflow-hidden rounded-full"
                            style={{ width: `${Math.min(barPct, 100)}%` }}
                          >
                            {top.map((seg, si) => (
                              <div
                                key={seg.taskId}
                                data-tool-seg={`${t.toolName}·${seg.taskId}`}
                                className={cn("h-full min-w-0", onOpenSearch && "cursor-pointer")}
                                style={{
                                  flexGrow: Math.max(seg.totalMs, 0.0001),
                                  flexBasis: 0,
                                  background: t.isDispatch ? DISPATCH_COLOR : SEG_COLORS[si],
                                  opacity: t.isDispatch ? 0.5 : 0.8,
                                }}
                                title={`${seg.label} · ${seg.calls} 次 · ${fmtMs(seg.totalMs)}${seg.errors > 0 ? ` · 错误 ${seg.errors}` : ""}\n点击 → Turns 搜索该成员的调用`}
                                onClick={
                                  onOpenSearch
                                    ? e => {
                                        e.stopPropagation();
                                        onOpenSearch(`tool:${t.toolName} member:${seg.taskId}`);
                                      }
                                    : undefined
                                }
                              />
                            ))}
                            {restMs > 0 && (
                              <div
                                data-tool-seg={`${t.toolName}·other`}
                                className="h-full min-w-0"
                                style={{ flexGrow: Math.max(restMs, 0.0001), flexBasis: 0, background: OTHER_COLOR, opacity: 0.9 }}
                                title={`其他 ${restCount} 成员 · Σ ${fmtMs(restMs)}`}
                              />
                            )}
                          </div>
                          {t.p50Ms > 0 && (
                            <span
                              className="absolute top-1/2 h-[11px] w-[2px] -translate-y-1/2 rounded-full bg-white shadow-[0_0_0_0.5px_rgba(0,0,0,0.18)]"
                              style={{ left: `${Math.min((t.p50Ms / maxToolMs) * 100, 100)}%` }}
                              title={`p50 ${fmtMs(t.p50Ms)}（单次调用分位）`}
                            />
                          )}
                          {t.p95Ms > 0 && (
                            <span
                              className="absolute top-1/2 h-[11px] w-[2px] -translate-y-1/2 rounded-full"
                              style={{ left: `${Math.min((t.p95Ms / maxToolMs) * 100, 100)}%`, background: PERF_COLORS.danger }}
                              title={`p95 ${fmtMs(t.p95Ms)}（单次调用分位）`}
                            />
                          )}
                        </div>
                      </div>
                      {/* 右对齐统计列（标签上/值下——热点排行同门语法） */}
                      <div className="flex shrink-0 items-center gap-4">
                        <div className="flex flex-col items-end leading-tight">
                          <span className="text-[10px] text-muted-foreground">耗时</span>
                          <span className="text-xs font-semibold tabular-nums">{fmtMs(t.totalMs)}</span>
                        </div>
                        <div className="hidden flex-col items-end leading-tight sm:flex">
                          <span className="text-[10px] text-muted-foreground">p95</span>
                          <span className="text-xs font-semibold tabular-nums">{fmtMs(t.p95Ms)}</span>
                        </div>
                      </div>
                      {/* 幽灵定位角标：悬停浮现，点击 = 该工具全成员下钻 Turns 搜索 */}
                      {onOpenSearch && (
                        <span
                          role="button"
                          tabIndex={0}
                          data-tool-drill={t.toolName}
                          title="在 Turns 搜索该工具全部调用"
                          className="mt-1 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground/50 opacity-0 transition-opacity duration-200 hover:bg-foreground/[0.06] hover:text-foreground group-hover:opacity-100"
                          onClick={e => { e.stopPropagation(); onOpenSearch(`tool:${t.toolName}`) }}
                          onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); onOpenSearch(`tool:${t.toolName}`) } }}
                        >
                          <SearchIcon className="size-3.5" />
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
              {tools.length > TOOL_FOLD && (
                <div
                  className="cursor-pointer select-none px-3 py-1.5 text-center text-[11px] text-blue-600 transition-colors hover:underline dark:text-blue-400"
                  onClick={() => setShowAllTools(prev => !prev)}
                >
                  {showAllTools ? "收起" : `展开全部 (${tools.length} 工具)`}
                </div>
              )}
            </div>
          </div>

          {/* 右：下钻详情面板——选中工具的成员分解（常驻，默认选中 Σ 最高工具） */}
          <div className="min-w-0">
            {selectedTool == null ? (
              <div
                data-tool-breakdown-empty
                className="flex min-h-[240px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-foreground/[0.14] px-6 text-center"
              >
                <ChevronRightIcon className="size-4 text-muted-foreground/40" />
                <p className="text-xs text-muted-foreground">点击工具行，查看该工具的成员分解</p>
              </div>
            ) : (
              (() => {
                const cells = cellsByTool.get(selectedTool.toolName) ?? [];
                const q = memberQuery.trim().toLowerCase();
                const filtered = q
                  ? cells.filter(
                      c => c.label.toLowerCase().includes(q) || c.taskId.toLowerCase().includes(q),
                    )
                  : cells;
                const isShowAll = showAllMembers.has(selectedTool.toolName);
                const visible = isShowAll ? filtered : filtered.slice(0, MEMBER_FOLD);
                const maxCellMs = Math.max(1, ...cells.map(c => c.totalMs));
                return (
                  <div
                    data-tool-breakdown={selectedTool.toolName}
                    key={selectedTool.toolName}
                    className="animate-in fade-in slide-in-from-right-2 duration-200 rounded-xl border border-foreground/[0.06] bg-card p-3"
                  >
                    {/* 身份行 + 时序口径一行扫读 */}
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-medium" title={selectedTool.toolName}>
                        {selectedTool.toolName}
                      </span>
                      {selectedTool.isDispatch && (
                        <span
                          className="shrink-0 rounded-full px-1.5 py-px text-[10px] font-medium leading-4"
                          style={{ color: DISPATCH_COLOR, backgroundColor: "rgba(140,149,159,0.12)" }}
                        >
                          派发
                        </span>
                      )}
                      {!selectedTool.isDispatch && selectedTool.isSkillRelated && (
                        <span
                          className="shrink-0 rounded-full px-1.5 py-px text-[10px] font-medium leading-4"
                          style={{ color: SKILL_COLOR, backgroundColor: "rgba(139,92,246,0.1)" }}
                        >
                          技能
                        </span>
                      )}
                      {selectedTool.errors > 0 && (
                        <span className="shrink-0 rounded-full bg-red-500/10 px-1.5 py-px text-[10px] font-medium leading-4 text-red-600">
                          错 {selectedTool.errors}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[11px] leading-4 tabular-nums text-muted-foreground">
                      {`${selectedTool.calls} 次调用 · Σ ${fmtMs(selectedTool.totalMs)} · 均值 ${fmtMs(selectedTool.avgMs)} · p50 ${fmtMs(selectedTool.p50Ms)} · p95 ${fmtMs(selectedTool.p95Ms)}${selectedTool.timedCalls > 0 ? "" : " · 无计时（不进分位）"}`}
                    </p>
                    {/* 搜索胶囊（显示名/原始 ID 双匹配）+ 计数 */}
                    <div className="mt-2 flex items-center gap-2">
                      <div className="flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-full border border-foreground/[0.09] bg-muted/40 pl-2.5 pr-2.5 transition-colors focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/15">
                        <SearchIcon className="size-3 shrink-0 text-muted-foreground/70" />
                        <input
                          data-tool-member-search
                          value={memberQuery}
                          onChange={e => setMemberQuery(e.target.value)}
                          placeholder="搜索成员（名 / ID）"
                          className="h-full min-w-0 flex-1 bg-transparent text-[11px] outline-none placeholder:text-muted-foreground/60"
                        />
                      </div>
                      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                        {q ? `${filtered.length}/${cells.length}` : `成员 · ${cells.length}`}
                      </span>
                    </div>
                    {/* 成员行：全量按 Σ 降序 + 比例条，点击 = 该成员该工具下钻 */}
                    <div className="mt-1.5">
                      {visible.map(c => (
                        <div
                          key={c.taskId}
                          data-member-row={`${selectedTool.toolName}·${c.taskId}`}
                          role="button"
                          tabIndex={0}
                          className={cn(
                            "flex items-center gap-3 border-b border-black/[0.04] px-1 py-1.5 text-[11px] tabular-nums transition-colors last:border-0 dark:border-white/[0.05]",
                            onOpenSearch ? "cursor-pointer hover:bg-muted/50" : undefined,
                          )}
                          onClick={
                            onOpenSearch
                              ? () => onOpenSearch(`tool:${selectedTool.toolName} member:${c.taskId}`)
                              : undefined
                          }
                          onKeyDown={
                            onOpenSearch
                              ? e => { if (e.key === "Enter" || e.key === " ") onOpenSearch(`tool:${selectedTool.toolName} member:${c.taskId}`) }
                              : undefined
                          }
                        >
                          <span className="w-[128px] shrink-0 truncate font-medium" title={c.taskId}>
                            {c.label}
                          </span>
                          <span className={cn("w-[80px] shrink-0", c.errors > 0 ? "text-red-600" : "text-muted-foreground")}>
                            {`${c.calls} 次${c.errors > 0 ? ` · 错 ${c.errors}` : ""}`}
                          </span>
                          <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full rounded-full transition-[width] duration-300 [transition-timing-function:cubic-bezier(0.32,0.72,0,1)]"
                              style={{
                                width: `${Math.round((c.totalMs / maxCellMs) * 100)}%`,
                                background: selectedTool.isDispatch ? DISPATCH_COLOR : SEG_COLORS[0],
                                opacity: selectedTool.isDispatch ? 0.5 : 0.8,
                              }}
                            />
                          </div>
                          <span className="w-[48px] shrink-0 text-right font-semibold">
                            {fmtMs(c.totalMs)}
                          </span>
                          <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/40" />
                        </div>
                      ))}
                      {filtered.length === 0 && (
                        <div className="px-1 py-3 text-center text-[11px] text-muted-foreground">无匹配成员</div>
                      )}
                      {filtered.length > MEMBER_FOLD && (
                        <div
                          className="cursor-pointer select-none px-1 py-1.5 text-[11px] text-blue-600 transition-colors hover:underline dark:text-blue-400"
                          onClick={e => { e.stopPropagation(); setShowAllMembers(prev => toggleSet(prev, selectedTool.toolName)) }}
                        >
                          {isShowAll ? "收起" : `展开全部 (${filtered.length} 成员)`}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()
            )}
          </div>
        </div>
        {/* 图例：堆叠与分位刻度读法 */}
        <p className="mt-1.5 text-[10px] text-muted-foreground">
          条 = Σ 执行时长（段 = 前 {STACK_TOP} 成员，灰段 = 其他成员聚合）· 白刻度 p50 · 红刻度 p95（单次调用分位）· 点击行选中（右侧看成员分解）· 点段/成员行/搜索图标 → Turns 搜索直达调用清单
        </p>
      </CardContent>
    </Card>
  );
}
