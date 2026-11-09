// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// the CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 评分卡派生读取核心（session handler 与 score 导出共用，逻辑零复制）：
// 读最新缓存卡，没有则现算确定性层（首次打开零等待——GET 幂等只读）；
// 统一过 overlays（疑似人工复核层）+ deriveItemScores（有效分/覆盖缺口
// 盖章）——消费方拿到的永远是 UI 同款形态。registry 可注入（批量场景
// 复用一次加载，score 导出全员卡不重复读盘）。

import type { PrismaClient } from '@prisma/client';
import type { Scorecard } from './types';
import type { Registry } from '../registry';
import { runScorecard } from './runner';
import { scorecardStore } from './store';
import { loadRegistry } from '../registry';
import { applyOverlays } from './overlays';
import { deriveItemScores } from './aggregator';

export interface DerivedScorecard {
  sessionId: string;
  /** UI 同款派生形态（overlays + deriveItemScores 已过） */
  card: Scorecard;
}

/** 裸卡 → UI 派生形态（overlays 复核层 + 有效分/覆盖缺口盖章）单一出口 */
export async function deriveForUi(card: Scorecard, registry: Registry): Promise<Scorecard> {
  return deriveItemScores(await applyOverlays(card, registry.defs, registry.profile), registry.defs);
}

/** taskId（+可选 framework 消歧）→ 派生评分卡；会话不存在返回 null */
export async function getDerivedScorecard(
  taskId: string,
  opts: { framework?: string | null; prisma: PrismaClient; registry?: Registry },
): Promise<DerivedScorecard | null> {
  const { prisma } = opts;
  const session = await prisma.session.findFirst({
    where: { taskId, ...(opts.framework ? { framework: opts.framework } : {}) },
    select: { id: true },
  });
  if (!session) return null;
  const registry = opts.registry ?? (await loadRegistry());
  const cached = await scorecardStore().get(session.id);
  const card = cached ?? (await runScorecard(taskId, prisma, opts.framework ? { framework: opts.framework } : {}));
  if (!card) return null;
  return { sessionId: session.id, card: await deriveForUi(card, registry) };
}
