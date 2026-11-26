// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { spawn } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import type { AuditDeclarationEvidence, AuditLayerInfo } from "./sift-audit-types";
import {
  assembleCombinedDeclaration,
  declarationEvidenceOf,
  extractFileContent,
  extractFilePath,
  isSkillInvokeToolCall,
  pickFirstSubstantial,
  stripSkillRuntimeTail,
} from "./sift-audit";
// SKILL.md 正文候选走 skill-content 三通道单点（skill-tool / Read / shell）——
// codex 无 read 工具，cat 读 SKILL.md 同样入规程候选，词表与摄取/恢复侧共用。
import { skillMdReadsOfToolCall, skillMdReadsOfTurn, selectFromSkillReads, type SkillMdRead } from "./skill-content";
import { describeLineEvidence, sameDeclarationFile, type LineEvidence } from "./skill-evidence";
import { isShellToolCall, SHELL_TOOL_DB_NAMES } from "./tool-conventions";
// shell 隐式读（cat/sed 等）的文件归因引擎——与 skill-content shell 通道同源；
// codex 无 read 工具，计划/规程文件此前只认 Read 词表 → 全灭。
import { restoreShellReads, shellEntryCoverage } from "./shell-restore";
import { extractShellFileReads } from "./file-reads";
import { logError } from "@/lib/logger";

/**
 * LLM 提取主 agent 组合声明——**workflow 审计的声明提取唯一使用路**。
 *
 * 确定性提取链（sift-audit.ts 的 recoverCombinedWorkflowDeclaration 族 + 插件体系）
 * 已从审计链退役：代码保留休眠（不再被任何路由/探测使用），作为领域插件路的历史
 * 实现与回退素材。当前 root 对账、探测、预览全部走本模块。
 *
 * **选择式契约（不可篡改 by construction）**：LLM 不抄写正文——只从确定性收集的候选列表里
 * 选出「规程层用哪份、计划层用哪份」（输出候选 ID 的 JSON）；正文一律取 DB 原文，
 * 机械归一化（Read 剥行号 / 计划层 [x]→[ ]）在代码里做，
 * 最终与确定性提取（recoverCombinedWorkflowDeclaration）**共享同一个装配函数**
 * assembleCombinedDeclaration——两条路产出字节级同构（"提取拼接可以，篡改不可以"）。
 *
 * 两层分工：
 * - 规程层（编排纪律，"怎么干"）：skill 注入的编排规程 / 编排模板文件 / turn0 注入
 * - 计划层（任务承诺，"干什么"）：事先写定的承诺态清单（勾选承载进度、可机械归一
 *   [x]→[ ] 还原承诺态）。运行时状态账本（状态列/进度日志/欠账登记）记录的是「干到
 *   了哪」——需要内容手术才能还原承诺态的文档永远不能入声明（选择规则见
 *   buildCandidatePrompt；账本的归宿是证据侧，不是声明侧）。
 */

/** 引导区语境行上限（prompt 语境用，非候选）。 */
const MAX_TURNS = 10;
const CLAUDE_TIMEOUT_MS = 300_000;

/** 规程候选扫描窗口：dispatch 前非子代理轮（引导区全窗）。
 * 真实 day0 会话实证：flow 模板/tracker 模板在 T27-T52 读入、首 dispatch 在 T163——
 * 此前 take:10 的静默截窄把这些规程材料全部切掉，规程候选只剩注入通道侥幸兜底。 */
const REG_WINDOW_MAX_TURNS = 500;

/** 候选正文的机械下限（过滤空/残片，非领域启发）。 */
const CANDIDATE_MIN_CHARS = 100;
/** turn0 user 注入候选的下限（低于视为短任务噪声，不入候选）。 */
const USER_CANDIDATE_MIN_CHARS = 200;
/** prompt 内候选正文预览上限（选择只需可辨认的开头结构）。 */
const PREVIEW_MAX_CHARS = 1200;
/** 计划候选总数上限（防爆 prompt；实测 40 候选 × 2000 字预览撑到 78KB，选不动还慢）。 */
const MAX_PLAN_CANDIDATES = 16;
/** 规程候选总数上限。 */
const MAX_REG_CANDIDATES = 8;
/** 计划候选的文件扩展名白名单（任务清单/计划文档的实际载体）。 */
const PLAN_FILE_EXTENSIONS = [".md", ".txt"];
/** 计划候选查询的 take 上限（read/write/shell 三通道合并池；Bash 千级调用入池后
 * 防时序截断把晚段 Read 挤出——真实会话 1700+ 调用里 tracker.md 的读集中在 T722+）。 */
const PLAN_SCAN_TAKE = 4000;

