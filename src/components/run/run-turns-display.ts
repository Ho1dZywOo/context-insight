// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Run Turns 展示模型（纯函数层）：轮次 → 显示角色 / 摘要的单一事实源。
// 从 RunTurnsNodes.tsx 抽出——这些纯函数不依赖后续批次的 workspace 外壳
// （RunTurnsNodes 整文件仍依赖 ExpandableText 前向引用，typecheck 待批 15
// 恢复），抽出后当下即可直接测（Integration over unit 的纯逻辑单点）。

import { isCommandTurn, isCommandCaveat, isCommandStdout, parseCommandTurns, formatCommandDisplay, isContinuationTurn, parseContinuationTurn } from "@/lib/shared/command-parser";
import type { SessionRef } from "@/lib/run/model";
import type { NodeInstance, NodeStatus } from "@/lib/run/view-model";

// ── 节点模型（RunTurnsTab 由 viewModel 构建） ──────────────────────

export interface TurnsNodeSession {
  /** 成员 taskId（turns?member= 挂载键 + SessionRef 身份） */
  taskId: string;
  label: string | null;
  role: "execute" | "verify";
  attemptOrdinal: number;
  ref: SessionRef;
}

export interface TurnsNodeAttempt {
  ordinal: number;
  status: string;
  verification: { type: string; status: string; reason: string | null };
  outputText: string | null;
  execute: TurnsNodeSession | null;
  verify: TurnsNodeSession | null;
}

export interface TurnsNode {
  /** 节点实例 key（n-<nodeId>-g<generation>） */
  key: string;
  nodeId: string;
  generation: number;
  label: string;
  taskType: NodeInstance["taskType"];
  status: NodeStatus;
  executionState: NodeInstance["executionState"];
  carriedFromGeneration: number | null;
  hasSubgraph: boolean;
  /** 0 = 主图；1+ = 子图嵌套层级 */
  depth: number;
  attempts: TurnsNodeAttempt[];
  /** 尝试内顺序拍平（execute → verify） */
  sessions: TurnsNodeSession[];
}

export interface MemberTurnsState {
  turns: TurnsBlockTurn[];
  total: number;
  page: number;
  loading: boolean;
}

/** 会话块消费的轮次最小结构（run 轮次投影与离线查看器轮次同构子集） */
export interface TurnsBlockTurn {
  turnId: string;
  turnIndex: number;
  role: string;
  contentSummary: string | null;
  agentName: string | null;
  isSubagent: boolean;
  subagentName: string | null;
  subagentSessionId: string | null;
  subagentType?: string | null;
  totalTokens: number;
  inputTokens: number;
  inputMessagesCount: number;
  createdAt: string | null;
  contextWindowPct: number | null;
  latencyMs: number;
  toolCalls: Array<{ toolName: string; state: string; durationMs?: number }>;
  finishReason?: string | null;
}

/** 泳道消费的桥最小结构（MergedBridgeItem 与查看器 BridgeItem 的公共子集） */
export interface TurnsBridge {
  bridgeId: string;
  dispatchTurnId: string | null;
  dispatchContent: string | null;
  dispatchTimestamp?: string | null;
  subagentSessionId: string | null;
  subagentType: string | null;
  subagentName: string | null;
  agentName: string | null;
  status: string;
  subagentTokens: number;
  subagentLatencyMs: number;
  /** 后台异步派发（collectors 侧 isBackgroundDispatch）：黄徽章提示
   *  「派发立即返回，完成后再通知」——响应时刻 ≠ 完成时刻 */
  dispatchBackground?: boolean;
}

// ── 状态色（单一映射：节点状态 → 圆点 class，Run 轨状态段同源复用） ──

export const STATUS_DOT: Record<NodeStatus, string> = {
  passed: "bg-emerald-500",
  failed: "bg-red-500",
  running: "bg-amber-500 animate-pulse",
  pending: "bg-foreground/25",
  carried: "bg-sky-400",
  unknown: "bg-foreground/25",
};

