// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 工具调用错误语义单点：中性分类学（闭集）+ 跨框架证据提取 + ingest 兜底分类
// + 读侧判定/消息，错误行查询超集常量。四层分工（错误通道三段式的语义层）：
//   形态层 tool-conventions —— codexExecFailureEvidenceOf：框架协议形态 → 失败
//     形态 + 证据文本（不解释语义）
//   解析层 adapters —— codex 卷回/claude 声明信封在证据尚存时（剥壳前/信封里）
//     解析最终 errorType/errorMessage，经 ToolCallInfo 语义通道传出
//   持久层 turn-split —— passthrough-first 直采 adapter 语义，缺失时用本模块
//     classifyToolCallError 从 resultJson 兜底
//   读侧 —— 本模块 kind/消息/查询超集，展示层禁止再持框架词表副本
import { codexExecFailureEvidenceOf } from '@/lib/tool-conventions';

export interface ToolCallErrorItem {
  toolName: string
  resultJson?: string | null | undefined
  state: string
  errorType?: string | null | undefined
  errorMessage?: string | null | undefined
  turn?: { sessionId: string; turnIndex: number }
}

export interface SkillEventErrorItem {
  skillName: string
  eventType: string
  success: boolean
  errorMessage?: string | null | undefined
  turn?: { sessionId: string; turnIndex: number }
}

export interface ErrorSummary {
  total: number
  cancelled: number
  failed: number
  skillFail: number
  truncated: number
  details: Array<{ toolName: string; type: string }>
}

/** 轮级错误摘要（服务端预算，Overview 消费）：计数与 details 与
 *  summarizeToolCallErrors 同源同口径，另带错误消息提取（60 字符内）与技能
 *  失败消息——消费方不再需要 resultJson 原文（18MB 级载荷不进 Overview 响应）。 */
export interface TurnErrorDigest extends ErrorSummary {
  messages: Array<{ toolName: string; message: string }>
  skillMessages: Array<{ skillName: string; message: string }>
}

/** 中性错误分类学（闭集）——ingest 兜底分类与全读侧共用单点。桶语义：
 *  - exec_failed      命令/工具执行了但非零退出（Exit code N / Process exited
 *                     with code N）；失败态证据无桶匹配时的兜底桶
 *  - sandbox_rejected 执行环境拒绝派生（codex CreateProcess Rejected——命令
 *                     从未执行，如 rm -f 危险命令样式被静态分析拒绝）
 *  - bad_args         工具参数畸形（模型输出的 args JSON 截断/解析失败——调用
 *                     未成形，agent 侧质量信号）
 *  - shell_syntax     shell 语法/找不到命令（unexpected EOF / Unterminated
 *                     quoted / command not found）
 *  - timeout / permission / format / server_error 证据文本标记细化（既有桶，
 *                     语义不变）
 *  - tool_error       状态 ok 但结果带错误证据（claude <tool_use_error> 历史语义）
 *  - unknown          失败但无任何证据（诚实兜底，宁缺毋假） */
export type ToolCallErrorType =
  | 'tool_error' | 'exec_failed' | 'sandbox_rejected' | 'bad_args' | 'shell_syntax'
  | 'timeout' | 'permission' | 'format' | 'server_error' | 'unknown';

/** 错误行查询超集（Prisma OR 分支）——错误摘要 digest / 工具矩阵错误行 / 资产页
 *  错误计数共用单点。state/errorType 主判（错误语义通道修复后的行语义齐全）；
 *  resultJson 文本分支是存量行兼容的超集兜底（claude ok 态结果带错误文本、
 *  codex 修复前导入的派生拒绝/参数畸形行）——退出码分支用 startsWith 收窄
 *  （'Exit code' 真失败形态只在结果头部；contains 会命中正文引用与 EXIT CODE
 *  横幅，现场 260 行 contains 命中仅 43 行真失败）。超集宁宽勿漏：取回的行
 *  再经 toolCallErrorKind 精判（头部非零退出码定性，Exit code: 0 撤销旧误标）。
 *  新框架的错误形态一律在此扩展，查询侧不再散布词表副本。 */
