"use client"
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { memo, useMemo, useState } from "react"
import { ChevronRightIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import type {
  AuditLayerInfo,
  CoverageSummary,
  TextCoverageSummary,
  TextCoverageUnit,
} from "@/lib/sift-audit-types"
import { matchFindingLayers } from "./verdictConfig"

/**
 * 声明覆盖总览（原文快照版）：对账时刻的声明原文（skill_body）整篇原文呈现，
 * 颜色直接涂在文本上——绿=已触达（该段指令全部被真实执行碰过）、黄=未验证
 * （有规则未触发或判不全，保守最低态）、灰=未建模（没抽出指令——说明文字或
 * 抽取盲区）。不做分段盒子、不插明细行：文档就是原文本身，色块即覆盖位置，
 * 悬停色块看该段指令摘要（含 root 组合声明归层）。
 *
 * 原文重建：以 skill_body 为基准，按单元顺序 indexOf 逐段消费（精确子串匹配，
 * 无偏移算术——Python 侧 code point 偏移与 JS UTF-16 code unit 不混用）；
 * 单元之间的间隙（空行、代码围栏）原样保留——快照逐字节可信。无 skill_body
 * 或匹配失配时回退单元顺序拼接（着色语义不变，仅丢失间隙排版）。
 *
 * 头部指标分报（含义不同不混）：指令覆盖 covered/total（碰过的指令/指令总数，条数
 * 口径）+ 文本覆盖 covered/total（涂绿文字字数/原文可着色文字总字数——字数口径，
 * 渲染端从 units 现算；单元计数会把一行 bullet 与整段代码块等量齐观，字数才是
 * 「原文文本被覆盖了多少」）+ 建模完整度 modeled/total（同字数口径）。heading
 * 是结构行（加粗、不着色、不计入字数分母）。默认收起，展开看整篇着色原文。
 */

const INSTR_ICON: Record<string, string> = {
  covered: "✓",
  uncovered: "○",
  unknown: "?",
}

const STATE_RUN: Record<string, { cls: string; chip: string; label: string; hint: string }> = {
  covered: {
    cls: "bg-emerald-500/15 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300",
    chip: "rounded bg-emerald-500/15 px-1 text-emerald-700 dark:text-emerald-300",
    label: "已触达",
    hint: "该段声明的指令全部被真实执行触达（守没守规悬停看指令摘要）",
  },
  uncovered: {
    cls: "bg-amber-500/20 text-amber-800 dark:bg-amber-500/25 dark:text-amber-200",
    chip: "rounded bg-amber-500/20 px-1 text-amber-800 dark:text-amber-200",
    label: "未验证",
    hint: "该段有指令但未触发或判不全（保守最低态：任一未验证即拉黄）",
  },
  unmodeled: {
    cls: "bg-muted/60 text-muted-foreground",
    chip: "rounded bg-muted/60 px-1 text-muted-foreground",
    label: "未建模",
    hint: "该段没有抽出任何指令——非规则文本或抽取盲区（不猜）",
  },
}

function ratePercent(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) return 0
  return Math.round(rate * 100)
}

/** 字数（code point 计数，emoji 记 1）——「原文文本覆盖率」的分母/分子口径。 */
function charCount(s: string): number {
  return [...s].length
}

function fmtChars(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n)
}

/** 着色单元的字数三态：绿字数 / 黄字数 / 灰字数（heading 结构行不计入）。 */
interface CharStats {
  covered: number
  uncovered: number
  unmodeled: number
  total: number
}

function charStatsOf(units: TextCoverageUnit[]): CharStats {
  let covered = 0
  let uncovered = 0
  let unmodeled = 0
  for (const u of units) {
    if (u.kind === "heading") continue
    const n = charCount(u.text)
    if (u.state === "covered") covered += n
    else if (u.state === "uncovered") uncovered += n
    else unmodeled += n
  }
  return { covered, uncovered, unmodeled, total: covered + uncovered + unmodeled }
}

/** 一个着色文本段：原文切片 + 三色 class + 悬停摘要。 */
interface Run {
  text: string
  cls: string
  title?: string
}

/** 单元悬停摘要：状态说明 + 指令逐条（含 root 归层标签）。 */
function unitTooltip(unit: TextCoverageUnit, layers?: AuditLayerInfo[]): string | undefined {
  const instrs = unit.instructions ?? []
  if (!instrs.length) {
    return unit.state ? STATE_RUN[unit.state]?.hint : undefined
  }
  const lines = instrs.map((i) => {
    const icon = INSTR_ICON[i.status] ?? "?"
    const matched = layers
      ? matchFindingLayers({ instruction_text: i.instruction_text, source_excerpt: undefined }, layers)
      : []
    const layerTxt = matched.length ? `（${matched.map((l) => l.label).join("/")}）` : ""
    return `${icon} ${i.headline || i.instruction_text}${layerTxt}`
  })
  const hint = unit.state ? STATE_RUN[unit.state]?.hint : ""
  return [hint, ...lines].filter(Boolean).join("\n")
}

