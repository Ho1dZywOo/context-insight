// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 资产图标（应用图标范式）：框架 → 渐变色 + glyph 单点声明；彩色方块
// 即时可扫，取代列表内的类型徽标。调用侧传归一后的 icon id（解析含 -proxy
// 后缀的 framework、sourceType 兜底等归一逻辑在调用侧）。

import {
  SquareTerminalIcon,
  BotIcon,
  LayersIcon,
  CommandIcon,
  SparklesIcon,
  FlaskConicalIcon,
  BoxesIcon,
  FileJsonIcon,
  FileIcon,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export type AssetIconId =
  | 'opencode'
  | 'cannbot'
  | 'dsh'
  | 'codex'
  | 'claude-code'
  | 'brand'
  | 'run'
  | 'jsonl'
  | 'unknown';

const ICONS: Record<AssetIconId, { Icon: LucideIcon; grad: string }> = {
  opencode: { Icon: SquareTerminalIcon, grad: 'from-sky-500 to-blue-600' },
  cannbot: { Icon: BotIcon, grad: 'from-emerald-500 to-green-600' },
  dsh: { Icon: LayersIcon, grad: 'from-violet-500 to-purple-600' },
  codex: { Icon: CommandIcon, grad: 'from-slate-500 to-slate-700' },
  'claude-code': { Icon: SparklesIcon, grad: 'from-orange-400 to-amber-600' },
  brand: { Icon: FlaskConicalIcon, grad: 'from-purple-500 to-fuchsia-600' },
  run: { Icon: BoxesIcon, grad: 'from-indigo-500 to-violet-600' },
  jsonl: { Icon: FileJsonIcon, grad: 'from-neutral-400 to-neutral-600' },
  unknown: { Icon: FileIcon, grad: 'from-neutral-400 to-neutral-500' },
};

export function AssetIcon({ id, className, size = 'md' }: { id: AssetIconId; className?: string; size?: 'md' | 'sm' }) {
  const cfg = ICONS[id] ?? ICONS.unknown;
  const Icon = cfg.Icon;
  return (
    <span
      data-asset-icon={id}
      className={cn(
        'flex shrink-0 items-center justify-center rounded-[28%] bg-gradient-to-br text-white',
        'shadow-[0_1px_3px_rgba(0,0,0,0.18),0_6px_14px_-6px_rgba(0,0,0,0.28)]',
        size === 'md' ? 'size-10' : 'size-8',
        cfg.grad,
        className,
      )}
    >
      <Icon className={size === 'md' ? 'size-[18px]' : 'size-[15px]'} strokeWidth={2.2} />
    </span>
  );
}