type ToolCallErrorQueryOrItem =
  | { state: { in: string[] } }
  | { errorType: { not: null } }
  | { resultJson: { contains: string } }
  | { resultJson: { startsWith: string } };

export const TOOL_CALL_ERROR_QUERY_OR: ToolCallErrorQueryOrItem[] = [
  { state: { in: ['error', 'failed'] } },
  { errorType: { not: null } },
  { resultJson: { contains: '<tool_use_error>' } },
  { resultJson: { startsWith: 'Exit code' } },
  { resultJson: { contains: 'exec_command failed:' } },
  { resultJson: { contains: 'failed to parse function arguments' } },
];

const EVIDENCE_MAX = 200;

function truncateEvidence(text: string, max: number = EVIDENCE_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** 终端错误原因行提取（exec_failed 证据增强——退出码只说失败不说为何）：
 *  构建工具/测试框架/运行时的错误陈述都在输出尾部（traceback 末行是异常
 *  本尊、make/npm/pytest 尾部给总结行），故从尾部向头扫、首个强特征行即
 *  原因；尾部窗口 4KB——DB 有 18MB 级 resultJson，不整段扫。词表保守：
 *  强前缀 + 错误关键词行才算（`no error` 类否定行排除），无特征行 → null
 *  （不编造，证据退回纯退出码）。终端语义框架中立：codex 卷回与 claude
 *  兜底证据、digest 速览共用本单点。 */
// 否定守卫：no errors / 无错误；计数清零总结行不是原因（「FAIL 0 / UNKNOWN 0」
// 是通过态——\bfail\b 命中 FAIL 0 的计数，现场曾把「健康探针 OK（FAIL 0）」
// 成功总结行当原因提取）
const REASON_NEGATIVE_RE = /no (errors?|issues?|problems?|failures?|exceptions?)|(?:无|没有)(?:错误|失败|异常)|\bFAIL(?:ED|S)?\s*[：:]?\s*0\b|\b0\s*(?:failed|failures?|errors?)\b|失败\s*[：:]?\s*0|错误\s*[：:]?\s*0/i;
const REASON_STRONG_RE = /^(?:make: \*\*\*|npm ERR!|Traceback |fatal:|panic:|Assertion |Segmentation fault|core dumped|Killed|✕|✗|FAIL(?:ED)?\b|\d+ (?:failed|error)s?\b)/i;
// 现场全量审计（01a1e584，77 条纯退出码行）后的保守增量：
// - FAIL 在行中而非行首（探针总结行「PASS 7 / FAIL 1」）→ \bfail\b
// - shell 经典错误行不含 error 关键词：No such file or directory / Permission denied
// - 探针 status JSON：非 OK 状态即原因（reason 字段），AVAILABLE/RELEASED 不误伤
// - aborted / invalid（无效参数、用户中断）
// - 中文错误行（现场中文重度）：失败|错误|异常
// CamelCase 异常类（ValueError:/TypeError:…）词内无边界，\b 挡不住——单列模式
const REASON_KEYWORD_RE = /\b(?:error|fatal|fail|failed|failure|exception|panic|assertion|segfault|segmentation fault|command not found|no such file or directory|permission denied|invalid|aborted|could not|cannot|can't|unable to)\b|"status":\s*"(?:UNKNOWN|ERROR|FAILED|BUSY)"|[A-Za-z]{0,24}(?:Error|Exception)\s*:|失败|错误|异常|必须(?:给|提供|指定|设置|包含)|缺少(?:参数|字段)|参数(?:错误|缺失|不合法)/i;

export function terminalErrorReasonOf(output: string | null | undefined): string | null {
  if (!output) return null;
  const tail = output.length > 4096 ? output.slice(-4096) : output;
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === '' || REASON_NEGATIVE_RE.test(line)) continue;
    if (REASON_STRONG_RE.test(line) || REASON_KEYWORD_RE.test(line)) {
      return line.length > 120 ? `${line.slice(0, 120)}…` : line;
    }
  }
  return null;
}