export const ROLE_DOT: Record<string, string> = {
  user: "bg-blue-500",
  assistant: "bg-emerald-500",
  system: "bg-slate-400",
  tool_result: "bg-teal-500",
  command: "bg-slate-400",
  continuation: "bg-purple-400",
  compaction: "bg-amber-400",
};

// ── 轮次行（新排版语法：角色点 + 单行摘要 + 右对齐数值） ───────────

export interface DisplayTurn extends TurnsBlockTurn {
  displayRole: string;
  displayContent: string;
  /** 输出构成（决定摘要行的着色语义）：text 正文｜thinking 思考｜tools 工具名 */
  displayKind: "text" | "thinking" | "tools";
}

// 轮次行的输出构成摘要：正文 > 思考片段 > 工具名——无正文的轮也要一眼
// 读出「这轮产出了什么」。思考块两种形态都要剥干净：闭标签完好（整块剥除）
// 与 summary 200 字符预算砍掉闭标签的截断残留（开标签起整体按思考内容读）。
// 思考/工具解析只对 assistant 生效——用户轮正文里的字面量 <thinking> 是数据
// 不是标记，须原样呈现。
export function summarizeOutput(
  role: string,
  text: string | null,
  toolCalls: Array<{ toolName: string }>,
): { kind: "text" | "thinking" | "tools"; content: string } {
  const raw = (text ?? "").trim();
  if (role === "assistant") {
    if (raw) {
      const body = raw.replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, " ").trim();
      const openIdx = body.indexOf("<thinking>");
      if (openIdx === 0) {
        const thought = body.substring("<thinking>".length).replace(/<\/?thinking>/g, "").trim();
        if (thought) return { kind: "thinking", content: thought };
      } else if (openIdx > 0) {
        const before = body.substring(0, openIdx).trim();
        if (before) return { kind: "text", content: before };
      } else if (body) {
        return { kind: "text", content: body };
      } else {
        const m = raw.match(/<thinking>([\s\S]*?)<\/thinking>/);
        if (m && m[1].trim()) return { kind: "thinking", content: m[1].trim() };
      }
    } else if (toolCalls.length > 0) {
      return { kind: "tools", content: [...new Set(toolCalls.map(tc => tc.toolName))].join(" · ") };
    }
  }
  return { kind: "text", content: raw };
}

/** 轮次行角色归一（行渲染与角色筛选同源单一事实）：命令 / 续接摘要 / 压缩
 *  边界由文本与 agentName 推导，其余透传 role；命令的 caveat/stdout 附注行
 *  不独立成行（null = 不进入列表，也不参与筛选计数） */
export function classifyDisplayRole(t: TurnsBlockTurn): string | null {
  const text = t.contentSummary ?? "";
  if (isCommandCaveat(text) || isCommandStdout(text)) return null;
  if (t.agentName === "compaction-boundary") return "compaction";
  if (isCommandTurn(text)) return "command";
  if (isContinuationTurn(text)) return "continuation";
  if (t.agentName === "continuation") return "continuation";
  return t.role;
}

// 泳道行显示对象（窄列截断 48 字符承旧）：在 processed 内预构——渲染期
// 逐行新建对象会打散 TurnRow 的 memo，换选就得全量重渲所有泳道行
export function toLaneDisplayTurn(st: TurnsBlockTurn): DisplayTurn {
  const s = summarizeOutput(st.role, st.contentSummary, st.toolCalls);
  return { ...st, displayRole: st.role, displayContent: s.content.substring(0, 48), displayKind: s.kind };
}

