// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. Do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// skill 原文恢复候选面 collector（单点）：工具调用三通道 + 斜杠命令 system
// 注入轮。此前三处消费方（skill-content / skill-content-audit 两个 handler +
// sift-audit recoverSkillBody）各持一份 OR 查询词表且已漂移——shell 兜底分支
// 仅主 handler 有，旧数据 shell 读在 audit / sift 恒漏；注入轮则全部缺位
// （斜杠命令会话原文恢复恒空）。候选面收单点后三处同宽，恢复层通道判定
// 单点在 skill-content.ts。

import type { PrismaClient } from '@prisma/client';
import { SHELL_TOOL_DB_NAMES } from '@/lib/tool-conventions';
import type { SkillToolCall } from '@/lib/skill-content';

export interface SkillContentCandidates {
  toolCalls: SkillToolCall[];
  /** system 注入轮（非注入行由 skillMdReadsOfTurn 指纹单点过滤，此处只按角色收） */
  turns: { role: string; content: string | null; createdAt: Date | null }[];
}

export async function collectSkillContentCandidates(
  prisma: PrismaClient,
  sessionId: string,
): Promise<SkillContentCandidates> {
  const [toolCalls, turns] = await Promise.all([
    prisma.toolCall.findMany({
      where: {
        turn: { sessionId },
        OR: [
          { isSkillRelated: true },
          { AND: [{ toolName: 'Read' }, { argsJson: { contains: 'SKILL.md' } }] },
          { AND: [{ toolName: 'read' }, { argsJson: { contains: 'SKILL.md' } }] },
          // shell 读类命令（exec_command cat …/SKILL.md——codex 主通道）；
          // 摄取侧已给源工具行打 isSkillRelated，此分支兜历史未打标数据
          { AND: [{ toolName: { in: [...SHELL_TOOL_DB_NAMES] } }, { argsJson: { contains: 'SKILL.md' } }] },
        ],
      },
      select: { toolName: true, argsJson: true, resultJson: true, startedAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.turn.findMany({
      where: { sessionId, role: 'system' },
      select: { role: true, content: true, createdAt: true },
      orderBy: { turnIndex: 'asc' },
    }),
  ]);
  return {
    toolCalls: toolCalls.map(tc => ({
      toolName: tc.toolName,
      argsJson: tc.argsJson,
      resultJson: tc.resultJson,
      startedAt: tc.startedAt ?? null,
    })),
    turns,
  };
}
