// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See the License in the root of the software repository for the full text of the License.

import { AlertCircleIcon } from "lucide-react"
import type { AuditDeclarationEvidence } from "@/lib/sift-audit-types"
import { describeLineEvidence } from "@/lib/skill-evidence"

/** 对账报告顶部的「声明不完整」常驻提示：本次对账只基于会话中确实读到的声明行，
 *  缺口处的指令没有参与对账，结论不覆盖它们。声明完整时（无 _evidence）不渲染。 */
export function DeclarationEvidenceNotice({ items }: { items: AuditDeclarationEvidence[] | undefined | null }) {
  if (!items || items.length === 0) return null
  return (
    <div className="rounded-lg border border-orange-500/40 bg-orange-500/5 p-2.5">
      <div className="inline-flex items-center gap-1.5 text-sm font-semibold text-orange-700 dark:text-orange-400">
        <AlertCircleIcon className="size-4" />
        对账声明不完整
      </div>
      <ul className="mt-1 space-y-1 text-xs leading-relaxed">
        {items.map((it, i) => {
          const notice = describeLineEvidence(it.evidence, false, true)
          return (
            <li key={`${it.layer ?? ""}:${it.source}:${i}`}>
              <span className="font-medium">{it.layer ? `${it.layer}（${it.source}）` : it.source}</span>
              ：{notice.summary}。{notice.detail}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
