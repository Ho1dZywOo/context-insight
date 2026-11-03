// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 工具执行时间推导（wire 轮间隙，单一权威源——评分 D4 与 Perf 页共读这一份）：
// 轮 i 响应(tool_use) → 携带其 tool_result 的下一请求行，间隙 = 该批工具的执行窗口
//（含毫秒级框架调度开销）。主链捕获与子代理捕获（<sid>/subagents/）各自推导；
// 派发类（task/agent）窗口 = subagent 整段执行，内含其 LLM 时间——不进工具时长
// （防与 Σlatency 双计），但算并行度时是并行行为。同批多工具均分间隙（保守串行
// 假设：Σ 正确，单调用时刻是近似）。末轮无后续请求的窗口拿不到间隙，不计。
// 时间戳模型（按窗口载体行与响应行的间隙符号逐窗判别）：
// - 模型 A（proxy wire 捕获）：assistant 行 ts = 响应到达，载体行 ts = 下一请求
//   → 窗口 = [响应行 ts, 载体行 ts]；
// - 模型 B（cc-db-turn 原生导出，lake bundle .native）：assistant 行
//   ts = 请求发出、duration_ms = 请求→响应，工具结果载体行与之同戳（间隙 ≤ 0
//   无信息）→ 窗口 = [ts + duration_ms, 下一请求行（下一条 assistant 行）ts]。
// 非 claude 格式（如原生 opencode 的消息时长已含 part 执行）不适用：评分层照旧
// 无法评判，Perf 层退回 token 估算。

import fs from 'node:fs';
import { parseJsonlLines, listSubagentSessions, type ClaudeJsonlLine } from '@/lib/ingest/adapters/claude-jsonl';
import { isClaudeFormatSession } from '@/lib/shared/session-format';

export interface ToolInterval {
  /** wire tool_use id（与 ToolCall.toolCallId 同源） */
  toolUseId: string;
  toolName: string;
  /** 'main' 或 subagent sid */
  chainSid: string;
  startMs: number;
  endMs: number;
  /** local=本地工具；dispatch=task/agent 派发（subagent 整段执行，不进工具时长） */
  kind: 'local' | 'dispatch';
}

export interface ToolTiming {
  intervals: ToolInterval[];
  /** Σ 本地工具执行窗口（D4.toolTime 原料） */
  localToolMs: number;
  /** Σ 派发等待（subagent wall 时长，诊断材料） */
  dispatchWallMs: number;
  /** Σ assistant duration_ms（全链 LLM 时长，校验/展示用） */
  llmMs: number;
  /** 参与推导的链数（主链 + 子代理） */
  chains: number;
}

const DISPATCH_RE = /^(task|agent)$/i;

interface ChainPass {
  intervals: ToolInterval[];
  llmMs: number;
}

function passChain(lines: ClaudeJsonlLine[], chainSid: string): ChainPass {
  interface Window {
    /** 本轮响应行时刻（模型 A：响应到达；模型 B：请求发出） */
    respTs: number;
    calls: Array<{ id: string; name: string }>;
    /** 首个携带该批任一结果的载体行时刻 */
    resultTs: number | null;
    /** 请求→响应时长（模型 B 的响应完成锚点） */
    durationMs: number | null;
    /** 下一请求行（下一条 assistant 行）时刻（模型 B 的窗口闭合边界） */
    nextReqTs: number | null;
  }
  const byId = new Map<string, Window>();
  const windows: Window[] = [];
  /** 最近一条带工具的 assistant 行的窗口（其后的下一条 assistant 行闭合它） */
  let pending: Window | null = null;
  let llmMs = 0;

  for (const line of lines) {
    const ts = line.timestamp ? Date.parse(line.timestamp) : NaN;
    if (Number.isNaN(ts)) continue;
    const msg = line.message;
    if (!msg) continue;
    const blocks = Array.isArray(msg.content) ? msg.content.filter(b => b != null && typeof b === 'object') : [];
    if (line.type === 'assistant') {
      const durationMs = typeof line.duration_ms === 'number' ? line.duration_ms : null;
      llmMs += durationMs ?? 0;
      // 任意 assistant 行（无论是否带工具）都是一次新请求：闭合上一窗口
      if (pending) pending.nextReqTs = ts;
      const calls = blocks
        .filter(b => (b as { type?: string }).type === 'tool_use')
        .map(b => {
          const u = b as { id?: unknown; name?: unknown };
          return { id: typeof u.id === 'string' ? u.id : '', name: typeof u.name === 'string' ? u.name : '?' };
        });
      pending = null;
      if (calls.length === 0) continue;
      const w: Window = { respTs: ts, calls, resultTs: null, durationMs, nextReqTs: null };
      windows.push(w);
      pending = w;
      for (const c of calls) if (c.id) byId.set(c.id, w);
    } else if (line.type === 'user') {
      for (const b of blocks) {
        const r = b as { type?: string; tool_use_id?: unknown };
        if (r.type !== 'tool_result' || typeof r.tool_use_id !== 'string') continue;
        const w = byId.get(r.tool_use_id);
        if (w && w.resultTs == null) w.resultTs = ts;   // 首个携带该批任一结果的行 = 窗口闭合
      }
    }
  }

  const intervals: ToolInterval[] = [];
  for (const w of windows) {
    if (w.resultTs == null) continue;                    // 结果未归还（末轮/截断）不计
    let start: number, end: number;
    if (w.resultTs > w.respTs) {
      // 模型 A（proxy wire）：响应行 = 到达时刻，载体行 = 下一请求
      start = w.respTs;
      end = w.resultTs;
    } else if (w.durationMs != null && w.durationMs > 0 && w.nextReqTs != null) {
      // 模型 B（cc-db-turn 原生导出）：载体行与响应行同戳（间隙 ≤ 0 无信息），
      // 响应完成 = 响应行 ts + duration_ms，窗口闭合于下一请求行
      start = w.respTs + w.durationMs;
      end = w.nextReqTs;
    } else continue;                                     // 无诚实锚点可用
    const gap = end - start;
    if (gap <= 0) continue;                              // 负间隙（乱序/时钟异常）不计
    const n = w.calls.length;
    w.calls.forEach((c, k) => {
      if (!c.id) return;
      intervals.push({
        toolUseId: c.id,
        toolName: c.name,
        chainSid,
        startMs: start + Math.round((gap * k) / n),
        endMs: start + Math.round((gap * (k + 1)) / n),
        kind: DISPATCH_RE.test(c.name) ? 'dispatch' : 'local',
      });
    });
  }
  return { intervals, llmMs };
}

