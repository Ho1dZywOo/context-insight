// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import type { PrismaClient } from "@prisma/client";
import type { AuditLayerInfo } from "@/lib/sift-audit-types";
// 客户端安全核心（无 fs）：本文件被 session page 的客户端组件 import，凡引入的模块都进
// client bundle——fs 读 JSON 的加载器在 workflow-extract-config.ts（server-only，路由入口
// 调 ensureWorkflowExtractPluginLoaded 激活），此处只引类型/默认值/holder。
import { DEFAULT_PLUGIN, getWorkflowExtractPlugin } from "@/lib/workflow-extract-plugin";
import { buildAgentRoleNameMap } from "@/lib/agent-role-name-map";
import { unwrapSkillContent, SHELL_TOOL_DB_NAMES, isShellToolCall, isSkillToolCall } from "@/lib/tool-conventions";
// Read 无信封格式（claude-code-proxy 裸 `N\t` / opencode `N: ` / 纯文本）的多格式
// 行表解析单点——FILES 恢复层同源，本文件不另造格式判定。
import { parseReadLines, extractOffset } from "@/lib/file-restore";
import { restoreShellReads, renderShellEntryText } from "@/lib/shell-restore";
import { extractShellFileReads } from "@/lib/file-reads";
// skill-content（SKILL.md 正文恢复三通道单点：skill-tool / Read / shell）纯模块，
// client bundle 安全；Audit 对账与 Skills 面板共用同一恢复词表，通道扩展不再双头漂移。
import { selectSkillContent, stripSkillRuntimeTail, type SkillContentResult } from "@/lib/skill-content";
import type { AuditDeclarationEvidence } from "@/lib/sift-audit-types";
import type { LineEvidence } from "@/lib/skill-evidence";
import { collectSkillContentCandidates } from "@/lib/observe/collectors/skill-content";
// dispatch-tools 是纯模块（唯一导入为 type-only，无 fs/db）——client bundle 安全；
// 派发工具判定单点：task/agent/subagent/spawn_agent 及注册表未来形态自动纳入。
import { dispatchSpecOf } from "@/lib/ingest/dispatch-tools";

export { stripSkillRuntimeTail };

/**
 * sift 对账桥接：从 insight 的 session 里恢复某 skill 的 SKILL.md 正文，
 * 物化成临时 skill 目录，shell out 调 `sift audit`，读回 audit-report.json。
 *
 * 每个 skill 的完整正文存在 invoke 类 ToolCall 的 resultJson 里，以
 * `<skill_content name="…">…</skill_content>` 包裹（见 skill-event-grouping.ts 的 invokeTc）。
 */

/** skill 工具调用里能带 <skill_content> 正文的 toolName（小写）。 */
const SKILL_INVOKE_TOOLS = new Set(["skill", "skill/invoke", "skill/use"]);

/**
 * 从一段文本里剥出 `<skill_content>…</skill_content>` 内部的正文（trim）。
 * 没有外壳 / 空输入 → null。audit 期望的是纯 SKILL.md markdown，不要外壳。
 * 协议壳剥除上收词表（unwrapSkillContent，单一事实源）；尾部运行时注入
 * 块（Base directory / skill_files）仍由本模块剥离。
 */
export function stripSkillContent(resultJson: string | null | undefined): string | null {
  const inner = unwrapSkillContent(resultJson);
  return inner !== null ? stripSkillRuntimeTail(inner) : null;
}

/**
 * 对账落盘用 SKILL.md：恢复正文自带 YAML frontmatter（read/shell 通道的
 * cat/Read 原文保留 `---\nname:`）则原样返回，否则注入合成头（skill-tool
 * 通道剥协议壳后无头）。sift 的 parse_skill_md 需 frontmatter 才能解析指令。
 * frontmatter 识别收紧（块体 ≤30 行且含 name: 键）：防把正文首部的 `---`
 * 分隔线误判成 frontmatter 而漏注入。名字行对齐请求名（transcript 锚点用
 * 事件技能名切段，声明名与锚点名不一致会切段落空；name 是元数据键非指令）。
 */
export function ensureSkillFrontmatter(body: string, name: string): string {
  const m = body.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (m && m[1].split("\n").length <= 30 && /^\s*name\s*:/m.test(m[1])) {
    const aligned = body.replace(m[1], m[1].replace(/^\s*name\s*:.*$/m, `name: ${name}`));
    return aligned.endsWith("\n") ? aligned : `${aligned}\n`;
  }
  return `---\nname: ${name}\ndescription: recovered from session\n---\n${body}\n`;
}

/** 一个 ToolCall 是不是"带正文的 skill invoke 调用"（区别于 task/agent dispatch）。 */
export function isSkillInvokeToolCall(toolName: string | null | undefined): boolean {
  return !!toolName && SKILL_INVOKE_TOOLS.has(toolName.toLowerCase());
}

/**
 * audit 调用参数（不含二进制名 `sift`，由调用方加）。声明路径作位置参：目录找其下 SKILL.md，传 .md 文件则直读。
 *
 * `--kind skill` 始终带:本路(--db)是 per-skill 对账(只传一个 skill 的 SKILL.md)。不带它,
 * sift 会拿本 skill 的指令去对账整条 session(含别的 skill 跑的 turn)→ 误判。sift
 * 靠传入 SKILL.md 的 name + --kind skill 切出本 skill 被 Skill 调用期间的段,只对账这些段
 * (audit.py;skill 未被调用过 → exit 2,而此处正文必来自一次 invoke,不会触发)。
 */
export function buildAuditArgs(opts: {
  skillPath: string;
  dbPath: string;
  sessionId: string;
  outputDir: string;
  kind?: "skill" | "agent" | "root";
}): string[] {
  return [
    "audit",
    opts.skillPath,
    "--db",
    opts.dbPath,
    "--session",
    opts.sessionId,
    "-o",
    opts.outputDir,
    "--kind",
    opts.kind ?? "skill",
    "--turn-refs",
  ];
}

