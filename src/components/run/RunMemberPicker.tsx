"use client";
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// run 工作台成员选择（design: docs/design/run-first-architecture/design.md
// §3.4，刀I2，自 RunAuditTab 抽取复用）。成员域能力（Wire 轮次 / Score 卡 /
// Replay / Skill 审计）的数据约束是单会话——多成员 run 须先选成员（执行目标
// 选择，非观看过滤，对齐 Audit sift 先例）；solo/单成员 run 由调用方免渲染。
// allLabel 提供时多一枚「全部」chip（Audit 的发现合并视图），此时再点当前
// 成员可取消回全部；不提供时成员必选（点击当前成员为 no-op）。
// 形态：凹槽轨道 × 浮起卡舌——单行横向滚动不折行（成员再多也只占一行），
// 选中成员是浮在轨道上的白卡舌，与 Audit 域导航同款语法。可滚动方向以
// mask 边缘渐隐提示（任意底色可用），活跃卡舌自动滚入视野，悬停时纵向
// 滚轮转为轨道横向滚动（鼠标用户的直达路径）；成员量大时（>8）轨道头
// 挂搜索胶囊——输入即过滤，直达任意成员，轨道尾挂计数（视口里只是子集这
// 件事必须可见）。

import { useEffect, useRef, useState } from "react";
import { SearchIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RunMemberRow } from "@/lib/run/member-rows";

export interface RunMemberPickerProps {
  members: RunMemberRow[];
  value: string | null;
  onChange: (member: string | null) => void;
  /** 提供时渲染「全部」chip（value=null 选中）；缺省时成员必选。 */
  allLabel?: string;
}

export function RunMemberPicker({ members, value, onChange, allLabel }: RunMemberPickerProps) {
  const [query, setQuery] = useState("");
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  // 可滚动方向的边缘渐隐：滚动/尺寸变化时按 scrollLeft/scrollWidth 现算
  // mask（rAF 节流；mask 对任意底色成立，不挑宿主背景）。同时接管悬停时
  // 的纵向滚轮——轨道能横滚就转成横向增量，滚不动了交还页面
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const update = () => {
      const sl = scroller.scrollLeft;
      const left = sl > 4;
      const right = sl + scroller.clientWidth < scroller.scrollWidth - 4;
      const mask = left || right
        ? `linear-gradient(to right, ${left ? "transparent" : "#000"} 0, #000 24px, #000 calc(100% - 24px), ${right ? "transparent" : "#000"} 100%)`
        : "none";
      scroller.style.webkitMaskImage = mask;
      scroller.style.maskImage = mask;
    };
    let raf = 0;
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    const onWheel = (e: WheelEvent) => {
      const max = scroller.scrollWidth - scroller.clientWidth;
      if (max <= 0 || e.deltaY === 0) return;
      const before = scroller.scrollLeft;
      scroller.scrollLeft = Math.max(0, Math.min(max, before + e.deltaY));
      if (scroller.scrollLeft !== before) e.preventDefault();
    };
    update();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    scroller.addEventListener("wheel", onWheel, { passive: false });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(onScroll) : null;
    ro?.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("wheel", onWheel);
      ro?.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // 活跃卡舌可达性：溢出时滚入视野（手动 scrollLeft 数学；block 维度不碰——
  // 页面各 tab 自滚动，scrollIntoView 可能惊动外层）
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const pill = scroller.querySelector<HTMLButtonElement>(`[data-member-pill="${value ?? "__all__"}"]`);
    if (!pill) return;
    const l = pill.offsetLeft;
    const r = l + pill.offsetWidth;
    const sl = scroller.scrollLeft;
    if (l < sl + 8) scroller.scrollTo?.({ left: Math.max(0, l - 8), behavior: "smooth" });
    else if (r > sl + scroller.clientWidth - 8) scroller.scrollTo?.({ left: r - scroller.clientWidth + 8, behavior: "smooth" });
  }, [value, members, query]);

  if (members.length < 2 && allLabel == null) return null;
  const norm = query.trim().toLowerCase();
  const shown = norm
    ? members.filter(m => m.displayName.toLowerCase().includes(norm) || m.taskId.toLowerCase().includes(norm))
    : members;
  const searchable = members.length > 8;
  const pill = (isActive: boolean) =>
    cn(
      "max-w-[200px] shrink-0 cursor-pointer truncate rounded-full px-2.5 py-1 text-xs font-medium",
      "transition-[background-color,box-shadow,color,transform] duration-200 [transition-timing-function:cubic-bezier(0.32,0.72,0,1)] active:scale-[0.97]",
      isActive
        ? "bg-card text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.06),0_6px_16px_-8px_rgba(0,0,0,0.22)] ring-1 ring-foreground/[0.06]"
        : "text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground",
    );
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      {searchable && (
        <label className="flex h-7 w-28 shrink-0 items-center gap-1.5 rounded-full bg-card px-2.5 ring-1 ring-foreground/[0.06] transition-[width] duration-200 [transition-timing-function:cubic-bezier(0.32,0.72,0,1)] focus-within:w-44">
          <SearchIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
          <input
            data-member-search
            aria-label="搜索成员"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Escape") {
                setQuery("");
                (e.target as HTMLInputElement).blur();
              }
            }}
            placeholder="搜成员"
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
          />
        </label>
      )}
      <div
        ref={scrollerRef}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto rounded-full bg-foreground/[0.03] p-1 dark:bg-foreground/[0.05] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {allLabel != null && (
          <button type="button" data-member-pill="__all__" className={pill(value == null)} onClick={() => onChange(null)}>
            {allLabel}
          </button>
        )}
        {shown.map(m => (
          <button
            key={m.taskId}
            type="button"
            title={m.taskId}
            data-member-pill={m.taskId}
            className={pill(value === m.taskId)}
            onClick={() => {
              if (m.taskId === value) {
                if (allLabel != null) onChange(null);
              } else {
                onChange(m.taskId);
              }
            }}
          >
            {m.displayName}
          </button>
        ))}
        {shown.length === 0 && <span className="px-2 text-xs text-muted-foreground">无匹配成员</span>}
      </div>
      {members.length > 8 && (
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground" title="成员总数">
          {norm ? `${shown.length}/` : ""}{members.length}
        </span>
      )}
    </div>
  );
}