export function buildDisplayTurns(rootTurns: TurnsBlockTurn[]): DisplayTurn[] {
  const commandInfoMap = new Map<string, { display: string }>();
  let groupTexts: string[] = [];
  let leadId: string | null = null;
  for (const t of rootTurns) {
    const text = t.contentSummary ?? "";
    if (isCommandTurn(text) || isCommandCaveat(text) || isCommandStdout(text)) {
      groupTexts.push(text);
      if (isCommandTurn(text)) leadId = t.turnId;
    } else {
      if (groupTexts.length > 0 && leadId) {
        commandInfoMap.set(leadId, { display: formatCommandDisplay(parseCommandTurns(groupTexts)) });
      }
      groupTexts = [];
      leadId = null;
    }
  }
  if (groupTexts.length > 0 && leadId) {
    commandInfoMap.set(leadId, { display: formatCommandDisplay(parseCommandTurns(groupTexts)) });
  }

  const enhanced = rootTurns
    .filter(t => {
      const text = t.contentSummary ?? "";
      return !(isCommandCaveat(text) || isCommandStdout(text));
    })
    .map((t): DisplayTurn => {
      const text = t.contentSummary ?? "";
      const displayRole = classifyDisplayRole(t) ?? t.role;
      if (displayRole === "compaction") {
        return { ...t, displayRole, displayContent: text || "/compact", displayKind: "text" };
      }
      if (displayRole === "command") {
        return { ...t, displayRole, displayContent: commandInfoMap.get(t.turnId)?.display ?? "/unknown", displayKind: "text" };
      }
      if (displayRole === "continuation") {
        if (isContinuationTurn(text)) {
          return { ...t, displayRole, displayContent: parseContinuationTurn(text).summaryLine ?? "Compact summary", displayKind: "text" };
        }
        const summaryLine = text.split("\n").find(l => l.trim()) ?? "Compact summary";
        return { ...t, displayRole, displayContent: summaryLine.substring(0, 120), displayKind: "text" };
      }
      const summary = summarizeOutput(t.role, text, t.toolCalls);
      return { ...t, displayRole, displayContent: summary.content, displayKind: summary.kind };
    });
  // opencode 的 continuation 摘要 turnIndex 低于产生它的 /compact 命令——
  // 交换相邻对让命令领先其摘要（承旧时间线同款归一）
  const result = [...enhanced];
  for (let i = 0; i < result.length - 1; i++) {
    const cur = result[i];
    const next = result[i + 1];
    if (
      cur.displayRole === "continuation" &&
      next.displayRole === "command" &&
      (next.displayContent.includes("/compact") || next.displayContent === "compact")
    ) {
      [result[i], result[i + 1]] = [result[i + 1], result[i]];
      i++;
    }
  }
  return result;
}

/** 角色筛选缺省空集（未传入 = 不过滤；模块级常量保身份稳定，memo 比较
 *  不被每次渲染的新 Set 打散） */
export const EMPTY_ROLE_FILTER: ReadonlySet<string> = new Set();

export interface SessionBlockProps {
  session: TurnsNodeSession;
  state: MemberTurnsState;
  bridges: TurnsBridge[];
  selectedTurnId: string | null;
  onSelectTurn: (turnId: string) => void;
  onLoadMore: (taskId: string) => void;
  /** 角色多选筛选（空集/缺省 = 全显）；身份变更是全块重渲的唯一触发 */
  roleFilter?: ReadonlySet<string>;
}

/** 会话块 memo 比较：数据/回调不变时，仅当选中轮「进出本会话」才需要重渲
 *  （行高亮与泳道自动展开都只跟随本会话的轮）——换选高频路径上无关会话
 *  整块跳过。60 节点 run、多会话上千行同时挂载时，一次全量重渲是走查/
 *  换选卡顿的主源 */
export function sessionBlockPropsEqual(a: SessionBlockProps, b: SessionBlockProps): boolean {
  if (
    a.session !== b.session ||
    a.state !== b.state ||
    a.bridges !== b.bridges ||
    a.onSelectTurn !== b.onSelectTurn ||
    a.onLoadMore !== b.onLoadMore ||
    (a.roleFilter ?? EMPTY_ROLE_FILTER) !== (b.roleFilter ?? EMPTY_ROLE_FILTER)
  ) {
    return false;
  }
  if (a.selectedTurnId === b.selectedTurnId) return true;
  const turns = a.state.turns;
  return [a.selectedTurnId, b.selectedTurnId].every(id => id == null || !turns.some(t => t.turnId === id));
}