/** 头部退出码证据（claude Bash / cpx 捕获壳的失败形态）：`Exit code N` 只在
 *  结果头部成立，且 N=0 是成功回显——旧词表 includes 任意位置的 'Exit code'
 *  都算证据，现场 260 行 ok 态命中里仅 43 行真失败（正文引用、EXIT CODE 横幅、
 *  code 0 成功回显全被误标 tool_error/failed）。非零 → 退出码；其余 → null。 */
function exitHeadCodeOf(r: string): number | null {
  const m = r.match(/^Exit code:?\s*(\d+)/);
  return m != null ? Number(m[1]) : null;
}

/** 工具结果原文里的失败证据提取（跨框架形态，单点）——持久层兜底（adapter
 *  未解析语义时 turn-split 用）与读侧存量行重推导（离线内核 / digest 消息）
 *  共用。codex 派生失败形态是 starts-with 精确形态、先于子串壳判定；claude
 *  壳（<tool_use_error> 原文 / 头部非零退出码加 Command failed 前缀）维持既有
 *  截断口径。无证据 → null（干净成功或证据不可提取，不编造）。 */
export function extractErrorEvidence(resultJson: string | null | undefined): string | null {
  if (!resultJson) return null;
  const failure = codexExecFailureEvidenceOf(resultJson);
  if (failure != null) return failure.evidence;
  if (resultJson.includes('<tool_use_error>')) return truncateEvidence(resultJson);
  const code = exitHeadCodeOf(resultJson);
  if (code != null && code !== 0) {
    // 有可提取的错误原因行 → 蒸馏证据（退出码 + 原因）；无 → 保留原文截断老口径
    const reason = terminalErrorReasonOf(resultJson);
    return reason != null
      ? truncateEvidence(`Command failed: Exit code ${code}: ${reason}`)
      : truncateEvidence(`Command failed: ${resultJson}`);
  }
  return null;
}

const EXIT_EVIDENCE_RE = /(?:exit code|exited with code|process exited with code) (-?\d+)/i;

/** 证据文本 → 分类桶（null = 无桶匹配）：结构性形态优先于标记细化，退出码
 *  证据优先于 server 标记（"Exit code 502" 是命令失败不是网关错）。 */
function evidenceBucketOf(message: string): ToolCallErrorType | null {
  const m = message.toLowerCase();
  if (m.includes('failed to parse function arguments')) return 'bad_args';
  if (m.includes('sandbox rejected')) return 'sandbox_rejected';
  if (m.includes('unexpected eof') || m.includes('unterminated quoted')
    || m.includes('command not found') || m.includes('syntax error')) return 'shell_syntax';
  if (m.includes('timeout') || m.includes('timed out') || m.includes('deadline exceeded')) return 'timeout';
  if (m.includes('permission') || m.includes('denied') || m.includes('forbidden')
    || m.includes('unauthorized')) return 'permission';
  if (m.includes('format') || m.includes('invalid') || m.includes('parse')) return 'format';
  const exitMatch = m.match(EXIT_EVIDENCE_RE);
  if (exitMatch != null && exitMatch[1] !== '0') return 'exec_failed';
  if (m.includes('rate limit') || m.includes('internal error') || m.includes('overloaded')
    || m.includes('unavailable') || m.includes('econnrefused') || /\b5\d{2}\b/.test(m)) return 'server_error';
  return null;
}

/** 工具调用错误分类（持久层兜底单点；adapter 已解析语义时 turn-split 直采
 *  errorType 不进此）。口径：
 *  - 状态 ok/completed + 证据 → 按证据分桶，无桶匹配 → tool_error（claude
 *    <tool_use_error> 历史语义保留）
 *  - 失败态（error/failed 及一切非 ok 态）+ 证据 → 按证据分桶，无桶匹配 →
 *    exec_failed（失败态兜底；历史口径为 server_error，现场 112/112 失败里
 *    语义错位——多为命令失败退出，诚说「执行失败」不再猜 server）
 *  - 失败态无证据 → unknown（宁缺毋假） */