/** 一份可被 LLM 选择的声明候选（正文为 DB 原文，归一化见各收集点）。 */
export interface WorkflowExtractCandidate {
  /** 候选 ID（"R1".."Rn" 规程 / "P1".."Pn" 计划），LLM 输出引用它。 */
  id: string;
  layer: "regulation" | "plan";
  /** 来源标识（与确定性提取的 source 口径一致：basename / "skillName (SKILL.md)" / "turn0 (注入编排规程)"）。 */
  source: string;
  /** 原文（Read 已剥行号；计划层 [x] 归一在选择命中时做）。 */
  content: string;
  /** Read 带 offset/limit（部分读取，prompt 里降权提示）。 */
  partialRead: boolean;
  /** 同一文件被读的次数（多次读取 = 活跃计划文件信号，仅排序提示）。 */
  readCount?: number;
  /** 同一文件在 session 内被写的次数（写入来源 = 执行产物的中性信号；
   * 0 = 只读未写，更像事先存在的契约/清单）。 */
  writeCount?: number;
  /** markdown 勾选框行数（[ ]/[x]，计划层归一载体计数——「进度是否由勾选承载」的
   * 机械信号，与 readCount/writeCount 同为中性标注，判内容仍交给 LLM）。 */
  checkboxCount?: number;
  /** 完整路径（basename 撞名时 source 扩为「父目录/文件名」，其余时候不展示）。 */
  pathHint?: string;
  /** 候选不完整时的行级证据（来源为会话内行号读取：覆盖了哪些行、缺哪些行）。 */
  evidence?: LineEvidence;
}

export interface WorkflowExtractCandidates {
  regulation: WorkflowExtractCandidate[];
  plan: WorkflowExtractCandidate[];
  /** dispatch 前引导区的 turn 骨架（prompt 语境用，非候选）。 */
  contextLines?: string[];
}

/**
 * 廉价探测：该 session 是否有可供 LLM 选择的声明候选（规程或计划任一非空）。
 *
 * RunAuditTab 挂载期探测（main-agent-workflow 端点的 available 徽标）用——
 * 确定性、零 LLM 调用（就是候选收集本身），毫秒级。
 * 注意：有候选 ≠ LLM 必然选出可用两层（选择可为 null、部分读取等由选择阶段
 * 判断）——探测只回答「能否发起 root 对账」，失败在对账流里诚实暴露。
 */
export async function hasWorkflowExtractCandidates(
  sessionId: string,
  prisma: PrismaClient,
): Promise<boolean> {
  const candidates = await collectWorkflowExtractCandidates(sessionId, prisma);
  return candidates.regulation.length > 0 || candidates.plan.length > 0;
}

/**
 * 服务端模块级缓存：GET 端点立即返回（不阻塞 HTTP 连接），前端轮询。
 * key = taskId, value = { loading, content, source, error, promise }
 */
interface LlmExtractJob {
  loading: boolean;
  content: string | null;
  source: string | null;
  error: string | null;
  /** 所选声明不完整时的行级证据（完整时缺省）。 */
  evidence?: AuditDeclarationEvidence[];
  promise: Promise<void> | null;
}
const extractJobs = new Map<string, LlmExtractJob>();

/**
 * 启动或查询 LLM 提取任务。非阻塞：
 * - 无 job → 后台启动 claude CLI，立即返回 { loading: true }
 * - 已在运行 → 返回同一 job（loading: true）
 * - 已完成（成功或失败）→ 原样返回 content 或 error。**失败不自动重启**——前端轮询会
 *   反复 GET，若失败即重启会变成"每 5s 重spawn CLI、loading 永远 true"的死循环
 *   （v2.02 修过的坑）。显式重试走 opts.force（重试按钮 → restart=1）。
 * - opts.force：job 已失败/已完成且不在跑 → 丢弃旧 job 重新启动；在跑 → 原样返回。
 */
export function getOrStartLlmExtract(
  taskId: string,
  sessionId: string,
  prisma: PrismaClient,
  opts?: { force?: boolean },
): LlmExtractJob {
  const existing = extractJobs.get(taskId);
  if (existing) {
    if (existing.loading) return existing;
    if (!opts?.force) return existing;
    // force 且已 settle：丢弃重启（在跑的上面已 return）
  }

  const job: LlmExtractJob = { loading: true, content: null, source: null, error: null, promise: null };
  extractJobs.set(taskId, job);

  job.promise = (async () => {
    try {
      const decl = await llmExtractWorkflowDeclaration(sessionId, prisma);
      if (decl) { job.content = decl.content; job.source = decl.source; job.evidence = decl.evidence; }
      else { job.error = "LLM 提取无输出（无候选/选择无效）"; }
    } catch (e) { job.error = e instanceof Error ? e.message : String(e); }
    finally { job.loading = false; }
  })();

  return job;
}

/** 测试用：清空 job 缓存。 */
export function __resetLlmExtractForTests(): void {
  extractJobs.clear();
}

