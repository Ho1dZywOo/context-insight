"use client";
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Perf 工具耗时卡（Perf「成员 × 工具」双维度的工具侧，纯 SVG——仓库铁律）：
// 一体化行布局——左工具名与调用/错误计数，中 Σ 时长排行条（p50/p95 近秩
// 分位刻度直接落在条上：慢工具一眼可见——平均会撒谎），右 tool × member
// 热力矩阵（行与排行同序对齐；大 run 列收敛 Top-12 +「+N」标注，Context
// 页 Top-K 同门纪律）。四问一屏：哪个工具最吃时间（条长）/ 哪个工具慢
//（p95 刻度靠右）／哪个不可靠（错误计数红字）／谁在用（矩阵列强度）。
// 诚实口径：无计时调用（源缺时间且无 wire）计入 untimed 摘要不进分位；
// Task/agent 派发行灰条带「派发」标（窗口 = 子代理整段执行，不进 Σ 工具
// 执行头部口径）；skill 族元调用行（skill / load_skill / 技能派发型——提示
// 词注入而非可执行工具，isSkillRelated 由采集侧 tool-conventions 单源判
// 定）紫字带「技能」标，悬停解释耗时语义。下钻唯一出口 = Turns 搜索语法
// 深链（工具行 → tool:X，矩阵格 → tool:X member:Y）——Turns 命中索引即调用
// 清单，叙事舞台已渲染工具调用块（参数/结果/错误/时长），零新清单面。

import { useMemo } from "react";
import {
  fmtMs,
  PERF_COLORS,
  perfEntrance,
  PERF_CARD_SM,
} from "@/components/observe/perf-shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { RunToolStats } from "@/lib/observe/collectors/tool-stats";

const BAR_COLOR = "#2563eb";        // 与 Perf 泳道 agent 蓝同源
const DISPATCH_COLOR = "#8c959f";   // 与时间构成「重试等待」灰同源
const SKILL_COLOR = "#8b5cf6";      // 与 Token 构成「推理」紫同源（技能 = 提示词注入，语义相邻）
const ROW_H = 26;
const NAME_W = 210;                 // 工具名 + 调用计数列
const STATS_W = 92;                 // Σ/p95 数字列
const BAR_W = 320;
const MATRIX_PAD = 28;
const CELL_W = 44;
const CELL_H = 18;
const HEAD_H = 34;                  // 矩阵列头（成员显示名，竖排空间）
/** 大 run 矩阵列收敛（Context 页 Top-K 同门纪律）：默认渲染 Σ 工具耗时
 *  Top-12 列 +「+N」诚实标注，行点击 tool:X 仍全成员下钻；小 run 全显 */
const MATRIX_MAX_COLS = 12;

interface MemberAxis {
  taskId: string;
  label: string;
  totalMs: number;
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

  // 成员轴：有工具调用的成员按耗时降序（矩阵列序）；显示名走 Perf 泳道
  // 同源（member.label ?? taskId），列头截断。大 run（成员 > MATRIX_MAX_COLS）
  // 列收敛为 Top-N——其余列不渲染但 API 全量在场（行点击 tool:X 仍全成员下钻）
  const allAxis: MemberAxis[] = useMemo(() => {
    const labelOf = new Map(members.map(m => [m.taskId, m.label ?? null]));
    const totals = new Map<string, number>();
    for (const toolRow of Object.values(stats.matrix)) {
      for (const [taskId, cell] of Object.entries(toolRow)) {
        totals.set(taskId, (totals.get(taskId) ?? 0) + cell.totalMs);
      }
    }
    return stats.members
      .map(taskId => ({ taskId, label: labelOf.get(taskId) ?? taskId, totalMs: totals.get(taskId) ?? 0 }))
      .sort((a, b) => b.totalMs - a.totalMs || a.taskId.localeCompare(b.taskId));
  }, [stats, members]);
  const hiddenMembers = Math.max(0, allAxis.length - MATRIX_MAX_COLS);
  const axis = hiddenMembers > 0 ? allAxis.slice(0, MATRIX_MAX_COLS) : allAxis;

  const maxToolMs = Math.max(1, ...tools.map(t => t.totalMs));
  const matrixLeft = NAME_W + STATS_W + BAR_W + MATRIX_PAD;
  const moreW = hiddenMembers > 0 ? 56 : 0;
  const svgW = matrixLeft + Math.max(axis.length, 1) * CELL_W + moreW + 8;
  const svgH = HEAD_H + tools.length * ROW_H + 6;