export function classifyToolCallError(
  state: string | null | undefined,
  errorMessage: string | null | undefined,
): ToolCallErrorType | null {
  const ok = state === 'ok' || state === 'completed';
  const message = errorMessage != null && errorMessage !== '' ? errorMessage : null;
  if (ok) return message == null ? null : (evidenceBucketOf(message) ?? 'tool_error');
  return message == null ? 'unknown' : (evidenceBucketOf(message) ?? 'exec_failed');
}

export interface ToolCallFailureSemantics {
  kind: ToolCallErrorType;
  evidence: string;
}

/** codex exec_command 失败语义解析（适配器卷回单点入口）——证据只在剥壳前的
 *  raw 里（退出码在传输壳头、派生失败形态占整个 output），剥壳即失，必须在
 *  卷回处解析成最终语义并随 ToolCallInfo.errorType/errorMessage 持久化。
 *  非零退出时以 terminalOutput（剥壳后的终端原文）提取错误原因行附加到证据
 *  ——退出码只说失败不说为何（共享 terminalErrorReasonOf 单点）。 */
export function codexExecFailureOf(
  raw: string,
  exitCode: number | null,
  terminalOutput?: string | null,
): ToolCallFailureSemantics | null {
  const failure = codexExecFailureEvidenceOf(raw);
  if (failure != null) {
    return {
      kind: failure.form === 'spawn_rejected' ? 'sandbox_rejected'
        : failure.form === 'bad_args' ? 'bad_args' : 'exec_failed',
      evidence: failure.evidence,
    };
  }
  if (exitCode != null && exitCode !== 0) {
    const reason = terminalErrorReasonOf(terminalOutput);
    return {
      kind: 'exec_failed',
      evidence: reason != null
        ? `Process exited with code ${exitCode}: ${reason}`
        : `Process exited with code ${exitCode}`,
    };
  }
  return null;
}

/** 工具调用错误消息提取（60 字符内，读侧速览）：resultJson 原文里的框架形态
 *  （claude 壳 / codex 派生失败 / 退出码精炼 `exit N: 原因`——含原因行的
 *  蒸馏口径）优先，持久化 errorMessage（错误语义通道修复后的行语义齐全）
 *  兜底——线上（服务端 digest）与离线导出（客户端原文计算）共用同一实现。 */
export function toolCallErrorMessage(tc: { errorMessage?: string | null; resultJson?: string | null }): string {
  const r = tc.resultJson ?? '';
  if (r.includes('<tool_use_error>')) {
    return r.replace(/.*<tool_use_error>/, '').replace(/<\/tool_use_error>.*/, '').substring(0, 60);
  }
  const failure = codexExecFailureEvidenceOf(r);
  if (failure != null) return failure.evidence.substring(0, 60);
  const headCode = exitHeadCodeOf(r);
  if (headCode != null && headCode !== 0) {
    const reason = terminalErrorReasonOf(r);
    return reason != null ? `exit ${headCode}: ${reason}`.substring(0, 60) : `exit ${headCode}`;
  }
  const pm = (tc.errorMessage || '').match(/(?:Exit code|Process exited with code) (-?\d+)(?::\s*(.+))?/);
  if (pm != null) {
    const reason = pm[2] != null ? pm[2].trim() : '';
    return reason !== '' ? `exit ${pm[1]}: ${reason}`.substring(0, 60) : `exit ${pm[1]}`;
  }
  const persisted = (tc.errorMessage || '').trim();
  return persisted !== '' ? persisted.substring(0, 60) : '';
}

/** Completion reasons which indicate that the model output was cut short. */
const TRUNCATED_FINISH_REASONS = new Set(['length', 'max_tokens']);