/** LLM 运行器结果：text=正常输出；error=CLI 基础设施失败（认证 403/非 0 退出/超时/启动失败），
 * 调用方须把 error 上抛给用户（此前被吞成"提取中"死循环的正是这类失败）。 */
export interface LlmRunnerResult {
  text: string | null;
  error: string | null;
}

/** LLM 运行器（prompt → 结果）；生产走 claude CLI，测试可注入。 */
export type LlmRunner = (prompt: string) => Promise<LlmRunnerResult>;

/**
 * LLM 提取组合声明：收集候选 → 选择式 prompt → LLM 选 → 共享装配。
 * 返回与 recoverCombinedWorkflowDeclaration 同构（content/source/layers）。
 *
 * CLI 基础设施失败（认证/退出/超时）→ **throw**（消息直达用户，如 "claude CLI 退出码 1：
 * Failed to authenticate. API Error: 403 invalid api-key"）；无候选/选择无效 → null。
 */
export async function llmExtractWorkflowDeclaration(
  sessionId: string,
  prisma: PrismaClient,
  runner: LlmRunner = runClaudeCli,
): Promise<{ content: string; source: string; layers: AuditLayerInfo[]; evidence: AuditDeclarationEvidence[] } | null> {
  const candidates = await collectWorkflowExtractCandidates(sessionId, prisma);
  if (candidates.regulation.length === 0 && candidates.plan.length === 0) {
    console.log('[llm-workflow-extract] no candidates collected');
    return null;
  }

  const prompt = buildCandidatePrompt(candidates);
  console.log('[llm-workflow-extract] prompt length:', prompt.length,
    'reg candidates:', candidates.regulation.length, 'plan candidates:', candidates.plan.length);

  const result = await runner(prompt);
  if (!result.text) {
    const reason = result.error ?? "无输出";
    logError('workflow-extract', 'LLM runner failed', { reason: String(reason).slice(0, 200), promptChars: prompt.length });
    throw new Error(reason);
  }

  const layers = parseCandidateSelection(result.text, candidates);
  if (layers.length === 0) {
    logError('workflow-extract', 'selection parsed to no layers', { output: result.text.slice(0, 300) });
    return null;
  }
  const evidence = layers
    .map(l => declarationEvidenceOf(l.source, l.label, l.evidence ? { fullRead: false, evidence: l.evidence } : null))
    .filter((e): e is AuditDeclarationEvidence => e != null);
  const assembled = assembleCombinedDeclaration(layers);
  if (!assembled) return null;
  return { ...assembled, evidence };
}

/**
 * 确定性收集候选（LLM 只在此之上做选择）：
 *
 * - 规程候选（dispatch 前引导区全窗，cap REG_WINDOW_MAX_TURNS）：turn0 user 注入、
 *   skill invoke 的 `<skill_content>` 正文、Read 的文件正文（覆盖 skill resources
 *   编排模板）、shell 隐式读的 .md/.txt（codex 无 read 工具）。文件多通道按路径
 *   分组取首份实质快照。
 * - 计划候选（全 session）：.md/.txt 文件 read/write + shell 隐式读（每文件取首次
 *   实质读取快照，同文件多次读不重复占位），readCount/writeCount 分开计——
 *   「session 内被写」是执行产物 vs 外部契约的中性信号。
 *   todowrite 不入候选（主 agent 自我维护的 todos 是自评循环，不作为计划层）。
 *
 * 收集零领域启发（文件名白名单/内容特征全交给 LLM 判断）——这是泛化路径；
 * 排序仅用中性信号（读次数、时序）帮助候选进入名单。
 *
 * 查询两步走（性能）：先只取 argsJson（小）判定哪些调用需要正文，再按 id 批量取
 * resultJson——直接 select resultJson 会把全 session 的 Read 大结果（单条可达 MB 级）
 * 整列拉进内存，大 session 收集就要几十秒。
 */
