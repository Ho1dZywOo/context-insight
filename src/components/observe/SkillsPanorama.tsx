"use client";
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Run Skills 全景（双维度 × 四卡）。维度 = 观测种群：「技能」（invoke/use
// 的 SKILL.md 调用）与「派发」（子代理 dispatch——claude 真值事件 + run 成员
// 首 turn 推导，collector 双源合一）；各自同构四卡（画像 → 时间线 → 热点
// 排行 → 选中明细），同屏单一种群、口径不混。成员归因收纳进行内计数，明细
// 卡逐条披露（不铺徽标墙）。配色一主一语义：技能蓝 / 派发紫 / 失败红。

import { useMemo, useState } from "react";
import { BookOpenIcon, ArrowUpRightIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import {
  perfEntrance,
  PERF_CARD_CLS,
  PERF_CARD_SM,
  fmtTok,
  svgViewX,
  PerfSegmented,
} from "@/components/observe/perf-shared";
import { useSkillContent } from "@/components/observe/use-skill-content";
import { SkillCoverageCard } from "@/components/observe/SkillCoverageCard";
import { runMemberUrlFor } from "@/lib/observe/member-url";
import type { MouseEvent as ReactMouseEvent } from "react";

export interface SkillsSkillItem {
  skillName: string;
  version: number | null;
  invocationCount: number;
  /** 使用成员标签（collector 归因；本页只用于计数，名字进明细） */
  members?: string[];
}

export interface SkillsEventItem {
  id: string;
  skillName: string;
  skillVersion: number | null;
  eventType: string;
  success: boolean;
  errorMessage: string | null;
  durationMs: number;
  turnIndex: number;
  /** 事件所属 turn（跳转闭环；旧载荷缺省为 undefined——不渲染跳转） */
  turnId?: string;
  /** turn 时间（createdAt_ts 回退 createdAt；缺失为 null——时间轴按事件序回落） */
  turnCreatedAt?: string | null;
  agentName: string | null;
  isSubagent: boolean;
  subagentSessionId: string | null;
  turnTokens: {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  member: { taskId: string; label: string | null } | null;
}

export interface SkillsDispatchItem {
  id: string;
  /** 子代理基名（事件=skillName；推导=图结构 nodeId[·验收]） */
  name: string;
  turnId: string;
  at: string | null;
  /** 验收角色（推导路径） */
  verify: boolean;
  member: { taskId: string; label: string | null; framework: string | null } | null;
  /** 子代理会话 token 合计（null = 会话未入库） */
  tokens?: number | null;
  source: "event" | "member";
}

export interface SkillsPanoramaData {
  skills: SkillsSkillItem[];
  events: SkillsEventItem[];
  /** 派发种群（collector 双源合一；旧载荷缺省为无派发观测） */
  dispatches?: SkillsDispatchItem[];
  total: number;
}

/** 覆盖度卡的作用域成员（页面外壳从 run 视图模型传入） */
export interface SkillsMemberRef {
  taskId: string;
  framework: string;
  displayName: string | null;
}

// ── 配色：一主一语义（技能绿 / 派发紫 / 失败红），构成段条用主色渐层 + 灰阶 ──
const SKILL_ACCENT = "#10b981";
const DISPATCH_ACCENT = "#7c3aeb";
const DOT_FAIL = "#dc2626";
const COMP_COLORS = {
  invoke: SKILL_ACCENT,
  use: "#6ee7b7",
  load: "#64748b",
  unload: "#94a3b8",
  execute: DISPATCH_ACCENT,
  verify: "#a78bfa",
} as const;

// 排行/明细双列同构：同高卡身 + 头部固定 + 内部滚动（滚动窗口与滚动条对齐）
const PANEL_BODY_CLS = "flex h-[468px] flex-col";

// ── 时间线几何（viewBox 单位；svg 宽 100% + meet 居中，像素映射走 svgViewX） ──
const TL_W = 720;
const TL_PAD_L = 148;
const TL_PAD_R = 14;
const TL_PAD_T = 16;
const TL_PAD_B = 24;
const LANE_PITCH = 22;
const LANE_CAP = 18;
const TL_CW = TL_W - TL_PAD_L - TL_PAD_R;

/** 时间轴刻度与明细行的时间读数（run 内时刻，不带日期） */
function fmtClock(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ── 维度视图模型（两种群各自聚合，渲染路径同构） ──

interface ChartDotVm {
  id: string;
  name: string;
  at: string | null;
  ord: number;
  fail: boolean;
  turnId?: string;
  tip1: string;
  tip2: string;
}

interface TileVm {
  stat: string;
  label: string;
  value: string;
  danger?: boolean;
}

interface CompSegVm {
  key: keyof typeof COMP_COLORS;
  label: string;
  n: number;
}

interface SkillAgg {
  name: string;
  version: number | null;
  events: SkillsEventItem[];
  failCount: number;
  memberCount: number;
  totalTokens: number;
  /** 无事件的 SessionSkill 行（罕见）：计数回退 invocationCount */
  invocationCount: number;
}

interface DispatchAgg {
  name: string;
  items: SkillsDispatchItem[];
  verifyCount: number;
  memberCount: number;
  /** 已入库子代理会话的 token 合计（未入库不计入） */
  totalTokens: number;
}

function aggregate(data: SkillsPanoramaData): SkillAgg[] {
  const byName = new Map<string, SkillAgg>();
  const touch = (name: string, version: number | null): SkillAgg => {
    let a = byName.get(name);
    if (!a) {
      a = {
        name, version, events: [], failCount: 0, memberCount: 0,
        totalTokens: 0, invocationCount: 0,
      };
      byName.set(name, a);
    }
    return a;
  };
  for (const s of data.skills) {
    const a = touch(s.skillName, s.version);
    a.invocationCount = Math.max(a.invocationCount, s.invocationCount);
    if (s.version != null && (a.version == null || s.version > a.version)) a.version = s.version;
  }
  const membersByName = new Map<string, Set<string>>();
  for (const e of data.events) {
    const a = touch(e.skillName, e.skillVersion);
    a.events.push(e);
    if (!e.success) a.failCount += 1;
    a.totalTokens += e.turnTokens.totalTokens;
    if (e.member?.taskId) {
      const set = membersByName.get(e.skillName) ?? new Set<string>();
      set.add(e.member.taskId);
      membersByName.set(e.skillName, set);
    }
  }
  for (const a of byName.values()) a.memberCount = membersByName.get(a.name)?.size ?? 0;
  return [...byName.values()].sort(
    (a, b) => b.events.length - a.events.length || b.invocationCount - a.invocationCount || a.name.localeCompare(b.name),
  );
}

function aggregateDispatches(list: SkillsDispatchItem[]): DispatchAgg[] {
  const byName = new Map<string, DispatchAgg>();
  const membersByName = new Map<string, Set<string>>();
  for (const d of list) {
    let a = byName.get(d.name);
    if (!a) {
      a = { name: d.name, items: [], verifyCount: 0, memberCount: 0, totalTokens: 0 };
      byName.set(d.name, a);
    }
    a.items.push(d);
    if (d.verify) a.verifyCount += 1;
    if (d.tokens != null) a.totalTokens += d.tokens;
    if (d.member?.taskId) {
      const set = membersByName.get(d.name) ?? new Set<string>();
      set.add(d.member.taskId);
      membersByName.set(d.name, set);
    }
  }
  for (const a of byName.values()) a.memberCount = membersByName.get(a.name)?.size ?? 0;
  return [...byName.values()].sort(
    (a, b) => b.items.length - a.items.length || a.name.localeCompare(b.name),
  );
}

/** 泳道：按点数排序取前 cap 条，余量并入「其他」行 */
function lanesOf(dots: ChartDotVm[], cap: number): { label: string; dots: ChartDotVm[] }[] {
  const byName = new Map<string, ChartDotVm[]>();
  for (const d of dots) {
    const list = byName.get(d.name) ?? [];
    list.push(d);
    byName.set(d.name, list);
  }
  const rows = [...byName.entries()]
    .map(([label, list]) => ({ label, list }))
    .sort((a, b) => b.list.length - a.list.length || a.label.localeCompare(b.label));
  const capped = rows.slice(0, cap);
  const rest = rows.slice(cap);
  const lanes = capped.map(r => ({ label: r.label, dots: r.list }));
  if (rest.length > 0) lanes.push({ label: `其他 ${rest.length} 项`, dots: rest.flatMap(r => r.list) });
  return lanes;
}

// ── 时间线轴模型（位置编码与刻度由「显示粒度上的跨度」单一决策） ──────────────
// 三态：time（起止跨秒、显示上可分辨 → 位置=真实时刻比例，刻度起中末按标签
// 去重——同文刻度是纯噪声）；instant（全部事件落在同一显示秒 → 毫秒差不足
// 以支撑比例编码，位置退化为事件序几何、刻度收拢为一枚居中时刻）；ordinal
// （时间戳缺失 → 事件序，轴不撒谎）。单点会话必然落 instant：一枚时刻刻度。

interface TimelineTick {
  at: number;
  label: string;
  anchor: "start" | "middle" | "end";
}

interface TimelineAxis {
  mode: "time" | "instant" | "ordinal";
  xOf: (d: ChartDotVm) => number;
  ticks: TimelineTick[];
}

function axisOf(dots: ChartDotVm[]): TimelineAxis {
  const n = dots.length;
  const ordX = (d: ChartDotVm) => TL_PAD_L + (n > 1 ? (d.ord / (n - 1)) * TL_CW : TL_CW / 2);
  if (n === 0 || !dots.every(d => d.at != null)) {
    return {
      mode: "ordinal",
      xOf: ordX,
      ticks: [
        { at: TL_PAD_L, label: "事件序 起点", anchor: "start" },
        { at: TL_PAD_L + TL_CW, label: "终点", anchor: "end" },
      ],
    };
  }
  const ts = dots.map(d => new Date(d.at!).getTime());
  const tMin = Math.min(...ts);
  const tMax = Math.max(...ts);
  const labelOf = (t: number) => fmtClock(new Date(t).toISOString());
  if (labelOf(tMin) === labelOf(tMax)) {
    return {
      mode: "instant",
      xOf: ordX,
      ticks: [{ at: TL_PAD_L + TL_CW / 2, label: labelOf(tMin), anchor: "middle" }],
    };
  }
  const timeX = (d: ChartDotVm) => TL_PAD_L + ((new Date(d.at!).getTime() - tMin) / (tMax - tMin)) * TL_CW;
  const marks = [
    { t: tMin, anchor: "start" },
    { t: (tMin + tMax) / 2, anchor: "middle" },
    { t: tMax, anchor: "end" },
  ] as const;
  const ticks: TimelineTick[] = [];
  for (const m of marks) {
    const label = labelOf(m.t);
    if (ticks.some(k => k.label === label)) continue;
    ticks.push({ at: TL_PAD_L + ((m.t - tMin) / (tMax - tMin)) * TL_CW, label, anchor: m.anchor });
  }
  return { mode: "time", xOf: timeX, ticks };
}

// ── 时间线卡（维度无关：泳道 × run 时间 / 事件序，点按落 turn 现场） ──

function TimelineCard({ title, chartKind, lanes, accent, onOpenTurn }: {
  title: string;
  chartKind: "calls" | "dispatch";
  lanes: { label: string; dots: ChartDotVm[] }[];
  accent: string;
  onOpenTurn: (turnId: string) => void;
}) {
  const [hover, setHover] = useState<{ x: number; li: number; dot: ChartDotVm } | null>(null);

  const dots = useMemo(() => lanes.flatMap(l => l.dots), [lanes]);
  const laneIndexByDot = useMemo(() => {
    const m = new Map<string, number>();
    lanes.forEach((l, i) => l.dots.forEach(d => m.set(d.id, i)));
    return m;
  }, [lanes]);
  const tl = useMemo(() => axisOf(dots), [dots]);

  const laneY = (i: number) => TL_PAD_T + i * LANE_PITCH + LANE_PITCH / 2;
  const tlH = TL_PAD_T + TL_PAD_B + Math.max(1, lanes.length) * LANE_PITCH;

  const onMove = (e: ReactMouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const vx = svgViewX(rect, e.clientX, TL_W, tlH);
    if (vx < TL_PAD_L - 2 || vx > TL_W - TL_PAD_R + 2 || dots.length === 0) {
      setHover(null);
      return;
    }
    let best: { d: number; dot: ChartDotVm } | null = null;
    for (const dot of dots) {
      const d = Math.abs(tl.xOf(dot) - vx);
      if (!best || d < best.d) best = { d, dot };
    }
    setHover(best ? { x: Math.round(tl.xOf(best.dot)), li: laneIndexByDot.get(best.dot.id) ?? 0, dot: best.dot } : null);
  };

  return (
    <Card size="sm" {...perfEntrance(75, cn(PERF_CARD_CLS, "bg-card", "h-full"))}>
      <CardContent className="flex flex-1 flex-col">
        <div className="mb-2 flex shrink-0 items-baseline justify-between">
          <p className="text-[13px] font-semibold text-foreground/90">{title}</p>
          <p className="text-[11px] text-muted-foreground">
            {tl.mode === "time" ? "run 时刻" : tl.mode === "instant" ? "run 时刻（同一秒内）" : "事件序（时间戳缺失）"}
            {" · "}共 {dots.length} 次
          </p>
        </div>
        <div className="relative flex min-h-0 flex-1 items-center">
          <svg
            data-skill-timeline
            data-dim={chartKind}
            viewBox={`0 0 ${TL_W} ${tlH}`}
            width="100%"
            height={tlH}
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
            className="block select-none"
          >
            {/* 泳道标签 + 发丝分隔 */}
            {lanes.map((l, i) => (
              <g key={l.label}>
                {i > 0 && <line x1={TL_PAD_L - 8} y1={TL_PAD_T + i * LANE_PITCH} x2={TL_W - TL_PAD_R} y2={TL_PAD_T + i * LANE_PITCH} stroke="#eef1f4" strokeWidth={1} />}
                <text x={TL_PAD_L - 10} y={laneY(i) + 3} textAnchor="end" fontSize="10" className="fill-muted-foreground">
                  {l.label.length > 22 ? l.label.slice(0, 21) + "…" : l.label}
                </text>
              </g>
            ))}
            {/* 图区底 + 轴刻度 */}
            <line x1={TL_PAD_L} y1={TL_PAD_T} x2={TL_PAD_L} y2={tlH - TL_PAD_B} stroke="#e2e8f0" strokeWidth={1} />
            {tl.ticks.map((t, i) => (
              <text
                key={i}
                data-skill-tick
                x={t.at}
                y={tlH - 6}
                textAnchor={t.anchor}
                fontSize="8.5"
                className="fill-muted-foreground tabular-nums"
              >
                {t.label}
              </text>
            ))}
            {/* 调用点：主色 / 失败红；点击落 turn 现场 */}
            {lanes.map((l, i) =>
              l.dots.map(dot => (
                <circle
                  key={dot.id}
                  data-skill-dot={dot.name}
                  cx={tl.xOf(dot)}
                  cy={laneY(i)}
                  r={3}
                  fill={dot.fail ? DOT_FAIL : accent}
                  opacity={0.9}
                  className={dot.turnId ? "cursor-pointer" : undefined}
                  onClick={() => { if (dot.turnId) onOpenTurn(dot.turnId) }}
                />
              )),
            )}
            {/* 悬停：十字线 + 焦点圈 + 读数气泡（SVG 内定位，不随缩放错位） */}
            {hover && (() => {
              const { x, li, dot } = hover;
              const w = Math.max(dot.tip1.length, dot.tip2.length) * 5.6 + 16;
              const bx = Math.max(TL_PAD_L, Math.min(TL_W - TL_PAD_R - w, x - w / 2));
              const by = Math.max(2, laneY(li) - 40);
              return (
                <g pointerEvents="none" className="animate-in fade-in duration-150">
                  <line x1={x} y1={TL_PAD_T} x2={x} y2={tlH - TL_PAD_B} stroke="#94a3b8" strokeWidth={0.75} strokeDasharray="3 3" opacity={0.55} />
                  <circle cx={x} cy={laneY(li)} r={6} fill={dot.fail ? DOT_FAIL : accent} opacity={0.16} />
                  <rect x={bx} y={by} width={w} height={30} rx={8} className="fill-card" stroke="#94a3b8" strokeOpacity={0.4} strokeWidth={1} />
                  <text x={bx + w / 2} y={by + 12} textAnchor="middle" fontSize="8.5" className="fill-muted-foreground">{dot.tip1}</text>
                  <text x={bx + w / 2} y={by + 24} textAnchor="middle" fontSize="9.5" fontWeight={600} className="fill-foreground tabular-nums">{dot.tip2}</text>
                </g>
              );
            })()}
          </svg>
        </div>
      </CardContent>
    </Card>
  );
}

// ── 画像瓦片行 + 构成段条（两维度共用渲染） ──

function PortraitTiles({ tiles, comp, total }: {
  tiles: TileVm[];
  comp: CompSegVm[];
  total: number;
}) {
  return (
    <CardContent className="flex flex-wrap items-center gap-x-8 gap-y-4">
      <div className="flex flex-wrap items-end gap-x-8 gap-y-4">
        {tiles.map(t => (
          <div key={t.label} data-stat={t.stat} className="min-w-0">
            <p className="text-[11px] text-muted-foreground">{t.label}</p>
            <p className={cn("truncate text-[22px] font-semibold leading-7 tabular-nums", t.danger && "text-red-600 dark:text-red-400")} title={t.value}>
              {t.value}
            </p>
          </div>
        ))}
      </div>
      <span className="hidden h-10 w-px bg-foreground/[0.08] sm:block" />
      {/* 构成：主色渐层段条 + 图例 */}
      <div className="min-w-[180px] flex-1">
        <p className="text-[11px] text-muted-foreground">构成</p>
        <div className="mt-1.5 flex h-1.5 w-full overflow-hidden rounded-full bg-foreground/[0.06]">
          {comp.map(s => (
            <span key={s.key} style={{ width: `${(s.n / Math.max(1, total)) * 100}%`, background: COMP_COLORS[s.key] }} />
          ))}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
          {comp.map(s => (
            <span key={s.key} className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
              <span className="size-1.5 rounded-full" style={{ background: COMP_COLORS[s.key] }} />
              {s.label} <span className="tabular-nums">{s.n}</span>
            </span>
          ))}
        </div>
      </div>
    </CardContent>
  );
}

// ── 覆盖度卡（与时间线同排双列、等高）：有声明未调用的可见性。成员域视图
// ——solo/单成员自动定向，多成员 run 内联选成员；口径随维度拆分（skills/agents）──

function CoverageSection({ runId, members, scope }: {
  runId: string;
  members: SkillsMemberRef[];
  scope: "skills" | "agents";
}) {
  const [memberTaskId, setMemberTaskId] = useState(members[0]?.taskId ?? "");
  // 派生收进 memo、依赖只认稳定源（members/memberTaskId），不给编译器留可变别名
  const urlFor = useMemo(() => {
    const m = members.find(x => x.taskId === memberTaskId) ?? members[0];
    return m ? runMemberUrlFor(runId, m.taskId) : undefined;
  }, [runId, members, memberTaskId]);
  const member = members.find(x => x.taskId === memberTaskId) ?? members[0] ?? null;

  if (!member) return null;
  return (
    <div {...perfEntrance(150, "h-full")}>
      <SkillCoverageCard
        taskId={member.taskId}
        framework={member.framework}
        urlFor={urlFor}
        scope={scope}
        className={cn(PERF_CARD_CLS, "h-full")}
        toolbar={members.length > 1 ? (
          <select
            aria-label="覆盖度成员"
            value={member.taskId}
            onChange={e => setMemberTaskId(e.target.value)}
            className="ml-auto max-w-[240px] cursor-pointer rounded-md border border-foreground/15 bg-card px-1.5 py-0.5 text-[11px] text-foreground/80 outline-none transition-colors hover:border-foreground/25"
          >
            {members.map(m => (
              <option key={m.taskId} value={m.taskId}>{m.displayName || m.taskId}</option>
            ))}
          </select>
        ) : undefined}
      />
    </div>
  );
}

export function SkillsPanorama({ runId, data, members, onOpenTurn }: {
  runId: string;
  data: SkillsPanoramaData;
  /** 覆盖度成员域（页面外壳传入；缺省无覆盖卡） */
  members?: SkillsMemberRef[];
  onOpenTurn: (turnId: string) => void;
}) {
  const dispatches = useMemo(() => data.dispatches ?? [], [data.dispatches]);
  const [dim, setDim] = useState<"skills" | "dispatch">("skills");
  const [selected, setSelected] = useState<string | null>(null);

  const aggs = useMemo(() => aggregate(data), [data]);
  const dispatchAggs = useMemo(() => aggregateDispatches(dispatches), [dispatches]);
  const withEvents = useMemo(() => aggs.filter(a => a.events.length > 0), [aggs]);

  // ── 技能维视图模型 ──
  const failTotal = useMemo(() => data.events.filter(e => !e.success).length, [data.events]);
  const typeCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of data.events) m.set(e.eventType, (m.get(e.eventType) ?? 0) + 1);
    return m;
  }, [data.events]);
  const skillDots = useMemo(() => data.events.map((e, i) => ({
    id: e.id,
    name: e.skillName,
    at: e.turnCreatedAt ?? null,
    ord: i,
    fail: !e.success,
    turnId: e.turnId,
    tip1: `${e.skillName}${e.eventType !== "invoke" ? ` · ${e.eventType}` : ""}`,
    tip2: `${e.member?.label ?? "—"} · ${e.turnCreatedAt ? fmtClock(e.turnCreatedAt) : `#${e.turnIndex}`} · ${fmtTok(e.turnTokens.totalTokens)} tok`,
  })), [data.events]);

  // ── 派发维视图模型 ──
  const verifyTotal = useMemo(() => dispatches.filter(d => d.verify).length, [dispatches]);
  const dispatchDots = useMemo(() => dispatches.map((d, i) => ({
    id: d.id,
    name: d.name,
    at: d.at,
    ord: i,
    fail: false,
    turnId: d.turnId,
    tip1: d.name,
    tip2: `${d.member?.label ?? "—"} · ${d.at ? fmtClock(d.at) : `#${i + 1}`}`,
  })), [dispatches]);

  const skillLanes = useMemo(() => lanesOf(skillDots, LANE_CAP), [skillDots]);
  const dispatchLanes = useMemo(() => lanesOf(dispatchDots, LANE_CAP), [dispatchDots]);

  // ── 明细：全文端点的成员定向（技能=首个归因成员；派发=首个派发成员）。
  // 派生收进 memo、依赖只认稳定源，不给编译器留可变别名 ──
  const urlFor = useMemo(() => {
    if (dim === "skills") {
      const agg = aggs.find(a => a.name === selected);
      const taskId = agg?.events.find(e => e.member?.taskId)?.member?.taskId;
      return taskId ? runMemberUrlFor(runId, taskId) : undefined;
    }
    const agg = dispatchAggs.find(a => a.name === selected);
    const taskId = agg?.items.find(i => i.member?.taskId)?.member?.taskId;
    return taskId ? runMemberUrlFor(runId, taskId) : undefined;
  }, [runId, aggs, dispatchAggs, selected, dim]);
  const selAgg = dim === "skills" ? aggs.find(a => a.name === selected) ?? null : null;
  const selDispatchAgg = dim === "dispatch" ? dispatchAggs.find(a => a.name === selected) ?? null : null;
  const selMemberTaskId = dim === "skills"
    ? selAgg?.events.find(e => e.member?.taskId)?.member?.taskId ?? null
    : selDispatchAgg?.items.find(i => i.member?.taskId)?.member?.taskId ?? null;
  const sc = useSkillContent(selMemberTaskId ?? "", urlFor);

  const topSkill = withEvents[0] ?? aggs[0] ?? null;
  const topDispatch = dispatchAggs[0] ?? null;
  const maxSkillCount = Math.max(1, ...aggs.map(a => Math.max(a.events.length, a.invocationCount)));
  const maxDispatchCount = Math.max(1, ...dispatchAggs.map(a => a.items.length));

  if (aggs.length === 0 && dispatches.length === 0) {
    return (
      <Card size="sm" className={cn(PERF_CARD_SM, "bg-card")}>
        <CardContent className="flex flex-col items-center justify-center gap-2 py-16 text-center">
          <span className="text-sm font-medium text-foreground/80">该 run 无技能使用与派发记录</span>
          <span className="text-xs text-muted-foreground">技能在成员会话中被调用、子代理被派发后，这里会给出画像、时间线与热点。</span>
        </CardContent>
      </Card>
    );
  }

  const dimEmpty = dim === "skills" ? aggs.length === 0 : dispatches.length === 0;

  const skillTiles: TileVm[] = [
    { stat: "skills", label: "技能", value: String(aggs.length) },
    { stat: "calls", label: "调用", value: String(data.events.length) },
    { stat: "fails", label: "失败", value: String(failTotal), danger: failTotal > 0 },
    {
      stat: "top",
      label: "峰值技能",
      value: topSkill ? (topSkill.events.length > 0 ? `${topSkill.name} · ${topSkill.events.length}` : `${topSkill.name} · ${topSkill.invocationCount}`) : "—",
    },
  ];
  const dispatchTiles: TileVm[] = [
    { stat: "dispatches", label: "派发", value: String(dispatches.length) },
    { stat: "agents", label: "子代理", value: String(dispatchAggs.length) },
    { stat: "verify", label: "验收", value: String(verifyTotal) },
    {
      stat: "top",
      label: "峰值子代理",
      value: topDispatch ? `${topDispatch.name} · ${topDispatch.items.length}` : "—",
    },
  ];
  const skillComp: CompSegVm[] = (["invoke", "use", "load", "unload"] as const)
    .map((k): CompSegVm => ({ key: k, label: k, n: typeCounts.get(k) ?? 0 }))
    .filter(s => s.n > 0);
  const dispatchCompAll: CompSegVm[] = [
    { key: "execute", label: "正式", n: dispatches.length - verifyTotal },
    { key: "verify", label: "验收", n: verifyTotal },
  ];
  const dispatchComp = dispatchCompAll.filter(s => s.n > 0);

  return (
    <div className="flex flex-col gap-4">
      {/* 维度切换：两种群互斥（无派发数据时隐藏——solo 常态只见技能） */}
      {dispatches.length > 0 && (
        <div {...perfEntrance(0, "flex justify-end")}>
          <PerfSegmented
            value={dim}
            options={[{ value: "skills", label: "技能" }, { value: "dispatch", label: "派发" }]}
            onChange={v => { setDim(v); setSelected(null) }}
            ariaLabel="观测维度"
          />
        </div>
      )}

      {dimEmpty ? (
        <Card size="sm" {...perfEntrance(0, cn(PERF_CARD_SM, "bg-card"))}>
          <CardContent className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <span className="text-sm font-medium text-foreground/80">
              {dim === "skills" ? "该 run 无技能使用记录" : "该 run 无子代理派发记录"}
            </span>
            <span className="text-xs text-muted-foreground">
              {dim === "skills" ? "技能在成员会话中被调用后，这里会给出画像、时间线与热点。" : "子代理被派发后，这里会给出派发画像、时间线与热点。"}
            </span>
          </CardContent>
        </Card>
      ) : (
        <div key={dim} className="flex flex-col gap-4">
          {/* ① 画像：总量瓦片 + 构成 */}
          <Card size="sm" {...perfEntrance(0, cn(PERF_CARD_CLS, "bg-card"))}>
            {dim === "skills"
              ? <PortraitTiles tiles={skillTiles} comp={skillComp} total={data.events.length} />
              : <PortraitTiles tiles={dispatchTiles} comp={dispatchComp} total={dispatches.length} />}
          </Card>

          {/* ② 调用/派发时间线 ｜ ⑤ 覆盖度（两维各自同排双列、等高对齐——半宽
              时间线填实图区；覆盖度按维拆分：技能维只看 skills，派发维只看
              派发的子代理；无成员域时时间线整宽） */}
          {members && members.length > 0 ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {dim === "skills"
                ? <TimelineCard title="调用时间线" chartKind="calls" lanes={skillLanes} accent={SKILL_ACCENT} onOpenTurn={onOpenTurn} />
                : <TimelineCard title="派发时间线" chartKind="dispatch" lanes={dispatchLanes} accent={DISPATCH_ACCENT} onOpenTurn={onOpenTurn} />}
              <CoverageSection runId={runId} members={members} scope={dim === "skills" ? "skills" : "agents"} />
            </div>
          ) : dim === "skills" ? (
            <TimelineCard title="调用时间线" chartKind="calls" lanes={skillLanes} accent={SKILL_ACCENT} onOpenTurn={onOpenTurn} />
          ) : (
            <TimelineCard title="派发时间线" chartKind="dispatch" lanes={dispatchLanes} accent={DISPATCH_ACCENT} onOpenTurn={onOpenTurn} />
          )}

          {/* ③ 热点排行 + ④ 选中明细（同排双列，lg 以下纵叠） */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card size="sm" {...perfEntrance(225, cn(PERF_CARD_CLS, "bg-card"))}>
              <CardContent className={PANEL_BODY_CLS} data-panel="rank">
                <div className="mb-1 flex shrink-0 items-baseline justify-between">
                  <p className="text-[13px] font-semibold text-foreground/90">{dim === "skills" ? "热点排行" : "派发排行"}</p>
                  <p className="text-[11px] text-muted-foreground">{dim === "skills" ? "按调用量" : "按派发次数"}</p>
                </div>
                <div className="min-h-0 flex-1 divide-y divide-foreground/[0.05] overflow-y-auto">
                  {dim === "skills" ? aggs.map((a, i) => {
                    const count = a.events.length > 0 ? a.events.length : a.invocationCount;
                    return (
                      <button
                        key={a.name}
                        type="button"
                        data-skill-row={a.name}
                        onClick={() => setSelected(cur => (cur === a.name ? null : a.name))}
                        className={cn(
                          "flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-1.5 py-2 text-left transition-colors",
                          selected === a.name ? "bg-primary/[0.06]" : "hover:bg-foreground/[0.03]",
                        )}
                      >
                        <span className="w-5 shrink-0 text-right text-[11px] text-muted-foreground/70 tabular-nums">{i + 1}</span>
                        <span className="w-[38%] shrink-0 truncate text-xs font-medium text-foreground/90" title={a.name}>{a.name}</span>
                        <span className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-foreground/[0.05]">
                          <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${(count / maxSkillCount) * 100}%`, background: SKILL_ACCENT }} />
                          {a.failCount > 0 && <span className="absolute inset-y-0 left-0 rounded-full bg-red-500" style={{ width: `${(a.failCount / maxSkillCount) * 100}%` }} />}
                        </span>
                        <span className="w-8 shrink-0 text-right text-xs font-semibold tabular-nums">{count}</span>
                        <span
                          className="w-14 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums"
                          title={a.events.length > 0 ? `${a.memberCount} 个成员会话调用该技能` : "仅会话聚合，无事件级记录"}
                        >
                          {a.events.length > 0 ? `${a.memberCount} 成员` : "—"}
                        </span>
                        <span className="w-12 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums" title="调用 turn 的 token 合计">
                          {a.events.length > 0 ? fmtTok(a.totalTokens) : "—"}
                        </span>
                      </button>
                    );
                  }) : dispatchAggs.map((a, i) => (
                    <button
                      key={a.name}
                      type="button"
                      data-skill-row={a.name}
                      onClick={() => setSelected(cur => (cur === a.name ? null : a.name))}
                      className={cn(
                        "flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-1.5 py-2 text-left transition-colors",
                        selected === a.name ? "bg-primary/[0.06]" : "hover:bg-foreground/[0.03]",
                      )}
                    >
                      <span className="w-5 shrink-0 text-right text-[11px] text-muted-foreground/70 tabular-nums">{i + 1}</span>
                      <span className="w-[42%] shrink-0 truncate text-xs font-medium text-foreground/90" title={a.name}>{a.name}</span>
                      <span className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-foreground/[0.05]">
                        <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${(a.items.length / maxDispatchCount) * 100}%`, background: DISPATCH_ACCENT }} />
                        {a.verifyCount > 0 && (
                          <span
                            data-verify-seg
                            className="absolute inset-y-0 left-0 rounded-full"
                            style={{ width: `${(a.verifyCount / maxDispatchCount) * 100}%`, background: "#a78bfa" }}
                            title={`验收角色 ${a.verifyCount} 次`}
                          />
                        )}
                      </span>
                      <span className="w-8 shrink-0 text-right text-xs font-semibold tabular-nums">{a.items.length}</span>
                      <span
                        className="w-14 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums"
                        title={`${a.memberCount} 个成员会话涉及该子代理的派发`}
                      >
                        {a.memberCount} 成员
                      </span>
                      <span
                        className="w-12 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums"
                        title="子代理会话 token 合计（未入库会话不计）"
                      >
                        {a.totalTokens > 0 ? fmtTok(a.totalTokens) : "—"}
                      </span>
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card size="sm" {...perfEntrance(300, cn(PERF_CARD_CLS, "bg-card"))}>
              <CardContent className={PANEL_BODY_CLS} data-panel="detail">
                {!selAgg && !selDispatchAgg ? (
                  <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
                    <span className="text-sm font-medium text-foreground/80">
                      {dim === "skills" ? "选择技能查看调用明细" : "选择子代理查看派发明细"}
                    </span>
                    <span className="max-w-[260px] text-xs leading-relaxed text-muted-foreground">
                      {dim === "skills"
                        ? "点击排行行，展开该技能的逐次调用（时刻 · 成员 · 结果 · token），并可跳转 turn 现场。"
                        : "点击排行行，展开该子代理的逐次派发（时刻 · 成员归因），可查看声明原文并跳转 turn 现场。"}
                    </span>
                  </div>
                ) : selAgg ? (
                  <div className="flex min-h-0 flex-1 flex-col">
                    <div className="flex shrink-0 items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-[13px] font-semibold text-foreground/90" title={selAgg.name}>{selAgg.name}</p>
                          {selAgg.version != null && <span className="shrink-0 rounded border border-foreground/10 px-1 text-[10px] leading-4 text-muted-foreground">v{selAgg.version}</span>}
                          {selAgg.failCount > 0 && <span className="shrink-0 rounded bg-red-500/10 px-1.5 text-[10px] leading-4 font-semibold text-red-600 dark:text-red-400 tabular-nums">失败 {selAgg.failCount}</span>}
                        </div>
                        <p className="mt-0.5 text-[11px] text-muted-foreground tabular-nums" title="成员 = 调用该技能的成员会话（工作流 run 内即各子代理会话）">
                          {selAgg.events.length > 0
                            ? `${selAgg.events.length} 次调用 · ${selAgg.memberCount} 成员 · Σ ${fmtTok(selAgg.totalTokens)} tok`
                            : `${selAgg.invocationCount} 次调用（会话聚合，无事件级记录）`}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {selMemberTaskId && (
                          <span
                            role="button"
                            tabIndex={0}
                            title="查看 SKILL.md 全文（按首个归因成员的会话注入内容）"
                            className={cn(
                              "inline-flex cursor-pointer items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-semibold transition-colors",
                              sc.content.has(selAgg.name) || sc.error.has(selAgg.name)
                                ? "border-emerald-600 bg-emerald-600/15 text-emerald-700 dark:text-emerald-200"
                                : "border-emerald-600/50 bg-emerald-600/10 text-emerald-600 dark:text-emerald-300 hover:bg-emerald-600/20",
                              sc.loading.has(selAgg.name) && "animate-pulse",
                            )}
                            onClick={() => {
                              if (sc.content.has(selAgg.name) || sc.error.has(selAgg.name)) sc.clear(selAgg.name);
                              else if (!sc.loading.has(selAgg.name)) sc.fetchOne(selAgg.name);
                            }}
                            onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { if (sc.content.has(selAgg.name)) sc.clear(selAgg.name); else if (!sc.loading.has(selAgg.name)) sc.fetchOne(selAgg.name); } }}
                          >
                            <BookOpenIcon className="size-3" />
                            {sc.loading.has(selAgg.name) ? "加载中…" : sc.content.has(selAgg.name) ? "收起" : "全文"}
                          </span>
                        )}
                        <button
                          type="button"
                          title="收起明细"
                          onClick={() => setSelected(null)}
                          className="cursor-pointer rounded p-1 text-muted-foreground/60 transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
                        >
                          <XIcon className="size-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* SKILL.md 全文（成员会话注入内容） */}
                    {(sc.content.has(selAgg.name) || sc.error.has(selAgg.name)) && (
                      <div className="mt-2 shrink-0 rounded-lg border border-emerald-600/20 bg-emerald-600/[0.04] p-2.5">
                        {sc.error.get(selAgg.name) ? (
                          <p className="text-xs text-destructive">Error: {sc.error.get(selAgg.name)}</p>
                        ) : (
                          <>
                            <p className="mb-1 text-[11px] text-muted-foreground">
                              SKILL.md · 来源 {sc.content.get(selAgg.name)?.source === "skill-tool" ? "Skill 工具注入" : sc.content.get(selAgg.name)?.source === "shell" ? "Shell 读取" : "Read 读取"} · {sc.content.get(selAgg.name)?.length} 字符
                            </p>
                            <pre className="max-h-60 overflow-auto rounded border bg-background p-2 font-mono text-xs whitespace-pre-wrap break-words">{sc.content.get(selAgg.name)?.content}</pre>
                          </>
                        )}
                      </div>
                    )}

                    {/* 逐次调用：成员归因在这里披露（一行一个，不堆徽标） */}
                    <div className="mt-2 min-h-0 flex-1 divide-y divide-foreground/[0.05] overflow-y-auto">
                      {selAgg.events.map(ev => (
                        <div key={ev.id} className="flex items-center gap-2 py-1.5 text-xs">
                          <span className="w-14 shrink-0 text-muted-foreground tabular-nums" title={ev.turnCreatedAt ?? "时间戳缺失"}>
                            {ev.turnCreatedAt ? fmtClock(ev.turnCreatedAt) : `#${ev.turnIndex}`}
                          </span>
                          <span
                            className={cn("size-1.5 shrink-0 rounded-full", ev.success ? "bg-emerald-600" : "bg-red-500")}
                            title={ev.success ? "成功" : `失败：${ev.errorMessage ?? "未知错误"}`}
                          />
                          <span className="w-11 shrink-0 text-muted-foreground">{ev.eventType}</span>
                          <span className="min-w-0 flex-1 truncate text-foreground/85" title={ev.member?.taskId}>{ev.member?.label ?? "—"}</span>
                          <span className="shrink-0 text-muted-foreground tabular-nums" title="调用 turn 的 token">{fmtTok(ev.turnTokens.totalTokens)} tok</span>
                          {ev.turnId ? (
                            <button
                              type="button"
                              data-skill-jump={ev.turnId}
                              title="跳转 turn 现场"
                              onClick={() => onOpenTurn(ev.turnId!)}
                              className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
                            >
                              <ArrowUpRightIcon className="size-3.5" />
                            </button>
                          ) : (
                            <span className="inline-flex size-5 shrink-0" />
                          )}
                        </div>
                      ))}
                      {selAgg.events.length === 0 && (
                        <p className="py-3 text-center text-xs text-muted-foreground">该技能无事件级调用记录（仅会话聚合）。</p>
                      )}
                    </div>
                  </div>
                ) : selDispatchAgg ? (
                  <div className="flex min-h-0 flex-1 flex-col">
                    <div className="flex shrink-0 items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-[13px] font-semibold text-foreground/90" title={selDispatchAgg.name}>{selDispatchAgg.name}</p>
                          {selDispatchAgg.verifyCount > 0 && <span className="shrink-0 rounded bg-purple-600/10 px-1.5 text-[10px] leading-4 font-semibold text-purple-600 dark:text-purple-300 tabular-nums">验收 {selDispatchAgg.verifyCount}</span>}
                        </div>
                        <p className="mt-0.5 text-[11px] text-muted-foreground tabular-nums" title="Σ 为已入库子代理会话的 token 合计">
                          {selDispatchAgg.items.length} 次派发 · {selDispatchAgg.memberCount} 成员{selDispatchAgg.totalTokens > 0 ? ` · Σ ${fmtTok(selDispatchAgg.totalTokens)} tok` : ""}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {selMemberTaskId && (
                          <span
                            role="button"
                            tabIndex={0}
                            title="查看子代理声明原文（.md：会话注入恢复为主，磁盘扫描兜底）"
                            className={cn(
                              "inline-flex cursor-pointer items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-semibold transition-colors",
                              sc.content.has(`agent:${selDispatchAgg.name}`) || sc.error.has(`agent:${selDispatchAgg.name}`)
                                ? "border-purple-600 bg-purple-600/15 text-purple-700 dark:text-purple-200"
                                : "border-purple-600/50 bg-purple-600/10 text-purple-600 dark:text-purple-300 hover:bg-purple-600/20",
                              sc.loading.has(`agent:${selDispatchAgg.name}`) && "animate-pulse",
                            )}
                            onClick={() => {
                              const key = `agent:${selDispatchAgg.name}`;
                              if (sc.content.has(key) || sc.error.has(key)) sc.clear(key);
                              else if (!sc.loading.has(key)) {
                                const fw = selDispatchAgg.items.find(i => i.member?.framework)?.member?.framework;
                                sc.fetchAgent(selDispatchAgg.name, fw ?? undefined);
                              }
                            }}
                            onKeyDown={e => {
                              if (e.key === "Enter" || e.key === " ") {
                                const key = `agent:${selDispatchAgg.name}`;
                                if (sc.content.has(key)) sc.clear(key);
                                else if (!sc.loading.has(key)) sc.fetchAgent(selDispatchAgg.name);
                              }
                            }}
                          >
                            <BookOpenIcon className="size-3" />
                            {sc.loading.has(`agent:${selDispatchAgg.name}`) ? "加载中…" : sc.content.has(`agent:${selDispatchAgg.name}`) ? "收起" : "声明"}
                          </span>
                        )}
                        <button
                          type="button"
                          title="收起明细"
                          onClick={() => setSelected(null)}
                          className="cursor-pointer rounded p-1 text-muted-foreground/60 transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
                        >
                          <XIcon className="size-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* 子代理声明原文（agent .md） */}
                    {(sc.content.has(`agent:${selDispatchAgg.name}`) || sc.error.has(`agent:${selDispatchAgg.name}`)) && (
                      <div className="mt-2 shrink-0 rounded-lg border border-purple-600/20 bg-purple-600/[0.04] p-2.5">
                        {sc.error.get(`agent:${selDispatchAgg.name}`) ? (
                          <p className="text-xs text-destructive">Error: {sc.error.get(`agent:${selDispatchAgg.name}`)}</p>
                        ) : (
                          <>
                            <p className="mb-1 text-[11px] text-muted-foreground">
                              声明原文 · {sc.content.get(`agent:${selDispatchAgg.name}`)?.via === "system" ? "会话注入恢复" : "磁盘扫描"} · {sc.content.get(`agent:${selDispatchAgg.name}`)?.length} 字符
                            </p>
                            <pre className="max-h-60 overflow-auto rounded border bg-background p-2 font-mono text-xs whitespace-pre-wrap break-words">{sc.content.get(`agent:${selDispatchAgg.name}`)?.content}</pre>
                          </>
                        )}
                      </div>
                    )}

                    {/* 逐次派发：成员归因在这里披露（一行一个，不堆徽标） */}
                    <div className="mt-2 min-h-0 flex-1 divide-y divide-foreground/[0.05] overflow-y-auto">
                      {selDispatchAgg.items.map((d, di) => (
                        <div key={d.id} className="flex items-center gap-2 py-1.5 text-xs">
                          <span className="w-14 shrink-0 text-muted-foreground tabular-nums" title={d.at ?? "时间戳缺失"}>
                            {d.at ? fmtClock(d.at) : `#${di + 1}`}
                          </span>
                          <span className="w-12 shrink-0 text-[10px] leading-4 text-muted-foreground/80" title={d.source === "event" ? "claude 派发事件（真值）" : "成员会话首 turn 推导"}>
                            {d.source === "event" ? "事件" : "推导"}
                          </span>
                          {d.verify && <span className="shrink-0 rounded bg-purple-600/10 px-1 text-[10px] leading-4 font-semibold text-purple-600 dark:text-purple-300">验收</span>}
                          <span className="min-w-0 flex-1 truncate text-foreground/85" title={d.member?.taskId}>{d.member?.label ?? "—"}</span>
                          {d.tokens != null && (
                            <span className="w-11 shrink-0 text-right text-[10px] text-muted-foreground/80 tabular-nums" title="子代理会话 token 合计">{fmtTok(d.tokens)}</span>
                          )}
                          {d.turnId ? (
                            <button
                              type="button"
                              data-skill-jump={d.turnId}
                              title="跳转 turn 现场"
                              onClick={() => onOpenTurn(d.turnId)}
                              className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
                            >
                              <ArrowUpRightIcon className="size-3.5" />
                            </button>
                          ) : (
                            <span className="inline-flex size-5 shrink-0" />
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