/** 单次工具调用错误判别（summarize / count / tool-stats / 展示层的公共内核）：
 *  'cancelled'（result 含 <tool_use_error> + Cancelled）/ 'failed' / null。
 *  头部退出码是定性判据：非零 → failed；Exit code: 0 是成功回显 → 撤销旧
 *  词表误标的 errorType（存量库里 89 行被 includes 词表毒化为 tool_error 的
 *  成功行；仅当状态本身非 error/failed——线缆 isError 优先于文本）。
 *  codex 形态兼容存量行（修复前导入的派生拒绝/参数畸形行 state 仍 completed，
 *  证据原文还在行内）。 */
export function toolCallErrorKind(
  tc: { toolName?: string; resultJson?: string | null | undefined; state?: string; errorType?: string | null | undefined },
): 'cancelled' | 'failed' | null {
  const r = tc.resultJson ?? '';
  const state = tc.state ?? '';
  if (state !== 'error' && state !== 'failed') {
    const code = exitHeadCodeOf(r);
    if (code === 0) return null;
    if (code != null) return 'failed';
  }
  if (r.includes('<tool_use_error>') && r.includes('Cancelled')) return 'cancelled';
  if (state === 'error' || state === 'failed' || tc.errorType) return 'failed';
  if (codexExecFailureEvidenceOf(r) != null) return 'failed';
  return null;
}

export function summarizeToolCallErrors(
  toolCalls: ToolCallErrorItem[],
  skillEvents?: SkillEventErrorItem[],
  finishReason?: string | null,
): ErrorSummary {
  let failed = 0
  let cancelledCount = 0
  const details: Array<{ toolName: string; type: string }> = []

  for (const tc of toolCalls) {
    const kind = toolCallErrorKind(tc)
    if (kind === 'cancelled') {
      cancelledCount++
      details.push({ toolName: tc.toolName, type: 'cancelled' })
    } else if (kind === 'failed') {
      failed++
      details.push({ toolName: tc.toolName, type: 'failed' })
    }
  }

  let skillFail = 0
  if (skillEvents) {
    for (const se of skillEvents) {
      if (!se.success && se.errorMessage) {
        skillFail++
        details.push({ toolName: se.skillName, type: 'skill_fail' })
      }
    }
  }

  const truncated = finishReason != null && TRUNCATED_FINISH_REASONS.has(finishReason) ? 1 : 0
  if (truncated) details.push({ toolName: `stop_reason=${finishReason}`, type: 'truncated' })

  return {
    total: cancelledCount + failed + skillFail + truncated,
    cancelled: cancelledCount,
    failed,
    skillFail,
    truncated,
    details,
  }
}

export function countToolCallErrors(
  toolCalls: ToolCallErrorItem[],
  skillEvents?: SkillEventErrorItem[],
): Map<string, { count: number; firstTurnIndex: number | null }> {
  const map = new Map<string, { count: number; firstTurnIndex: number | null }>()

  for (const tc of toolCalls) {
    if (toolCallErrorKind(tc) != null && tc.turn?.sessionId) {
      const sid = tc.turn.sessionId
      const entry = map.get(sid) ?? { count: 0, firstTurnIndex: null }
      entry.count++
      if (entry.firstTurnIndex === null || tc.turn.turnIndex < entry.firstTurnIndex) {
        entry.firstTurnIndex = tc.turn.turnIndex
      }
      map.set(sid, entry)
    }
  }

  if (skillEvents) {
    for (const se of skillEvents) {
      if (!se.success && se.errorMessage && se.turn?.sessionId) {
        const sid = se.turn.sessionId
        const entry = map.get(sid) ?? { count: 0, firstTurnIndex: null }
        entry.count++
        if (entry.firstTurnIndex === null || se.turn.turnIndex < entry.firstTurnIndex) {
          entry.firstTurnIndex = se.turn.turnIndex
        }
        map.set(sid, entry)
      }
    }
  }

  return map
}
