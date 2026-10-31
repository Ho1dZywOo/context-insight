"use client";
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Run Turns tab（design: run 级 Turns 变革——Run Player 架构；搜索驻留 =
// Trace 退役后的跨成员搜索归位）。
// 三层：① Run 轨（顶部）= 节点状态时间线——状态段 + 代际发丝分隔 + 活动
// 节点加高锚定与标识簇 + 搜索胶囊（跨成员搜索 / #数字直达，命中索引驻留
// 左列）；② 节点列表（左列）= 代分组 → 节点实例（成员会话懒加载，subagent
// 泳道嵌套照旧），搜索驻留期间让位为命中索引；③ Turn Player（右列）=
// 传输条 + 本会话胶片轨 + 三联指标 + 叙事舞台（TurnDetail，携带搜索高亮）。
// 选中轮的节点归属由 turn 详情的 taskId 单点解析（深链/跨 tab 同路）；
// ←/→ 沿「节点 × 成员会话 × 轮次」全序列连续走查，越过节点边界自动加载。

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessageSquareIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { TurnDetail, type TurnDetailData } from "@/components/observe/TurnDetail";
import { TurnDetailSkeleton } from "@/components/observe/TurnDetailSkeleton";
import type { FilmstripTurn } from "@/components/observe/TurnFilmstrip";
import { RunTurnsNodes, STATUS_DOT, type TurnsNode, type TurnsNodeSession, type MemberTurnsState } from "@/components/run/RunTurnsNodes";
import { RunTurnsRoleFilter, deriveRoleOptions, toggleRoleFilter } from "@/components/run/RunTurnsRoleFilter";
import { TurnSearchField, TurnHitsPanel, useTurnsHitsFilter, type TurnsSearchState } from "@/components/run/RunTurnsSearch";
import type { TurnHighlight } from "@/lib/shared/highlight";
import type { TurnSearchItem } from "@/lib/observe/collectors/search";
import type { MergedBridgeItem } from "@/lib/observe/collectors/bridges";
import type { NodeInstance, RunViewModel } from "@/lib/run/view-model";
import type { SessionRef } from "@/lib/run/model";

const PAGE_SIZE = 200;

/** 详情骨架出场延迟：点击选轮的取数快于该值时不出骨架（保留旧内容直到
 *  新内容落地），超过才让位给骨架——快取数不闪、慢取数有信号 */
const DETAIL_SKELETON_DELAY_MS = 180;

/** 揭示滚动（原语）：离屏会话块按 content-visibility 占位（600px）参与
 *  布局，远距跳转若按占位几何滚动，落地后真实布局展开行会偏移出视野——
 *  先给列表挂揭示类把占位块临时展平为真实布局，读一次几何强制同步，再
 *  平滑居中；滚动收尾（scrollend / 兜底计时）后摘除揭示类恢复跳渲染
 *  （contain-intrinsic-size:auto 已记住真实尺寸，恢复不引起跳动） */
function revealIntoView(list: HTMLDivElement | null, el: Element) {
  if (!list) return;
  list.classList.add("turn-list-revealing");
  void list.scrollHeight;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  const settle = () => {
    list.classList.remove("turn-list-revealing");
    list.removeEventListener("scrollend", settle);
    if (timer != null) clearTimeout(timer);
  };
  const timer = setTimeout(settle, 800);
  list.addEventListener("scrollend", settle);
}

export interface RunTurnsTabProps {
  runId: string;
  viewModel: RunViewModel;
  turnId: string | null;
  onSelectTurn: (turnId: string | null) => void;
}

