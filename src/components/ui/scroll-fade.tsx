"use client";
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import { cn } from "@/lib/utils";

// 滚动渐隐容器：run-scroll-fade 的滚动感知伴生——mask 只在该侧真有滚出
// 视口的内容时出现（scrollTop>0 → 顶部渐隐；未滚到底 → 底部渐隐），静止
// 贴边行完整显示（此前无条件双向渐隐会把贴边首行晕染掉）。渐隐形态由
// data-fade 状态驱动（globals.css），本组件是其唯一合法书写方。
export function ScrollFade({
  as = "div",
  className,
  children,
  ...props
}: ComponentProps<"div"> & { as?: "div" | "aside" }) {
  const ref = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState<"none" | "top" | "bottom" | "top-bottom">("none");
  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const top = el.scrollTop > 0;
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    const next = top && bottom ? "top-bottom" : top ? "top" : bottom ? "bottom" : "none";
    setFade(prev => (prev === next ? prev : next));
  }, []);
  // 无依赖 effect：每次渲染后重估（子内容增删改变 scrollHeight）；
  // ResizeObserver 兜元素/视口尺寸变化（无实现或无布局环境跳过，恒 none）
  useEffect(() => {
    update();
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => update());
    ro.observe(el);
    return () => ro.disconnect();
  });
  const Comp = as as "div";
  return (
    <Comp ref={ref} data-fade={fade} onScroll={update} className={cn("run-scroll-fade", className)} {...props}>
      {children}
    </Comp>
  );
}