// 进程级缓存（Perf 每次开会话页都会走 turns API，重复解压 11MB 捕获没必要）：
// 主文件 mtime+size 变化即失效。三形态 stat 与 adapter 的 resolveCaptureForm 同口径。
function statKey(sourcePath: string): string {
  for (const p of [sourcePath, `${sourcePath}.7z`, `${sourcePath}.gz`]) {
    try {
      const st = fs.statSync(p);
      return `${p}:${st.mtimeMs}:${st.size}`;
    } catch { /* 试下一形态 */ }
  }
  return `${sourcePath}:missing`;
}

const cache = new Map<string, { key: string; value: ToolTiming | null }>();

/** 从捕获文件推导全链工具执行区间；无捕获/解析失败/无有效窗口返回 null */
export function deriveToolTiming(sourcePath: string, taskId: string): ToolTiming | null {
  const key = statKey(sourcePath);
  const hit = cache.get(sourcePath);
  if (hit && hit.key === key) return hit.value;
  let value: ToolTiming | null = null;
  try {
    const chains: ChainPass[] = [
      passChain(parseJsonlLines(sourcePath), 'main'),
      ...listSubagentSessions(sourcePath, taskId).map(({ id, filePath }) => passChain(parseJsonlLines(filePath), id)),
    ];
    const intervals = chains.flatMap(c => c.intervals);
    value = intervals.length > 0
      ? {
        intervals,
        localToolMs: intervals.filter(i => i.kind === 'local').reduce((s, i) => s + (i.endMs - i.startMs), 0),
        dispatchWallMs: intervals.filter(i => i.kind === 'dispatch').reduce((s, i) => s + (i.endMs - i.startMs), 0),
        llmMs: chains.reduce((s, c) => s + c.llmMs, 0),
        chains: chains.length,
      }
      : null;
  } catch {
    value = null;   // 捕获缺失/损坏：如实返回 null，调用方走各自兜底
  }
  cache.set(sourcePath, { key, value });
  return value;
}

/** Perf 页用：toolUseId → 执行毫秒（DB durationMs 为 0 时覆盖）。非 claude 格式
 * （原生 opencode 无 wire）返回 null。框架门即内容门：lake 原生导出虽统一转
 * claude 格式布局，但 opencode 源的导出把工具执行折叠进 duration_ms（消息时
 * 长，实证：subagent 工具轮 dur 700–1000s、工具完成后到下一请求的间隙 Σ 仅
 * 5s），post-completion 窗口是主链空转——按工具计会错，故 framework 保留原值
 * 的会话一律不做 wire 增补（claude-code 源导出为纯 LLM 时长，走框架门放行）。 */
export function wireToolDurations(
  sourcePath: string | null,
  taskId: string,
  framework: string,
  version: string | null,
): Map<string, number> | null {
  if (!sourcePath || !isClaudeFormatSession(framework, version)) return null;
  const t = deriveToolTiming(sourcePath, taskId);
  if (!t) return null;
  const out = new Map<string, number>();
  for (const i of t.intervals) out.set(i.toolUseId, i.endMs - i.startMs);
  return out.size > 0 ? out : null;
}
