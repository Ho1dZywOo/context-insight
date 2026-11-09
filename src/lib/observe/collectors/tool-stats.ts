// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 工具维度耗时统计 collector（Perf「成员 × 工具」双维度的工具侧单一源）：
// 作用域内成员会话的全部 ToolCall 一次收齐（轻投影——args/result 原文不整
// 列进内存），错误行二次过滤查询补 resultJson 标记（superset 条件与 turns
// collector 错误摘要同门：state/errorType 之外，<tool_use_error>/Exit code
// 原文标记也是信号），逐调用耗时 = DB durationMs > 0 ? 原值 : wire 回填
// （claude-format 捕获的 toolUseId→ms，与 turns collector wire 增补同缓存
// 同框架门——cpx 捕获采集侧 durationMs 全 0，wire 是唯一真实来源）。
// 口径教义（lib/tool-timing 同源）：Task/agent 派发窗口含子代理整段执行，
// 与 Σlatency 双计——派发行单独标注、不进 meta.totalToolMs 头部口径；
// 无计时调用（源缺时间且无 wire）如实计数、不进分位（轴不撒谎）。
// 消费方：/api/observe/run/[runId]/tool-stats（Perf 工具耗时卡 + 离线导出）。

import type { PrismaClient } from '@prisma/client';
import type { ObserveScope } from '@/lib/observe/scope';
import { memberByRowId } from '@/lib/observe/scope';
import { wireToolDurations } from '@/lib/tool-timing';
import { toolCallErrorKind } from '@/lib/tool-call-errors';

const DISPATCH_NAME_RE = /^(task|agent)$/i;

export interface ToolStatErrorType {
  type: string;
  count: number;
}

export interface ToolStatItem {
  toolName: string;
  calls: number;
  errors: number;
  /** 计时 Σ（DB 真实 + wire 回填；派发行计入本行、不进 meta.totalToolMs） */
  totalMs: number;
  timedCalls: number;
  untimedCalls: number;
  wireDerived: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  avgMs: number;
  /** Task/agent 派发类（窗口 = 子代理整段执行，含其 LLM 时间） */
  isDispatch: boolean;
  isSkillRelated: boolean;
  errorTypes: ToolStatErrorType[];
}

export interface ToolMatrixCell {
  calls: number;
  totalMs: number;
  errors: number;
  /** 该（工具 × 成员）最早一次调用所在轮——下钻 Turns 的直跳锚点 */
  firstTurnId: string | null;
}

export interface RunToolStats {
  /** 按 totalMs 降序（次序 calls 降序、名升序） */
  tools: ToolStatItem[];
  /** toolName → memberTaskId → cell（成员显示名由 UI 的 run-actor 目录解析） */
  matrix: Record<string, Record<string, ToolMatrixCell>>;
  /** 有工具调用的成员 taskId（矩阵列序） */
  members: string[];
  meta: {
    totalCalls: number;
    /** Σ 本地工具执行（非派发计时）——与评分 D4 / Perf 时间构成互认的口径 */
    totalToolMs: number;
    dispatchMs: number;
    timedCalls: number;
    untimedCalls: number;
    wireDerivedCalls: number;
  };
}

function emptyStats(): RunToolStats {
  return {
    tools: [],
    matrix: {},
    members: [],
    meta: { totalCalls: 0, totalToolMs: 0, dispatchMs: 0, timedCalls: 0, untimedCalls: 0, wireDerivedCalls: 0 },
  };
}

/** 近秩分位（ceil(p·n) 位；空集 0） */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

interface ScratchTool extends ToolStatItem {
  durations: number[];
  errorTypeCounts: Map<string, number>;
}

interface ScratchCell extends ToolMatrixCell {
  firstTs: number;
}

