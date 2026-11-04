// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS FILE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import type { ReactNode } from "react"
import type { TurnSearchItem } from "@/lib/observe/collectors/search"

export interface TurnHighlight {
  keyword: string
  /** 匹配面单源派生自 TurnSearchItem.matchField（content/摘要/工具三载体/工具名） */
  matchField?: TurnSearchItem["matchField"]
  toolName?: string
  /** 查询解析出的正文本词（多词/短语/引号词）——高亮与详情自动展开定位用；
   *  缺省回落 [keyword]（旧调用方兼容），算子与负词不参与文本定位 */
  terms?: string[]
}

/**
 * Split text around keyword occurrences and wrap matches in <mark>.
 * Case-insensitive. Keyword may be one term or an array of terms (query
 * grammar): every term's occurrences are highlighted. Returns the original
 * text unchanged when keyword is empty.
 */
export function highlightKeyword(text: string, keyword: string | string[] | undefined | null): ReactNode {
  const terms = (Array.isArray(keyword) ? keyword : [keyword])
    .map(k => k?.trim())
    .filter((k): k is string => !!k && k.length > 0)
  if (terms.length === 0) return text
  const lowerText = text.toLowerCase()
  // 全词收集命中区间（各词独立 indexOf 扫描），重叠区间合并后统一切段
  const ranges: Array<[number, number]> = []
  for (const term of terms) {
    const lowerTerm = term.toLowerCase()
    let idx = lowerText.indexOf(lowerTerm)
    while (idx !== -1) {
      ranges.push([idx, idx + term.length])
      idx = lowerText.indexOf(lowerTerm, idx + term.length)
    }
  }
  if (ranges.length === 0) return text
  ranges.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const r of ranges) {
    const last = merged[merged.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else merged.push([...r] as [number, number])
  }
  const parts: Array<{ text: string; isKeyword: boolean }> = []
  let lastIndex = 0
  for (const [start, end] of merged) {
    if (start > lastIndex) parts.push({ text: text.substring(lastIndex, start), isKeyword: false })
    parts.push({ text: text.substring(start, end), isKeyword: true })
    lastIndex = end
  }
  if (lastIndex < text.length) {
    parts.push({ text: text.substring(lastIndex), isKeyword: false })
  }
  return parts.map((p, i) =>
    p.isKeyword
      ? <mark key={i} className="bg-yellow-200 dark:bg-yellow-500/30 text-foreground rounded px-0.5">{p.text}</mark>
      : p.text
  )
}
