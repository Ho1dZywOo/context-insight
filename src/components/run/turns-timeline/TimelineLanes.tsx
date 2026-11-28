"use client";
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with
// the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See the License in the root of the software repository for the full text of the License.

// 时间线道行：全部条子——整条时间线里唯一「重」的子树。
// 两级 memo：外层 TimelineLanes 只把道逐个交给 memo 的 TimelineLane；内层每道
// 各自比较。选中轮落到哪道，就只有「上一选」与「当前选」两道重渲染，其余道
// 一根条子都不动——←/→ 连续走查、上百成员的 run 包上也是恒定开销。

import { memo } from "react";
import { SWIM_BAR_H, swimBarTop, swimLaneHeight, type SwimBar, type SwimLane } from "@/lib/swimlane-model";
import { cn } from "@/lib/utils";

/** 选中轮在本道条子上的落点（相对整段时长的百分比；已钳进条盒） */
export interface LaneSelection {
  barKey: string;
  /** 条子本色：选中环沿用道自己的颜色（不引入第二种色） */
  color: string;
  leftPct: number;
  widthPct: number;
  top: number;
}

export interface TimelineLanesProps {
  lanes: SwimLane[];
  /** 选中轮落在哪些道上（没有选中 / 轮不在任何条子上 = 空表） */
  selectionByLane: ReadonlyMap<string, LaneSelection>;
  /** 悬停条子（锚点 = 条子的视口矩形）；离开传 null */
  onHover: (bar: SwimBar | null, anchor: DOMRect | null) => void;
}

export const TimelineLanes = memo(function TimelineLanes({ lanes, selectionByLane, onHover }: TimelineLanesProps) {
  return (
    <div data-timeline-lanes>
      {lanes.map(lane => (
        <TimelineLane key={lane.key} lane={lane} selection={selectionByLane.get(lane.key) ?? null} onHover={onHover} />
      ))}
    </div>
  );
});

export const TimelineLane = memo(function TimelineLane({
  lane,
  selection,
  onHover,
}: {
  lane: SwimLane;
  selection: LaneSelection | null;
  onHover: (bar: SwimBar | null, anchor: DOMRect | null) => void;
}) {
  const rows = lane.rows;
  return (
    <div
      data-lane={lane.key}
      className={cn("relative border-b border-foreground/[0.06] last:border-b-0", lane.kind === "root" && "cursor-pointer")}
      style={{ height: swimLaneHeight(rows) }}
    >
      {lane.bars.map(bar => {
        const top = swimBarTop(rows, bar.row);
        return (
          <div
            key={bar.key}
            className="absolute inset-y-0"
            style={{ left: `${bar.startPct}%`, width: `${bar.widthPct}%` }}
          >
            {/* 底色 = turns 跨度（休眠段浅色）；hover 提亮到活跃段同色 */}
            <div
              data-bar={bar.key}
              className="absolute w-full cursor-pointer rounded-[3px] transition-opacity duration-150 hover:!opacity-90"
              style={{ top, height: SWIM_BAR_H, backgroundColor: bar.color, opacity: bar.failed ? 0.15 : 0.22 }}
              onMouseEnter={e => onHover(bar, e.currentTarget.getBoundingClientRect())}
              onMouseLeave={() => onHover(null, null)}
            />
            {bar.pieces.map((piece, i) => (
              <span
                key={i}
                data-bar-piece
                aria-hidden
                className="absolute rounded-[3px]"
                style={{
                  left: `${piece.leftPct}%`,
                  width: `${piece.widthPct}%`,
                  top,
                  height: SWIM_BAR_H,
                  backgroundColor: bar.color,
                  opacity: bar.failed ? 0.45 : 0.9,
                }}
              />
            ))}
          </div>
        );
      })}
      {/* 选中轮的时间窗：在本道的条子上套一圈选中环（本色 + 白色间隔 + 本色描边，
          换轮时位置与宽度平滑过渡）——横贯所有道的淡色竖带在覆盖层 */}
      {selection && (
        <span
          data-selected-turn
          aria-hidden
          className="pointer-events-none absolute z-[2] rounded-[3px] transition-[left,width] duration-200 ease-out motion-reduce:transition-none"
          style={{
            left: `${selection.leftPct}%`,
            width: `${selection.widthPct}%`,
            minWidth: 3,
            top: selection.top,
            height: SWIM_BAR_H,
            backgroundColor: selection.color,
            boxShadow: `0 0 0 1.5px var(--color-background), 0 0 0 3px ${selection.color}`,
          }}
        />
      )}
    </div>
  );
});
