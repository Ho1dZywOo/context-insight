// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS OF A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import type { Prisma, PrismaClient } from '@prisma/client';
import { restoreFile, renderRestoredText, type RestoreOp, type ResolvedRestoreOp } from './file-restore';
import { isShellToolCall, SHELL_TOOL_NAMES } from './tool-conventions';
import { restoreShellReads } from './shell-restore';

export interface RecoveredAgentMd {
  content: string;
  /** 运行时实际读取的文件路径（read args / shell 归因条目里的 filePath） */
  source: string;
  /** 是否拼出了完整文件（无 gap） */
  fullRead: boolean;
  maxLine: number;
}

export interface RecoverToolCallRow {
  toolName: string;
  argsJson: string | null;
  resultJson: string | null;
  startedAt: Date | null;
}

function readFilePath(argsJson: string | null): string | null {
  if (!argsJson) return null;
  try {
    const p = JSON.parse(argsJson) as { filePath?: unknown; file_path?: unknown };
    const fp = p.filePath ?? p.file_path;
    return typeof fp === 'string' && fp.length > 0 ? fp : null;
  } catch {
    return null;
  }
}

function agentMdPathMatches(filePath: string, agentName: string): boolean {
  const norm = filePath.replace(/\\/g, '/');
  const want = `agents/${agentName}.md`;
  const idx = norm.lastIndexOf('/' + want);
  return idx !== -1 && idx + want.length + 1 === norm.length;
}

/**
 * 从 session 的读取记录里恢复 agent .md 原文（Skills tab subagent 行"全文"、
 * audit agent 对账的会话内声明层）。
 *
 * 依据：opencode 的 task 派发 prompt 只带角色名（"扮演 X agent"），agent .md
 * 不进 dispatch args；子代理（或主会话）运行时会自己读取该 .md 文件 ——
 * 读取结果（ToolCall.resultJson）就是运行时真正生效的定义原文。恢复它比
 * 磁盘扫描更准：文件事后可能已改/已删，且多插件同名时磁盘只能按覆盖率+
 * 字母序猜，而会话里读的是哪份就是哪份。
 *
 * 双通道：Read 工具（claude/opencode）+ shell 命令族隐式读（codex 无 Read
 * 工具，cat agents/x.md 的输出此前全灭）——shell 走 shell-restore 引擎
 * 归因为已解析行表，与 Read 通道同入行级合并。
 *
 * - 匹配：Read 的 filePath / shell 归因条目路径以 /agents/<agentName>.md 结尾
 * - 多份同名（demo/glacier 等多插件都被读过）→ 取最新一次读取所在的那份文件
 * - 同一文件多次分段读 → 按时间序合并行（restoreFile），gap 标记 --line N not found --
 * - 空结果（读失败的探测路径）/ 归因失败（混 dump、管道段）跳过（宁缺毋假）
 */
export function selectRecoveredAgentMd(
  toolCalls: RecoverToolCallRow[],
  agentName: string
): RecoveredAgentMd | null {
  const byFile = new Map<string, Array<RestoreOp | ResolvedRestoreOp>>();
  const latestRef: { v: { file: string; ts: number } | null } = { v: null };

  const record = (file: string, op: RestoreOp | ResolvedRestoreOp, ts: Date | null) => {
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file)!.push(op);
    const t = ts?.getTime() ?? -Infinity;
    if (!latestRef.v || t > latestRef.v.ts) latestRef.v = { file, ts: t };
  };

  for (const tc of toolCalls) {
    const tn = tc.toolName.toLowerCase();
    if (isShellToolCall(tn)) {
      if (!tc.argsJson || !tc.resultJson || tc.resultJson.length === 0) continue;
      const ts = tc.startedAt;
      for (const entry of restoreShellReads(tc.argsJson, tc.resultJson)) {
        if (entry.lines.size === 0) continue;
        if (!agentMdPathMatches(entry.filePath, agentName)) continue;
        record(entry.filePath, { kind: 'resolved', source: 'read', filePath: entry.filePath, lines: entry.lines, ts }, ts);
      }
      continue;
    }
    if (tn !== 'read') continue;
    if (!tc.resultJson || tc.resultJson.length === 0) continue;
    const fp = readFilePath(tc.argsJson);
    if (!fp || !agentMdPathMatches(fp, agentName)) continue;
    record(fp, { kind: 'read', argsJson: tc.argsJson, resultJson: tc.resultJson, ts: tc.startedAt }, tc.startedAt);
  }

  if (byFile.size === 0 || !latestRef.v) return null;

  const ops = byFile.get(latestRef.v.file)!;
  const restored = restoreFile(ops);
  const fullRead = restored.lines.every(l => l.content !== null);
  return {
    content: renderRestoredText(restored.lines),
    source: latestRef.v.file,
    fullRead,
    maxLine: restored.maxLine,
  };
}

/** DB 版：取整个 session（含子代理 turns）的 Read + shell 隐式读 ToolCall 后走
 *  selectRecoveredAgentMd。argsJson 含 `agents/<name>.md` 对 shell 命令文本
 *  天然过滤（cat 路径串在 args 里）。 */
export async function recoverAgentMdFromSession(
  prisma: PrismaClient | Prisma.TransactionClient,
  sessionId: string,
  agentName: string
): Promise<RecoveredAgentMd | null> {
  const toolCalls = ((await prisma.toolCall.findMany({
    where: {
      turn: { sessionId },
      toolName: { in: ['read', 'Read', ...SHELL_TOOL_NAMES] },
      argsJson: { contains: `agents/${agentName}.md`, not: null },
    },
    select: { toolName: true, argsJson: true, resultJson: true, startedAt: true },
    orderBy: { startedAt: 'asc' },
  })) ?? []) as RecoverToolCallRow[];
  return selectRecoveredAgentMd(toolCalls, agentName);
}
