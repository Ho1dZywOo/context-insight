"use client"
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.

import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { CheckCircle2Icon, AlertCircleIcon, BookOpenIcon, Loader2Icon } from "lucide-react"
import { useSkillContentAudit, type SkillContentAuditItem } from "@/components/observe/use-skill-content-audit"
import type { ViewUrlFor } from "@/lib/observe/member-url"
import { describeLineEvidence } from "@/lib/skill-evidence"
import { CODEX_LIMIT_ADVICE } from "@/lib/tool-output-truncation"
import { skillSourceLabel } from "@/components/observe/SkillSourceView"

interface SkillContentAuditProps {
  taskId: string
  /** 表格里的 skill 名顺序，用于按表格顺序展示校验 chip；未提供时用接口返回顺序。 */
  skillNames?: string[]
  /** 点击某个 skill chip 时触发（由 SkillDetail 接到 sc.fetchOne + 展开该行）。 */
  onView?: (skillName: string) => void
  urlFor?: ViewUrlFor
}

export function SkillContentAudit({ taskId, skillNames, onView, urlFor }: SkillContentAuditProps) {
  const { items, loading, error } = useSkillContentAudit(taskId, undefined, urlFor)

  if (loading) {
    return (
      <Card size="sm">
        <CardContent className="py-3 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2Icon className="size-3.5 animate-spin" />
          正在校验 Skill 加载情况…
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card size="sm">
        <CardContent className="py-3 flex items-center gap-2 text-xs text-destructive">
          <AlertCircleIcon className="size-3.5" />
          校验失败：{error}
        </CardContent>
      </Card>
    )
  }

  if (items.length === 0) {
    return null
  }

  const ordered = skillNames
    ? [...items].sort((a, b) => {
        const ia = skillNames.indexOf(a.skillName)
        const ib = skillNames.indexOf(b.skillName)
        return (ia === -1 ? Infinity : ia) - (ib === -1 ? Infinity : ib)
      })
    : items

  const fullCount = items.filter(i => i.hasContent && i.fullRead).length
  const partialCount = items.filter(i => i.hasContent && !i.fullRead).length
  const missCount = items.filter(i => !i.hasContent).length

  type Status = "full" | "partial" | "missing"
  function statusOf(i: SkillContentAuditItem): Status {
    if (!i.hasContent) return "missing"
    return i.fullRead ? "full" : "partial"
  }

  return (
    <Card size="sm">
      <CardContent className="py-3 space-y-2.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold">
            <BookOpenIcon className="size-3.5" />
            Skill 加载校验
          </span>
          <span className="text-xs text-muted-foreground">
            检查每个 skill 是否在会话内读到完整 SKILL.md：Skill 工具注入即全文；Read/Shell 读取需文件总行数可知且每行都有可靠内容才判为全文，否则为部分读取并标出未读的行
            </span>
          {fullCount > 0 && <Badge variant="green" className="text-xs">{fullCount} 全文</Badge>}
          {partialCount > 0 && <Badge variant="orange" className="text-xs">{partialCount} 部分</Badge>}
          {missCount > 0 && <Badge variant="gray" className="text-xs">{missCount} 未读</Badge>}
          <Badge variant="outline" className="text-xs">{items.length} skills</Badge>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {ordered.map(item => {
            const st = statusOf(item)
            const tone = st === "full"
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20"
              : st === "partial"
                ? "border-orange-500/40 bg-orange-500/10 text-orange-700 dark:text-orange-300 hover:bg-orange-500/20"
                : "border-zinc-400/40 bg-zinc-400/10 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-400/20"
            const channel = skillSourceLabel(item.source)
            const notice = describeLineEvidence(item.evidence, item.fullRead, item.source === "shell" ? CODEX_LIMIT_ADVICE : "")
            const injected = item.source === "skill-tool" || item.source === "command"
            const tip = st === "full"
              ? `全文 · ${channel}（${injected ? "框架注入完整 SKILL.md" : "会话内读到的行拼齐了整个文件"}）· ${item.length} 字符 / ${item.lines} 行`
              : st === "partial"
                ? `部分读取 · ${channel} · ${notice.summary} · ${notice.detail}`
                : `未读取 · 未捕获到 SKILL.md 正文（该 skill 仅被调用未注入，或未通过 Skill 工具/Read/Shell 读取加载）`
            const covered = item.evidence?.lineNumbers.length ?? item.lines
            const coverageLabel = item.evidence?.fileLines != null ? `${covered}/${item.evidence.fileLines}` : `${covered}`
            return (
              <Tooltip key={item.skillName}>
                <TooltipTrigger
                  delay={0}
                  closeDelay={0}
                  render={
                    <span
                      role="button"
                      onClick={() => onView?.(item.skillName)}
                      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] font-medium border cursor-pointer transition-colors ${tone}`}
                    >
                      {st === "full"
                        ? <CheckCircle2Icon className="size-3" />
                        : <AlertCircleIcon className="size-3" />}
                      <span className="truncate max-w-[16ch]">{item.skillName}</span>
                      <span className="text-[10px] text-muted-foreground tabular-nums">
                        {st === "full" ? `全文·${item.lines}行`
                          : st === "partial" ? `部分·${coverageLabel}行`
                          : "未读"}
                      </span>
                    </span>
                  }
                />
                <TooltipContent side="top">{tip}</TooltipContent>
              </Tooltip>
            )
          })}
        </div>

        <div className="text-[11px] text-muted-foreground leading-snug">
          ✓ 绿色=全文（Skill 注入，或读到的行拼齐了整个文件）· ⚠ 橙色=部分读取（已读/总行数，悬停看未读区间与成因）· 灰色=未读取。点击任意 chip 可在下方表格展开该 skill 行。每行右侧
          <span className="inline-flex items-center gap-0.5 mx-1 text-teal-600 dark:text-teal-400 font-medium">
            <BookOpenIcon className="size-3" />全文
          </span>
          按钮可查看/下载恢复的 SKILL.md。
        </div>
      </CardContent>
    </Card>
  )
}