/**
 * `--transcript` 路的参数(cannbot-insight / claude-code framework 用):
 * 把 session 序列化成结构化 records JSON 喂 sift,绕开 `--db` 的 opencode-native 限制。
 * `kind` 必带:skill=按 Skill 调用切(skill 对账)、agent=按 agent 归属切(被 dispatch 的 agent 对账)。
 */
export function buildTranscriptArgs(opts: {
  skillPath: string;
  transcriptPath: string;
  outputDir: string;
  kind: "skill" | "agent" | "root";
}): string[] {
  return ["audit", opts.skillPath, "--transcript", opts.transcriptPath, "-o", opts.outputDir, "--kind", opts.kind, "--turn-refs"];
}

/**
 * 一个声明单元在 session 里以哪些「面」出现 → 该跑哪些 kind 的对账。
 *
 * Skills tab 每行按 events 的 eventType 路由对账按钮:
 *   - invoke / use 事件 → skill 面(Skill 调用锚点,正文从 session 的 resultJson 恢复)
 *   - dispatch 事件 → agent 面(被 dispatch 的子 agent,.md 声明从 AGENTS_ROOT 读)
 *
 * 注:**主 agent 的 workflow 对账（root 面）不在此派生**——主 agent 通常不 invoke skill
 * （只 dispatch 子 agent），其 workflow skill 声明是 session 首条 user turn 的注入系统
 * 提示（见 audit-skillsift 路由 kind=root + recoverMainAgentWorkflowBody）。root 目标由
 * SkillAuditTab / SkillDetail 按 turn0 长度阈值合成添加，不靠 skillEvents 的 eventType。
 *
 * dispatch-only 行(如 developer)原来也挂 skill 对账按钮,但无 invoke 事件 → recoverSkillBody
 * 返回 null → 必 404。路由到 agent 对账才对。dual-nature(同既 invoke 又 dispatch,如 st-verifier)
 * 两面都返,UI 出两个按钮各审各的(与 sift 的 kind 分路一致——同名 skill 声明 ≠ agent 声明)。
 *
 * 输入只读 eventType,与 SkillEventItem 结构兼容(鸭子类型);未知 eventType → 不计入任何面。
 */
export function auditKindsForEvents(
  events: { eventType: string }[],
): ("skill" | "agent")[] {
  const kinds: ("skill" | "agent")[] = []
  if (events.some((e) => e.eventType === "invoke" || e.eventType === "use")) kinds.push("skill")
  if (events.some((e) => e.eventType === "dispatch")) kinds.push("agent")
  return kinds
}

/**
 * 仅 dispatch（含 dispatch+unload）的条目是被分派的子代理，不是被加载/调用的 skill。
 * Skills 表据此过滤掉子代理，与 Audit 的 agent/skill 划分对齐。
 * 输入只读 eventType，与 SkillEventItem 结构兼容（鸭子类型）。
 */
export function isDispatchOnlyAgent(events: { eventType: string }[]): boolean {
  return !events.some(
    (e) => e.eventType === "load" || e.eventType === "invoke" || e.eventType === "use"
  );
}

/**
 * 返回「仅 dispatch」的 skillName 集合（即被分派的子代理，如 blackbox-designer）。
 * 用于全页统一过滤：Overview 计数/列表、Skills 图表都不展示这些非-skill 条目。
 * 与 isDispatchOnlyAgent 同口径：某 name 无任何 load/invoke/use 事件 → 视为子代理。
 */
export function dispatchOnlySkillNames(events: { skillName: string; eventType: string }[]): Set<string> {
  const hasSkillEvent = new Map<string, boolean>();
  for (const e of events) {
    if (e.eventType === "load" || e.eventType === "invoke" || e.eventType === "use") {
      hasSkillEvent.set(e.skillName, true);
    } else if (!hasSkillEvent.has(e.skillName)) {
      hasSkillEvent.set(e.skillName, false);
    }
  }
  const out = new Set<string>();
  for (const [name, hasSkill] of hasSkillEvent) if (!hasSkill) out.add(name);
  return out;
}

/**
 * In-flight 去重:同 key 的请求在飞时,复用已有 promise、不再调 fetcher。
 *
 * SiftAuditDialog 的 audit POST 在 useEffect 里,dev 下 remount(HMR / Fast Refresh 回退
 * 全页刷新)会重跑 effect → 不去重就再发一次 POST。而服务端 execFileSync 不可中止、单跑可达
 * 30 分钟 → 多轮堆叠抢 LLM 端点 → 限流失败(实测 opdef-developer:两轮重叠 2 分钟,先起的被
 * 529 杀)。去重让重发复用在飞的 promise,从根上杜绝堆叠。settle(resolve/reject)后清条目,
 * 下次 open 重跑无妨(已有结果不再缓存,允许用户重审)。
 *
 * cache 入参可注入(便于测);生产由调用方传模块级单例。泛型 T = 请求结果类型。
 */
export function getInflightAudit<T>(
  key: string,
  fetcher: () => Promise<T>,
  cache: Map<string, Promise<T>>,
): Promise<T> {
  const existing = cache.get(key);
  if (existing) return existing;
  const p = fetcher().finally(() => {
    cache.delete(key);
  });
  cache.set(key, p);
  return p;
}

