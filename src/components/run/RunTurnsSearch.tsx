"use client";
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Turns 搜索驻留面板（design: Trace 退役——搜索归 Turns，run 页与离线查看器共用）。
// ① 搜索胶囊（Turns 头部右端）：一框两语法——文本 Enter = 跨成员搜索；
// #数字 / 纯数字 = 轮次直达（run 级解析：服务端真相源，单候选直接跳、多会
// 话同号轮弹下钻选择，# 前缀输入期给即时提示）。胶囊正下方是锚定表面栈
// （下钻 > # 提示 > 未命中提示 > 最近搜索，同材质互斥）。⌘K / Ctrl+K 全局聚焦。
// ② 命中索引（玻璃浮层覆盖左列）：搜索驻留到用户主动关闭（✕ / Esc / 点
// Run 轨）——节点列表在玻璃后常驻虚化（滚动位置保留），命中索引以毛玻璃
// 卡片覆盖其上（覆盖感而非换页）。排查工作流里命中集是工作集，选中命中
// 打开 player 后列表不消失（结果与详情并排，无往返跳转）。首行标「起源」
// （当前视图内该词的最早出现），点开过的行降透明度（已读），驻留期间 ↑↓ + Enter 连续
// 走查命中（Spotlight 语法：输入未变时 Enter 打开活跃命中）。命中集内可按
// 来源 / thinking / 工具名单维过滤（旧 Trace 筛选面恢复，「全部」复位）。

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { SearchIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { highlightKeyword } from "@/lib/shared/highlight";
import { parseTurnsQuery } from "@/lib/observe/collectors/turns-query";
import type { TurnSearchItem } from "@/lib/observe/collectors/search";

export interface TurnsSearchState {
  keyword: string;
  loading: boolean;
  items: TurnSearchItem[];
  /** 全量命中数（服务端口径；> items.length 即截断，面板明示「已显示前 N」） */
  total: number;
}

const RECENT_KEY = "turns-search-recent";
const RECENT_MAX = 8;

function loadRecents(): string[] {
  try {
    const raw = sessionStorage.getItem(RECENT_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function saveRecent(kw: string) {
  try {
    const next = [kw, ...loadRecents().filter(k => k !== kw)].slice(0, RECENT_MAX);
    sessionStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* 存储不可用则放弃记忆 */
  }
}

function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    const s = String(d.getSeconds()).padStart(2, "0");
    return `${h}:${m}:${s}`;
  } catch {
    return "";
  }
}

const FIELD_TAG: Record<TurnSearchItem["matchField"], { label: string; cls: string }> = {
  content: { label: "正文", cls: "text-muted-foreground" },
  contentSummary: { label: "摘要", cls: "text-muted-foreground" },
  toolResult: { label: "工具结果", cls: "text-violet-600 dark:text-violet-400" },
  toolArgs: { label: "工具参数", cls: "text-violet-600 dark:text-violet-400" },
  toolError: { label: "工具错误", cls: "text-red-600 dark:text-red-400" },
  toolName: { label: "工具名", cls: "text-violet-600 dark:text-violet-400" },
};

// ── 命中过滤（旧 Trace 的 source/tools 筛选面恢复，run 页与离线查看器共用）──
// 多维 AND：来源六类（用户/模型/工具输出/派发/子代理/桥接返回，按命中轮的
// 角色与桥接事实分类）× 工具名（命中轮用过的工具全集，按命中数降序取前
// 12）× thinking（思维链非空）——各维内多选（OR）、跨维相与；「全部」复位。
// 键盘走查（↑↓/Enter）与过滤后列表对齐由父层 visible 序列保证。

const HIT_SOURCE_CONFIG = [
  { key: "user_input", label: "用户引入" },
  { key: "model_output", label: "模型产出" },
  { key: "tool_output", label: "工具输出" },
  { key: "root_agent_dispatch", label: "父agent指令" },
  { key: "subagent_output", label: "子agent产出" },
  { key: "bridge_response", label: "子agent返回" },
] as const;

type HitSourceKey = (typeof HIT_SOURCE_CONFIG)[number]["key"];

function classifyHitSource(item: TurnSearchItem, bridgeResponseTurnIds: ReadonlySet<string>): HitSourceKey {
  if (item.role === "user") return "user_input";
  if (item.role === "tool_result") return "tool_output";
  if (item.role === "assistant" && item.isSubagent) {
    return bridgeResponseTurnIds.has(item.turnId) ? "bridge_response" : "subagent_output";
  }
  if (item.role === "assistant" && item.hasDispatchBridge) return "root_agent_dispatch";
  return "model_output";
}

/** 过滤态（多维 AND）：各维数组为空 = 该维不筛；thinking 开关 */
export interface HitsFilterState {
  srcs: string[];
  tools: string[];
  thinking: boolean;
}

const EMPTY_HITS_FILTER: HitsFilterState = { srcs: [], tools: [], thinking: false };

function hitMatchesFilters(item: TurnSearchItem, filter: HitsFilterState, bridgeResponseTurnIds: ReadonlySet<string>): boolean {
  if (filter.srcs.length > 0 && !filter.srcs.includes(classifyHitSource(item, bridgeResponseTurnIds))) return false;
  if (filter.tools.length > 0 && !(item.toolNames ?? []).some(tn => filter.tools.includes(tn))) return false;
  if (filter.thinking && !((item.reasoningTokens ?? 0) > 0)) return false;
  return true;
}

export interface HitFilterOption {
  key: string;
  label: string;
  count: number;
}

/** 命中索引的过滤状态机：父层持有（键盘走查的活跃序号须与过滤后列表对齐） */
export function useTurnsHitsFilter(items: TurnSearchItem[], bridgeResponseTurnIds: ReadonlySet<string>) {
  const [filter, setFilter] = useState<HitsFilterState>(EMPTY_HITS_FILTER);

  const sourceOptions = useMemo(() => {
    const counts = new Map<HitSourceKey, number>();
    for (const item of items) {
      const key = classifyHitSource(item, bridgeResponseTurnIds);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return HIT_SOURCE_CONFIG
      .filter(cfg => (counts.get(cfg.key) ?? 0) > 0)
      .map(cfg => ({ key: `src:${cfg.key}`, label: cfg.label, count: counts.get(cfg.key)! }));
  }, [items, bridgeResponseTurnIds]);

  const thinkingOption = useMemo(() => {
    const n = items.filter(item => (item.reasoningTokens ?? 0) > 0).length;
    return n > 0 ? { key: "thinking", label: "thinking", count: n } : null;
  }, [items]);

  const toolOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) {
      for (const tn of item.toolNames ?? []) counts.set(tn, (counts.get(tn) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([name, count]) => ({ key: `tool:${name}`, label: name, count }));
  }, [items]);

  /** 维内翻转（再点取消）、跨维并存；「全部」即整体复位 */
  const toggle = useCallback((key: string) => {
    setFilter(prev => {
      if (key === "thinking") return { ...prev, thinking: !prev.thinking };
      if (key.startsWith("src:")) {
        const v = key.slice(4);
        return { ...prev, srcs: prev.srcs.includes(v) ? prev.srcs.filter(x => x !== v) : [...prev.srcs, v] };
      }
      if (key.startsWith("tool:")) {
        const v = key.slice(5);
        return { ...prev, tools: prev.tools.includes(v) ? prev.tools.filter(x => x !== v) : [...prev.tools, v] };
      }
      return prev;
    });
  }, []);

  const reset = useCallback(() => setFilter(EMPTY_HITS_FILTER), []);

  const visible = useMemo(
    () => items.filter(item => hitMatchesFilters(item, filter, bridgeResponseTurnIds)),
    [items, filter, bridgeResponseTurnIds],
  );

  /** 任一维在场（「全部」胶囊的激活态与计数切换） */
  const anyActive = filter.srcs.length > 0 || filter.tools.length > 0 || filter.thinking;

  return { filter, toggle, reset, visible, anyActive, sourceOptions, thinkingOption, toolOptions };
}

/** #N 直达解析出的候选（run 级）：成员归因 + 轮次摘要（下钻选择行预览） */
export interface TurnJumpMatch {
  turnId: string;
  memberTaskId: string;
  memberLabel: string;
  contentSummary?: string | null;
}

/** #N 直达的解析结果（run 级）：found=false 全 run 无该轮；单候选由胶囊
 *  直接跳转，多候选（多会话同号轮）弹出下钻列表由用户选择——不静默跳 */
export interface TurnJumpOutcome {
  found: boolean;
  matches?: TurnJumpMatch[];
  /** 当前会话（播放器所在成员）——下钻列表置顶与「当前」徽标依据 */
  currentMemberTaskId?: string | null;
}

export function TurnSearchField({ state, hitCount, onSearch, onExit, onJumpIndex, onJumpTurn, onStepHit, onOpenHit }: {
  /** 驻留搜索态（null = 空闲——胶囊仅作入口） */
  state: TurnsSearchState | null;
  hitCount: number;
  onSearch: (kw: string) => void;
  onExit: () => void;
  /** #N 直达（run 级解析，异步）：返回候选集——单候选胶囊直接跳，多候选弹下钻 */
  onJumpIndex: (idx: number) => TurnJumpOutcome | Promise<TurnJumpOutcome>;
  /** 执行跳转（解析与呈现分离——胶囊只管语法与选择，跳转动作归宿主） */
  onJumpTurn: (turnId: string) => void;
  onStepHit: (dir: 1 | -1) => void;
  onOpenHit: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [recents, setRecents] = useState<string[]>(() => loadRecents());
  // #N 下钻选择面：多会话同号轮的候选列表（键盘 ↑↓/Enter、Esc/外点关闭）
  const [jumpPicker, setJumpPicker] = useState<{ index: number; matches: TurnJumpMatch[]; currentMemberTaskId: string | null } | null>(null);
  const [pickerIdx, setPickerIdx] = useState(0);
  const pickerRef = useRef<HTMLDivElement>(null);
  // # 前缀即时提示（输入期引导，无取数）：刚敲下 # 还没输序号时告诉用户
  // 这个语法做什么；序号一旦开始输即让位（引导不是驻留物）
  const indexHint = value.trim() === "#";
  const closePicker = useCallback(() => {
    setJumpPicker(null);
    setPickerIdx(0);
  }, []);

  // 驻留关键词同步进输入框（改词重搜后回显最新词）；退出清空并复位提示
  const dockedKw = state?.keyword ?? null;
  const [prevDocked, setPrevDocked] = useState(dockedKw);
  if (prevDocked !== dockedKw) {
    setPrevDocked(dockedKw);
    setValue(dockedKw ?? "");
    setNote(null);
    closePicker();
  }

  // 下钻面外点关闭（行按下不抢焦点，外点才收）
  useEffect(() => {
    if (!jumpPicker) return;
    const h = (e: MouseEvent) => {
      if (!pickerRef.current?.contains(e.target as Node)) closePicker();
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [jumpPicker, closePicker]);

  // ⌘K / Ctrl+K 全局聚焦
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const submit = async () => {
    const v = value.trim();
    if (!v) return;
    // 语法二：#数字 / 纯数字 = 轮次直达（run 级解析：服务端跨成员定位该轮
    // 次号）。单候选直接跳；多候选（多会话同号轮）弹出下钻列表由用户选择
    if (/^#?\d+$/.test(v)) {
      const idx = Number(v.replace(/^#/, ""));
      try {
        const outcome = await onJumpIndex(idx);
        const matches = outcome.matches ?? [];
        if (!outcome.found || matches.length === 0) {
          setNote(`未找到第 ${idx} 轮`);
        } else if (matches.length === 1) {
          onJumpTurn(matches[0].turnId);
        } else {
          // 当前会话置顶（连续走查意图）+「当前」徽标；其余按成员序
          const current = outcome.currentMemberTaskId;
          const sorted = current == null
            ? matches
            : [...matches].sort((a, b) => Number(b.memberTaskId === current) - Number(a.memberTaskId === current));
          setNote(null);
          setPickerIdx(0);
          setJumpPicker({ index: idx, matches: sorted, currentMemberTaskId: current ?? null });
        }
      } catch {
        setNote(`未找到第 ${idx} 轮`);
      }
      return;
    }
    saveRecent(v);
    setRecents(loadRecents());
    setNote(null);
    onSearch(v);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    // 下钻面键盘导航：↑↓ 走行、Enter 选行、Esc 关闭（打开期间优先于搜索态）
    if (jumpPicker) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = jumpPicker.matches.length;
        setPickerIdx(i => (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
        return;
      }
      if (e.key === "Enter") {
        const m = jumpPicker.matches[pickerIdx];
        if (m) {
          onJumpTurn(m.turnId);
          closePicker();
        }
        return;
      }
      if (e.key === "Escape") {
        closePicker();
        return;
      }
    }
    if (e.key === "Enter") {
      // Spotlight 语法：驻留中且输入未变 = 打开活跃命中；否则提交新搜索
      if (state && value.trim() === state.keyword) onOpenHit();
      else submit();
      return;
    }
    if (e.key === "Escape" && note) {
      setNote(null);
      return;
    }
    if (e.key === "Escape" && state) {
      onExit();
      inputRef.current?.blur();
      return;
    }
    if (state && hitCount > 0 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      onStepHit(e.key === "ArrowDown" ? 1 : -1);
    }
  };

  return (
    <div className="relative shrink-0">
      <div
        className={cn(
          "flex h-7 w-[190px] items-center gap-1.5 rounded-full border bg-muted/40 pl-2.5 pr-1.5 transition-colors duration-200",
          state
            ? "border-primary/40 bg-primary/[0.05]"
            : "border-foreground/[0.09] focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/15",
        )}
      >
        <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          data-turns-search-input
          className="h-full min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/70"
          placeholder="搜索本 run…"
          aria-label="搜索本 run"
          value={value}
          onChange={e => {
            setValue(e.target.value);
            setNote(null);
            closePicker();
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
        />
        {state && (
          <button
            type="button"
            data-search-exit
            className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground/80 transition-colors hover:bg-foreground/[0.08] hover:text-foreground"
            onMouseDown={e => e.preventDefault()}
            onClick={onExit}
            title="退出搜索，返回节点列表"
          >
            <XIcon className="size-3" />
          </button>
        )}
      </div>

      {/* 锚定表面（胶囊正下方，互斥优先级：下钻 > # 提示 > 未命中提示 >
          最近搜索）。#N 系表面用振实毛玻璃（bg-card/60 + blur-2xl +
          saturate-150——底透才磨得出背景，饱和度补偿让前景色彩保持鲜活），
          动效纯 CSS */}

      {/* #N 下钻选择面：多会话同号轮的用户选择（不静默跳）。当前会话置顶
          + 徽标；行 = 成员点 + 名称 + 摘要预览；键盘 ↑↓/Enter、Esc/外点关闭 */}
      {jumpPicker && (
        <div
          ref={pickerRef}
          data-jump-picker
          className="absolute right-0 top-[calc(100%+6px)] z-30 w-[300px] animate-in fade-in slide-in-from-top-1 duration-150 overflow-hidden rounded-xl border border-border/70 bg-card/60 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_16px_40px_-24px_rgba(0,0,0,0.28)] backdrop-blur-2xl backdrop-saturate-150"
        >
          <div className="flex items-center justify-between px-3 pb-1 pt-2.5">
            <span className="text-[10px] text-muted-foreground/70">
              第 {jumpPicker.index} 轮 · {jumpPicker.matches.length} 个会话命中
            </span>
            <span
              role="button"
              tabIndex={0}
              className="cursor-pointer rounded-full px-1.5 py-px text-[10px] text-muted-foreground/70 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
              onMouseDown={e => e.preventDefault()}
              onClick={closePicker}
            >
              esc 关闭
            </span>
          </div>
          <div className="max-h-[240px] overflow-y-auto pb-1.5">
            {jumpPicker.matches.map((m, i) => (
              <button
                key={m.turnId}
                type="button"
                data-jump-item={m.turnId}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors duration-100",
                  i === pickerIdx ? "bg-accent" : "hover:bg-accent/50",
                )}
                onMouseDown={e => e.preventDefault()}
                onClick={() => {
                  onJumpTurn(m.turnId);
                  closePicker();
                }}
              >
                <span className="size-1.5 shrink-0 rounded-full bg-primary/70" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-1.5">
                    <span className="truncate text-[11px] font-medium text-foreground">{m.memberLabel}</span>
                    {m.memberTaskId === jumpPicker.currentMemberTaskId && (
                      <span className="shrink-0 rounded-full bg-primary/10 px-1 py-px text-[9px] leading-none text-primary">当前</span>
                    )}
                  </span>
                  {m.contentSummary && (
                    <span className="block truncate text-[10px] leading-relaxed text-muted-foreground/80">{m.contentSummary}</span>
                  )}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* # 前缀即时提示：输入期引导（无取数）——告诉用户这个语法做什么 */}
      {!jumpPicker && !note && indexHint && (
        <div
          data-jump-hint
          className="absolute right-0 top-[calc(100%+6px)] z-30 flex items-center gap-2 animate-in fade-in slide-in-from-top-1 duration-150 rounded-full border border-border/70 bg-card/60 px-3 py-1.5 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_16px_40px_-24px_rgba(0,0,0,0.28)] backdrop-blur-2xl backdrop-saturate-150"
        >
          <span className="text-[11px] font-semibold text-primary/80">#</span>
          <span className="text-[11px] text-muted-foreground">请输入轮次序号，Enter 直达 · 多会话同号轮将给出选择</span>
        </div>
      )}

      {/* 未命中提示（error 红）：下次输入即消，Esc 可关 */}
      {!jumpPicker && note && (
        <p
          data-search-note
          className="absolute right-0 top-[calc(100%+6px)] z-30 animate-in fade-in slide-in-from-top-1 duration-150 rounded-lg border border-border/70 bg-card px-2.5 py-1.5 text-[11px] text-red-600 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_16px_40px_-24px_rgba(0,0,0,0.28)] dark:text-red-400"
        >
          {note}
        </p>
      )}

      {/* 聚焦气泡：最近搜索 + 语法提示（毛玻璃、失焦即收；有提示让位） */}
      {focused && recents.length > 0 && !note && !jumpPicker && !indexHint && (
        <div className="absolute right-0 top-[calc(100%+6px)] z-30 w-[300px] animate-in fade-in slide-in-from-top-1 duration-150 rounded-xl border border-border/70 bg-card/95 p-2.5 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_16px_40px_-24px_rgba(0,0,0,0.28)] backdrop-blur-xl">
          <div className="flex flex-wrap gap-1">
            {recents.map(kw => (
              <button
                key={kw}
                type="button"
                className="max-w-[130px] cursor-pointer truncate rounded-full bg-foreground/[0.05] px-2 py-0.5 text-[11px] text-foreground/75 transition-colors hover:bg-foreground/[0.1]"
                // 按下不抢焦点（气泡点击不致失焦收起）
                onMouseDown={e => e.preventDefault()}
                onClick={() => {
                  saveRecent(kw);
                  setRecents(loadRecents());
                  onSearch(kw);
                }}
              >
                {kw}
              </button>
            ))}
          </div>
          <p className="px-1 pt-1.5 text-[10px] leading-relaxed text-muted-foreground/70">
            空格多词 AND · -词 排除 · “短语” · #数字 直达轮次 · ⌘K 聚焦
            <br />
            算子：role:user · agent:/member:/tool:名字 · error:true · thinking:&gt;5k · dur:&gt;10s · after:/before:15:30
          </p>
        </div>
      )}
    </div>
  );
}

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      data-hit-filter={label}
      className={cn(
        "shrink-0 cursor-pointer rounded-full border px-1.5 py-px text-[10px] transition-colors",
        active
          ? "border-primary/40 bg-primary/10 font-medium text-primary"
          : "border-foreground/[0.08] text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground",
      )}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

export function TurnHitsPanel({ state, hits, activeIdx, selectedTurnId, visited, onSelect, onExit, filter, onToggle, onReset, anyActive, sourceOptions, thinkingOption, toolOptions }: {
  state: TurnsSearchState;
  /** 过滤后的命中集（父层经 useTurnsHitsFilter 收窄——键盘走查与之对齐） */
  hits: TurnSearchItem[];
  activeIdx: number;
  selectedTurnId: string | null;
  visited: ReadonlySet<string>;
  onSelect: (item: TurnSearchItem) => void;
  onExit: () => void;
  filter: HitsFilterState;
  onToggle: (key: string) => void;
  onReset: () => void;
  anyActive: boolean;
  sourceOptions: HitFilterOption[];
  thinkingOption: HitFilterOption | null;
  toolOptions: HitFilterOption[];
}) {
  // 正文本词解析单点（多词/引号词全量高亮；算子与负词不参与文本定位）
  const positiveTerms = useMemo(() => parseTurnsQuery(state.keyword).positiveTerms, [state.keyword]);
  return (
    // 玻璃浮层覆盖左列：节点列表在玻璃后虚化常驻（父层保持挂载并 inert），
    // 卡片全幅盖满左列（列表滚动条一并压进玻璃下，被盖列表 inert 期间滚动
    // 条直接隐藏——圆角缺口不探尖角），外溢投影 + 圆角读作浮层覆盖而非换
    // 页；卡片材质与 Turn 播放器顶部导航条同一配方（bg-muted/40 +
    // backdrop-blur-xl，零新调色），头部与过滤钉顶、行区滚动（mask 边缘
    // 渐隐），入场 = 左缘轻移淡入
    <div data-turns-hits className="turns-hits-in absolute inset-0 z-10">
      <div className="flex h-full min-h-0 flex-col rounded-2xl border border-foreground/[0.07] bg-muted/40 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_24px_56px_-24px_rgba(0,0,0,0.28)] backdrop-blur-xl">
        <div className="flex shrink-0 items-center gap-2 px-3 pb-1 pt-3">
          <p className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground/85">“{state.keyword}”</span>
            {state.loading
              ? " 搜索中…"
              : ` · ${hits.length} 个命中`
                + (anyActive ? ` / 共 ${state.items.length}` : "")
                + (state.total > state.items.length ? `（已显示前 ${state.items.length} / 共 ${state.total}）` : "")}
          </p>
          <button
            type="button"
            data-hits-exit
            className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.08] hover:text-foreground"
            onClick={onExit}
            title="退出搜索，返回节点列表"
          >
            <XIcon className="size-3.5" />
          </button>
        </div>

        {/* 过滤面（旧 Trace 筛选恢复）：来源 × 工具 × thinking 多维 AND、
            维内多选（再点取消）、「全部」整体复位 */}
        {!state.loading && state.items.length > 0 && (
          <div className="flex shrink-0 flex-col gap-1 border-b border-foreground/[0.06] px-3 pb-2">
            <div className="flex flex-wrap items-center gap-1">
              <span className="w-7 shrink-0 text-[10px] text-muted-foreground/70">来源</span>
              <FilterChip label={`全部 ${state.items.length}`} active={!anyActive} onClick={onReset} />
              {sourceOptions.map(o => (
                <FilterChip
                  key={o.key}
                  label={`${o.label} ${o.count}`}
                  active={filter.srcs.includes(o.key.slice(4))}
                  onClick={() => onToggle(o.key)}
                />
              ))}
              {thinkingOption && (
                <FilterChip
                  label={`thinking ${thinkingOption.count}`}
                  active={filter.thinking}
                  onClick={() => onToggle(thinkingOption.key)}
                />
              )}
            </div>
            {toolOptions.length > 0 && (
              <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
                <span className="w-7 shrink-0 text-[10px] text-muted-foreground/70">工具</span>
                {toolOptions.map(o => (
                  <FilterChip
                    key={o.key}
                    label={`${o.label} ${o.count}`}
                    active={filter.tools.includes(o.key.slice(5))}
                    onClick={() => onToggle(o.key)}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        <div className="run-scroll-fade flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-2 pb-2 pt-1.5">
          {state.loading ? (
            [0, 1, 2].map(i => (
              <div key={i} className="flex animate-pulse flex-col gap-1.5 rounded-lg px-2.5 py-2">
                <div className="h-3 w-1/3 rounded bg-foreground/[0.06]" />
                <div className="h-3 w-full rounded bg-foreground/[0.04]" />
                <div className="h-3 w-2/3 rounded bg-foreground/[0.04]" />
              </div>
            ))
          ) : hits.length === 0 ? (
            <p className="px-2 py-8 text-center text-xs text-muted-foreground">
              {state.items.length === 0 ? "无命中——换个关键词试试" : "当前过滤条件下无命中"}
            </p>
          ) : (
            hits.map((item, i) => (
              <button
                key={`${item.turnId}-${item.matchField}-${i}`}
                type="button"
                data-hit={item.turnId}
                className={cn(
                  "flex cursor-pointer flex-col gap-1 rounded-lg px-2.5 py-2 text-left transition-colors",
                  i === activeIdx ? "bg-accent/60" : "hover:bg-accent/40",
                  visited.has(item.turnId) && item.turnId !== selectedTurnId && "opacity-55",
                )}
                onClick={() => onSelect(item)}
              >
                <div className="flex min-w-0 items-center gap-1.5 text-[11px]">
                  {i === 0 && (
                    <span className="shrink-0 rounded-full bg-emerald-500/10 px-1.5 py-px text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                      起源
                    </span>
                  )}
                  <span className="shrink-0 font-mono text-muted-foreground tabular-nums">#{item.turnIndex}</span>
                  {item.member?.label && (
                    <span className="max-w-[90px] shrink-0 truncate rounded bg-primary/[0.07] px-1.5 py-px text-[10px] text-foreground/70">
                      {item.member.label}
                    </span>
                  )}
                  <span className={cn("shrink-0", FIELD_TAG[item.matchField].cls)}>{FIELD_TAG[item.matchField].label}</span>
                  {item.isSubagent && (
                    <span className="max-w-[100px] shrink-0 truncate text-[10px] text-muted-foreground">
                      {item.subagentName ?? "subagent"}
                    </span>
                  )}
                  <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">{formatTime(item.createdAt)}</span>
                </div>
                <p className="line-clamp-2 text-xs leading-relaxed text-foreground/80">
                  {highlightKeyword(item.matchContext, positiveTerms)}
                </p>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