// viewModel → 节点序列（主图按 代→rank 排序；子图节点递归挂生成器后）
function buildNodes(vm: RunViewModel): TurnsNode[] {
  const main = vm.views[0];
  if (!main) return [];
  const subViewsByParent = new Map<string, typeof vm.views>();
  for (const v of vm.views.slice(1)) {
    if (!v.parentKey) continue;
    const arr = subViewsByParent.get(v.parentKey) ?? [];
    arr.push(v);
    subViewsByParent.set(v.parentKey, arr);
  }
  const toSession = (ref: SessionRef | null, role: "execute" | "verify", ordinal: number): TurnsNodeSession | null =>
    ref ? { taskId: ref.taskId, label: ref.label, role, attemptOrdinal: ordinal, ref } : null;

  const build = (view: RunViewModel["views"][number], depth: number): TurnsNode[] => {
    const nodes = view.nodeKeys
      .map(k => vm.nodes.find(n => n.key === k))
      .filter((n): n is NodeInstance => n != null)
      .sort((a, b) => a.generation - b.generation || (view.ranks[a.key] ?? 0) - (view.ranks[b.key] ?? 0));
    const out: TurnsNode[] = [];
    for (const n of nodes) {
      const attempts = n.attempts.map(a => ({
        ordinal: a.ordinal,
        status: a.status,
        verification: a.verification,
        outputText: a.outputText,
        execute: toSession(a.executeMember.session ?? null, "execute", a.ordinal),
        verify: toSession(a.verifyMember?.session ?? null, "verify", a.ordinal),
      }));
      const sessions = attempts.flatMap(a => [a.execute, a.verify]).filter((s): s is TurnsNodeSession => s != null);
      out.push({
        key: n.key,
        nodeId: n.nodeId,
        generation: n.generation,
        label: n.label,
        taskType: n.taskType,
        status: n.status,
        executionState: n.executionState,
        carriedFromGeneration: n.carriedFromGeneration,
        hasSubgraph: n.hasSubgraph,
        depth,
        attempts,
        sessions,
      });
      if (n.hasSubgraph) {
        for (const sv of subViewsByParent.get(n.key) ?? []) out.push(...build(sv, depth + 1));
      }
    }
    return out;
  };
  return build(main, 0);
}

function firstContentNode(nodes: TurnsNode[]): TurnsNode | undefined {
  return nodes.find(c => c.executionState !== "not_run" && c.sessions.length > 0) ?? nodes[0];
}

/** 搜索未驻留时过滤 hook 的稳定空集（避免每次渲染新数组触发 memo 重算） */
const EMPTY_SEARCH_ITEMS: TurnSearchItem[] = [];