/** 安全解析 ToolCall.argsJson(JSON 字符串)→ 对象；坏 / 空 → {}。 */
function parseArgs(argsJson: string | null | undefined): Record<string, unknown> {
  if (!argsJson) return {};
  try {
    return JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * 把 insight 的 session(Turn + ToolCall)序列化成 sift 结构化 records JSON：
 * `{format:"sift-records", records:[{role, text?, agent?, parent_tool_use_id, tool_calls?}]}`。
 * sift 收到后展开成 cc 记录、按 skill 切段对账（见 sift evals/structured.py）。
 *
 * scope-aware:子 agent turn 的 parent_tool_use_id = subagentSessionId(缺则 parentExecutionId),
 * 主 turn 恒 null。sift 切片器(slice.py _scope_of)据此归作用域——子 agent 里跑的 skill 段
 * 不再被主 scope 的 last-invoked-owns 污染(主 scope 噪声混进段)。无需合成 Agent tool_use:零嵌套
 * 数据下 parent_tool_use_id 直接归段即正确(slice.py 的 depth-1 closure 在无 Agent tool_use 时是
 * no-op,归段只靠 parent_tool_use_id)。turn 按 turnIndex 升序;turn 内 tool_calls 按 createdAt 升序。
 */
export async function buildStructuredRecords(
  sessionId: string,
  prisma: PrismaClient,
): Promise<{ format: string; records: unknown[] }> {
  const turns = await prisma.turn.findMany({
    where: { sessionId },
    orderBy: { turnIndex: "asc" },
  });
  if (turns.length === 0) return { format: "sift-records", records: [] };

  // 子代理会话 → 角色名（见下方 rec.agent 注释；无映射的子会话回退 agentName）
  const roleMap = await buildAgentRoleNameMap(sessionId, prisma);

  const turnIds = turns.map((t) => t.id);
  const toolCalls = await prisma.toolCall.findMany({
    where: { turnId: { in: turnIds } },
    orderBy: { createdAt: "asc" },
  });
  const byTurn = new Map<string, typeof toolCalls>();
  for (const tc of toolCalls) {
    const arr = byTurn.get(tc.turnId) ?? [];
    arr.push(tc);
    byTurn.set(tc.turnId, arr);
  }

  // B 形技能加载（Read/shell 读 SKILL.md，无 skill 工具调用行）在 transcript 补合成
  // Skill 锚点：sift --kind skill 按 Skill 调用切段（structured reader 把 name=skill
  // 归一成 Skill、input.skill 即技能名），B 形会话缺锚点 → 切段为空直接 exit 2。
  // DB 不合成工具行（turn-split 单点否决过：合成行污染工具统计）；transcript 是
  // 审计视图的协议适配，合成只发生在序列化出口。锚点排在源工具调用之前（调用→读取）。
  // A 形（skill 工具族）的真实工具调用即天然锚点，无 source_tool_call_id 不双锚。
  const bFormEvents = await prisma.skillEvent.findMany({
    where: { eventType: "use", turn: { sessionId } },
    select: { turnId: true, argsJson: true },
    orderBy: { createdAt: "asc" },
  });
  const anchorsByToolCallId = new Map<string, Array<{ skill: string }>>();
  for (const se of bFormEvents) {
    const a = parseArgs(se.argsJson);
    if (typeof a.source_tool_call_id !== "string" || typeof a.skill !== "string") continue;
    const arr = anchorsByToolCallId.get(a.source_tool_call_id) ?? [];
    arr.push({ skill: a.skill });
    anchorsByToolCallId.set(a.source_tool_call_id, arr);
  }

  // C 形（斜杠命令注入，claude-code v1：/skill 展开全文进 system 轮、无任何工具调用）
  // 的 invoke 事件锚在 user 命令轮——同一条合成规则的第三种形态：锚点直接落事件轮
  // （命令轮的 args 文本即技能入参，段含命令轮 = 审判面拿到任务参数）。A 形守卫：
  // 事件轮已有原生 skill 工具调用则不双锚（slice/digest 对锚点 role 不敏感，user 轮
  // 挂 tool_use 与 cc 判定层兼容——slice.py _skill_calls_of 逐 record 无 role 过滤）。
  const cFormEvents = await prisma.skillEvent.findMany({
    where: { eventType: "invoke", turn: { sessionId } },
    select: { turnId: true, skillName: true },
    orderBy: { createdAt: "asc" },
  });
  const anchorsByTurnId = new Map<string, Set<string>>();
  for (const se of cFormEvents) {
    if (!se.skillName) continue;
    const tcsOfTurn = byTurn.get(se.turnId) ?? [];
    if (tcsOfTurn.some(tc => isSkillToolCall(tc.toolName))) continue;
    const set = anchorsByTurnId.get(se.turnId) ?? new Set<string>();
    set.add(se.skillName);
    anchorsByTurnId.set(se.turnId, set);
  }

  const records = turns.map((t) => {
    const rec: Record<string, unknown> = {
      role: t.role,
      // 子 agent turn → subagentSessionId 归独立 scope(缺则 parentExecutionId 兜底);主 turn → null
      // (主 scope)。sift 切片器按此归段,隔离子 agent 的 skill 执行、免主 scope 噪声污染。
      parent_tool_use_id: t.isSubagent ? (t.subagentSessionId || t.parentExecutionId || null) : null,
    };
    if (t.content) rec.text = t.content;
    // agent 字段用**角色名**（designer 等），不是 Turn.agentName 的任务标题
    // （"Task29 修复Kernel崩溃"）——sift --kind agent 按声明 frontmatter name 匹配
    // records.agent 切片，任务标题永远匹配不上（对账切片为空的根因）。角色名映射见
    // buildAgentRoleNameMap（bridge.subagentType 优先、SkillEvent join 兜 general）。
    const roleName = t.isSubagent ? roleMap.get(t.subagentSessionId ?? "") : undefined;
    const agent = roleName ?? t.agentName;
    if (agent) rec.agent = agent;
    const tcs = byTurn.get(t.id) ?? [];
    const calls: Array<Record<string, unknown>> = [];
    // C 形锚点（斜杠命令轮）先行：命令轮通常无任何工具调用，锚点即该轮唯一 tool_call
    for (const skill of anchorsByTurnId.get(t.id) ?? []) {
      calls.push({ name: "skill", input: { skill } });
    }
    if (tcs.length > 0) {
      // **不带 result**(`tc.resultJson`):audit 判定只读 user_turns(scene)+ tool 输入
      // (input → tool_trace)+ assistant 文本(transcript_text),**工具结果对 verdict 零贡献**
      // (见 sift audit/auditor.py:rebuild 只取这三项;derive_declarations 只读
      // input_files 的 path,而 path 来自 Read 的 file_path 输入、不靠 result)。真实 session
      // 的 resultJson 常达 10MB+(Read 整文件 / skill 正文 / 大输出),回传它会让 --transcript
      // 的 session.json 撑到 20MB+,序列化 / 落盘 / sift 解析全慢——纯死重量,砍之。
      // sift 结构化 reader 对缺 result 的 tool_call 本就容错(不产 tool_result 块)。
      //
      // **例外:dispatch 类带 result**(截断 4096)。派发的 tool_result 是子代理
      // 最终报告——cc 原生 transcript 里它本来就是主作用域记录(主 agent 亲眼看到才能决策
      // 推进/修复),sift 层3 用它构建"派发-回报对"喂 step 判官(缺席式误判的洗冤证据 +
      // "传递≠达成"的验收结论依据)。sift reader 原生支持 tool_calls[].result。
      // 派发判定走注册表（task/agent/subagent/spawn_agent 及未来形态单点纳入）。
      for (const tc of tcs) {
        for (const anchor of anchorsByToolCallId.get(tc.toolCallId) ?? []) {
          calls.push({ name: "skill", input: { skill: anchor.skill } });
        }
        const call: Record<string, unknown> = {
          name: tc.toolName,
          input: parseArgs(tc.argsJson),
        };
        if (dispatchSpecOf(tc.toolName) !== null && tc.resultJson) {
          call.result = tc.resultJson.slice(0, 4096);
        }
        calls.push(call);
      }
    }
    if (calls.length > 0) rec.tool_calls = calls;
    return rec;
  });
  return { format: "sift-records", records };
}

/** 主 agent 编排对账目标的合成名（Skills / Audit skill 子 tab 用；root 的 skillName 无意义，仅作 key + 显示）。 */
export const MAIN_AGENT_WORKFLOW_NAME = "主 agent 编排";

/**
 * 恢复主 agent 的 workflow 声明正文：取 session **首条 user/system turn**
 * （isSubagent=false、turnIndex 最小）的 content，剥 skill 运行时注入尾部。
 *
 * 三种注入形态都落在首条消息上：
 * - **S1**（cannbot-proxy / opencode ≤1.4.7）：skill 正文注入首条 user 消息 → role=user。
 * - **S3**（opencode ≥1.17）：skill 正文注入首条消息且带 `Base directory for this
 *   skill:` 尾部标记 → 被 claude-jsonl adapter 的 skill-injection 启发重分类为
 *   role=system（wire 上仍是 user 消息）。主 agent 不 invoke skill → 声明只能从
 *   turn0 取，不在 skillEvents。
 *
 * 内容过短（< 插件 regulation.turn0MinChars）→ null（视为普通短用户查询，非 workflow
 * 声明；"continue" 等续跑消息、"Available agent types" 等短注册注入同被过滤）。
 * 找不到 turn → null。
 *
 * 注：这是主 agent 的**角色/编排规程**（agent.md-like），不是具体工作流。具体工作流
 * （任务树）是 STATE.md，见 `recoverPlanFileDeclaration`。root 对账送两者的组合声明
 * （`recoverCombinedWorkflowDeclaration`：本函数的产物是其中的规程层）。
 */
export async function recoverMainAgentWorkflowBody(
  sessionId: string,
  prisma: PrismaClient,
): Promise<string | null> {
  const t = await prisma.turn.findFirst({
    where: { sessionId, role: { in: ["user", "system"] }, isSubagent: false },
    orderBy: { turnIndex: "asc" },
  });
  if (!t?.content) return null;
  if (t.content.length < getWorkflowExtractPlugin().regulation.turn0MinChars) return null;
  return stripSkillRuntimeTail(t.content);
}

/** 计划文件扫描的 take 上限（大 session 防爆）。计划文件早期就写，1000 够覆盖。 */
const PLAN_FILE_SCAN_TAKE = 1000;

/**
 * 计划文件声明（recoverPlanFileDeclaration 的返回）：剥行号 + [x]→[ ] 归一后的
 * plan 态正文 + 来源标识（供 UI 显示）。
 */
export interface PlanFileDeclaration {
  content: string;
  source: string;
}

/** 从 argsJson 提取 filePath（兼容 filePath/file_path/path 三种字段名）。
 * 确定性提取与 LLM 提取（llm-workflow-extract 候选收集）共用。 */
export function extractFilePath(argsJson: string | null): string | null {
  if (!argsJson) return null;
  try {
    const a = JSON.parse(argsJson);
    if (a && typeof a === "object") {
      const fp = a.filePath ?? a.file_path ?? a.path ?? a.filename;
      if (typeof fp === "string") return fp;
    }
  } catch {
    /* not JSON */
  }
  const m = argsJson.match(/"(?:filePath|file_path|path|filename)"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

/** 取路径 basename（兼容 / 和 \）。 */
function basenameOf(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/**
 * filePath 是否在 skill 打包目录（插件 plan.excludedDirs，默认 resources/ 或 templates/）下。
 * 这些是 skill 声明的一部分（编排模板如 task-prompts.md），不是 session 级任务承诺——
 * 组合声明里它们属于规程层，进计划层会造成同文双计 + 归层徽章全命中（分层失效）。
 */
function isSkillPackagedFile(filePath: string | null): boolean {
  if (!filePath) return false;
  const norm = filePath.replace(/\\/g, "/");
  return getWorkflowExtractPlugin().plan.excludedDirs.some((d) =>
    norm.toLowerCase().includes(`/${d.toLowerCase()}/`),
  );
}

/** filePath 的 basename 是否命中计划文件名（插件 plan.fileNames，大小写不敏感）。 */
function isPlanFilename(filePath: string | null): boolean {
  if (!filePath) return false;
  const base = basenameOf(filePath).toLowerCase();
  return getWorkflowExtractPlugin().plan.fileNames.some((n) => base === n.toLowerCase());
}

/**
 * 从一个文件工具调用（read/write）提取 content + filePath + basename。
 * Read 两种形态：`<content>…</content>` 信封（信封内剥 opencode `N: ` 与 claude `N\t`
 * 行号）；无信封的裸行号文本（claude-code-proxy `N\t` / opencode `N: ` / 纯文本）回退
 * file-restore 的 parseReadLines 多格式行表（按真实行号排序拼接）。
 * Write：argsJson.content（JSON parse）。无 content → null。
 * apply_patch（codex 写通道）不在此提取：它是终态自证写产物，计划/资源声明恢复
 * 只取读承诺态（见 recoverPlanFileDeclaration 的「早读=承诺态」），且其裸 patch
 * 文本无法走本文件 JSON-only 的 extractFilePath 取 basename（恒 null，无命中可能）。
 * 确定性提取与 LLM 提取（llm-workflow-extract 候选收集）共用——两路正文字节一致。
 */
export function extractFileContent(tc: {
  toolName: string;
  argsJson: string | null;
  resultJson: string | null;
}): { content: string; basename: string | null } | null {
  const tn = (tc.toolName || "").toLowerCase();
  let content: string | null = null;
  if (tn === "read" && tc.resultJson) {
    const m = tc.resultJson.match(/<content>([\s\S]*?)<\/content>/);
    if (m) {
      const lines = m[1].split("\n");
      // claude 信封格式整篇 `N\t` 行号：全行皆 tab 行号才整篇剥（防 TSV 正文误剥）
      if (lines.filter((l) => l.trim()).every((l) => /^\s*\d+\t/.test(l))) {
        content = lines.map((l) => l.replace(/^\s*\d+\t/, "")).join("\n");
      } else {
        content = m[1].replace(/^\s*\d+:\s/gm, "");
      }
    } else {
      const lines = parseReadLines(tc.resultJson, extractOffset(tc.argsJson));
      if (lines.size > 0) {
        content = [...lines.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v).join("\n");
      }
    }
  } else if (tn === "write" && tc.argsJson) {
    try {
      const a = JSON.parse(tc.argsJson);
      if (a && typeof a.content === "string") content = a.content;
    } catch {
      /* ignore */
    }
  }
  if (!content) return null;
  const fp = extractFilePath(tc.argsJson);
  return { content, basename: fp ? basenameOf(fp) : null };
}

/**
 * shell 工具调用 → 逐文件读取候选（声明恢复共用）：restoreShellReads 引擎
 * 归因后的行表渲染成文本（缺口行跳过——未观测行不可知、不参与对账）。
 * codex 无 Read 工具，计划/资源文件的声明此前只认 Read 词表 → 全灭。
 */
function shellReadCandidates(tc: {
  argsJson: string | null;
  resultJson: string | null;
}): Array<{ filePath: string; content: string; basename: string | null }> {
  if (!tc.argsJson || !tc.resultJson) return [];
  const out: Array<{ filePath: string; content: string; basename: string | null }> = [];
  for (const entry of restoreShellReads(tc.argsJson, tc.resultJson)) {
    const { content } = renderShellEntryText(entry);
    if (content.length === 0) continue;
    out.push({ filePath: entry.filePath, content, basename: basenameOf(entry.filePath) });
  }
  return out;
}

/**
 * 桶内选「首次实质读取」：计划文件是运行时演进的（任务勾选、结果列追加），
 * 后读 = 终态（含执行结果）→ 拿结果当声明有自证风险；早读 = 承诺态（该干什么）。
 * 但首次读取可能是部分读取（Read 带 limit）→ 要求达桶内最长内容的 60% 才算"实质"，
 * 全不达标退最长（宁取终态也不取残片）。
 */
export function pickFirstSubstantial<T extends { content: string }>(cands: T[]): T | null {
  if (cands.length === 0) return null;
  const maxLen = Math.max(...cands.map((c) => c.content.length));
  const firstSubstantial = cands.find((c) => c.content.length >= maxLen * 0.6);
  if (firstSubstantial) return firstSubstantial;
  return cands.reduce((a, b) => (b.content.length > a.content.length ? b : a));
}

/**
 * 恢复主 agent 的 workflow 具体计划：从 session 的 Read 工具调用取计划内容，
 * [x]→[ ] 归一为 plan 态（声明=该干什么，非执行结果）。
 *
 * **named-Read 单路**（见 docs/design/workflow-plan-extraction/design.md）：
 * 单次 DB 查询（Read）+ 内存过滤，只有 basename 命中计划文件名（插件 plan.fileNames，
 * 命名即语义）的 Read 才算计划声明。todowrite（自评循环：计划写漏审不出）、
 * Write 产物（终态自证）、内容特征 scan（误报噪声）均不作为计划层。
 *
 * 文件桶内取「首次实质读取」（pickFirstSubstantial，见其 doc）：早读是承诺态。
 *
 * 返回 { content, source }：source = 文件名。
 */
export async function recoverPlanFileDeclaration(
  sessionId: string,
  prisma: PrismaClient,
): Promise<PlanFileDeclaration | null> {
  // 双通道：Read 工具（claude/opencode）+ shell 命令族隐式读（codex 无 Read，
  // cat/sed 读计划文件此前全灭）。shell 走两步（内存瘦身）：先只取 argsJson
  // 按命令侧路径初筛（extractShellFileReads 与恢复引擎同一路径判定单点），
  // 命中才回捞 resultJson 做归因——千级 exec 的 codex 会话不整段载入输出。
  const [readTcs, shellTcs] = await Promise.all([
    prisma.toolCall.findMany({
      where: {
        turn: { sessionId },
        toolName: { in: ["read", "Read"] },
      },
      select: { toolName: true, argsJson: true, resultJson: true, createdAt: true },
      orderBy: { createdAt: "asc" },
      take: PLAN_FILE_SCAN_TAKE,
    }),
    prisma.toolCall.findMany({
      where: {
        turn: { sessionId },
        toolName: { in: [...SHELL_TOOL_DB_NAMES] },
      },
      select: { id: true, argsJson: true, createdAt: true },
      orderBy: { createdAt: "asc" },
      take: PLAN_FILE_SCAN_TAKE,
    }),
  ]).then(([a, b]) => [a ?? [], b ?? []] as const);

  const namedReads: Array<{ content: string; basename: string; at: Date }> = [];
  for (const tc of readTcs) {
    // 计划层只认 Read（查询已过滤；此处自卫防御——Write 产物不作为声明）
    if ((tc.toolName || "").toLowerCase() !== "read") continue;
    // skill 打包目录（resources/templates）下的文件是 skill 声明（规程层素材），
    // 不是 session 级任务承诺 → 不进计划层（防同文双计 + 归层徽章全命中）。
    const ex = extractFileContent(tc);
    if (!ex) continue;
    if (isSkillPackagedFile(extractFilePath(tc.argsJson))) continue;
    if (isPlanFilename(ex.basename)) {
      namedReads.push({ content: ex.content, basename: ex.basename ?? "unknown", at: tc.createdAt });
    }
  }

  const shellHitIds: string[] = [];
  for (const tc of shellTcs) {
    const paths = extractShellFileReads(tc.argsJson).map((r) => r.filePath);
    if (paths.some((p) => isPlanFilename(p) && !isSkillPackagedFile(p))) shellHitIds.push(tc.id);
  }
  if (shellHitIds.length > 0) {
    const hits = await prisma.toolCall.findMany({
      where: { id: { in: shellHitIds } },
      select: { argsJson: true, resultJson: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    for (const tc of hits) {
      for (const cand of shellReadCandidates(tc)) {
        if (isSkillPackagedFile(cand.filePath)) continue;
        if (isPlanFilename(cand.basename)) {
          namedReads.push({ content: cand.content, basename: cand.basename ?? "unknown", at: tc.createdAt });
        }
      }
    }
  }
  // 双通道合并后统一时间序（pickFirstSubstantial 的「早读 = 承诺态」依赖顺序）
  const tv = (d: Date | null | undefined) => (d instanceof Date ? d.getTime() : 0);
  namedReads.sort((a, b) => tv(a.at) - tv(b.at));
  const bestNamedRead = pickFirstSubstantial(namedReads);
  const planBodyMin = getWorkflowExtractPlugin().plan.bodyMinChars;
  if (bestNamedRead && bestNamedRead.content.length >= planBodyMin) {
    return { content: bestNamedRead.content.replace(/\[x\]/g, "[ ]"), source: bestNamedRead.basename };
  }
  return null;
}

/**
 * 找主 agent 的 workflow skill name：主 agent（isSubagent=false）的首个 Skill
 * invoke/use 事件。S1 → ops-registry-invoke-glacier，S2 → ops-registry-invoke-workflow；
 * B 形会话（codex 无 skill 工具，Read/shell 读 SKILL.md → turn-split 合成 use 事件）
 * 同样可解。主 agent 通常先 invoke workflow skill（编排规程），再按它 dispatch 子 agent。
 * 比旧方案（turn0 ≥500 反查磁盘）更通用——不依赖 turn0 是注入型还是短用户任务。
 */
export async function resolveWorkflowSkillName(
  sessionId: string,
  prisma: PrismaClient,
): Promise<string | null> {
  const se = await prisma.skillEvent.findFirst({
    where: { eventType: { in: ["invoke", "use"] }, turn: { sessionId, isSubagent: false } },
    orderBy: { createdAt: "asc" },
  });
  return se?.skillName ?? null;
}

/**
 * 恢复 workflow skill 的 references 资源文件（task-prompts.md 等，具体编排模板）：
 * 主 agent Read 的文件里 filePath 含 skillName 的，取最长内容。
 * 泛化：不限文件名（task-prompts.md / prompts.md / ...），按 filePath 含 skill name 匹配。
 * 内容含每阶段 Task 调用参数（subagent_type + prompt + 验收标准）→ 外部声明的编排模板。
 * 双通道：Read 工具 + shell 隐式读（codex 的 cat/sed 读资源文件此前全灭）。
 */
export async function recoverSkillResourceFile(
  sessionId: string,
  skillName: string,
  prisma: PrismaClient,
): Promise<PlanFileDeclaration | null> {
  // 双通道：Read 工具 + shell 隐式读（codex 的 cat/sed 读资源文件此前全灭）。
  // argsJson 含 skillName 对 shell 天然过滤（命令里带技能路径才命中）
  const tcs = (await prisma.toolCall.findMany({
    where: {
      turn: { sessionId },
      toolName: { in: ["read", "Read", ...SHELL_TOOL_DB_NAMES] },
      argsJson: { contains: skillName },
    },
    select: { toolName: true, argsJson: true, resultJson: true },
    take: 200,
  })) ?? [];
  const candidates: Array<{ content: string; basename: string }> = [];
  for (const tc of tcs) {
    const tn = (tc.toolName || "").toLowerCase();
    // filePath 必须含 skillName 且命中插件 regulation.resourceDirs（默认 resources/，
    // 编排模板所在；templates/ 目录的 STATE.md.templ / DESIGN.md.templ 不命中自然排除）
    const reg = getWorkflowExtractPlugin().regulation;
    if (isShellToolCall(tn)) {
      for (const cand of shellReadCandidates(tc)) {
        if (!cand.filePath.includes(skillName) || !reg.resourceDirs.some((d) => cand.filePath.includes(d))) continue;
        candidates.push({ content: cand.content, basename: cand.basename ?? "unknown" });
      }
      continue;
    }
    const ex = extractFileContent(tc);
    if (!ex) continue;
    const fp = extractFilePath(tc.argsJson);
    if (!fp || !fp.includes(skillName) || !reg.resourceDirs.some((d) => fp.includes(d))) continue;
    candidates.push({ content: ex.content, basename: ex.basename ?? "unknown" });
  }
  const best = candidates.length > 0
    ? candidates.reduce((a, b) => (b.content.length > a.content.length ? b : a))
    : null;
  if (!best || best.content.length < getWorkflowExtractPlugin().regulation.bodyMinChars) return null;
  return { content: best.content.replace(/\[x\]/g, "[ ]"), source: best.basename };
}

/**
 * 恢复 workflow 声明的**规程层**（编排规程）。root 对账送组合声明
 * （`recoverCombinedWorkflowDeclaration` = 本函数的规程层 + `recoverPlanFileDeclaration`
 * 的计划层），本函数只负责规程层。
 *
 * 按 sift 设计意图（slice.py 注释："root 声明常是 workflow 级 SKILL.md"），
 * 规程层审"编排纪律遵循度"；计划层（STATE.md）审"任务完成度"——
 * 两层盲区正交互补，故组合。
 *
 * 两种 workflow skill 加载方式：
 * - **S2 型（Skill invoke）**：主 agent 调用 Skill 工具加载 workflow skill。
 *   优先级 1：skill resources 文件（task-prompts.md 等，具体编排模板）。
 *   优先级 2：SKILL.md body（编排规程骨架，`<skill_content>`）。
 * - **S1 型（turn0 注入）**：workflow skill 正文注入首条 user turn（≥500 字），
 *   主 agent 不 invoke skill。turn0 = agent.md-like 编排规程。
 *
 * workflow skill 定位：主 agent Skill invoke（`resolveWorkflowSkillName`）；
 * 无 invoke → 退 turn0 ≥500（`recoverMainAgentWorkflowBody`）。
 * S1 → turn0 注入（1809 字编排规程），S2 → Skill invoke（ops-registry-invoke-workflow）。
 *
 * 返回 { content, source }：source = 文件名（resources）或 "skillName (SKILL.md)"。
 *（本函数单用时即 root 声明；组合声明里是规程层。）
 */
export async function recoverWorkflowDeclaration(
  sessionId: string,
  prisma: PrismaClient,
): Promise<PlanFileDeclaration | null> {
  const skillName = await resolveWorkflowSkillName(sessionId, prisma);

  // 有 Skill invoke（S2 型）：workflow skill 通过 Skill 调用加载
  if (skillName) {
    // 优先级 1：skill resources 文件（task-prompts.md 等，具体编排模板）
    const resource = await recoverSkillResourceFile(sessionId, skillName, prisma);
    if (resource) return resource;
    // 优先级 2：SKILL.md body（编排规程骨架）
    const body = await recoverSkillBody(sessionId, skillName, prisma);
    if (body && body.length >= getWorkflowExtractPlugin().regulation.bodyMinChars) {
      return { content: body, source: `${skillName} (SKILL.md)` };
    }
  }

  // 无 Skill invoke（S1 型）：workflow skill 注入 turn0（编排规程在首条 user turn）
  // turn0 ≥500 字 = 注入的 agent.md-like 编排规程，不是短用户任务
  const turn0 = await recoverMainAgentWorkflowBody(sessionId, prisma);
  if (turn0) {
    return { content: turn0, source: "turn0 (注入编排规程)" };
  }

  return null;
}

/**
 * root 对账的组合声明：**编排规程层 + 任务计划层** 拼接（分层标注）。
 *
 * **状态：已从审计链退役（休眠保留）**——workflow 审计的声明提取已整体切换
 * LLM 选择式路（llm-workflow-extract 单点），本函数不再被任何路由/探测调用；
 * 代码与配套插件体系保留作为领域启发路的历史实现与回退/对照素材（UT 保持绿，
 * llm-workflow-extract.test 的字节级同构用例仍以本函数为对照基准）。
 *
 * 单层各有结构性盲区：规程层（agent.md-like，"怎么干"）对"本单任务做没做完"无话可说；
 * 计划层（STATE.md-like，"干什么"）是运行时生成的自我承诺，计划写漏时审不出（自评循环）。
 * 拼接后一次 root 对账同时审两个正交问题：编排纪律遵循度 + 任务完成度。
 *
 * - 规程层：`recoverWorkflowDeclaration`（skill resources > SKILL.md body > turn0 注入）
 * - 计划层：`recoverPlanFileDeclaration`（named-Read：计划文件名白名单命中）
 *
 * 两层都有 → 带分层标题拼接（标题是结构性文本，extractor 不当指令）；单层 → 原文直出
 * （与该层单独使用的产出逐字节一致，native 行为不变）；两层皆无 → null（root 目标不可用）。
 *
 * layers 随 result 事件回传前端，FindingCard 按 instruction_text 子串匹配归层打徽章。
 */
export async function recoverCombinedWorkflowDeclaration(
  sessionId: string,
  prisma: PrismaClient,
): Promise<{ content: string; source: string; layers: AuditLayerInfo[] } | null> {
  const regulation = await recoverWorkflowDeclaration(sessionId, prisma);
  const plan = await recoverPlanFileDeclaration(sessionId, prisma);

  const layers: AuditLayerInfo[] = [];
  if (regulation) {
    layers.push({
      kind: "regulation",
      label: "编排规程",
      source: regulation.source,
      content: regulation.content,
    });
  }
  if (plan) {
    layers.push({
      kind: "plan",
      label: "任务计划",
      source: plan.source,
      content: plan.content,
    });
  }
  return assembleCombinedDeclaration(layers);
}

/**
 * 组合声明的装配函数：层列表 → 最终声明（content + source + layers）。
 *
 * **确定性提取与 LLM 提取共享此装配**——LLM 路只做"选哪份候选"，正文一律取 DB 原文、
 * 归一化（剥行号 / [x]→[ ]）全在代码里做，装配字节级一致：
 * "提取拼接可以，篡改不可以"由构造保证（LLM 无从改写正文）。
 *
 * - 两层 → 带分层标题拼接（标题是结构性文本，extractor 不当指令）
 * - 单层 → 原文直出（与该层单独使用的产出逐字节一致）
 * - 空 → null
 */
export function assembleCombinedDeclaration(layers: AuditLayerInfo[]): {
  content: string;
  source: string;
  layers: AuditLayerInfo[];
} | null {
  if (layers.length === 0) return null;
  if (layers.length === 1) {
    return { content: layers[0].content, source: layers[0].source, layers };
  }
  const content = [
    "# Workflow 声明（主 agent）",
    "",
    "## 一、编排规程",
    "",
    layers[0].content,
    "",
    "## 二、任务计划",
    "",
    layers[1].content,
    "",
  ].join("\n");
  return {
    content,
    source: `规程: ${layers[0].source} + 计划: ${layers[1].source}`,
    layers,
  };
}

/**
 * 按 session + skillName 恢复该 skill 的纯 SKILL.md 正文，委托 selectSkillContent
 * 四通道单点（skill-tool `<skill_content>` / 斜杠命令 system 注入 / Read
 * `<content>` / shell 读类命令终端输出）——与 Skills 面板「SKILL.md 原文」
 * 同一恢复路径。
 *
 * 候选面经 collectSkillContentCandidates 单点（工具调用 OR 词表 + system
 * 注入轮），三处消费方（本函数 + 两个 handler）同宽。
 * 历史缺陷（codex 客户现场）：本函数此前自带一套 invoke 事件 + skill 工具族的
 * 平行词表，B 形会话（无 read 工具、cat 读 SKILL.md、eventType=use）全链 404。
 * 找不到 / 无正文 → null。
 */
export async function recoverSkillBody(
  sessionId: string,
  skillName: string,
  prisma: PrismaClient,
): Promise<string | null> {
  return (await recoverSkillDeclaration(sessionId, skillName, prisma))?.content ?? null;
}

/**
 * 对账用声明的恢复出口：正文只含会话中确实读到的行（未读部分不补、不猜），
 * 行级证据随同一结果返回——对账路由据此在结果上挂「声明不完整」提示。
 * 找不到 / 无可靠正文 → null。
 */
export async function recoverSkillDeclaration(
  sessionId: string,
  skillName: string,
  prisma: PrismaClient,
): Promise<SkillContentResult | null> {
  const { toolCalls, turns } = await collectSkillContentCandidates(prisma, sessionId);
  return selectSkillContent(toolCalls, skillName, turns);
}

/** 声明不完整（有未读行 / 读取被截断）→ 随对账结果回传的证据项；完整 → null。 */
export function declarationEvidenceOf(
  source: string,
  layer: string | undefined,
  decl: { fullRead: boolean; evidence: LineEvidence } | null | undefined,
): AuditDeclarationEvidence | null {
  if (!decl || decl.fullRead) return null;
  return { source, ...(layer ? { layer } : {}), evidence: decl.evidence };
}

/**
 * Skill audit 板块的 target 列表：从 session 已有的 skillEvents 派生本 session 所有可对账的
 * 声明单元，同名合并。每行按 events 的 eventType 路由对账面：
 *
 * - skill 面：eventType=invoke/use → skill 对账（正文从 session 的 resultJson 恢复）
 * - agent 面：eventType=dispatch → agent 对账（.md 声明从 AGENTS_SCAN_ROOT 本地扫描，
 *   见 audit-agentsift 路由 + agent-md-scan.ts）
 *
 * 注：root 面（主 agent 编排 对账）**不在此派生**——主 agent 通常只 dispatch、不 invoke
 * skill，其 workflow 声明是 session 首条 user turn 的注入系统提示。root 目标由 SkillAuditTab /
 * SkillDetail 按 turn0 长度阈值合成添加（见 audit-skillsift kind=root +
 * recoverMainAgentWorkflowBody）。
 *
 * dual-nature（同既 invoke 又 dispatch，如 st-verifier）两面都返，UI 出多个条目各审各的
 * （与 sift 的 kind 分路一致——同名 skill 声明 ≠ agent 声明）。
 *
 * 输入是 page.tsx 已加载的内存数据（不查 DB），鸭子类型兼容 SkillEventForDetail。
 */
export interface AuditableTarget {
  name: string;
  kinds: ("skill" | "agent" | "root")[];
  skillEventCount: number;
}

export function deriveAuditableTargets(
  skillEvents: { skillName: string; eventType: string }[],
): AuditableTarget[] {
  const byName = new Map<string, { skillEvents: { eventType: string }[] }>();
  for (const se of skillEvents) {
    const name = se.skillName;
    if (!name) continue;
    const entry = byName.get(name) ?? { skillEvents: [] };
    entry.skillEvents.push(se);
    byName.set(name, entry);
  }
  const targets: AuditableTarget[] = [];
  for (const [name, e] of byName) {
    const kinds = auditKindsForEvents(e.skillEvents);
    if (kinds.length === 0) continue;
    targets.push({ name, kinds, skillEventCount: e.skillEvents.length });
  }
  targets.sort((a, b) => a.name.localeCompare(b.name));
  return targets;
}