export async function collectScopeToolStats(prisma: PrismaClient, scope: ObserveScope): Promise<RunToolStats> {
  const rowIds = scope.members.map(m => m.rowId);
  if (rowIds.length === 0) return emptyStats();

  const rows = await prisma.toolCall.findMany({
    where: { turn: { sessionId: { in: rowIds } } },
    select: {
      toolCallId: true,
      toolName: true,
      state: true,
      errorType: true,
      durationMs: true,
      isSkillRelated: true,
      dispatchBridgeId: true,
      turn: { select: { id: true, sessionId: true, createdAt_ts: true, createdAt: true } },
    },
  });
  if (rows.length === 0) return emptyStats();

  // 错误行 superset（turns collector 错误摘要同款 OR 条件）——错误行才带
  // resultJson 原文（18MB 级载荷不整列进内存），错误判别走 toolCallErrorKind
  // 单一源（cancelled / failed / null）
  const errorCalls = await prisma.toolCall.findMany({
    where: {
      turn: { sessionId: { in: rowIds } },
      OR: [
        { state: { in: ['error', 'failed'] } },
        { errorType: { not: null } },
        { resultJson: { contains: '<tool_use_error>' } },
        { resultJson: { contains: 'Exit code' } },
      ],
    },
    select: { toolCallId: true, state: true, errorType: true, resultJson: true },
  });
  const errorByToolCallId = new Map(errorCalls.map(c => [c.toolCallId, c]));

  // 成员会话行元数据（wire 增补用）：一次批查拿齐 per-row 框架/版本/捕获路径
  const memberSessions = await prisma.session.findMany({
    where: { id: { in: rowIds } },
    select: { id: true, taskId: true, framework: true, version: true, sourcePath: true },
  });
  const sessionById = new Map(memberSessions.map(s => [s.id, s]));
  const wireCache = new Map<string, Map<string, number> | null>();
  const wireOf = (sessionRowId: string): Map<string, number> | null => {
    if (wireCache.has(sessionRowId)) return wireCache.get(sessionRowId) ?? null;
    const s = sessionById.get(sessionRowId);
    const w = s ? wireToolDurations(s.sourcePath, s.taskId, s.framework, s.version) : null;
    wireCache.set(sessionRowId, w);
    return w;
  };

  const byRowId = memberByRowId(scope);
  const memberSet = new Set<string>();
  const tools = new Map<string, ScratchTool>();
  const matrix: Record<string, Record<string, ScratchCell>> = {};
  const meta = { totalCalls: 0, totalToolMs: 0, dispatchMs: 0, timedCalls: 0, untimedCalls: 0, wireDerivedCalls: 0 };

  for (const c of rows) {
    const turn = c.turn;
    const taskId = byRowId.get(turn.sessionId)?.taskId ?? turn.sessionId;
    memberSet.add(taskId);
    const isDispatch = c.dispatchBridgeId != null || DISPATCH_NAME_RE.test(c.toolName);

    // 逐调用耗时：DB 真实值优先，0 时 wire 回填（同会话捕获推导一次、缓存复用）
    let ms = c.durationMs;
    let wireDerived = false;
    if (!(ms > 0)) {
      const derived = wireOf(turn.sessionId)?.get(c.toolCallId) ?? 0;
      if (derived > 0) {
        ms = derived;
        wireDerived = true;
      } else {
        ms = 0;
      }
    }

    const err = errorByToolCallId.get(c.toolCallId);
    const kind = err ? toolCallErrorKind(err) : null;

    let t = tools.get(c.toolName);
    if (!t) {
      t = {
        toolName: c.toolName,
        calls: 0,
        errors: 0,
        totalMs: 0,
        timedCalls: 0,
        untimedCalls: 0,
        wireDerived: 0,
        minMs: 0,
        p50Ms: 0,
        p95Ms: 0,
        maxMs: 0,
        avgMs: 0,
        isDispatch,
        isSkillRelated: false,
        errorTypes: [],
        durations: [],
        errorTypeCounts: new Map(),
      };
      tools.set(c.toolName, t);
    }
    t.calls++;
    if (c.isSkillRelated) t.isSkillRelated = true;
    if (kind != null) {
      t.errors++;
      const key = kind === 'cancelled' ? 'cancelled' : (err?.errorType ?? kind);
      t.errorTypeCounts.set(key, (t.errorTypeCounts.get(key) ?? 0) + 1);
    }
    if (ms > 0) {
      t.totalMs += ms;
      t.timedCalls++;
      t.durations.push(ms);
      if (wireDerived) {
        t.wireDerived++;
        meta.wireDerivedCalls++;
      }
      meta.timedCalls++;
      if (isDispatch) meta.dispatchMs += ms;
      else meta.totalToolMs += ms;
    } else {
      t.untimedCalls++;
      meta.untimedCalls++;
    }
    meta.totalCalls++;

    let memberRow = matrix[c.toolName];
    if (!memberRow) memberRow = matrix[c.toolName] = {};
    let cell = memberRow[taskId];
    if (!cell) cell = memberRow[taskId] = { calls: 0, totalMs: 0, errors: 0, firstTurnId: null, firstTs: Number.POSITIVE_INFINITY };
    cell.calls++;
    if (ms > 0) cell.totalMs += ms;
    if (kind != null) cell.errors++;
    const ts = turn.createdAt_ts?.getTime() ?? (turn.createdAt ? new Date(turn.createdAt).getTime() : 0);
    if (ts < cell.firstTs) {
      cell.firstTs = ts;
      cell.firstTurnId = turn.id;
    }
  }

  const list: ToolStatItem[] = [];
  for (const t of tools.values()) {
    t.durations.sort((a, b) => a - b);
    t.minMs = t.durations[0] ?? 0;
    t.maxMs = t.durations[t.durations.length - 1] ?? 0;
    t.p50Ms = percentile(t.durations, 0.5);
    t.p95Ms = percentile(t.durations, 0.95);
    t.avgMs = t.timedCalls > 0 ? Math.round(t.totalMs / t.timedCalls) : 0;
    t.errorTypes = [...t.errorTypeCounts.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
      .slice(0, 5);
    list.push({
      toolName: t.toolName,
      calls: t.calls,
      errors: t.errors,
      totalMs: t.totalMs,
      timedCalls: t.timedCalls,
      untimedCalls: t.untimedCalls,
      wireDerived: t.wireDerived,
      minMs: t.minMs,
      p50Ms: t.p50Ms,
      p95Ms: t.p95Ms,
      maxMs: t.maxMs,
      avgMs: t.avgMs,
      isDispatch: t.isDispatch,
      isSkillRelated: t.isSkillRelated,
      errorTypes: t.errorTypes,
    });
  }
  list.sort((a, b) => b.totalMs - a.totalMs || b.calls - a.calls || a.toolName.localeCompare(b.toolName));

  const members = [...memberSet];
  const outMatrix: RunToolStats['matrix'] = {};
  for (const [toolName, memberRow] of Object.entries(matrix)) {
    outMatrix[toolName] = {};
    for (const [taskId, cell] of Object.entries(memberRow)) {
      outMatrix[toolName][taskId] = {
        calls: cell.calls,
        totalMs: cell.totalMs,
        errors: cell.errors,
        firstTurnId: cell.firstTurnId,
      };
    }
  }

  return { tools: list, matrix: outMatrix, members, meta };
}
