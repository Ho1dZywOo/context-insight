"use client";
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root directory of the software repository for the full text of the License.

// Perf 工具耗时卡（Perf「成员 × 工具」双维度的工具侧，图表纯 SVG——仓库铁律）：
// 一体化行布局——左工具名与派发/技能标，中 Σ 时长排行条（p50/p95 近秩
// 分位刻度直接落在条上：慢工具一眼可见——平均会撒谎），条内按成员构成
// 堆叠：Top-3 成员段（悬停给名/量，点段 = tool:X member:Y 下钻）+ 灰「其
// 他」段（聚合不可点）——零点击回答「这个工具的时间花在谁身上」；右调
// 用/错误计数与展开 chevron。成员是无界维度（solo 1 个 → 大 run 237 个），
// 热力矩阵随成员数横向增长不可扩展，已退役：交叉热力 → 条内堆叠吸收，
// 定位特定成员 → 行尾 chevron 展开成员分解清单（全量成员按 Σ 降序、限高
// 滚动 + 搜索框双匹配显示名/原始 taskId——高基数维度的业界收敛答案：
// 纵向清单 + Top-K + 搜索 + 点击下钻，Grafana topk 表格 / DataDog facet
// 同门）。诚实口径：无计时调用（源缺时间且无 wire）计入 untimed 摘要不
// 进分位；Task/agent 派发行灰条带「派发」标（窗口 = 子代理整段执行，不
// 进 Σ 工具执行头部口径）；skill 族元调用行（skill / load_skill / 技能派
// 发型——提示词注入而非可执行工具，isSkillRelated 由采集侧
// tool-conventions 单源判定）紫字带「技能」标，悬停解释耗时语义。下钻唯
// 一出口 = Turns 搜索语法深链（工具行 → tool:X，成员段/分解行 →
// tool:X member:Y）——Turns 命中索引即调用清单，叙事舞台已渲染工具调用
// 块（参数/结果/错误/时长），零新清单面。

import { useMemo, useState } from "react";
import {
  fmtMs,
  PERF_COLORS,
  perfEntrance,
  PERF_CARD_SM,
} from "@/components/observe/perf-shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { cn } from "@/lib/utils";
import type { RunToolStats } from "@/lib/observe/collectors/tool-stats";

const BAR_COLOR = "#2563eb";        // 与 Perf 泳道 agent 蓝同源（堆叠首段同色）
const DISPATCH_COLOR = "#8c959f";   // 与时间构成「重试等待」灰同源
const SKILL_COLOR = "#8b5cf6";      // 与 Token 构成「推理」紫同源（技能 = 提示词注入，语义相邻）
/** 条内成员构成堆叠段色：按行内位置（Top-1/2/3）着色，不按成员——跨行
 *  成员颜色不承诺一致（同一成员在不同工具条上色相不同），识别靠悬停与
 *  成员分解清单，避免 237 成员 × 全局调色的不可扩展着色 */
