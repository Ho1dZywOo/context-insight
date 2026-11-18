// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software and is distributed under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may not use this file except in compliance with the License.
// A copy of the License is located in the "LICENSE" file at the root of the source tree.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
// EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY,
// OR FITNESS FOR A PARTICULAR PURPOSE. See the License for the full text of the License.

// codex apply_patch 载荷解析器（写通道单点）。
//
// codex 没有 Write/Edit 工具——文件创建与修改全走 apply_patch，且其
// argsJson 是**裸 patch 文本**（非 JSON，`extractFilePath` 的 JSON 解析天然
// 失败）——此前所有按 claude/opencode 写工具形态假设的词表与路径提取对
// codex 的写操作全家失明（评分「写入」维度零计、自清理登记缺失、改代码
// 判定失效、测试文件识别失效）。本模块是 patch 文本的唯一解析点：
//
//   *** Begin Patch
//   *** Add File: <path>      ← 新建：后续 `+` 前缀行即全文
//   +line...
//   *** Update File: <path>   ← 修改：hunk（@@）内 +/-/上下文行；hunk 无行号
//   *** Delete File: <path>   ← 删除
//   *** End Patch
//
// 语义边界（诚实模型）：
//   · Add File 的全文可知 → 可作为恢复引擎的写操作素材（行 1..n）
//   · Update File 的 hunk **无行号**（codex 格态 `@@` 不带位置）→ 变更行
//     无法定位到文件行号，不产出行级素材（宁缺毋假）；路径与动作仍可知
//   · 一份 patch 可含多个文件段 → 逐文件产出
//   · JSON {input:"*** Begin Patch…"} 包装形态（wire 层）剥壳后同解析

export interface PatchFileOp {
  action: 'add' | 'update' | 'delete';
  file: string;
  /** Add File 的全文行（已剥 `+` 前缀）；Update/Delete 恒 null（行号不可知） */
  addLines: string[] | null;
}

const PATCH_BEGIN = '*** Begin Patch';
const PATCH_END = '*** End Patch';

/** argsJson 是否为 apply_patch 载荷（裸 patch 文本或 JSON input 包装） */
export function isApplyPatchArgs(argsJson: string | null): boolean {
  return patchTextOf(argsJson) != null;
}

/** 载荷形态归一：裸 patch 文本直取；JSON {input:"…"} 包装 / JSON 字符串化
 *  （args 采集层统一 stringify 的形态）剥壳；其余 null */
function patchTextOf(argsJson: string | null): string | null {
  if (!argsJson) return null;
  const raw = argsJson.trimStart();
  if (raw.startsWith(PATCH_BEGIN)) return argsJson;
  try {
    const p = JSON.parse(argsJson);
    if (typeof p === 'string' && p.trimStart().startsWith(PATCH_BEGIN)) return p;
    if (typeof p?.input === 'string' && p.input.trimStart().startsWith(PATCH_BEGIN)) return p.input;
  } catch {
    // 非 JSON —— 裸文本形态已在前一分支命中
  }
  return null;
}

/**
 * 解析 apply_patch 载荷 → 逐文件操作。非 patch 载荷返回 null。
 */
export function parseApplyPatch(argsJson: string | null): PatchFileOp[] | null {
  const text = patchTextOf(argsJson);
  if (text == null) return null;

  const ops: PatchFileOp[] = [];
  const lines = text.split('\n');
  let current: PatchFileOp | null = null;

  for (const line of lines) {
    if (line === PATCH_BEGIN || line === PATCH_END) continue;
    const header = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (header) {
      if (current) ops.push(current);
      const action = header[1].toLowerCase() as PatchFileOp['action'];
      current = {
        action,
        file: header[2].trim(),
        addLines: action === 'add' ? [] : null,
      };
      continue;
    }
    if (!current) continue;
    if (current.action === 'add') {
      // Add File 段：`+` 前缀行是文件内容（真空行也是 `+`）；无前缀行是
      // patch 文本尾部换行的伪影（*** End Patch 前），不是内容
      if (line.startsWith('+')) current.addLines!.push(line.slice(1));
    }
    // Update 段：+/-/上下文行——无行号语义，不产出内容
  }
  if (current) ops.push(current);
  return ops.length > 0 ? ops : null;
}