function unitRun(unit: TextCoverageUnit, layers?: AuditLayerInfo[]): Run {
  if (unit.kind === "heading") {
    return { text: unit.text, cls: "font-bold text-foreground" }
  }
  const st = unit.state ? STATE_RUN[unit.state] : null
  return {
    text: unit.text,
    cls: st?.cls ?? "",
    title: unitTooltip(unit, layers),
  }
}

/**
 * 以 skill_body 为基准按序消费单元，重建整篇原文 + 着色段：
 * 间隙（空行/代码围栏等不属于任何单元的原文）以中性色原样保留。
 * 匹配失败（任一单元文本在剩余原文中找不到）→ 返回 null，调用方走拼接回退。
 */
function buildRuns(skillBody: string, units: TextCoverageUnit[], layers?: AuditLayerInfo[]): Run[] | null {
  const runs: Run[] = []
  let cursor = 0
  for (const u of units) {
    const idx = skillBody.indexOf(u.text, cursor)
    if (idx < 0) return null
    if (idx > cursor) runs.push({ text: skillBody.slice(cursor, idx), cls: "" })
    runs.push(unitRun(u, layers))
    cursor = idx + u.text.length
  }
  if (cursor < skillBody.length) runs.push({ text: skillBody.slice(cursor), cls: "" })
  return runs
}

/** 回退：无 skill_body / 匹配失配 → 单元顺序拼接（着色不变，间隙排版丢失）。 */
function fallbackRuns(units: TextCoverageUnit[], layers?: AuditLayerInfo[]): Run[] {
  return units.map((u) => {
    const r = unitRun(u, layers)
    return { ...r, text: r.text + (u.kind === "heading" ? "\n" : "\n\n") }
  })
}

/** 三段堆叠条（字数口径：绿/黄/灰字数之和 = 可着色文字总数；与指标瓦片同源）。 */
function StackedBar({ cs, w }: { cs: CharStats; w: string }) {
  const total = cs.total || 1
  return (
    <span className={cn("h-1.5 shrink-0 gap-px overflow-hidden rounded-full bg-foreground/[0.07]", w)}>
      <span className="h-full bg-emerald-500/70" style={{ width: `${(100 * cs.covered) / total}%` }} />
      <span className="h-full bg-amber-500/70" style={{ width: `${(100 * cs.uncovered) / total}%` }} />
      <span className="h-full bg-foreground/[0.14]" style={{ width: `${(100 * cs.unmodeled) / total}%` }} />
    </span>
  )
}

/** 标签上/值下的单指标瓦片。 */
function MetricTile({ label, hint, value, sub }: { label: string; hint: string; value: string; sub: string }) {
  return (
    <div className="min-w-0 flex-1 rounded-lg bg-foreground/[0.04] px-2.5 py-1.5 dark:bg-foreground/[0.06]">
      <div className="truncate text-[10px] font-medium text-muted-foreground" title={hint}>
        {label}
      </div>
      <div className="mt-0.5 truncate text-[15px] font-semibold leading-6 tracking-tight tabular-nums text-foreground">
        {value}
        <span className="ml-1 text-[11px] font-normal text-muted-foreground">{sub}</span>
      </div>
    </div>
  )
}