export async function collectWorkflowExtractCandidates(
  sessionId: string,
  prisma: PrismaClient,
): Promise<WorkflowExtractCandidates> {
  // ── 规程候选：dispatch 前窗口（首个 dispatch 的 turnIndex 作 cutoff）──
  const firstDispatch = await prisma.skillEvent.findFirst({
    where: { eventType: "dispatch", turn: { sessionId, isSubagent: false } },
    orderBy: { createdAt: "asc" },
    select: { turnId: true },
  });
  let cutoff: number | undefined;
  if (firstDispatch) {
    const dispatchTurn = await prisma.turn.findUnique({
      where: { id: firstDispatch.turnId },
      select: { turnIndex: true },
    });
    cutoff = dispatchTurn?.turnIndex ?? undefined;
  }

  const turns = await prisma.turn.findMany({
    where: {
      sessionId,
      isSubagent: false,
      ...(cutoff != null ? { turnIndex: { lt: cutoff } } : {}),
    },
    orderBy: { turnIndex: "asc" },
    take: REG_WINDOW_MAX_TURNS,
    select: { id: true, turnIndex: true, role: true, content: true, agentName: true },
  });

  const regCandidates: WorkflowExtractCandidate[] = [];
  const contextLines: string[] = [];
  // 窗口内对 SKILL.md 的全部读取（skill-tool / Read / shell / 斜杠命令注入）——同一
  // SKILL.md 的多个截断片段、行范围读在窗口结束后按行号合并为一个候选
  const skillReads: SkillMdRead[] = [];
  // 窗口内文件读（Read/shell 隐式读）按路径分组 → 每文件首份实质快照
  // （同文件多次/多通道读不重复占席——overlay_flow 两段部分读此前吃掉 2 个候选位）。
  const regFileSnaps = new Map<string, Array<{ content: string; partialRead: boolean; evidence?: LineEvidence }>>();
  if (turns.length > 0) {
    // 步骤 1：窗口内工具调用的轻量元数据（不含 resultJson）
    const regMeta = await prisma.toolCall.findMany({
      where: { turnId: { in: turns.map((t) => t.id) } },
      orderBy: { createdAt: "asc" },
      select: { id: true, turnId: true, toolName: true, argsJson: true },
    });
    // 步骤 2：只为"skill invoke + Read/shell(.md/.txt)"批量取 resultJson
    const regNeedIds = regMeta
      .filter((tc) => {
        const tn = tc.toolName.toLowerCase();
        if (isSkillInvokeToolCall(tc.toolName)) return true;
        if (isShellToolCall(tn) && /\.(md|txt)/i.test(tc.argsJson ?? "")) return true;
        if (tn !== "read") return false;
        const base = basenameOf(extractFilePath(tc.argsJson));
        return PLAN_FILE_EXTENSIONS.some((e) => base.toLowerCase().endsWith(e));
      })
      .map((tc) => tc.id);
    const resultById = await fetchResultJsonByIds(prisma, regNeedIds);

    const tcByTurn = new Map<string, Array<{ toolName: string; argsJson: string | null; resultJson: string | null }>>();
    for (const tc of regMeta) {
      const arr = tcByTurn.get(tc.turnId) ?? [];
      arr.push({ toolName: tc.toolName, argsJson: tc.argsJson, resultJson: resultById.get(tc.id) ?? null });
      tcByTurn.set(tc.turnId, arr);
    }

    for (const t of turns) {
      // 引导区语境（供 LLM 理解，非候选；封顶防爆 prompt）
      if (contextLines.length < MAX_TURNS) {
        contextLines.push(`- Turn ${t.turnIndex} (${t.role}${t.agentName ? `, agent=${t.agentName}` : ""}): ${firstLine(t.content)}`);
      }

      // C 形（斜杠命令注入，claude-code v1：/skill 展开全文进 system 轮、无工具调用行）
      // 与 S3（opencode ≥1.17 注入体带 Base directory 标记）的注入正文都在轮级——
      // skillMdReadsOfTurn 是 skill-content 四通道单点的轮级面（skill-tool / Read / shell
      // 三通道由下方 tc 级覆盖，此处补注入通道）。正文再过 stripSkillRuntimeTail（幂等）：
      // S3 的中部标记块 / <skill_files> 清单同样要剥。
      // 现场缺口：day0-inference 会话 19823 字注入体落在 turnIndex=1 的 system 轮，
      // 此前收集只认 turnIndex===0 → 规程候选仅剩 373 字命令壳，正文缺席。
      const injReads = skillMdReadsOfTurn(t);
      skillReads.push(...injReads);
      // S1（role=user 注入，无标记老形态）与泛化大文本的 turn0 兜底——注入轮已被
      // 上面通道以真名收录（同一正文不重复收两份）
      if (
        injReads.length === 0 &&
        (t.role === "user" || t.role === "system") &&
        t.turnIndex === 0 &&
        (t.content ?? "").length >= USER_CANDIDATE_MIN_CHARS
      ) {
        regCandidates.push({
          id: "", // 编号在收集完成后统一定
          layer: "regulation",
          source: "turn0 (注入编排规程)",
          content: stripSkillRuntimeTail(t.content!),
          partialRead: false,
        });
      }
      for (const tc of tcByTurn.get(t.id) ?? []) {
        // SKILL.md 正文候选（skillMdReadsOfToolCall 三通道单点；skill-tool 通道
        // 的 <skill_content> 剥壳在此前实现里，现统一走 skill-content）
        const mdReads = skillMdReadsOfToolCall(tc);
        if (mdReads.length > 0) skillReads.push(...mdReads);
        if (mdReads.length === 0 && tc.toolName.toLowerCase() === "read") {
          const ex = extractFileContent(tc);
          if (ex && ex.content.length >= CANDIDATE_MIN_CHARS && ex.basename) {
            const key = extractFilePath(tc.argsJson) ?? ex.basename;
            const arr = regFileSnaps.get(key) ?? [];
            arr.push({ content: ex.content, partialRead: hasReadOffsetOrLimit(tc.argsJson) });
            regFileSnaps.set(key, arr);
          }
        } else if (isShellToolCall(tc.toolName)) {
          // shell 隐式读（cat/sed 等）：.md/.txt 规程材料（flow 模板等）入候选
          for (const entry of restoreShellReads(tc.argsJson, tc.resultJson)) {
            // 同一命令里读到的 SKILL.md 已走技能候选，不再作为文件候选重复入列；
            // 命令里其余的规程文件照常入列（此前读到 SKILL.md 的命令整条被技能分支独占）
            if (mdReads.some((r) => r.filePath != null && sameDeclarationFile(r.filePath, entry.filePath))) continue;
            const base = basenameOf(entry.filePath);
            if (!PLAN_FILE_EXTENSIONS.some((e) => base.toLowerCase().endsWith(e))) continue;
            const { content, evidence, complete } = shellEntryCoverage(entry);
            if (content.length < CANDIDATE_MIN_CHARS) continue;
            const arr = regFileSnaps.get(entry.filePath) ?? [];
            arr.push({ content, partialRead: !complete, evidence });
            regFileSnaps.set(entry.filePath, arr);
          }
        }
      }
    }
    // SKILL.md → 规程候选（每技能一份：多段读取按行号合并，只含确实读到的行；
    // 此前每次读取各占一个候选，截断片段之间互相竞争、入选的只是残篇且无标记）
    const skillNames = [...new Set(skillReads.map(r => r.skillName))];
    for (const skillName of skillNames) {
      const merged = selectFromSkillReads(skillReads, skillName);
      if (!merged || merged.content.length < CANDIDATE_MIN_CHARS) continue;
      regCandidates.push({
        id: "",
        layer: "regulation",
        source: `${skillName} (SKILL.md)`,
        content: merged.content,
        partialRead: !merged.fullRead,
        evidence: merged.fullRead ? undefined : merged.evidence,
      });
    }
    // 文件分组 → 规程候选（每文件首份实质读取，首触时序）
    for (const [fp, snaps] of regFileSnaps) {
      const best = pickFirstSubstantial(snaps);
      if (!best) continue;
      regCandidates.push({
        id: "",
        layer: "regulation",
        source: basenameOf(fp),
        content: best.content,
        partialRead: best.partialRead,
        evidence: best.partialRead ? best.evidence : undefined,
        pathHint: fp,
      });
    }
  }

  // ── 计划候选：全 session 的 read/write + shell 隐式读 ──
  // 步骤 1：轻量元数据；write 的正文在 argsJson 里，read/shell 的正文在 resultJson
  const planMeta = await prisma.toolCall.findMany({
    where: {
      turn: { sessionId },
      toolName: { in: ["read", "Read", "write", "Write", ...SHELL_TOOL_DB_NAMES] },
    },
    orderBy: { createdAt: "asc" },
    take: PLAN_SCAN_TAKE,
    select: { id: true, toolName: true, argsJson: true },
  });
  // 步骤 2：只为"Read/shell(.md/.txt)"批量取 resultJson（write 用 argsJson 即可）
  const planReadIds = planMeta
    .filter((tc) => {
      if (isShellToolCall(tc.toolName)) {
        // shell：命令侧路径初筛（与恢复引擎同一路径判定单点），命中才回捞 resultJson
        const paths = extractShellFileReads(tc.argsJson).map((r) => r.filePath);
        return paths.some((p) => PLAN_FILE_EXTENSIONS.some((e) => p.toLowerCase().endsWith(e)));
      }
      if (tc.toolName.toLowerCase() !== "read") return false;
      const base = basenameOf(extractFilePath(tc.argsJson));
      return PLAN_FILE_EXTENSIONS.some((e) => base.toLowerCase().endsWith(e));
    })
    .map((tc) => tc.id);
  const planResultById = await fetchResultJsonByIds(prisma, planReadIds);
  const planTcs = planMeta.map((tc) => ({
    toolName: tc.toolName,
    argsJson: tc.argsJson,
    resultJson: planResultById.get(tc.id) ?? null,
  }));

  const fileGroups = new Map<string, Array<{ content: string; partialRead: boolean; evidence?: LineEvidence; op: "read" | "write" }>>();
  for (const tc of planTcs) {
    if (isShellToolCall(tc.toolName)) {
      for (const entry of restoreShellReads(tc.argsJson, tc.resultJson)) {
        const base = basenameOf(entry.filePath);
        if (!PLAN_FILE_EXTENSIONS.some((e) => base.toLowerCase().endsWith(e))) continue;
        const { content, evidence, complete } = shellEntryCoverage(entry);
        if (content.length < CANDIDATE_MIN_CHARS) continue;
        const arr = fileGroups.get(entry.filePath) ?? [];
        arr.push({ content, partialRead: !complete, evidence, op: "read" });
        fileGroups.set(entry.filePath, arr);
      }
      continue;
    }
    const ex = extractFileContent(tc);
    if (!ex || ex.content.length < CANDIDATE_MIN_CHARS) continue;
    const fp = extractFilePath(tc.argsJson);
    const base = ex.basename ?? basenameOf(fp);
    if (!base || !PLAN_FILE_EXTENSIONS.some((e) => base.toLowerCase().endsWith(e))) continue;
    const key = fp ?? base;
    const arr = fileGroups.get(key) ?? [];
    arr.push({
      content: ex.content,
      partialRead: hasReadOffsetOrLimit(tc.argsJson),
      op: /write/i.test(tc.toolName) ? "write" : "read",
    });
    fileGroups.set(key, arr);
  }

  // 每文件取首次实质读取（与确定性提取同语义：早读=承诺态，非终态）；
  // readCount/writeCount 分开计——「session 内被写」是执行产物 vs 外部契约的中性信号
  const fileCandidates: WorkflowExtractCandidate[] = [];
  for (const [fp, snaps] of fileGroups) {
    const best = pickFirstSubstantial(snaps);
    if (!best) continue;
    fileCandidates.push({
      id: "",
      layer: "plan",
      source: basenameOf(fp),
      content: best.content,
      partialRead: best.partialRead,
      evidence: best.partialRead ? best.evidence : undefined,
      readCount: snaps.filter((s) => s.op === "read").length,
      writeCount: snaps.filter((s) => s.op === "write").length,
      checkboxCount: (best.content.match(/^\s*[-*]\s*\[[ xX]\]/gm) ?? []).length,
      pathHint: fp,
    });
  }
  // 排序：文件按读取次数降序（反复读 = 活跃计划）+ 名字序稳定
  fileCandidates.sort((a, b) => (b.readCount ?? 1) - (a.readCount ?? 1) || a.source.localeCompare(b.source));

  const planCandidates = fileCandidates.slice(0, MAX_PLAN_CANDIDATES);
  const regulation = dedupeCandidates(regCandidates).slice(0, MAX_REG_CANDIDATES);
  // basename 撞名消歧：同名候选的 source 扩为「父目录/文件名」（handback.md ×10 可分辨）
  disambiguateCollidingSources(regulation);
  disambiguateCollidingSources(planCandidates);

  return {
    regulation: regulation.map((c, i) => ({ ...c, id: `R${i + 1}` })),
    plan: planCandidates.map((c, i) => ({ ...c, id: `P${i + 1}` })),
    contextLines,
  };
}