const STACK_COLORS = [BAR_COLOR, "#16a34a", "#d97706"];
const OTHER_COLOR = "#cbd5e1";      // 「其他」聚合段：中性灰（不可点——聚合非成员）
const STACK_TOP = 3;                // 条内堆叠取前 N 成员（其余归「其他」段）
const ROW_H = 26;
const NAME_W = 210;                 // 工具名 + 徽标列
const STATS_W = 92;                 // Σ 数字列
const BAR_W = 320;
const CALLS_W = 88;                 // 调用/错误计数列（条后专列，不再压条尾）
const CALLS_X = NAME_W + STATS_W + BAR_W + CALLS_W;
const CHEV_X = CALLS_X + 8;
const SVG_W = CHEV_X + 22;
const TOP_PAD = 4;

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
  const [expandedTool, setExpandedTool] = useState<string | null>(null);
  const [memberQuery, setMemberQuery] = useState("");

  // 每工具的成员格全量清单（Σ 降序）：堆叠段与成员分解清单共用单一源；
  // 显示名走 Perf 泳道同源（member.label ?? taskId），无 label 回落原始 ID
  const cellsByTool = useMemo(() => {
    const labelOf = new Map(members.map(m => [m.taskId, m.label ?? m.taskId]));
    const map = new Map<string, MemberCell[]>();
    for (const t of tools) {
      map.set(
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
      );
    }
    return map;
  }, [stats, members, tools]);

  const maxToolMs = Math.max(1, ...tools.map(t => t.totalMs));
  const svgH = TOP_PAD + tools.length * ROW_H + 4;

  const toolShare = totalNonLlmMs != null && totalNonLlmMs > 0 ? meta.totalToolMs / totalNonLlmMs : null;

  // 展开即换工具清搜索（手风琴单开——避免巨量 DOM 与陈旧过滤态串味）
  const expand = (toolName: string) => {
    setMemberQuery("");
    setExpandedTool(prev => (prev === toolName ? null : toolName));
  };

  return (
    <Card {...perfEntrance(150, PERF_CARD_SM)} size="sm" data-testid="perf-tool-time">
      <CardHeader>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <div className="flex items-baseline gap-2">
            <CardTitle>工具耗时</CardTitle>
            <span className="text-[11px] text-muted-foreground">
              Σ 执行 {fmtMs(meta.totalToolMs)}
              {toolShare != null ? ` · 占非 LLM 时间 ${Math.round(toolShare * 100)}%` : ""}
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
        <div className="w-full overflow-x-auto">
          <svg width={SVG_W} height={svgH} className="block" role="img" aria-label="工具耗时排行与成员构成">
            {tools.map((t, ri) => {
              const y = TOP_PAD + ri * ROW_H;
              const cells = cellsByTool.get(t.toolName) ?? [];
              const top = cells.slice(0, STACK_TOP);
              const restMs = cells.slice(STACK_TOP).reduce((s, c) => s + c.totalMs, 0);
              const restCount = cells.length - top.length;
              const errRate = t.calls > 0 ? t.errors / t.calls : 0;
              const isOpen = expandedTool === t.toolName;
              return (
                <g key={t.toolName} data-tool-row={t.toolName}>
                  {isOpen && (
                    <rect x={-2} y={y} width={SVG_W} height={ROW_H} rx={5} fill={BAR_COLOR} fillOpacity={0.06} />
                  )}
                  {/* 工具名 + 派发/技能标 + 调用与错误计数：行点击 = 该工具全成员下钻 */}
                  <g
                    className={onOpenSearch ? "cursor-pointer" : undefined}
                    onClick={onOpenSearch ? () => onOpenSearch(`tool:${t.toolName}`) : undefined}
                  >
                    <title>{[
                      `${t.toolName}${t.isDispatch ? "（派发——窗口为子代理整段执行，另计不入 Σ 工具执行）" : t.isSkillRelated ? "（技能加载/调用——提示词注入类元调用，耗时不代表工具执行）" : ""}`,
                      `${t.calls} 次 · 错误 ${t.errors}${t.errors > 0 ? `（${Math.round(errRate * 100)}%）` : ""}`,
                      `Σ ${fmtMs(t.totalMs)} · 均值 ${fmtMs(t.avgMs)} · p50 ${fmtMs(t.p50Ms)} · p95 ${fmtMs(t.p95Ms)} · 最慢 ${fmtMs(t.maxMs)}`,
                      ...(t.timedCalls > 0 ? [] : ["无计时（源缺时间且无 wire）"]),
                      ...(t.errorTypes.length > 0 ? [`错误类型：${t.errorTypes.map(e => `${e.type}×${e.count}`).join(" · ")}`] : []),
                      "点击 → Turns 搜索该工具全部调用",
                    ].filter(Boolean).join("\n")}</title>
                    <text x={0} y={y + 12} fontSize={10.5} fontWeight={600} fill={PERF_COLORS.axis} className="fill-foreground/90">
                      {t.toolName.length > 20 ? t.toolName.slice(0, 19) + "…" : t.toolName}
                    </text>
                    {t.isDispatch && (
                      <text x={NAME_W - 26} y={y + 12} fontSize={8} fill={DISPATCH_COLOR}>派发</text>
                    )}
                    {/* skill 族元调用标（与派发互斥显示——技能派发型 task/agent 行
                        归派发语义优先） */}
                    {!t.isDispatch && t.isSkillRelated && (
                      <text x={NAME_W - 26} y={y + 12} fontSize={8} fill={SKILL_COLOR}>技能</text>
                    )}
                    <text x={CALLS_X} y={y + 12} fontSize={9} fill={errRate > 0 ? PERF_COLORS.danger : PERF_COLORS.axis} textAnchor="end">
                      {`${t.calls} 次${t.errors > 0 ? ` · 错 ${t.errors}` : ""}`}
                    </text>
                  </g>
                  {/* Σ 时长条按成员构成堆叠（Top-3 段 + 灰「其他」段；派发行段
                      统一灰半透——「另计」信号不丢）+ p50/p95 近秩分位刻度
                      （刻度时刻 = 该工具单次调用分位，落在条内——慢工具刻度
                      靠右即见） */}
                  {(() => {
                    let segX = NAME_W + STATS_W;
                    const stack = (
                      <>
                        {top.map((seg, si) => {
                          const w = (seg.totalMs / maxToolMs) * BAR_W;
                          const el = (
                            <g
                              key={seg.taskId}
                              data-tool-seg={`${t.toolName}·${seg.taskId}`}
                              className={onOpenSearch ? "cursor-pointer" : undefined}
                              onClick={
                                onOpenSearch
                                  ? e => {
                                      e.stopPropagation();
                                      onOpenSearch(`tool:${t.toolName} member:${seg.taskId}`);
                                    }
                                  : undefined
                              }
                            >
                              <title>{`${seg.label} · ${seg.calls} 次 · ${fmtMs(seg.totalMs)}${seg.errors > 0 ? ` · 错误 ${seg.errors}` : ""}\n点击 → Turns 搜索该成员的调用`}</title>
                              <rect
                                x={segX}
                                y={y + 3}
                                width={Math.max(w, seg.totalMs > 0 ? 2 : 0)}
                                height={11}
                                rx={2}
                                fill={t.isDispatch ? DISPATCH_COLOR : STACK_COLORS[si]}
                                fillOpacity={t.isDispatch ? 0.45 : 0.72}
                              />
                              {!t.isDispatch && w > 56 && (
                                <text x={segX + 6} y={y + 11.5} fontSize={8} fill="#ffffff" fillOpacity={0.92}>
                                  {seg.label.length > 7 ? seg.label.slice(0, 6) + "…" : seg.label}
                                </text>
                              )}
                            </g>
                          );
                          segX += w;
                          return el;
                        })}
                        {restMs > 0 && (() => {
                          const w = (restMs / maxToolMs) * BAR_W;
                          const el = (
                            <g key="other" data-tool-seg={`${t.toolName}·other`}>
                              <title>{`其他 ${restCount} 成员 · Σ ${fmtMs(restMs)}`}</title>
                              <rect
                                x={segX + 1}
                                y={y + 3}
                                width={Math.max(w, 2)}
                                height={11}
                                rx={2}
                                fill={OTHER_COLOR}
                                fillOpacity={0.8}
                              />
                            </g>
                          );
                          segX += w;
                          return el;
                        })()}
                      </>
                    );
                    return stack;
                  })()}
                  {t.p50Ms > 0 && (
                    <line
                      x1={NAME_W + STATS_W + (t.p50Ms / maxToolMs) * BAR_W}
                      y1={y + 1}
                      x2={NAME_W + STATS_W + (t.p50Ms / maxToolMs) * BAR_W}
                      y2={y + 16}
                      stroke="#ffffff" strokeWidth={1.4} strokeOpacity={0.95}
                    />
                  )}
                  {t.p95Ms > 0 && (
                    <line
                      x1={NAME_W + STATS_W + (t.p95Ms / maxToolMs) * BAR_W}
                      y1={y + 1}
                      x2={NAME_W + STATS_W + (t.p95Ms / maxToolMs) * BAR_W}
                      y2={y + 16}
                      stroke={PERF_COLORS.danger} strokeWidth={1.4} strokeOpacity={0.85}
                    />
                  )}
                  <text x={NAME_W + STATS_W - 6} y={y + 12} fontSize={9.5} fill={PERF_COLORS.axis} textAnchor="end" className="tabular-nums">
                    {fmtMs(t.totalMs)}
                  </text>
                  {/* 展开钮：成员分解清单开关（手风琴单开；全量成员的唯一入口） */}
                  <g data-tool-expand={t.toolName} className="cursor-pointer" onClick={() => expand(t.toolName)}>
                    <title>{isOpen ? "收起成员分解" : "展开成员分解"}</title>
                    <rect x={CHEV_X} y={y + 2} width={18} height={ROW_H - 10} fill="transparent" />
                    <path
                      d="M -3.5 -2.5 L 0 1 L 3.5 -2.5"
                      transform={`translate(${CHEV_X + 9}, ${y + 12}) rotate(${isOpen ? 90 : 0})`}
                      stroke={PERF_COLORS.axis}
                      strokeWidth={1.5}
                      fill="none"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </g>
                </g>
              );
            })}
          </svg>
        </div>
        {/* 成员分解清单（展开态）：全量成员按 Σ 降序 + 比例条 + 搜索框双匹配
            显示名/原始 taskId——大 run 定位特定成员的入口；限高滚动渐隐 */}
        {expandedTool != null &&
          (() => {
            const t = tools.find(x => x.toolName === expandedTool);
            if (t == null) return null;
            const cells = cellsByTool.get(expandedTool) ?? [];
            const q = memberQuery.trim().toLowerCase();
            const filtered = q
              ? cells.filter(
                  c => c.label.toLowerCase().includes(q) || c.taskId.toLowerCase().includes(q),
                )
              : cells;
            const maxCellMs = Math.max(1, ...cells.map(c => c.totalMs));
            const sumMs = cells.reduce((s, c) => s + c.totalMs, 0);
            const onDrill = onOpenSearch
              ? (taskId: string) => onOpenSearch(`tool:${expandedTool} member:${taskId}`)
              : null;
            return (
              <div data-tool-breakdown className="mt-3 rounded-xl border border-foreground/[0.08] bg-muted/30 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold">{expandedTool} · 成员分解</span>
                  {t.isDispatch && (
                    <span className="text-[10px]" style={{ color: DISPATCH_COLOR }}>派发</span>
                  )}
                  {!t.isDispatch && t.isSkillRelated && (
                    <span className="text-[10px]" style={{ color: SKILL_COLOR }}>技能</span>
                  )}
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {filtered.length}/{cells.length} 成员 · Σ {fmtMs(sumMs)}
                  </span>
                  <input
                    data-tool-member-search
                    value={memberQuery}
                    onChange={e => setMemberQuery(e.target.value)}
                    placeholder="搜索成员（显示名 / 原始 ID）"
                    className="ml-auto h-7 w-56 shrink-0 rounded-full border border-foreground/[0.09] bg-muted/40 px-3 text-xs outline-none placeholder:text-muted-foreground/70 focus:border-primary/40 focus:ring-2 focus:ring-primary/15"
                  />
                </div>
                <ScrollFade className="mt-2 max-h-72 overflow-y-auto pr-1" data-tool-member-list>
                  {filtered.map(c => (
                    <button
                      key={c.taskId}
                      data-member-row={`${expandedTool}·${c.taskId}`}
                      onClick={onDrill ? () => onDrill(c.taskId) : undefined}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors",
                        onDrill ? "cursor-pointer hover:bg-foreground/[0.05]" : "cursor-default",
                      )}
                    >
                      <span className="w-36 shrink-0 truncate text-xs font-medium" title={c.taskId}>
                        {c.label}
                      </span>
                      <span
                        className={`w-24 shrink-0 text-[11px] tabular-nums ${c.errors > 0 ? "text-red-600" : "text-muted-foreground"}`}
                      >
                        {`${c.calls} 次${c.errors > 0 ? ` · 错 ${c.errors}` : ""}`}
                      </span>
                      <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-foreground/[0.06]">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${Math.round((c.totalMs / maxCellMs) * 100)}%`,
                            backgroundColor: t.isDispatch ? DISPATCH_COLOR : BAR_COLOR,
                            opacity: t.isDispatch ? 0.6 : 0.72,
                          }}
                        />
                      </div>
                      <span className="w-16 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                        {fmtMs(c.totalMs)}
                      </span>
                    </button>
                  ))}
                  {filtered.length === 0 && (
                    <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">无匹配成员</p>
                  )}
                </ScrollFade>
              </div>
            );
          })()}
        {/* 图例：分位刻度与堆叠读法 */}
        <p className="mt-1.5 text-[10px] text-muted-foreground">
          条 = Σ 执行时长（段 = 前 {STACK_TOP} 成员，灰段 = 其他成员聚合）· 白刻度 p50 · 红刻度 p95（单次调用分位）· 点击行/段 → Turns 搜索直达调用清单 · ▸ 展开成员分解
        </p>
      </CardContent>
    </Card>
  );
}
