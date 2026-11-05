// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 工作台外壳（IDE 形态）：视口即应用——整窗不滚动（h-dvh overflow-hidden），
// 内部面板各自滚动。骨架 = 左侧导航栏 + 主列（工具栏 / 内容滚动区 / 可选
// 底部折叠面板 / 状态栏）。DOM 上主列在侧栏之前（flex order 侧栏归位左侧），
// 保证顶栏回链/入口仍是文档流首匹配（IT 语义：Viewer / 本地洞察库 / Settings）。

import type { ReactNode } from 'react'
import Link from 'next/link'
import { LayersIcon, DatabaseIcon, SettingsIcon, type LucideIcon } from 'lucide-react'
import { BRAND_NAME } from '@/lib/branding'
import { VERSION_DISPLAY } from '@/lib/version'
import { BrandMark } from '@/components/BrandMark'
import { cn } from '@/lib/utils'

function NavItem({ active, icon: Icon, label, href, badge, anchor }: { active?: boolean; icon: LucideIcon; label: string; href: string; badge?: number; anchor?: boolean }) {
  const className = cn(
    'flex h-9 items-center gap-2.5 rounded-lg px-3 text-sm transition-colors duration-200',
    active
      ? 'bg-emerald-500/[0.09] font-medium text-emerald-700 dark:text-emerald-300'
      : 'text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground',
  )
  const inner = (
    <>
      <Icon className="size-4 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="ml-auto rounded-full bg-foreground/[0.06] px-1.5 py-px text-[10px] font-medium tabular-nums text-muted-foreground">{badge}</span>
      )}
    </>
  )
  return anchor
    ? <a href={href} className={className}>{inner}</a>
    : <Link href={href} className={className}>{inner}</Link>
}

function NavSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <p className="px-3 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/60">{label}</p>
      {children}
    </div>
  )
}

export function AppShell({
  active,
  assetBadge,
  toolbar,
  panel,
  statusBar,
  children,
}: {
  active: 'assets' | 'lake'
  /** 资产库导航角标（独立会话 + run 总量） */
  assetBadge?: number
  /** 工具栏（AppHeader：标题 + 动作位，固定 chrome 不滚动） */
  toolbar?: ReactNode
  /** 底部折叠面板（Recent Imports 等，IDE 终端面板位） */
  panel?: ReactNode
  /** 状态栏（IDE 底栏：数据源 / 版本 / 计数） */
  statusBar?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground">
      {/* 主列先于侧栏入 DOM（见文件头注释）；侧栏 flex order 归位左侧 */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* 环境光：品牌翡翠微晕自顶部晕开（Linear/Stripe 式氛围层，纯装饰，
            pointer-events-none 零交互成本；后续 chrome/面板均为半透明，光
            从层间透出形成深度） */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-0 h-72 bg-[radial-gradient(56%_100%_at_50%_0%,rgba(16,185,129,0.08),transparent_70%)]" />
        <div className="relative z-10 shrink-0">{toolbar}</div>
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="relative z-10 min-h-0 flex-1 overflow-y-auto">{children}</div>
          {panel}
        </div>
        {statusBar}
      </div>
      <aside className="order-first hidden w-60 shrink-0 flex-col border-r border-border/40 bg-gradient-to-b from-card/60 via-card/40 to-card/30 backdrop-blur-2xl lg:flex">
        {/* 品牌行：与工具栏同高（h-14），双栏 chrome 基线对齐 */}
        <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border/40 px-5">
          <BrandMark size="sm" />
          <span className="text-sm font-semibold tracking-tight text-foreground">{BRAND_NAME}</span>
          <span className="ml-auto rounded-full bg-foreground/[0.05] px-1.5 py-px text-[10px] font-medium text-muted-foreground">{VERSION_DISPLAY}</span>
        </div>
        <nav className="flex-1 overflow-y-auto px-3 pb-4">
          <NavSection label="Workbench">
            <NavItem active={active === 'assets'} icon={LayersIcon} label="资产库" href="/" badge={assetBadge} />
            <NavItem active={active === 'lake'} icon={DatabaseIcon} label="数据仓" href="/?src=lake" />
          </NavSection>
          <NavSection label="System">
            <NavItem icon={SettingsIcon} label="Settings" href="/settings" anchor />
          </NavSection>
        </nav>
      </aside>
    </div>
  )
}