function firstLine(content: string | null): string {
  const l = (content ?? "").split("\n").find((x) => x.trim()) ?? "";
  return l.slice(0, 120);
}

/**
 * 按 id 批量取 ToolCall.resultJson（两步查询的第二步）。
 * 空列表 → 空 Map（不发查询）。
 */
async function fetchResultJsonByIds(
  prisma: PrismaClient,
  ids: string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (ids.length === 0) return out;
  const rows = await prisma.toolCall.findMany({
    where: { id: { in: ids } },
    select: { id: true, resultJson: true },
  });
  for (const r of rows) out.set(r.id, r.resultJson);
  return out;
}

function basenameOf(p: string | null): string {
  if (!p) return "";
  return p.split(/[\\/]/).pop() ?? p;
}

function hasReadOffsetOrLimit(argsJson: string | null): boolean {
  if (!argsJson) return false;
  try {
    const a = JSON.parse(argsJson);
    return (a.offset != null && a.offset > 0) || a.limit != null;
  } catch { return false; }
}

/** 同正文候选去重（turn0 注入常与 skill 注入同文）。 */
function dedupeCandidates(cands: WorkflowExtractCandidate[]): WorkflowExtractCandidate[] {
  const seen = new Set<string>();
  const out: WorkflowExtractCandidate[] = [];
  for (const c of cands) {
    const key = c.content.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/** basename 撞名的候选，source 扩为「父目录/文件名」（同名不同径可分辨；
 * 无撞名保持 basename——source 口径与确定性提取一致，只在歧义处加路径）。 */
function disambiguateCollidingSources(cands: WorkflowExtractCandidate[]): void {
  const byBase = new Map<string, number>();
  for (const c of cands) byBase.set(c.source, (byBase.get(c.source) ?? 0) + 1);
  for (const c of cands) {
    if ((byBase.get(c.source) ?? 0) > 1 && c.pathHint) {
      const segs = c.pathHint.split(/[\\/]/).filter(Boolean);
      if (segs.length >= 2) c.source = `${segs[segs.length - 2]}/${segs[segs.length - 1]}`;
    }
  }
}

/**
 * 选择式 prompt：两层定义 + 候选预览 + 选择规则（镜像确定性提取的优先级）+ 严格 JSON 输出。
 */
export function buildCandidatePrompt(candidates: WorkflowExtractCandidates): string {
  let text = `你是 workflow 声明选择器。任务：为「主 agent（编排者）」的 workflow 对账从下列候选中选出两部分声明。你只输出选择结果（候选 ID），不抄写正文。

背景：主 agent 的 workflow 声明分两层——
- 规程层（编排规程，"怎么干"）：主 agent 的角色定位、职责边界、阶段推进规则、派发纪律、验收要求等编排规程。常见形态：skill 注入的编排规程正文、编排模板文件（教每阶段怎么派发、带验收标准的模板）、注入首条 user 消息的系统级指令。
- 计划层（任务承诺，"干什么"）：事先写定的任务承诺态——逐条列明「要完成什么」的清单/检查单/里程碑，进度只由勾选框承载（勾选可机械归一回未勾选，承诺态完整可还原，正文本身独立于执行过程）。运行时状态账本不算计划：进度写在状态列、状态字段、进度日志、欠账/备注登记里的跟踪单/进度表记录「干到了哪」——由被审计的 agent 自己回写，作为声明就是拿自我记录自证。判内容不判命名——文件叫 tracker、STATE、TODO 皆不重要，看进度由什么承载。

引导区语境（dispatch 之前的 turn 骨架）：
${(candidates.contextLines ?? []).join("\n") || "（无）"}

## 规程层候选

`;
  for (const c of candidates.regulation) {
    text += formatCandidateBlock(c);
  }
  if (candidates.regulation.length === 0) text += "（无候选）\n";

  text += `
## 计划层候选

`;
  for (const c of candidates.plan) {
    text += formatCandidateBlock(c);
  }
  if (candidates.plan.length === 0) text += "（无候选）\n";

  text += `
## 选择规则

1. 规程层选最完整、最具体的编排规程：覆盖全程的编排总纲优先于只覆盖单阶段的细则；同覆盖面里含每阶段派发参数/验收标准的编排模板 > 编排规程骨架（原则/边界/阶段）> 泛化指令。同内容多份时选字数最多、结构最全的。
2. 计划层只选承诺态清单（事先写定、逐条列明「要完成什么」的清单/检查单）。声明将用于完成度对账，必须独立于执行过程，按顺序判定：
   a. 看进度由什么承载（候选标注「勾选 N 项」= 勾选框行数）：进度只藏在勾选框里（[ ]/[x]，选中后会被机械归一回未勾选，承诺态可完整还原）→ 承诺态清单，可选；完全静态、不承载任何进度的任务列举同样可选；进度写在状态列、状态字段、进度日志、欠账/备注登记里（如标题带「状态：」、步骤表带状态列、含「进度日志」段）→ 运行时状态账本，不选——这些进度是被审计的 agent 自己回写的，选它等于让对账拿被审计者的自我记录自证完成度；勾选与状态列混排的同样按账本处理。
   b. 源代码、API 文档、参考资料、需求原文不是计划。
   c. 审计报告、回执、交接记录、进度汇总等执行产物记录「干了什么」，不是「承诺要干什么」。
   d. 只有状态账本/执行产物、没有承诺清单时 plan 填 null（流程即计划，诚实留空优于拿账本凑数；不要因为「账本是唯一列出任务的文档」而放宽判据——宁缺毋假）。
3. 两层互斥：同一候选内容不得同时选为两层。编排模板（教怎么干，即使含检查单）归规程层；任务清单（列干什么）归计划层。
4. 标注「部分读取」的候选尽量避免（内容不完整）；有完整候选时优先完整。
5. 某层确实不存在时填 null（例如纯问答 session 无计划层；无任何编排规程时规程层为 null）。
6. 候选标注是中性信号：「只读未写」的候选更像事先存在/外部给定的契约与清单；「session 内被写」的候选更可能是本 session 的执行产物。结合内容判断，不要只凭标注。

输出要求：严格输出一个 JSON 对象，不要包裹代码块，不要任何解释文字：
{"regulation": "R1", "plan": "P1"}
某层缺失时该字段为 null，例如：{"regulation": "R2", "plan": null}`;
  return text;
}

function formatCandidateBlock(c: WorkflowExtractCandidate): string {
  const preview = c.content.slice(0, PREVIEW_MAX_CHARS);
  const ellipsis = c.content.length > PREVIEW_MAX_CHARS ? `…（节选，全文 ${c.content.length} 字）` : "";
  const marks = [
    c.partialRead ? `部分读取${c.evidence ? `（${describeLineEvidence(c.evidence, false).summary}，缺口处的指令不在正文内）` : ""}` : null,
    c.readCount && c.readCount > 1 ? `被读 ${c.readCount} 次` : null,
    c.layer === "plan" && c.writeCount != null
      ? c.writeCount > 0
        ? `session 内被写 ${c.writeCount} 次`
        : "只读未写"
      : null,
    c.layer === "plan" && c.checkboxCount != null ? `勾选 ${c.checkboxCount} 项` : null,
  ].filter(Boolean).join("，");
  // 标题骨架（廉价可判性：同名文件靠结构分辨——审计报告/流程模板/跟踪单一目了然）
  const heads = c.content.split("\n").filter((l) => /^#{1,3} /.test(l)).slice(0, 8).map((l) => l.slice(0, 60));
  const skeleton = heads.length > 0 ? `结构：${heads.join(" / ")}\n` : "";
  return `### [${c.id}] 来源：${c.source}${marks ? `（${marks}）` : ""}\n${skeleton}${preview}${ellipsis}\n\n`;
}

/**
 * 解析 LLM 选择输出 → 层列表（正文取候选原文，不信任 LLM 抄写）：
 * - 容忍代码块包裹/前后杂文（提取首个 JSON 对象）
 * - 字段引用不存在/跨层引用的 ID → 该层作 null 处理
 * - 两层互斥（选择规则 3 的机械强制）：同内容候选不得同时作两层，撞车时计划层作废
 * - 计划层正文做 [x]→[ ] 归一（与确定性提取同规则：声明=该干什么，非执行结果）
 */
export function parseCandidateSelection(
  output: string,
  candidates: WorkflowExtractCandidates,
): AuditLayerInfo[] {
  const jsonText = extractJsonObject(output);
  if (!jsonText) return [];
  let sel: { regulation?: unknown; plan?: unknown };
  try {
    sel = JSON.parse(jsonText) as { regulation?: unknown; plan?: unknown };
  } catch {
    return [];
  }
  if (sel === null || typeof sel !== "object") return [];

  const layers: AuditLayerInfo[] = [];
  const reg = candidates.regulation.find((c) => c.id === sel.regulation);
  if (reg) {
    layers.push({ kind: "regulation", label: "编排规程", source: reg.source, content: reg.content, evidence: reg.evidence });
  }
  const plan = candidates.plan.find((c) => c.id === sel.plan);
  if (plan && plan.content !== reg?.content) {
    layers.push({
      kind: "plan",
      label: "任务计划",
      source: plan.source,
      content: plan.content.replace(/\[x\]/g, "[ ]"),
      evidence: plan.evidence,
    });
  }
  return layers;
}

/** 从 LLM 输出提取首个 JSON 对象文本（容忍 ```json 包裹与前后解释文字）。 */
function extractJsonObject(output: string): string | null {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : output;
  const start = body.indexOf("{");
  if (start === -1) return null;
  const end = body.lastIndexOf("}");
  if (end <= start) return null;
  return body.slice(start, end + 1);
}

/**
 * claude CLI（-p 非交互）。失败时把 CLI 的真实输出（如 "Failed to authenticate. API
 * Error: 403 invalid api-key"）作为 error 带回——此前非 0 退出直接丢 stdout，认证类
 * 失败被吞成"提取中"死循环。
 * 路径：默认走 PATH 解析（"claude"）——服务进程的 PATH 与 sift 自带 LLM 同环境；
 * CLAUDE_CLI_PATH 显式覆写（非标准安装位/多版本切换）。
 */
function runClaudeCli(prompt: string): Promise<LlmRunnerResult> {
  return new Promise((resolve) => {
    const claudeBin = process.env.CLAUDE_CLI_PATH || "claude";
    const proc = spawn(claudeBin, ["-p", "--output-format", "text"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (r: LlmRunnerResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* ignore */ }
      finish({ text: null, error: `claude CLI 超时（${CLAUDE_TIMEOUT_MS / 1000}s，可能未认证或网络不通）` });
    }, CLAUDE_TIMEOUT_MS);

    proc.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) {
        finish({ text: stdout.trim(), error: null });
      } else {
        const detail = (stdout.trim() || stderr.trim() || "无输出").slice(0, 300);
        logError('workflow-extract', 'claude CLI 异常退出', { code: code ?? null, stdout: stdout.slice(0, 300), stderr: stderr.slice(0, 300) });
        finish({ text: null, error: `claude CLI 退出码 ${code ?? "null"}：${detail}` });
      }
    });
    proc.on("error", (err: Error) => {
      clearTimeout(timer);
      logError('workflow-extract', 'claude CLI spawn 失败', { error: err.message });
      finish({ text: null, error: `claude CLI 启动失败（${claudeBin}）：${err.message}` });
    });
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}
