// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { NextRequest, NextResponse } from 'next/server';
import { logError } from '@/lib/logger';
import { prisma } from '@/lib/db';
import { getContextWindowLimit } from '@/lib/context-window-config';
import { isProxyVersion } from '@/lib/shared/session-format';
import { joinSubagentIdentities, type TurnIdentity } from '@/lib/observe/turn-identity';
import { selectInputContextTurns } from '@/lib/ingest/input-reconstruct';
import { isContinuationTurn } from '@/lib/shared/command-parser';
import { wireToolDurations } from '@/lib/tool-timing';
import { turnWallMs } from '@/lib/observe/turn-duration';

type ToolCallDetail = {
  id: string;
  toolCallId: string;
  toolName: string;
  state: string;
  durationMs: number;
  argsJson?: string | null;
  resultJson?: string | null;
  errorType?: string | null;
  errorMessage?: string | null;
  isSkillRelated?: boolean;
};

type SkillEventDetail = {
  id: string;
  skillName: string;
  eventType: string;
  success: boolean;
  skillVersion?: number | null;
  errorMessage?: string | null;
  argsJson?: string | null;
  durationMs?: number;
};

// Compute stable system overhead from the first assistant turn
// For root: find first non-subagent assistant; for subagent: find first in that subagentSessionId
async function computeSystemOverhead(sessionId: string, subagentSessionId: string | null = null): Promise<number> {
  const where = subagentSessionId
    ? { sessionId, role: 'assistant', subagentSessionId }
    : { sessionId, role: 'assistant', isSubagent: false };
  const firstAssistant = await prisma.turn.findFirst({
    where,
    orderBy: [{ turnIndex: 'asc' }],
    select: { id: true, turnIndex: true, inputMessagesTokens: true },
  });
  if (!firstAssistant || firstAssistant.inputMessagesTokens === 0) return 0;

  const priorWhere = subagentSessionId
    ? { sessionId, turnIndex: { lt: firstAssistant.turnIndex }, role: { in: ['user', 'assistant', 'system', 'tool_result'] }, subagentSessionId }
    : { sessionId, turnIndex: { lt: firstAssistant.turnIndex }, role: { in: ['user', 'assistant', 'system', 'tool_result'] }, isSubagent: false };
  const priorMessages = await prisma.turn.findMany({
    where: priorWhere,
    select: { id: true, role: true, content: true },
  });

  // firstAssistant is chosen by turnIndex asc, so no prior turn can be an
  // assistant — the prior-assistant toolCall.findMany branch was dead code
  // and has been removed. priorMessages only ever contains user/system turns.
  const visibleEstimated = priorMessages.reduce((s, ct) => s + Math.round((ct.content?.length ?? 0) / 3.5), 0);
  return Math.max(0, firstAssistant.inputMessagesTokens - visibleEstimated);
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const taskId = searchParams.get('taskId');
    const framework = searchParams.get('framework');
    const isSubagent = searchParams.get('isSubagent');
    const role = searchParams.get('role');
    const subagentSessionId = searchParams.get('subagentSessionId');
    const includeContent = searchParams.get('includeContent') === 'true';
    // includeMeta：轮详情元数据投影（contentJson/ttftMs/modelId/providerId/
    // errorType）——离线导出档案用；不带 inputMessagesJson 重建（O(n²) 负载
    // 不进响应，窗口重建由消费侧经 input-reconstruct 纯函数单点按需执行）
    const includeMeta = searchParams.get('includeMeta') === 'true';
    const includeToolDetail = searchParams.get('includeToolDetail') === 'true';
    // skipOverhead: when the caller doesn't need systemOverheadTokens (e.g. the
    // compare page), skips the per-(root+subagent) computeSystemOverhead loop
    // which is the main N+1 source on sessions with many subagents.
    const skipOverhead = searchParams.get('skipOverhead') === 'true';
    // maxContentLen: truncates the `content` field to the first N characters.
    // The compare page only needs enough content for diff highlighting + the
    // initial 500-char preview — full content is rarely viewed and accounts
    // for ~50% of payload size on large sessions. Trimming to 1000 chars
    // preserves <thinking>...</thinking> blocks (usually < 500 chars) while
    // cutting transfer + fetch time on 4000-turn sessions.
    const maxContentLenRaw = searchParams.get('maxContentLen');
    const maxContentLen = maxContentLenRaw ? parseInt(maxContentLenRaw, 10) : null;

    if (!taskId) {
      return NextResponse.json(
        { error: 'Missing required query param: taskId' },
        { status: 400 }
      );
    }

    const sessionWhere: Record<string, string> = { taskId };
    if (framework) sessionWhere.framework = framework;

    const session = await prisma.session.findFirst({
      where: sessionWhere,
    });

    if (!session) {
      return NextResponse.json(
        { error: `Session not found for taskId: "${taskId}"` },
        { status: 404 }
      );
    }

    // Compute stable system overhead per agent (root + each subagent).
    // Skipped entirely when skipOverhead=true — the compare page only needs
    // role/content/tokens/tools/skills and never reads systemOverheadTokens,
    // so the per-subagent findFirst+findMany loop is pure waste there.
    // On a 27-subagent session this drops 28 findFirst + 28 findMany calls.
    // wire 工具时长同门控：compare 页只用工具名/计数（computeToolStats），
    // 从不读 durationMs——冷缓存时 wireToolDurations 走 readCaptureBuffer 同步
    // 解压，大捕获（631MB 级在案）会阻塞事件循环数秒
    const wireDurations = skipOverhead
      ? null
      : wireToolDurations(session.sourcePath, session.taskId, session.framework, session.version);
    const overheadMap = new Map<string, number>();
    if (!skipOverhead) {
      const rootOverhead = await computeSystemOverhead(session.id);
      const subagentIds = await prisma.turn.findMany({
        where: { sessionId: session.id, isSubagent: true, subagentSessionId: { not: null } },
        select: { subagentSessionId: true },
        distinct: ['subagentSessionId'],
      });
      overheadMap.set("", rootOverhead);
      for (const { subagentSessionId } of subagentIds) {
        if (subagentSessionId) {
          overheadMap.set(subagentSessionId, await computeSystemOverhead(session.id, subagentSessionId));
        }
      }
    }

    const where: Record<string, unknown> = { sessionId: session.id };
    if (isSubagent !== null && isSubagent !== undefined) {
      where.isSubagent = isSubagent === 'true';
    }
    if (role) {
      where.role = role;
    }
    if (subagentSessionId) {
      where.subagentSessionId = subagentSessionId;
    }

    const turns = await prisma.turn.findMany({
      where,
      orderBy: [{ turnIndex: 'asc' }],
      // Phase 9: when maxContentLen=0, omit the content column entirely from
      // the SQL SELECT — the DB stops reading multi-MB of content text, and
      // the compare page falls back to contentSummary (200 chars) for diff.
      // When maxContentLen>0, keep reading content (API layer truncates after).
      omit: maxContentLen === 0 ? { content: true } : undefined,
      include: {
        toolCalls: {
          select: includeMeta || includeToolDetail
            ? {
                id: true,
                toolCallId: true,
                toolName: true,
                dispatchBridgeId: true,
                argsJson: true,
                resultJson: true,
                state: true,
                errorType: includeMeta ? true : undefined,
                // 工具错误面进工具详情视图（含离线导出档案——错误文本是
                // 搜索六路之一，离线 error: 查询依赖它）
                errorMessage: (includeMeta || includeToolDetail) ? true : undefined,
                durationMs: true,
                isSkillRelated: (includeMeta || includeToolDetail) ? true : undefined,
              }
            : {
                id: true,
                toolCallId: true,
                toolName: true,
                dispatchBridgeId: true,
                state: true,
                durationMs: true,
              },
        },
        skillEvents: {
          select: includeMeta || includeToolDetail
            ? {
                id: true,
                skillName: true,
                skillVersion: true,
                eventType: true,
                success: true,
                errorMessage: true,
                argsJson: true,
                durationMs: true,
              }
            : {
                id: true,
                skillName: true,
                eventType: true,
                success: true,
              },
        },
      },
    });

    // 混模会话：subagent 的 null-model turn 回退该 subagent 首个 assistant 的
    // model（与详情 route 的 resolveSubagentModel 同源；按 turnIndex asc 分组
    // 一次查全、首见即定，避免逐 turn N+1），再回退会话级 model。仅在展示的
    // turns 里确有 null-model 的 subagent turn 时才查
    const subagentModels = new Map<string, string>();
    if (turns.some(t => !t.model && t.subagentSessionId)) {
      const subs = await prisma.turn.findMany({
        where: { sessionId: session.id, subagentSessionId: { not: null }, role: 'assistant', model: { not: null } },
        select: { subagentSessionId: true, model: true },
        orderBy: [{ turnIndex: 'asc' }],
      });
      for (const r of subs) {
        if (r.subagentSessionId == null || r.model == null) continue;
        if (!subagentModels.has(r.subagentSessionId)) subagentModels.set(r.subagentSessionId, r.model);
      }
    }
    const limitFor = (t: { model: string | null; subagentSessionId: string | null }) =>
      getContextWindowLimit(
        t.model || (t.subagentSessionId ? subagentModels.get(t.subagentSessionId) ?? null : null) || session.model
      );

    // 子代理身份双字段（类型 + 派发步骤）：join 算法在 lib/observe/turn-identity
    // （session 处理器与 run turns 收集器同源，两视图口径不可能分裂）。
    const identityBySession = turns.some(t => t.subagentSessionId)
      ? await (async () => {
          const bridgeRows = await prisma.interactionBridge.findMany({
            where: { sessionId: session.id, subagentSessionId: { not: null } },
            orderBy: [{ dispatchTimestamp: 'asc' }],
            select: { sessionId: true, subagentSessionId: true, subagentType: true, dispatchContent: true },
          });
          return joinSubagentIdentities(
            turns.map(t => ({ sessionId: session.id, subagentSessionId: t.subagentSessionId, subagentName: t.subagentName })),
            bridgeRows,
            () => isProxyVersion(session.version),
          );
        })()
      : new Map<string, TurnIdentity>();


    const items = turns.map(t => {
      // Prisma omit (maxContentLen===0) makes t.content type-optional at the
      // TS level even when present; normalize via a typed view so the rest of
      // the mapping reads content uniformly.
      const tContent = (t as { content?: string | null }).content ?? null
      // 工具有效时长（durationMs > 0 优先、wire 兜底）：turnMs 与下方
      // toolCalls 投影同源同值——单轮耗时口径见 lib/observe/turn-duration
      const effectiveToolDurations = t.toolCalls.map(tc =>
        tc.durationMs > 0 ? tc.durationMs : (wireDurations?.get(tc.toolCallId) ?? tc.durationMs));
      return {
      turnId: t.id,
      turnIndex: t.turnIndex,
      role: t.role,
      content: includeContent
        ? (maxContentLen && tContent ? tContent.substring(0, maxContentLen) : tContent)
        : undefined,
      contentJson: includeMeta ? t.contentJson : undefined,
      ttftMs: includeMeta ? t.ttftMs : undefined,
      modelId: includeMeta ? t.modelId : undefined,
      providerId: includeMeta ? t.providerId : undefined,
      contentSummary: t.contentSummary ?? tContent?.substring(0, 200) ?? null,
      contentLength: tContent?.length ?? 0,
      agentName: t.agentName,
      isSubagent: t.isSubagent,
      subagentName: t.subagentName,
      subagentSessionId: t.subagentSessionId,
      subagentType: identityBySession.get(t.subagentSessionId ?? '')?.subagentType ?? null,
      dispatchStep: identityBySession.get(t.subagentSessionId ?? '')?.step ?? null,
      parentExecutionId: t.parentExecutionId,
      totalTokens: t.totalTokens,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      reasoningTokens: t.reasoningTokens,
      cacheReadTokens: t.cacheReadTokens,
      cacheWriteTokens: t.cacheWriteTokens,
      inputMessagesCount: t.agentName === 'compaction' ? (() => {
        const json = (t as any).inputMessagesJson; // eslint-disable-line @typescript-eslint/no-explicit-any
        return json ? JSON.parse(json).length : t.inputMessagesCount;
      })() : t.inputMessagesCount,
      inputMessagesTokens: t.agentName === 'compaction' && t.inputMessagesTokens === t.outputTokens ? t.inputTokens : t.inputMessagesTokens,
      contextWindowPct: t.contextWindowPct,
      systemOverheadTokens: t.isSubagent && t.subagentSessionId
        ? overheadMap.get(t.subagentSessionId) ?? 0
        : overheadMap.get("") ?? 0,
      latencyMs: t.latencyMs,
      turnMs: turnWallMs(session.framework, session.version, t.latencyMs, effectiveToolDurations),
      createdAt: t.createdAt_ts?.toISOString() ?? t.createdAt.toISOString(),
      completedAt: t.completedAt?.toISOString() ?? null,
      model: t.model,
      contextWindowLimit: limitFor(t),
      finishReason: t.finishReason,
      toolCalls: t.toolCalls.map((tc, i) => {
        const detail: ToolCallDetail = tc;
        return {
          id: tc.id,
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          dispatchBridgeId: tc.dispatchBridgeId ?? null,
          argsJson: (includeMeta || includeToolDetail) ? (detail.argsJson ?? null) : undefined,
          resultJson: (includeMeta || includeToolDetail) ? (detail.resultJson ?? null) : undefined,
          state: tc.state,
          errorType: includeMeta ? (detail.errorType ?? null) : undefined,
          errorMessage: (includeMeta || includeToolDetail) ? (detail.errorMessage ?? null) : undefined,
          // DB per-call duration 采集侧未回填（全 0）：wire 轮间隙推导覆盖（cpx 捕获）；
          // 无 wire（原生 opencode）保持 0，Perf 分段退回 token 估算
          durationMs: effectiveToolDurations[i],
          isSkillRelated: (includeMeta || includeToolDetail) ? (detail.isSkillRelated ?? false) : undefined,
        }
      }),
      skillEvents: (() => {
        const skillToolCalls = t.toolCalls.filter(tc => {
          const d: ToolCallDetail = tc
          return d.isSkillRelated
        })
        return t.skillEvents.map((se, idx) => {
          const detail: SkillEventDetail = se
          const matchedTc: ToolCallDetail | undefined = skillToolCalls[idx]
          const matchedResult = matchedTc?.resultJson
          const resultError = matchedResult && (matchedResult.includes('<tool_use_error>') || matchedResult.includes('Exit code'))
          return {
            id: se.id,
            skillName: se.skillName,
            skillVersion: (includeMeta || includeToolDetail) ? (detail.skillVersion ?? null) : undefined,
            eventType: se.eventType,
            success: resultError ? false : se.success,
            errorMessage: resultError ? (matchedResult!.substring(0, 200)) : ((includeMeta || includeToolDetail) ? (detail.errorMessage ?? null) : undefined),
            argsJson: (includeMeta || includeToolDetail) ? (detail.argsJson ?? null) : undefined,
            durationMs: (includeMeta || includeToolDetail) ? (detail.durationMs ?? 0) : undefined,
          }
        })
      })(),
      }
    })

    // Insert virtual continuation user turns after each compaction assistant turn.
    // In claude-code, the continuation summary is a real user turn (e.g. #44).
    // In opencode, the summary is the compaction agent's content (#125), so we
    // synthesize a continuation turn from it to match claude-code's data model.
    const continuationItems: typeof items = [];
    for (const item of items) {
      continuationItems.push(item);
      if (item.agentName === 'compaction' && item.role === 'assistant') {
        const compTurn = turns.find(t => t.id === item.turnId)
        const compContent = includeContent ? ((compTurn as { content?: string | null } | undefined)?.content ?? null) : undefined;
        const compSummary = compTurn?.contentSummary ?? null;
        if (compContent || compSummary) {
          continuationItems.push({
            turnId: `${item.turnId}-continuation`,
            turnIndex: item.turnIndex,
            role: 'user',
            content: compContent ?? compSummary,
            contentJson: undefined,
            ttftMs: undefined,
            modelId: undefined,
            providerId: undefined,
            contentSummary: compSummary,
            contentLength: compContent?.length ?? 0,
            agentName: 'continuation',
            turnMs: 0,
            isSubagent: item.isSubagent,
            subagentName: item.subagentName,
            subagentSessionId: item.subagentSessionId,
            subagentType: identityBySession.get(item.subagentSessionId ?? '')?.subagentType ?? null,
            dispatchStep: identityBySession.get(item.subagentSessionId ?? '')?.step ?? null,
            parentExecutionId: item.parentExecutionId,
            totalTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            inputMessagesCount: 0,
            inputMessagesTokens: 0,
            contextWindowPct: null,
            systemOverheadTokens: 0,
            latencyMs: 0,
            createdAt: item.createdAt,
            completedAt: null,
            model: null,
            // 合成 continuation 是喂回主对话的 user turn，基数与主链路同源
            //（subagent/会话 model），不取 compaction turn 自己的 model——
            // opencode 落库的 compaction turn 带 model 且可与主链路不同
            //（摘要常用小模型），取它会让列表与详情 -continuation 分支分叉
            contextWindowLimit: limitFor({ model: null, subagentSessionId: item.subagentSessionId }),
            finishReason: null,
            toolCalls: [],
            skillEvents: [],
          });
        }
      }
    }

    return NextResponse.json({ items: continuationItems, total: continuationItems.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logError('route:observe/session/turns', '查询失败', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
