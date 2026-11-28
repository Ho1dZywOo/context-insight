"use client";
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with
// the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See the License in the root of the software repository for the full text of the License.

// 时间线道行（memo）：全部条子与网格线——整条时间线里唯一「重」的子树。
// 它的 props 只有模型里的道与一个恒定的悬停回调：换选轮、播放头移动、悬停
// 浮窗开关、横向滚动（刻度与网格线在另一层）都不会让它重渲染（React.memo
// 浅比较即命中），←/→ 连续走查时 DOM 一根条子都不动，动的只有播放头。

import { memo } from "react";
import { SWIM_BAR_H, swimBarTop, swimLaneHeight, type SwimBar, type SwimLane } from "@/lib/swimlane-model";
import { cn } from "@/lib/utils";

export interface TimelineLanesProps {
  lanes: SwimLane[];
  /** 悬停条子（锚点 = 条子的视口矩形）；离开传 null */
  onHover: (bar: SwimBar | null, anchor: DOMRect | null) => void;
}

export const TimelineLanes = memo(function TimelineLanes({ lanes, onHover }: TimelineLanesProps) {
  return (
    <div data-timeline-lanes>
      {lanes.map(lane => {
        const rows = lane.rows;
        return (
          <div
            key={lane.key}
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
          </div>
        );
      })}
    </div>
  );
});