export const DeclarationCoverageOverview = memo(function DeclarationCoverageOverview({
  textCoverage,
  skillBody,
  coverage,
  layers,
}: {
  textCoverage?: TextCoverageSummary
  /** 对账时刻的声明原文快照（AuditReport.skill_body）；着色以此为基准。 */
  skillBody?: string
  coverage?: CoverageSummary
  layers?: AuditLayerInfo[]
}) {
  const [open, setOpen] = useState(false)
  const runs = useMemo(
    () =>
      textCoverage && textCoverage.total_units > 0
        ? skillBody
          ? buildRuns(skillBody, textCoverage.units, layers) ?? fallbackRuns(textCoverage.units, layers)
          : fallbackRuns(textCoverage.units, layers)
        : null,
    [textCoverage, skillBody, layers],
  )
  const cs = useMemo(() => charStatsOf(textCoverage?.units ?? []), [textCoverage])
  if (!runs) return null
  const tc = textCoverage!
  const pct = cs.total > 0 ? Math.round((100 * cs.covered) / cs.total) : 0
  const modeledPct = cs.total > 0 ? Math.round((100 * (cs.covered + cs.uncovered)) / cs.total) : 0
  const unmapped = tc.unmapped_instructions ?? []
  return (
    <div
      data-audit-text-coverage
      className="rounded-xl border border-foreground/[0.06]"
    >
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex w-full cursor-pointer items-center gap-2 px-3.5 py-2 text-left transition-colors hover:bg-accent/40"
      >
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/50 transition-transform duration-200 [transition-timing-function:cubic-bezier(0.32,0.72,0,1)]",
            open && "rotate-90",
          )}
        />
        <span className="text-[11.5px] font-medium text-foreground/90">声明覆盖</span>
        <span
          className="rounded-full bg-foreground/[0.05] px-1.5 py-0.5 text-[10px] leading-4 text-muted-foreground"
          title="对账时刻的声明原文快照，声明事后被编辑不影响本图"
        >
          原文快照
        </span>
        <span className="ml-auto flex items-center gap-2">
          <StackedBar cs={cs} w="hidden w-16 sm:flex" />
          <span
            className="shrink-0 tabular-nums text-[11px] text-muted-foreground"
            title={`原文文本覆盖率 = 涂绿字数 ${fmtChars(cs.covered)} / 可着色文字总字数 ${fmtChars(cs.total)}（标题行不计入）`}
          >
            {fmtChars(cs.covered)}/{fmtChars(cs.total)} · {pct}%
          </span>
        </span>
      </button>
      {open ? (
        <div className="animate-in fade-in slide-in-from-bottom-1 space-y-2.5 border-t border-foreground/[0.06] px-3.5 py-2.5 [animation-timing-function:cubic-bezier(0.32,0.72,0,1)]">
          {/* 指标分报（标签上/值下）：三种含义不同不混在一个数里 */}
          <div className="flex flex-wrap gap-2">
            {coverage && coverage.total > 0 ? (
              <MetricTile
                label="指令覆盖"
                hint="被执行碰过的指令 / 指令总数（对账口径，与下方判定列表同源）"
                value={`${coverage.covered}/${coverage.total}`}
                sub={`${ratePercent(coverage.coverage_rate)}%`}
              />
            ) : null}
            <MetricTile
              label="文本覆盖"
              hint="涂绿文字字数 / 原文可着色文字总字数（标题行不计入）——原文文本的覆盖率"
              value={`${fmtChars(cs.covered)}/${fmtChars(cs.total)}`}
              sub={`${pct}%`}
            />
            <MetricTile
              label="建模完整度"
              hint="已建模字数 / 可着色文字总字数——抽取质量的自我坦白（大段灰 = 该治理声明写法了）"
              value={`${fmtChars(cs.covered + cs.uncovered)}/${fmtChars(cs.total)}`}
              sub={`${modeledPct}% · 灰 ${fmtChars(cs.unmodeled)}`}
            />
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            <span className={STATE_RUN.covered.chip}>绿 已触达</span>
            <span>该段指令全部碰过</span>
            <span className="text-muted-foreground/40">·</span>
            <span className={STATE_RUN.uncovered.chip}>黄 未验证</span>
            <span>有规则未触发或判不全</span>
            <span className="text-muted-foreground/40">·</span>
            <span className={STATE_RUN.unmodeled.chip}>灰 未建模</span>
            <span>没抽出指令</span>
            <span className="ml-auto" title="色块悬停可见该段指令逐条摘要（含组合声明归层）">
              悬停色块看指令摘要
            </span>
          </div>
          {/* 原文快照：整篇原文一体的 pre，颜色直接涂在文本上（间隙/围栏原样保留） */}
          <pre className="max-h-[32rem] overflow-auto rounded-lg border border-foreground/[0.06] bg-background/70 p-3 font-mono text-[11px] leading-5 break-words whitespace-pre-wrap">
            {runs.map((r, i) => (
              <span key={i} className={r.cls} title={r.title}>
                {r.text}
              </span>
            ))}
          </pre>
          {unmapped.length > 0 ? (
            <details className="text-[11px] text-muted-foreground">
              <summary className="w-fit cursor-pointer select-none transition-colors hover:text-foreground">
                另有 {unmapped.length} 条指令未落回原文（如类别级参考查阅）
              </summary>
              <div className="mt-1 space-y-0.5 pl-3">
                {unmapped.map((t, i) => (
                  <div key={`${t}-${i}`} className="break-words">{t}</div>
                ))}
              </div>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  )
})