export function RunTurnsTab({ runId, viewModel, turnId, onSelectTurn }: RunTurnsTabProps) {
  const nodes = useMemo(() => buildNodes(viewModel), [viewModel]);
  const flatSessions = useMemo(() => nodes.flatMap(c => c.sessions), [nodes]);
  const bands = useMemo(
    () => viewModel.views[0]?.layout.bands.map(b => ({ generation: b.generation, label: b.label })) ?? [],
    [viewModel],
  );
  const rollbacks = useMemo(
    () => viewModel.rollbacks.map(r => ({ ordinal: r.ordinal, note: r.note, toGeneration: r.to.generation })),
    [viewModel],
  );

  const [expanded, setExpanded] = useState<Set<string>>(() => {
    // 首个节点默认展开（落地即有内容；solo = 唯一会话直接呈现）
    const first = firstContentNode(nodes);
    return first ? new Set([first.key]) : new Set();
  });
  /** 用户点过的节点（点过即完全由 expanded 集合控制；未点过的节点跟随选中轮自动展开） */
  const [toggledNodes, setToggledTurnsNodes] = useState<Set<string>>(new Set());
  const [memberData, setMemberData] = useState<Map<string, MemberTurnsState>>(new Map());
  /** 已加载轮次全集 → 角色筛选选项（计数随成员懒加载增量就位，只列出真实
   *  出现过的角色） */
  const loadedTurnsAll = useMemo(() => [...memberData.values()].flatMap(s => s.turns), [memberData]);
  const roleOptions = useMemo(() => deriveRoleOptions(loadedTurnsAll), [loadedTurnsAll]);
  const [bridges, setBridges] = useState<MergedBridgeItem[]>([]);
  /** 跨成员搜索驻留态（null = 节点索引；非 null = 命中索引驻留左列） */
  const [search, setSearch] = useState<TurnsSearchState | null>(null);
  /** 角色多选筛选（左列节点列表视角；空集 = 全显）。搜索驻留时筛选条隐藏，
   *  筛选本身保持不动，退出搜索继续生效 */
  const [roleFilter, setRoleFilter] = useState<ReadonlySet<string>>(new Set());
  /** 轮详情仓（turnId → 详情；走查缓存命中不重取） */
  const [details, setDetails] = useState<Map<string, TurnDetailData>>(new Map());
  const inflightDetailRef = useRef<Set<string>>(new Set());
  /** 详情加载节奏态：骨架出场轮（越过延迟窗口仍在取数）/ 刚从取数落地的轮
   *  （内容卡入场动画标记）/ 走查选中标记（走查不入场）/ 骨架延迟计时器 */
  const [skeletonFor, setSkeletonFor] = useState<string | null>(null);
  const [enteredTurnId, setEnteredTurnId] = useState<string | null>(null);
  const walkSelectRef = useRef<string | null>(null);
  const skeletonTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 已取/在途的成员分页（`taskId:page`），懒加载去重闸 */
  const fetchedPagesRef = useRef<Set<string>>(new Set());
  /** 走查越过已加载边界时的待落地选择（目标会话加载完即选首/末轮） */
  const pendingWalk = useRef<{ taskId: string; dir: 1 | -1 } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 桥（run 全量一次，小载荷元数据；节点内按派发轮归组）
  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/observe/run/${encodeURIComponent(runId)}/bridges`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled) setBridges(d?.items ?? []) })
      .catch(() => { /* 桥不可用时泳道缺席，轮次不受影响 */ });
    return () => { cancelled = true };
  }, [runId]);

  const fetchMemberPage = useCallback((taskId: string, page: number) => {
    fetchedPagesRef.current.add(`${taskId}:${page}`);
    void fetch(`/api/observe/run/${encodeURIComponent(runId)}/turns?member=${encodeURIComponent(taskId)}&page=${page}&pageSize=${PAGE_SIZE}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        setMemberData(prev => {
          const cur = prev.get(taskId);
          if (!d) {
            if (cur?.loading) {
              const next = new Map(prev);
              next.set(taskId, { ...cur, loading: false });
              return next;
            }
            if (!cur) {
              const next = new Map(prev);
              next.set(taskId, { turns: [], total: 0, page: 1, loading: false });
              return next;
            }
            return prev;
          }
          const merged = page > 1 && cur ? [...cur.turns, ...(d.items ?? [])] : (d.items ?? []);
          const next = new Map(prev);
          next.set(taskId, { turns: merged, total: d.total ?? merged.length, page, loading: false });
          return next;
        });
      })
      .catch(() => {
        setMemberData(prev => {
          const cur = prev.get(taskId);
          if (!cur?.loading) return prev;
          const next = new Map(prev);
          next.set(taskId, { ...cur, loading: false });
          return next;
        });
      });
  }, [runId]);

  /** 首页懒加载（effect/事件两用；在途去重走 ref，首屏以数据缺席呈现载入态） */
  const ensureMemberTurns = useCallback((taskId: string) => {
    if (fetchedPagesRef.current.has(`${taskId}:1`)) return;
    fetchMemberPage(taskId, 1);
  }, [fetchMemberPage]);

  /** Run 轨节点点击：只揭示不展开——节点块滚动到视野居中；展开仍由节点头
   *  独占（定位与展开是两种意图，不捆绑触发，也不预取成员分页） */
  const revealNode = useCallback((key: string) => {
    const node = listRef.current?.querySelector(`[data-node="${key}"]`);
    if (node) revealIntoView(listRef.current, node);
  }, []);

  const toggleNode = useCallback((key: string) => {
    setToggledTurnsNodes(prev => (prev.has(key) ? prev : new Set(prev).add(key)));
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    const ch = nodes.find(c => c.key === key);
    if (ch && !expanded.has(key)) for (const s of ch.sessions) ensureMemberTurns(s.taskId);
  }, [nodes, ensureMemberTurns, expanded]);

  /** memberData 只读镜像（effect 提交后同步）：loadMore 读镜像而非闭包捕获，
   *  回调身份保持稳定——会话块/行 memo 不被每次成员取数打散 */
  const memberDataRef = useRef(memberData);
  useEffect(() => { memberDataRef.current = memberData; }, [memberData]);

  const loadMore = useCallback((taskId: string) => {
    const cur = memberDataRef.current.get(taskId);
    if (!cur || cur.loading || cur.turns.length >= cur.total) return;
    setMemberData(prev => {
      const c = prev.get(taskId);
      if (!c) return prev;
      const next = new Map(prev);
      next.set(taskId, { ...c, loading: true });
      return next;
    });
    fetchMemberPage(taskId, cur.page + 1);
  }, [fetchMemberPage]);

  // ── 选中即揭示（原语）──
  // 任何路径换选某轮（列表点击 / 胶片轨 / ←/→ 走查 / 深链 / 跨页跳转）都挂起
  // 揭示意图，行就位后滚动到视野居中——选中行成为视觉焦点，与节点揭示同口
  // 径。目标行可能要等「详情归属 → 成员分页 → 节点展开」逐步就位，意图保留
  // 到行出现为止（换选挂起 effect 随取数/展开变化重试，见 effectiveExpanded
  // 之后）。用户手动收起的节点不强拆——手动展开后挂起的意图仍然生效
  const pendingRevealRef = useRef<string | null>(null);
  const prevTurnIdRef = useRef<string | null>(null);
  const revealPending = useCallback(() => {
    const t = pendingRevealRef.current;
    if (!t) return;
    // 搜索驻留期间左列被玻璃命中索引覆盖——对被盖住的列表揭示不可见也无
    // 意义，意图保留到退出（换选挂起 effect 依赖 search，退出即重试落地）
    if (search) return;
    const row = listRef.current?.querySelector(`[data-turn-row="${t}"]`);
    if (!row) return;
    pendingRevealRef.current = null;
    revealIntoView(listRef.current, row);
  }, [search]);
  /** 跳转选中出口（胶片轨 / ←/→ 走查）：每次选中——含重选当前轮——都挂起
   *  揭示，重选已看过的轮也能把列表带回居中位置 */
  const handleSelectTurn = useCallback((id: string) => {
    pendingRevealRef.current = id;
    revealPending();
    onSelectTurn(id);
  }, [onSelectTurn, revealPending]);
  /** 列表内点击选中：不揭示——用户点的行已在视野内，强制居中反而扰动；
   *  记 origin 供换选挂起 effect 识别（prop 换选无此标记 = 外部跳转） */
  const listOriginRef = useRef<string | null>(null);
  const handleListSelectTurn = useCallback((id: string) => {
    listOriginRef.current = id;
    onSelectTurn(id);
  }, [onSelectTurn]);

  // 首节点成员取数（展开态由 useState 惰性初始化给出；本 effect 只负责数据）
  useEffect(() => {
    const first = firstContentNode(nodes);
    if (first) for (const s of first.sessions) ensureMemberTurns(s.taskId);
  }, [nodes, ensureMemberTurns]);

  // 选中轮详情（turnId 全局唯一；详情仓缓存命中不重取，←/→ 走查零请求）
  const activeDetail = turnId != null ? (details.get(turnId) ?? null) : null;

  // 换选渲染期快照（React 认可的 prev 值比较形态，同 run-view）：换选时
  // ①快照上一轮详情——取数窗口内保留旧内容展示（换轮不闪骨架）；
  // ②清入场标记——入场只属于「该轮取数落地」的那次挂载，换选（含缓存
  // 命中）不重放，本次选中若首次取数由下方详情 effect 在落地时重新标记
  const [prevTurnId, setPrevTurnId] = useState<string | null>(turnId);
  const [staleDetail, setStaleDetail] = useState<TurnDetailData | null>(null);
  if (prevTurnId !== turnId) {
    setPrevTurnId(turnId);
    setStaleDetail(prevTurnId != null ? details.get(prevTurnId) ?? null : null);
    setEnteredTurnId(null);
  }
  const shownDetail = activeDetail ?? (turnId != null ? staleDetail : null);

  useEffect(() => {
    if (!turnId || details.has(turnId) || inflightDetailRef.current.has(turnId)) return;
    inflightDetailRef.current.add(turnId);
    if (skeletonTimerRef.current) { clearTimeout(skeletonTimerRef.current); skeletonTimerRef.current = null; }
    // 走查标记消费：走查选中不入场（连续走查求快）；点击选中落地后阶梯入场
    const fromWalk = walkSelectRef.current === turnId;
    walkSelectRef.current = null;
    // 骨架出场时机：有旧内容保留 180ms（快取数全程无感）；无旧内容
    // （首选/深链）由渲染回退立即出骨架——真慢加载才让位给骨架
    if (staleDetail != null) {
      skeletonTimerRef.current = setTimeout(() => {
        skeletonTimerRef.current = null;
        setSkeletonFor(turnId);
      }, DETAIL_SKELETON_DELAY_MS);
    }
    void fetch(`/api/observe/turn/${encodeURIComponent(turnId)}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!d || d.turnId !== turnId) return;
        setDetails(prev => {
          const next = new Map(prev);
          next.set(turnId, d);
          return next;
        });
        setSkeletonFor(prev => (prev === turnId ? null : prev));
        if (!fromWalk) setEnteredTurnId(turnId);
      })
      .catch(() => { /* 详情不可用时保持占位 */ })
      .finally(() => {
        inflightDetailRef.current.delete(turnId);
        if (skeletonTimerRef.current) { clearTimeout(skeletonTimerRef.current); skeletonTimerRef.current = null; }
      });
  }, [turnId, details, staleDetail]);

  // 卸载时收尾骨架计时器
  useEffect(() => () => { if (skeletonTimerRef.current) clearTimeout(skeletonTimerRef.current) }, []);

  // 详情的成员归属 → 确保轮次就位（深链/搜索/跨 tab 同路；节点展开是
  // 渲染期派生——选中轮所在节点恒开，无需 effect 改状态）。取数窗口内
  // 跟随展示内容（旧轮的归属已在册，no-op）
  const ownerTaskId = shownDetail?.taskId ?? null;
  useEffect(() => {
    if (ownerTaskId) ensureMemberTurns(ownerTaskId);
  }, [ownerTaskId, ensureMemberTurns]);

  const ownerState = ownerTaskId ? (memberData.get(ownerTaskId) ?? null) : null;
  const ownerTurnsSorted = useMemo(
    () => (ownerState ? [...ownerState.turns].sort((a, b) => a.turnIndex - b.turnIndex) : []),
    [ownerState],
  );

  // 走查序列（当前会话内）：←/→ 沿轮次序；越界跳相邻会话——目标已加载
  // 直接选首/末轮（memberData 无变化也要落地），未加载记待落地并取数
  const resolveWalk = useCallback((taskId: string, dir: 1 | -1) => {
    const st = memberData.get(taskId);
    if (!st || st.loading || st.turns.length === 0) {
      pendingWalk.current = { taskId, dir };
      ensureMemberTurns(taskId);
      return;
    }
    const sorted = [...st.turns].sort((a, b) => a.turnIndex - b.turnIndex);
    const target = (dir === 1 ? sorted[0] : sorted[sorted.length - 1]).turnId;
    walkSelectRef.current = target;
    handleSelectTurn(target);
  }, [memberData, ensureMemberTurns, handleSelectTurn]);

  const walk = useCallback((dir: 1 | -1) => {
    if (!ownerTaskId) {
      if (flatSessions.length === 0) return;
      resolveWalk(flatSessions[dir === 1 ? 0 : flatSessions.length - 1].taskId, dir);
      return;
    }
    const idx = ownerTurnsSorted.findIndex(t => t.turnId === turnId);
    if (idx >= 0) {
      const next = ownerTurnsSorted[idx + dir];
      if (next) { walkSelectRef.current = next.turnId; handleSelectTurn(next.turnId); return }
    }
    const sIdx = flatSessions.findIndex(s => s.taskId === ownerTaskId);
    const target = flatSessions[sIdx + dir];
    if (!target) return;
    resolveWalk(target.taskId, dir);
  }, [ownerTaskId, ownerTurnsSorted, turnId, flatSessions, handleSelectTurn, resolveWalk]);

  // 越界取数完成后的落地（数据到位即选首/末轮，复用 resolveWalk 的目标推导）
  useEffect(() => {
    const pw = pendingWalk.current;
    if (!pw) return;
    const st = memberData.get(pw.taskId);
    if (!st || st.loading || st.turns.length === 0) return;
    pendingWalk.current = null;
    resolveWalk(pw.taskId, pw.dir);
  }, [memberData, resolveWalk]);

  // Player 注入：胶片 = 当前成员会话全量轮（root + subagent 混排，token 柱高）
  const filmstripTurns = useMemo<FilmstripTurn[]>(
    () => ownerTurnsSorted.map(t => ({
      turnId: t.turnId,
      turnIndex: t.turnIndex,
      role: t.role,
      isSubagent: t.isSubagent,
      totalTokens: t.totalTokens,
      latencyMs: t.latencyMs,
      contextWindowPct: t.contextWindowPct,
    })),
    [ownerTurnsSorted],
  );

  // 同 agent 维度的上一轮（Δ 输入卡的边界：root 与 subagent 各自连续）
  const prevSameAgent = useMemo(() => {
    if (!shownDetail) return null;
    const idx = ownerTurnsSorted.findIndex(t => t.turnId === shownDetail.turnId);
    for (let i = idx - 1; i >= 0; i--) {
      if (ownerTurnsSorted[i].subagentSessionId === shownDetail.subagentSessionId) return ownerTurnsSorted[i];
    }
    return null;
  }, [shownDetail, ownerTurnsSorted]);

  const subagentLabel = useMemo(() => {
    if (!shownDetail?.isSubagent) return undefined;
    const t = ownerTurnsSorted.find(x => x.turnId === shownDetail.turnId);
    return t?.subagentType ?? shownDetail.subagentName ?? "subagent";
  }, [shownDetail, ownerTurnsSorted]);

  // Run 轨：主图节点序列；活动节点 = 选中轮所属节点（标识簇 + 加高锚段）
  const railNodes = useMemo(() => nodes.filter(c => c.depth === 0), [nodes]);
  const ownerNodeKey = useMemo(
    () => (ownerTaskId ? nodes.find(c => c.sessions.some(s => s.taskId === ownerTaskId))?.key ?? null : null),
    [nodes, ownerTaskId],
  );
  const activeRailIdx = railNodes.findIndex(n => n.key === ownerNodeKey);
  const activeRailNode = activeRailIdx >= 0 ? railNodes[activeRailIdx] : null;

  /** 生效展开集 = 用户展开 ∪ 选中轮所在节点（未点过的节点跟随选中自动展开——
   * 深链/跨节点走查的展开是渲染期派生，不落 effect 改状态） */
  const effectiveExpanded = useMemo(() => {
    if (!ownerNodeKey || expanded.has(ownerNodeKey) || toggledNodes.has(ownerNodeKey)) return expanded;
    const next = new Set(expanded);
    next.add(ownerNodeKey);
    return next;
  }, [expanded, toggledNodes, ownerNodeKey]);

  // ── 选中即揭示：换选挂起 ──
  // prop 驱动的换选（深链 / 跨 tab / 上一层 select）在这里挂起意图；
  // handleSelectTurn 覆盖跳转选中出口。列表内点击（handleListSelectTurn
  // 记 origin）不揭示——行已在位。行未就位时意图保留，effect 随取数
  // （details/memberData）与展开（effectiveExpanded）变化重试
  useEffect(() => {
    if (prevTurnIdRef.current !== turnId) {
      prevTurnIdRef.current = turnId;
      pendingRevealRef.current = listOriginRef.current === turnId ? null : turnId;
      listOriginRef.current = null;
    }
    revealPending();
    // search 在依赖里：退出搜索（节点列表回位）时挂起的揭示意图落地
  }, [turnId, details, memberData, effectiveExpanded, search, revealPending]);

  // ── 跨成员搜索（Trace 退役，搜索归 Turns——命中索引驻留左列）──
  // 命中集是排查工作集：选中命中打开 player 后列表不消失；退出（✕ / Esc /
  // 点 Run 轨 / 改词重搜）才回节点索引。选中轮的成员分页与节点展开照常由
  // 既有管线就位（详情归属 → ensureMemberTurns → effectiveExpanded）
  const [activeHitIdx, setActiveHitIdx] = useState(0);
  const [visitedHits, setVisitedHits] = useState<ReadonlySet<string>>(new Set());
  const [hitHighlight, setHitHighlight] = useState<TurnHighlight | null>(null);
  const pendingNodeRevealRef = useRef<string | null>(null);
  // 桥接回应轮集合（来源过滤的「子agent返回」分类事实）
  const bridgeResponseTurnIds = useMemo(
    () => new Set(bridges.flatMap(b => (b.responseTurnId ? [b.responseTurnId] : []))),
    [bridges],
  );
  // 命中过滤：键盘走查（↑↓/Enter）与过滤后列表对齐；改词重搜复位过滤
  const { filter: hitFilter, setFilter: setHitFilter, visible: visibleHits, sourceOptions, thinkingOption, toolOptions } =
    useTurnsHitsFilter(search?.items ?? EMPTY_SEARCH_ITEMS, bridgeResponseTurnIds);

  const runSearch = useCallback(async (kw: string) => {
    setSearch({ keyword: kw, loading: true, items: [], total: 0 });
    setActiveHitIdx(0);
    setVisitedHits(new Set());
    setHitFilter(null);
    try {
      const res = await fetch(
        `/api/observe/run/${encodeURIComponent(runId)}/turns/search?keyword=${encodeURIComponent(kw)}&limit=50`,
      );
      const d = res.ok ? await res.json() : null;
      // 关键词已换（连续改词重搜）则丢弃迟到响应
      setSearch(prev =>
        prev && prev.keyword === kw
          ? { keyword: kw, loading: false, items: d?.items ?? [], total: d?.total ?? (d?.items ?? []).length }
          : prev,
      );
    } catch {
      setSearch(prev => (prev ? { ...prev, loading: false } : prev));
    }
  }, [runId, setHitFilter]);

  /** 过滤切换：活跃命中序号随列表收窄复位 */
  const changeHitFilter = useCallback(
    (key: string | null) => {
      setHitFilter(key);
      setActiveHitIdx(0);
    },
    [setHitFilter],
  );

  const exitSearch = useCallback(() => {
    setSearch(null);
    setHitHighlight(null);
    setActiveHitIdx(0);
    // 回节点列表后居中揭示当前选中轮（若在册）——工作流连续性
    if (turnId != null) pendingRevealRef.current = turnId;
  }, [turnId]);

  const openHit = useCallback(
    (item: TurnSearchItem) => {
      setVisitedHits(prev => {
        const next = new Set(prev);
        next.add(item.turnId);
        return next;
      });
      setHitHighlight({ keyword: search?.keyword ?? "", matchField: item.matchField, toolName: item.toolName });
      handleSelectTurn(item.turnId);
    },
    [search, handleSelectTurn],
  );

  /** #N 直达：与胶片轨同基准——当前会话已加载轮内按序号定位 */
  const jumpTurnIndex = useCallback(
    (idx: number) => {
      if (!ownerTaskId) return false;
      const t = [...(memberData.get(ownerTaskId)?.turns ?? [])].find(x => x.turnIndex === idx);
      if (!t) return false;
      handleSelectTurn(t.turnId);
      return true;
    },
    [ownerTaskId, memberData, handleSelectTurn],
  );

  /** Run 轨点击：搜索驻留时先退出（命中索引让位），揭示意图滞后到列表回位 */
  const onRailNodeClick = useCallback(
    (key: string) => {
      if (search) {
        pendingNodeRevealRef.current = key;
        exitSearch();
        return;
      }
      revealNode(key);
    },
    [search, exitSearch, revealNode],
  );

  useEffect(() => {
    if (search || !pendingNodeRevealRef.current) return;
    const key = pendingNodeRevealRef.current;
    pendingNodeRevealRef.current = null;
    revealNode(key);
  }, [search, revealNode]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-foreground/[0.07] bg-background shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      {/* ① Run 轨（节点状态时间线）：状态段一览全程健康，单行容纳任意节点数
          （等宽按钮排在 60 节点级 run 上会挤叠成团）；活动节点加高锚定 +
          标识簇常驻（状态点 · 节点名 · 位置计数），节点详情进悬停提示 */}
      <div className="flex shrink-0 items-center gap-3 border-b border-foreground/[0.07] px-4 py-2">
        {activeRailNode && (
          <div data-rail-active className="flex min-w-0 shrink-0 items-center gap-1.5">
            <span className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[activeRailNode.status] ?? "bg-foreground/25")} aria-hidden />
            <span className="max-w-[200px] truncate text-xs font-medium text-foreground/85">{activeRailNode.label}</span>
            <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">{activeRailIdx + 1}/{railNodes.length}</span>
          </div>
        )}
        <div data-rail-track className="flex min-w-0 flex-1 items-center gap-[2px] overflow-hidden" role="tablist" aria-label="run 节点">
          {railNodes.map((ch, i) => {
            const prev = railNodes[i - 1];
            const newGeneration = i > 0 && prev.generation !== ch.generation;
            const isRollback = newGeneration && ch.generation > (prev?.generation ?? 0);
            const isActive = ch.key === ownerNodeKey;
            const turnTotal = ch.sessions.reduce((s, x) => s + x.ref.turns, 0);
            const meta = ch.sessions.length > 0
              ? `${turnTotal}t`
              : ch.executionState === "not_run" ? "未运行"
              : ch.taskType === "bash" ? "bash" : "—";
            return (
              <Fragment key={ch.key}>
                {newGeneration && <span className="h-3 w-px shrink-0 bg-foreground/[0.15]" aria-hidden />}
                <button
                  type="button"
                  className="group flex h-5 min-w-1 cursor-pointer flex-1 items-center"
                  onClick={() => onRailNodeClick(ch.key)}
                  title={`${ch.label}${ch.generation > 0 ? ` · g${ch.generation}` : ""}${isRollback ? " · 回滚后新代际" : ""} · ${meta} · ${ch.status}`}
                >
                  <span
                    className={cn(
                      "w-full rounded-full transition-[height,opacity] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
                      isActive ? "h-2.5" : "h-1.5 opacity-75 group-hover:opacity-100",
                      STATUS_DOT[ch.status] ?? "bg-foreground/25",
                    )}
                    aria-hidden
                  />
                </button>
              </Fragment>
            );
          })}
          {railNodes.length === 0 && (
            <p className="px-1 py-2 text-xs text-muted-foreground">无可观测节点</p>
          )}
        </div>
        <TurnSearchField
          state={search}
          hitCount={visibleHits.length}
          onSearch={runSearch}
          onExit={exitSearch}
          onJumpIndex={jumpTurnIndex}
          onStepHit={dir =>
            setActiveHitIdx(i => {
              const max = Math.max(visibleHits.length - 1, 0);
              return Math.min(Math.max(i + dir, 0), max);
            })
          }
          onOpenHit={() => {
            const it = visibleHits[activeHitIdx];
            if (it) openHit(it);
          }}
        />
      </div>

      {/* ②③ 节点 + Player */}
      <div className="flex min-h-0 flex-1">
        {/* 节点列表常驻挂载——搜索驻留时被玻璃命中索引覆盖（列表在玻璃后
            虚化、滚动位置保留），覆盖期间 inert 防键盘焦点落入被盖住的行；
            角色筛选条在列表头上常驻（首份成员数据落地即出现），搜索驻留时
            让位隐藏、退出即回位 */}
        <div className="relative flex w-[400px] shrink-0 flex-col border-r border-foreground/[0.07]">
          {!search && (
            <RunTurnsRoleFilter
              options={roleOptions}
              total={loadedTurnsAll.length}
              selected={roleFilter}
              onToggle={role => setRoleFilter(prev => toggleRoleFilter(prev, role))}
              onReset={() => setRoleFilter(new Set())}
            />
          )}
          <div ref={listRef} data-turn-list className="min-h-0 flex-1 overflow-y-auto" inert={search != null}>
            <RunTurnsNodes
              nodes={nodes}
              bands={bands}
              rollbacks={rollbacks}
              expanded={effectiveExpanded}
              onToggleNode={toggleNode}
              memberData={memberData}
              bridges={bridges}
              selectedTurnId={turnId}
              onSelectTurn={handleListSelectTurn}
              onLoadMore={loadMore}
              roleFilter={roleFilter}
            />
          </div>
          {search && (
            <TurnHitsPanel
              state={search}
              hits={visibleHits}
              activeIdx={activeHitIdx}
              selectedTurnId={turnId}
              visited={visitedHits}
              onSelect={openHit}
              onExit={exitSearch}
              filter={hitFilter}
              onFilterChange={changeHitFilter}
              sourceOptions={sourceOptions}
              thinkingOption={thinkingOption}
              toolOptions={toolOptions}
            />
          )}
        </div>
        {/* 详情加载节奏：缓存命中/走查零等待直接换内容；点击选轮的首次取数
            在 180ms 内保留上一轮内容（微微压暗示意加载中，不闪骨架），落地后
            由 TurnDetail 的 entrance 阶梯入场；真慢加载（超时）才让位给骨架 */}
        <div
          className={cn(
            "min-w-0 flex-1 overflow-y-auto bg-muted/40 transition-opacity duration-200",
            turnId != null && !activeDetail && shownDetail != null && skeletonFor !== turnId && "opacity-70",
          )}
        >
          {turnId == null ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 py-16 text-center">
              <span className="flex size-10 items-center justify-center rounded-full bg-foreground/[0.04]">
                <MessageSquareIcon className="size-5 text-muted-foreground/60" />
              </span>
              <p className="text-sm font-medium text-foreground/80">选择一轮开始走查</p>
              <p className="max-w-[280px] text-xs leading-relaxed text-muted-foreground">
                展开左侧节点点击任意轮次；加载后 ←/→ 连续走查整个 run，越过节点边界自动衔接
              </p>
            </div>
          ) : activeDetail ? (
            <TurnDetail
              turn={activeDetail}
              entrance={enteredTurnId === activeDetail.turnId}
              highlight={hitHighlight}
              filmstripTurns={filmstripTurns.length > 0 ? filmstripTurns : undefined}
              onSelectTurn={handleSelectTurn}
              onPrevTurn={() => walk(-1)}
              onNextTurn={() => walk(1)}
              prevInputTokens={prevSameAgent?.inputTokens ?? null}
              prevInputMessagesCount={prevSameAgent?.inputMessagesCount ?? null}
              subagentLabel={subagentLabel}
            />
          ) : skeletonFor === turnId || !shownDetail ? (
            <TurnDetailSkeleton />
          ) : (
            <TurnDetail
              turn={shownDetail}
              filmstripTurns={filmstripTurns.length > 0 ? filmstripTurns : undefined}
              onSelectTurn={handleSelectTurn}
              onPrevTurn={() => walk(-1)}
              onNextTurn={() => walk(1)}
              prevInputTokens={prevSameAgent?.inputTokens ?? null}
              prevInputMessagesCount={prevSameAgent?.inputMessagesCount ?? null}
              subagentLabel={subagentLabel}
            />
          )}
        </div>
      </div>
    </div>
  );
}