  const toolShare = totalNonLlmMs != null && totalNonLlmMs > 0 ? meta.totalToolMs / totalNonLlmMs : null;

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
          <svg width={svgW} height={svgH} className="block" role="img" aria-label="工具耗时排行与成员矩阵">
            {/* 矩阵列头：成员显示名（Perf 泳道同源命名），悬停给全名；大 run
                列收敛（Top-12）后「+N」标注其余成员（行点击仍全成员下钻） */}
            {axis.map((m, i) => {
              const cx = matrixLeft + i * CELL_W;
              return (
                <g key={m.taskId}>
                  <title>{`${m.label} · Σ 工具 ${fmtMs(m.totalMs)}`}</title>
                  <text x={cx + CELL_W / 2} y={14} fontSize={9.5} fill={PERF_COLORS.axis} textAnchor="middle">
                    {m.label.length > 6 ? m.label.slice(0, 5) + "…" : m.label}
                  </text>
                  <line x1={cx} y1={HEAD_H - 6} x2={cx} y2={svgH} stroke={PERF_COLORS.grid} strokeWidth={0.5} />
                </g>
              );
            })}
            {hiddenMembers > 0 && (
              <g data-tool-matrix-more>
                <title>{`矩阵列收敛：只画 Σ 工具耗时 Top-${MATRIX_MAX_COLS} 成员列，其余 ${hiddenMembers} 个成员未展开——点击工具行仍全成员下钻`}</title>
                <text
                  x={matrixLeft + axis.length * CELL_W + 8}
                  y={14}
                  fontSize={9.5}
                  fill={PERF_COLORS.axis}
                  className="tabular-nums"
                >
                  +{hiddenMembers}
                </text>
              </g>
            )}
            {tools.map((t, ri) => {
              const y = HEAD_H + ri * ROW_H;
              const barW = (t.totalMs / maxToolMs) * BAR_W;
              const c = t.isDispatch ? DISPATCH_COLOR : BAR_COLOR;
              const errRate = t.calls > 0 ? t.errors / t.calls : 0;
              const cellTitle = (ms: number, calls: number) =>
                `${t.toolName} · ${calls} 次 · ${fmtMs(ms)}`;
              return (
                <g key={t.toolName} data-tool-row={t.toolName}>
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
                    <text x={NAME_W + STATS_W + BAR_W + 8} y={y + 12} fontSize={9} fill={errRate > 0 ? PERF_COLORS.danger : PERF_COLORS.axis} textAnchor="end">
                      {`${t.calls} 次${t.errors > 0 ? ` · 错 ${t.errors}` : ""}`}
                    </text>
                  </g>
                  {/* Σ 时长条 + p50/p95 近秩分位刻度（刻度时刻 = 该工具单次调用
                      分位，落在 Σ 条内——慢工具刻度靠右即见） */}
                  <rect x={NAME_W + STATS_W} y={y + 3} width={Math.max(barW, t.totalMs > 0 ? 2 : 0)} height={11} rx={2.5} fill={c} fillOpacity={t.isDispatch ? 0.45 : 0.72} />
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
                  {/* tool × member 矩阵格：强度 = 占该行最大格比，错误 > 0 红角标；
                      格点击 = 该工具该成员下钻 */}
                  {axis.map((m, mi) => {
                    const cell = stats.matrix[t.toolName]?.[m.taskId];
                    if (cell == null) return null;
                    const rowMax = Math.max(
                      1,
                      ...axis.map(x => stats.matrix[t.toolName]?.[x.taskId]?.totalMs ?? 0),
                    );
                    const alpha = cell.totalMs > 0 ? 0.12 + 0.68 * (cell.totalMs / rowMax) : 0;
                    const cx = matrixLeft + mi * CELL_W;
                    return (
                      <g
                        key={m.taskId}
                        data-tool-cell={`${t.toolName}·${m.taskId}`}
                        className={onOpenSearch ? "cursor-pointer" : undefined}
                        onClick={onOpenSearch ? () => onOpenSearch(`tool:${t.toolName} member:${m.taskId}`) : undefined}
                      >
                        <title>{`${cellTitle(cell.totalMs, cell.calls)}${cell.errors > 0 ? ` · 错误 ${cell.errors}` : ""}\n点击 → Turns 搜索该成员的调用`}</title>
                        <rect
                          x={cx + 3}
                          y={y + 2}
                          width={CELL_W - 6}
                          height={CELL_H}
                          rx={3}
                          fill={BAR_COLOR}
                          fillOpacity={alpha}
                        />
                        {cell.totalMs > 0 && (
                          <text x={cx + CELL_W / 2} y={y + 14} fontSize={8} fill={PERF_COLORS.axis} textAnchor="middle" className="tabular-nums">
                            {fmtMs(cell.totalMs)}
                          </text>
                        )}
                        {cell.errors > 0 && (
                          <circle cx={cx + CELL_W - 7} cy={y + 6} r={3} fill={PERF_COLORS.danger}>
                            <title>{`错误 ${cell.errors}`}</title>
                          </circle>
                        )}
                      </g>
                    );
                  })}
                </g>
              );
            })}
          </svg>
        </div>
        {/* 图例：分位刻度读法 */}
        <p className="mt-1.5 text-[10px] text-muted-foreground">
          条 = Σ 执行时长 · 白刻度 p50 · 红刻度 p95（单次调用分位）· 右矩阵 = 工具 × 成员（格内 Σ，红点 = 有错误，大 run 列收敛 Top-{MATRIX_MAX_COLS}）· 点击行/格 → Turns 搜索直达调用清单
        </p>
      </CardContent>
    </Card>
  );
}
