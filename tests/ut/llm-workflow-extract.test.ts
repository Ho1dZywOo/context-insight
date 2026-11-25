// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { describe, it, expect, vi, afterEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  collectWorkflowExtractCandidates,
  hasWorkflowExtractCandidates,
  buildCandidatePrompt,
  parseCandidateSelection,
  llmExtractWorkflowDeclaration,
  getOrStartLlmExtract,
  __resetLlmExtractForTests,
  type WorkflowExtractCandidates,
} from "@/lib/llm-workflow-extract";
import { assembleCombinedDeclaration, recoverCombinedWorkflowDeclaration } from "@/lib/sift-audit";

const TURN0_BODY = "# 基于 ACLNN 的算子开发工作流\n\n你是纯编排者（Orchestrator），读取任务清单按顺序派发 SubAgent，不自己写代码。" + "r".repeat(500);
const STATE_BODY = "# STATE\n\n## Tasks\n\n- [x] 1. 派发 developer\n- [ ] 2. 验收 st-verifier\n- [ ] 3. 收尾归档\n" + "p".repeat(120);
const STATE_WITH_LINES = STATE_BODY.split("\n").map((l, i) => `${i + 1}: ${l}`).join("\n");

/** S1 型 session mock：turn0 注入规程 + 读 STATE.md，无 dispatch、无 Skill invoke。
 * toolCall.findMany 按 where 形状分流：turnId（pre-dispatch 窗口 meta）/ turn（计划扫描 meta）/
 * id（两步查询第二步：按 id 批量取 resultJson）。 */
function makeS1Prisma(extraPlanTcs: Array<{ toolName: string; argsJson: string | null; resultJson: string | null }> = []) {
  const stateReadTc = {
    id: "tc-state",
    turnId: "t1",
    toolName: "read",
    argsJson: '{"filePath":"/repo/STATE.md"}',
    resultJson: `<path>/repo/STATE.md</path><content>${STATE_WITH_LINES}</content>`,
  };
  const allTcs: Array<{ id: string; turnId?: string; toolName: string; argsJson: string | null; resultJson: string | null }> =
    [stateReadTc, ...extraPlanTcs.map((tc, i) => ({ id: `tc-extra-${i}`, ...tc }))];
  return {
    skillEvent: { findFirst: vi.fn().mockResolvedValue(null) },
    turn: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue({ content: TURN0_BODY }),
      findMany: vi.fn().mockResolvedValue([
        { id: "t0", turnIndex: 0, role: "user", content: TURN0_BODY, agentName: null },
        { id: "t1", turnIndex: 1, role: "assistant", content: "我来读一下任务清单。", agentName: "build" },
      ]),
    },
    toolCall: {
      findMany: vi.fn().mockImplementation(async (args: { where?: { turnId?: unknown; turn?: unknown; id?: { in?: string[] } } }) => {
        const w = args?.where ?? {};
        if (w.id) return allTcs.filter((r) => w.id!.in?.includes(r.id)).map((r) => ({ id: r.id, resultJson: r.resultJson }));
        if (w.turnId) return allTcs.filter((r) => r.turnId); // pre-dispatch 窗口 meta（mock 行带多余字段，代码不读）
        if (w.turn) return allTcs; // 全 session 计划扫描 meta
        return [];
      }),
    },
  } as unknown as PrismaClient;
}

describe("collectWorkflowExtractCandidates（确定性收集，零领域启发）", () => {
  it("S1：turn0 → 规程候选；STATE.md Read → 规程+计划双列候选；剥行号", async () => {
    const c = await collectWorkflowExtractCandidates("ses_1", makeS1Prisma());
    expect(c.regulation.map((r) => r.source)).toEqual(["turn0 (注入编排规程)", "STATE.md"]);
    expect(c.regulation[0].content).toBe(TURN0_BODY);
    // Read 正文剥行号（与确定性提取 extractFileContent 同源）
    expect(c.regulation[1].content).toBe(STATE_BODY);
    expect(c.plan.map((p) => `${p.id}:${p.source}`)).toEqual(["P1:STATE.md"]);
    expect(c.plan[0].content).toBe(STATE_BODY);
    // 引导区语境行
    expect(c.contextLines?.[0]).toContain("Turn 0 (user)");
  });

  it("S2：skill invoke 的 <skill_content> → 规程候选（source=skillName (SKILL.md)）", async () => {
    const resourceBody = "# Task 调用参数\n\n## 1.1 开发准备\n\n- [ ] 日志已创建\n- [ ] 目录已创建\n- [ ] 环境检查\n" + "x".repeat(120);
    const skillTc = {
      id: "tc-skill",
      turnId: "t0",
      toolName: "skill",
      argsJson: '{"name":"ops-registry-invoke-workflow"}',
      resultJson: `<skill_content name="ops-registry-invoke-workflow">${resourceBody}</skill_content>`,
    };
    const prisma = {
      skillEvent: {
        findFirst: vi.fn().mockResolvedValueOnce({ turnId: "t9" }), // 首个 dispatch
      },
      turn: {
        findUnique: vi.fn().mockResolvedValue({ turnIndex: 5 }),
        findMany: vi.fn().mockResolvedValue([
          { id: "t0", turnIndex: 0, role: "user", content: "帮我把这个算子跑通", agentName: null },
        ]),
      },
      toolCall: {
        findMany: vi.fn().mockImplementation(async (args: { where?: { turnId?: unknown; turn?: unknown; id?: { in?: string[] } } }) => {
          const w = args?.where ?? {};
          if (w.id) return [skillTc].filter((r) => w.id!.in?.includes(r.id)).map((r) => ({ id: r.id, resultJson: r.resultJson }));
          if (w.turnId) return [skillTc];
          if (w.turn) return [];
          return [];
        }),
      },
    } as unknown as PrismaClient;
    const c = await collectWorkflowExtractCandidates("ses_1", prisma);
    // 短 turn0（<200）不入候选；skill 正文入
    expect(c.regulation).toHaveLength(1);
    expect(c.regulation[0].source).toBe("ops-registry-invoke-workflow (SKILL.md)");
    expect(c.regulation[0].content).toBe(resourceBody);
    expect(c.plan).toHaveLength(0);
  });

  it("B 形 shell 通道（codex exec_command cat SKILL.md）→ 规程候选（两步查询为它取 resultJson）", async () => {
    const body = "# CANNbay 审计报告规范\n\n五个必备章节。\n" + "x".repeat(120);
    const shellTc = {
      id: "tc-shell",
      turnId: "t0",
      toolName: "exec_command",
      argsJson: JSON.stringify({ cmd: "cat /home/u/.codex/skills/cannbay-report/SKILL.md" }),
      resultJson: `Chunk ID: 9014f0\nWall time: 0.0000 seconds\nOutput:\n${body}`,
    };
    const prisma = {
      skillEvent: {
        findFirst: vi.fn().mockResolvedValueOnce({ turnId: "t9" }),
      },
      turn: {
        findUnique: vi.fn().mockResolvedValue({ turnIndex: 5 }),
        findMany: vi.fn().mockResolvedValue([
          { id: "t0", turnIndex: 0, role: "user", content: "短任务", agentName: null },
        ]),
      },
      toolCall: {
        findMany: vi.fn().mockImplementation(async (args: { where?: { turnId?: unknown; turn?: unknown; id?: { in?: string[] } } }) => {
          const w = args?.where ?? {};
          if (w.id) return [shellTc].filter((r) => w.id!.in?.includes(r.id)).map((r) => ({ id: r.id, resultJson: r.resultJson }));
          if (w.turnId) return [shellTc];
          if (w.turn) return [];
          return [];
        }),
      },
    } as unknown as PrismaClient;
    const c = await collectWorkflowExtractCandidates("ses_1", prisma);
    expect(c.regulation).toHaveLength(1);
    expect(c.regulation[0].source).toBe("cannbay-report (SKILL.md)");
    expect(c.regulation[0].content.startsWith("# CANNbay 审计报告规范")).toBe(true);
    expect(c.regulation[0].content).not.toContain("Chunk ID");
  });

  it("计划候选：非 .md/.txt 排除 + 同文件多次读合并（readCount）+ 部分读取标记；todowrite 不入候选", async () => {
    const todosTc = {
      toolName: "todowrite",
      argsJson: JSON.stringify({ todos: [
        { content: "派发 developer", status: "completed" },
        { content: "验收", status: "pending" },
        { content: "归档", status: "pending" },
      ]}),
      resultJson: null,
    };
    const srcTc = {
      toolName: "read",
      argsJson: '{"filePath":"/x/main.ts"}',
      resultJson: `<content>1: export function foo() {}\n2: // todo: a\n3: // todo: b\n4: // todo: c\n5: // todo: d\n</content>`,
    };
    const partialTc = {
      toolName: "read",
      argsJson: '{"filePath":"/repo/STATE.md","offset":50,"limit":20}',
      resultJson: `<content>${STATE_WITH_LINES}</content>`,
    };
    const prisma = makeS1Prisma([todosTc, srcTc, partialTc]);
    const c = await collectWorkflowExtractCandidates("ses_1", prisma);
    const planSources = c.plan.map((p) => p.source);
    expect(planSources).not.toContain("todowrite"); // todowrite 已从计划层移除
    expect(planSources).not.toContain("main.ts"); // 非 md/txt 排除
    expect(planSources).toContain("STATE.md"); // 完整读 + 部分读合并为一份
    const statePlan = c.plan.find((p) => p.source === "STATE.md")!;
    expect(statePlan.readCount).toBe(2); // 完整读 + 部分读
    expect(statePlan.partialRead).toBe(false); // 取的是完整那份（首次实质读取）
  });

  it("S3：system turn0（opencode ≥1.17 注入，带 Base directory 中部标记）→ 注入通道真名收录 + 剥标记", async () => {
    const s3Turn0 = TURN0_BODY + "\n\nBase directory for this skill: /home/hwd/x/.opencode/skills/ops-registry-invoke-glacier\nRelative paths in this skill (e.g., scripts/) are relative to this base directory.\n\nsoftplus_v2_grad";
    const prisma = {
      skillEvent: { findFirst: vi.fn().mockResolvedValue(null) },
      turn: {
        findUnique: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([
          { id: "t0", turnIndex: 0, role: "system", content: s3Turn0, agentName: null },
          { id: "t1", turnIndex: 1, role: "assistant", content: "我来读一下任务清单。", agentName: "build" },
        ]),
      },
      toolCall: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient;
    const c = await collectWorkflowExtractCandidates("ses_1", prisma);
    // 注入通道（skillMdReadsOfTurn 真名收录）优先；turn0 泛化兜底不重复收
    expect(c.regulation).toHaveLength(1);
    expect(c.regulation[0].source).toBe("ops-registry-invoke-glacier (SKILL.md)");
    expect(c.regulation[0].content).toBe(TURN0_BODY + "\n\nsoftplus_v2_grad"); // 标记剥、用户请求留
    expect(c.regulation[0].content).not.toContain("Base directory for this skill");
  });

  it("无任何候选 → 两列表皆空", async () => {
    const prisma = {
      skillEvent: { findFirst: vi.fn().mockResolvedValue(null) },
      turn: { findUnique: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
      toolCall: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient;
    const c = await collectWorkflowExtractCandidates("ses_1", prisma);
    expect(c.regulation).toHaveLength(0);
    expect(c.plan).toHaveLength(0);
  });

  it("C 形：斜杠命令 system 注入轮（turnIndex 1）→ 规程候选带 SKILL.md 正文（前言剥除）", async () => {
    // 真实形态（day0-inference 会话）：turn0 = 命令壳（user），turn1 = 注入全文（system）
    const commandText = "<command-message>day0-inference</command-message>\n<command-name>/day0-inference</command-name>\n" + "day0 推理适配验证：".repeat(15);
    const body = "# Day0 Inference\n\n## 编排规程\n\n- [ ] 建日志\n- [ ] 派发\n- [ ] 验收\n" + "z".repeat(150);
    const turns = [
      { id: "t0", turnIndex: 0, role: "user", content: commandText, agentName: null },
      { id: "t1", turnIndex: 1, role: "system", content: `Base directory for this skill: /data1/cls/ds/vllm-ascend/.claude/skills/day0-inference\n\n${body}`, agentName: null },
    ];
    const prisma = {
      skillEvent: { findFirst: vi.fn().mockResolvedValue(null) },
      turn: { findUnique: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue(turns) },
      toolCall: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient;
    const c = await collectWorkflowExtractCandidates("ses_c", prisma);
    const sources = c.regulation.map((r) => r.source);
    // 注入正文进候选（此前只认 turnIndex===0 → 正文缺席，仅剩命令壳）
    expect(sources).toContain("day0-inference (SKILL.md)");
    const bodyCand = c.regulation.find((r) => r.source === "day0-inference (SKILL.md)")!;
    expect(bodyCand.content).not.toContain("Base directory for this skill");
    expect(bodyCand.content).toContain("# Day0 Inference");
    expect(bodyCand.partialRead).toBe(false);
    // 命令壳作为 turn0 引导候选保留（语境）
    expect(sources).toContain("turn0 (注入编排规程)");
  });

  it("proxy 裸 `N\\t` 行号 Read（claude-code-proxy）→ 计划候选恢复正文（剥行号）", async () => {
    // 真实 day0 会话形态：extractFileContent 此前只认 <content> 信封 → proxy 会话
    // Read 型候选全灭，tracker.md（读 18 次）零快照、LLM 只能从 Write 产物里选
    const TRACKER_BODY = "# Day0 流程跟踪单\n\n## Stage 1 Golden 基线\n\n| 步骤 | 状态 |\n|---|---|\n| S1.0 立项 | 已完成 |\n| S1.2 设计 | 进行中 |\n" + "t".repeat(200);
    const bareTc = {
      id: "tc-tracker",
      turnId: "t1",
      toolName: "Read",
      argsJson: '{"file_path":"/data1/cls/.day0/run1/tracker.md"}',
      resultJson: TRACKER_BODY.split("\n").map((l, i) => `${i + 1}\t${l}`).join("\n"),
    };
    const prisma = {
      skillEvent: { findFirst: vi.fn().mockResolvedValue(null) },
      turn: {
        findUnique: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([
          { id: "t0", turnIndex: 0, role: "user", content: "短任务", agentName: null },
          { id: "t1", turnIndex: 1, role: "assistant", content: "读跟踪单", agentName: "build" },
        ]),
      },
      toolCall: {
        findMany: vi.fn().mockImplementation(async (args: { where?: { turnId?: unknown; turn?: unknown; id?: { in?: string[] } } }) => {
          const w = args?.where ?? {};
          if (w.id) return [bareTc].filter((r) => w.id!.in?.includes(r.id)).map((r) => ({ id: r.id, resultJson: r.resultJson }));
          if (w.turnId) return [bareTc];
          if (w.turn) return [bareTc];
          return [];
        }),
      },
    } as unknown as PrismaClient;
    const c = await collectWorkflowExtractCandidates("ses_proxy", prisma);
    expect(c.plan.map((p) => p.source)).toContain("tracker.md");
    const tracker = c.plan.find((p) => p.source === "tracker.md")!;
    expect(tracker.content).toBe(TRACKER_BODY); // 剥行号后与原文一致
    expect(tracker.readCount).toBe(1);
    expect(tracker.writeCount).toBe(0);
    // readCount 排序：重复读的文件排前（活跃计划信号）
    expect(c.plan[0].source).toBe("tracker.md");
  });

  it("规程窗口：dispatch 前引导区全窗（T27 读 flow 模板不再被 take:10 截掉）", async () => {
    // 真实 day0 会话形态：golden_flow.md 在 T27 读、首 dispatch 在 T163——
    // 旧 take:10 窗口把 dispatch 前的所有 flow/tracker 模板全部切掉
    const FLOW_BODY = "# Golden Flow — Stage 1\n\n## 流水线\n\n### Phase 0 依赖判定\n### Phase 1 Designer\n" + "f".repeat(200);
    const flowTc = {
      id: "tc-flow",
      turnId: "t27",
      toolName: "read",
      argsJson: '{"file_path":"/repo/.claude/skills/day0/flows/golden_flow.md"}',
      resultJson: `<content>${FLOW_BODY.split("\n").map((l, i) => `${i + 1}: ${l}`).join("\n")}</content>`,
    };
    const prisma = {
      skillEvent: { findFirst: vi.fn().mockResolvedValue({ turnId: "t163" }) },
      turn: {
        findUnique: vi.fn().mockResolvedValue({ turnIndex: 163 }),
        findMany: vi.fn().mockResolvedValue([
          { id: "t0", turnIndex: 0, role: "user", content: "跑 day0", agentName: null },
          { id: "t27", turnIndex: 27, role: "assistant", content: "读 golden flow", agentName: "build" },
        ]),
      },
      toolCall: {
        findMany: vi.fn().mockImplementation(async (args: { where?: { turnId?: unknown; turn?: unknown; id?: { in?: string[] } } }) => {
          const w = args?.where ?? {};
          if (w.id) return [flowTc].filter((r) => w.id!.in?.includes(r.id)).map((r) => ({ id: r.id, resultJson: r.resultJson }));
          if (w.turnId) return [flowTc];
          if (w.turn) return [];
          return [];
        }),
      },
    } as unknown as PrismaClient;
    const c = await collectWorkflowExtractCandidates("ses_win", prisma);
    expect(c.regulation.map((r) => r.source)).toContain("golden_flow.md");
    expect(c.regulation.find((r) => r.source === "golden_flow.md")!.content).toBe(FLOW_BODY);
  });

  it("写入来源标注：只读未写（外部契约）vs session 内被写（执行产物）", async () => {
    const TRACKER_BODY = "# 跟踪单\n\n| 步骤 | 状态 |\n|---|---|\n| S1 | 进行中 |\n" + "t".repeat(120);
    const REPORT_BODY = "# R1 审计报告\n\n## 结论\n\n通过。\n" + "r".repeat(120);
    const bareRead = (path: string, body: string) => ({
      toolName: "Read",
      argsJson: JSON.stringify({ file_path: path }),
      resultJson: body.split("\n").map((l, i) => `${i + 1}\t${l}`).join("\n"),
    });
    const tcs = [
      { id: "tc-tracker", turnId: "t1", ...bareRead("/run/.day0/tracker.md", TRACKER_BODY) },
      {
        id: "tc-report-write",
        turnId: "t1",
        toolName: "Write",
        argsJson: JSON.stringify({ file_path: "/run/audit/r1-audit-report.md", content: REPORT_BODY }),
        resultJson: null,
      },
      { id: "tc-report-read", turnId: "t1", ...bareRead("/run/audit/r1-audit-report.md", REPORT_BODY) },
    ];
    const prisma = {
      skillEvent: { findFirst: vi.fn().mockResolvedValue(null) },
      turn: {
        findUnique: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([{ id: "t0", turnIndex: 0, role: "user", content: "短任务", agentName: null }]),
      },
      toolCall: {
        findMany: vi.fn().mockImplementation(async (args: { where?: { turnId?: unknown; turn?: unknown; id?: { in?: string[] } } }) => {
          const w = args?.where ?? {};
          if (w.id) return tcs.filter((r) => w.id!.in?.includes(r.id)).map((r) => ({ id: r.id, resultJson: r.resultJson }));
          if (w.turnId) return tcs;
          if (w.turn) return tcs;
          return [];
        }),
      },
    } as unknown as PrismaClient;
    const c = await collectWorkflowExtractCandidates("ses_wr", prisma);
    const tracker = c.plan.find((p) => p.source.includes("tracker.md"))!;
    const report = c.plan.find((p) => p.source.includes("r1-audit-report.md"))!;
    expect(tracker.writeCount).toBe(0);
    expect(report.writeCount).toBe(1);
    expect(report.readCount).toBe(1);
    const prompt = buildCandidatePrompt(c);
    // prompt 标注：中性信号直给 LLM（执行产物 vs 外部契约的判别依据）
    expect(prompt).toContain("只读未写");
    expect(prompt).toContain("session 内被写 1 次");
    expect(prompt).toContain("结构："); // 标题骨架（跟踪单/审计报告一目了然）
  });

  it("同名消歧：不同目录的 handback.md → source 扩为「父目录/文件名」", async () => {
    const mk = (id: string, dir: string, body: string) => ({
      id,
      turnId: "t1",
      toolName: "Write",
      argsJson: JSON.stringify({ file_path: `/run/parallel/impl/${dir}/handback.md`, content: body }),
      resultJson: null,
    });
    const tcs = [
      mk("tc-h1", "tester-1", "# Tester Handback\n\n全部通过。\n" + "a".repeat(150)),
      mk("tc-h2", "accuracy-1", "# Accuracy Handback\n\n精度达标。\n" + "b".repeat(150)),
    ];
    const prisma = {
      skillEvent: { findFirst: vi.fn().mockResolvedValue(null) },
      turn: {
        findUnique: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([{ id: "t0", turnIndex: 0, role: "user", content: "短任务", agentName: null }]),
      },
      toolCall: {
        findMany: vi.fn().mockImplementation(async (args: { where?: { turnId?: unknown; turn?: unknown; id?: { in?: string[] } } }) => {
          const w = args?.where ?? {};
          if (w.id) return tcs.filter((r) => w.id!.in?.includes(r.id)).map((r) => ({ id: r.id, resultJson: r.resultJson }));
          if (w.turnId) return tcs;
          if (w.turn) return tcs;
          return [];
        }),
      },
    } as unknown as PrismaClient;
    const c = await collectWorkflowExtractCandidates("ses_dup", prisma);
    const sources = c.plan.map((p) => p.source).sort();
    expect(sources).toEqual(["accuracy-1/handback.md", "tester-1/handback.md"]);
  });

  it("shell 隐式读（codex 无 read 工具，cat 计划文件）→ 计划候选", async () => {
    const STATE_CAT = "# STATE\n\n- [ ] 1. 派发 developer\n- [ ] 2. 验收\n" + "s".repeat(150);
    const shellTc = {
      id: "tc-cat",
      turnId: "t1",
      toolName: "exec_command",
      argsJson: JSON.stringify({ cmd: "cat /home/u/.day0/run/STATE.md" }),
      resultJson: `Chunk ID: 77f\nWall time: 0.0000 seconds\nOutput:\n${STATE_CAT}`,
    };
    const prisma = {
      skillEvent: { findFirst: vi.fn().mockResolvedValue(null) },
      turn: {
        findUnique: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([{ id: "t0", turnIndex: 0, role: "user", content: "短任务", agentName: null }]),
      },
      toolCall: {
        findMany: vi.fn().mockImplementation(async (args: { where?: { turnId?: unknown; turn?: unknown; id?: { in?: string[] } } }) => {
          const w = args?.where ?? {};
          if (w.id) return [shellTc].filter((r) => w.id!.in?.includes(r.id)).map((r) => ({ id: r.id, resultJson: r.resultJson }));
          if (w.turnId) return [shellTc];
          if (w.turn) return [shellTc];
          return [];
        }),
      },
    } as unknown as PrismaClient;
    const c = await collectWorkflowExtractCandidates("ses_cat", prisma);
    expect(c.plan.map((p) => p.source)).toContain("STATE.md");
    expect(c.plan.find((p) => p.source === "STATE.md")!.content).toBe(STATE_CAT);
  });
});

describe("hasWorkflowExtractCandidates（root 可对账探测：候选非空，零 LLM 调用）", () => {
  it("S1（turn0 规程 + STATE.md 计划）→ true", async () => {
    await expect(hasWorkflowExtractCandidates("ses_1", makeS1Prisma())).resolves.toBe(true);
  });

  it("无任何候选 → false", async () => {
    const prisma = {
      skillEvent: { findFirst: vi.fn().mockResolvedValue(null) },
      turn: { findUnique: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
      toolCall: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient;
    await expect(hasWorkflowExtractCandidates("ses_1", prisma)).resolves.toBe(false);
  });
});

describe("buildCandidatePrompt（选择式提示词）", () => {
  const cands: WorkflowExtractCandidates = {
    regulation: [{ id: "R1", layer: "regulation", source: "turn0 (注入编排规程)", content: "你是纯编排者……", partialRead: false }],
    plan: [
      { id: "P1", layer: "plan", source: "STATE.md", content: "# STATE\n\n## Tasks\n\n- [ ] a", partialRead: false, readCount: 3, checkboxCount: 1 },
    ],
    contextLines: ["- Turn 0 (user): 任务描述"],
  };

  it("含两层定义、候选 ID/来源/预览、选择规则、严格 JSON 输出要求", () => {
    const p = buildCandidatePrompt(cands);
    expect(p).toContain("规程层");
    expect(p).toContain("计划层");
    expect(p).toContain("[R1] 来源：turn0 (注入编排规程)");
    expect(p).toContain("[P1] 来源：STATE.md");
    expect(p).toContain("被读 3 次");
    expect(p).toContain('{"regulation": "R1", "plan": "P1"}');
    expect(p).toContain("null");
    // 选择规则核心：互斥 + 不当计划 + 完整优先
    expect(p).toContain("两层互斥");
    expect(p).toContain("参考资料");
    expect(p).toContain("部分读取");
  });

  it("明确 LLM 只选不抄（不可篡改契约落在提示词层）", () => {
    const p = buildCandidatePrompt(cands);
    expect(p).toContain("你只输出选择结果");
    expect(p).toContain("不抄写正文");
  });

  it("计划层判据：只认可机械归一的承诺态清单，运行时状态账本不选、只有账本时 null 兜底", () => {
    const p = buildCandidatePrompt(cands);
    // 承诺态定义（勾选可归一还原）与账本排除（状态列/进度日志/欠账登记）
    expect(p).toContain("承诺态");
    expect(p).toContain("状态账本");
    expect(p).toContain("进度日志");
    expect(p).toContain("机械归一");
    // 勾选载体机械标注（进度是否由勾选承载的中性信号）
    expect(p).toContain("勾选 1 项"); // cands 的 STATE.md 带一行勾选
    // 诚实兜底：只有账本 → plan=null（流程即计划）；唯一性不放宽（宁缺毋假）
    expect(p).toContain("只有状态账本");
    expect(p).toContain("宁缺毋假");
    // 判内容不判命名仍在（tracker 命名不是判据本身）
    expect(p).toContain("判内容不判命名");
  });
});

describe("parseCandidateSelection（选择解析：正文取候选原文，不信任 LLM 抄写）", () => {
  const cands: WorkflowExtractCandidates = {
    regulation: [{ id: "R1", layer: "regulation", source: "turn0 (注入编排规程)", content: "REGULATION-BODY", partialRead: false }],
    plan: [{ id: "P1", layer: "plan", source: "STATE.md", content: "- [x] done\n- [ ] todo", partialRead: false }],
  };

  it("合法选择 → 两层；计划层 [x]→[ ] 归一，规程层原文不动", () => {
    const layers = parseCandidateSelection('{"regulation":"R1","plan":"P1"}', cands);
    expect(layers).toHaveLength(2);
    expect(layers[0]).toMatchObject({ kind: "regulation", source: "turn0 (注入编排规程)", content: "REGULATION-BODY" });
    expect(layers[1]).toMatchObject({ kind: "plan", source: "STATE.md", content: "- [ ] done\n- [ ] todo" });
  });

  it("容忍 ```json 包裹与前后解释文字", () => {
    const out = '好的，我的选择：\n```json\n{"regulation": "R1", "plan": null}\n```\n以上。';
    const layers = parseCandidateSelection(out, cands);
    expect(layers).toHaveLength(1);
    expect(layers[0].kind).toBe("regulation");
  });

  it("跨层引用（regulation 字段填 P1）→ 该层作 null；未知 ID 同理", () => {
    expect(parseCandidateSelection('{"regulation":"P1","plan":"P1"}', cands)).toHaveLength(1); // plan 命中
    expect(parseCandidateSelection('{"regulation":"R9","plan":"R1"}', cands)).toHaveLength(0);
  });

  it("两层互斥的机械强制：同内容候选撞车 → 计划层作废（规则 3 的构造性保证）", () => {
    const dup: WorkflowExtractCandidates = {
      regulation: [{ id: "R1", layer: "regulation", source: "golden_flow.md", content: "SAME-BODY", partialRead: false }],
      plan: [{ id: "P1", layer: "plan", source: "golden_flow.md", content: "SAME-BODY", partialRead: false }],
    };
    const layers = parseCandidateSelection('{"regulation":"R1","plan":"P1"}', dup);
    expect(layers).toHaveLength(1);
    expect(layers[0].kind).toBe("regulation");
  });

  it("全 null / 非 JSON / 非对象 → 空层", () => {
    expect(parseCandidateSelection('{"regulation":null,"plan":null}', cands)).toHaveLength(0);
    expect(parseCandidateSelection("我觉得没有合适的声明", cands)).toHaveLength(0);
    expect(parseCandidateSelection('["R1"]', cands)).toHaveLength(0);
  });
});

describe("llmExtractWorkflowDeclaration（选择 → 共享装配，端到端）", () => {
  it("识别正确时与确定性提取字节一致（S1：turn0 规程 + STATE.md 计划）", async () => {
    const prisma = makeS1Prisma();
    const runner = vi.fn(async (prompt: string) => {
      // prompt 里 R1=turn0、P1=STATE.md（collect 顺序），模拟 LLM 识别正确
      expect(prompt).toContain("[R1] 来源：turn0 (注入编排规程)");
      expect(prompt).toContain("[P1] 来源：STATE.md");
      return { text: '{"regulation": "R1", "plan": "P1"}', error: null };
    });

    const llm = await llmExtractWorkflowDeclaration("ses_1", prisma, runner);
    const det = await recoverCombinedWorkflowDeclaration("ses_1", makeS1Prisma());

    expect(llm).not.toBeNull();
    expect(det).not.toBeNull();
    // 字节级一致：content / source / layers 全同（共享 assembleCombinedDeclaration + 同源候选）
    expect(llm!.content).toBe(det!.content);
    expect(llm!.source).toBe(det!.source);
    expect(llm!.layers).toEqual(det!.layers);
    expect(llm!.content).toContain("## 一、编排规程");
    expect(llm!.content).toContain(TURN0_BODY);
    expect(llm!.content).toContain("## 二、任务计划");
    // 计划层 [x] 归一（声明态）
    expect(llm!.content).toContain("- [ ] 1. 派发 developer");
    expect(llm!.content).not.toContain("- [x]");
  });

  it("LLM 只选规程层（计划 null）→ 单层直出（与确定性单层行为同构）", async () => {
    const prisma = makeS1Prisma();
    const runner = vi.fn(async () => ({ text: '{"regulation": "R1", "plan": null}', error: null }));
    const r = await llmExtractWorkflowDeclaration("ses_1", prisma, runner);
    expect(r!.content).toBe(TURN0_BODY); // 单层原文直出，无分层标题
    expect(r!.source).toBe("turn0 (注入编排规程)");
    expect(r!.layers).toHaveLength(1);
  });

  it("LLM 输出与 assembleCombinedDeclaration 等价（装配共享的直接锁定）", async () => {
    const prisma = makeS1Prisma();
    const runner = vi.fn(async () => ({ text: '{"regulation": "R1", "plan": "P1"}', error: null }));
    const r = await llmExtractWorkflowDeclaration("ses_1", prisma, runner);
    const expected = assembleCombinedDeclaration([
      { kind: "regulation", label: "编排规程", source: "turn0 (注入编排规程)", content: TURN0_BODY },
      { kind: "plan", label: "任务计划", source: "STATE.md", content: STATE_BODY.replace(/\[x\]/g, "[ ]") },
    ]);
    expect(r).toEqual({ ...expected, evidence: [] });
  });

  it("CLI 基础设施失败（认证 403 等）→ throw，错误消息直达用户", async () => {
    const prisma = makeS1Prisma();
    const runner = vi.fn(async () => ({
      text: null,
      error: "claude CLI 退出码 1：Failed to authenticate. API Error: 403 invalid api-key",
    }));
    await expect(llmExtractWorkflowDeclaration("ses_1", prisma, runner)).rejects.toThrow("403 invalid api-key");
  });

  it("选择无效 / 无候选 → null（不 throw）", async () => {
    const prisma = makeS1Prisma();
    expect(await llmExtractWorkflowDeclaration("ses_1", prisma, vi.fn(async () => ({ text: "我不明白", error: null })))).toBeNull();
    const empty = {
      skillEvent: { findFirst: vi.fn().mockResolvedValue(null) },
      turn: { findUnique: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
      toolCall: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient;
    expect(await llmExtractWorkflowDeclaration("ses_1", empty, vi.fn(async () => ({ text: "{}", error: null })))).toBeNull();
  });

  it("正文不可篡改：LLM 无法通过输出改写候选内容（只认 ID，不解析其正文）", async () => {
    const prisma = makeS1Prisma();
    // LLM 输出里夹带伪造正文 —— 解析只取 ID，正文一律来自候选（DB 原文）
    const runner = vi.fn(async () => ({ text: '{"regulation": "R1", "plan": "P1", "content": "我篡改的声明正文"}', error: null }));
    const r = await llmExtractWorkflowDeclaration("ses_1", prisma, runner);
    expect(r!.content).toContain(TURN0_BODY);
    expect(r!.content).toContain(STATE_BODY.replace(/\[x\]/g, "[ ]"));
    expect(r!.content).not.toContain("我篡改的声明正文");
  });

  it("day0 型：tracker 状态账本照常入候选（收集零启发）、prompt 带账本判别信号；LLM 判 plan=null → 规程单层诚实直出", async () => {
    // 真实 day0 会话形态：tracker.md 是「单一状态源」账本——状态列（待签收/打回）+
    // 进度日志混排，不是承诺态清单（勾选归一还原不出它的承诺态）→ 计划层诚实为 null
    const TRACKER_BODY =
      "# Day0 流程跟踪单\n\n## Stage 1 步骤表\n\n| 步骤 | 状态 | 备注 |\n|---|---|---|\n| S1.0 立项 | 待签收 | 产物已出 |\n| S1.2 设计 | 进行中 | — |\n\n## 进度日志\n\n- T10 designer 完成 S1.2 设计，产物见备注\n" + "t".repeat(200);
    const trackerTc = {
      id: "tc-tracker",
      turnId: "t1",
      toolName: "Read",
      argsJson: '{"file_path":"/run/.day0/tracker.md"}',
      resultJson: TRACKER_BODY.split("\n").map((l, i) => `${i + 1}\t${l}`).join("\n"),
    };
    const prisma = {
      skillEvent: { findFirst: vi.fn().mockResolvedValue(null) },
      turn: {
        findUnique: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([
          { id: "t0", turnIndex: 0, role: "user", content: TURN0_BODY, agentName: null },
          { id: "t1", turnIndex: 1, role: "assistant", content: "读跟踪单", agentName: "build" },
        ]),
      },
      toolCall: {
        findMany: vi.fn().mockImplementation(async (args: { where?: { turnId?: unknown; turn?: unknown; id?: { in?: string[] } } }) => {
          const w = args?.where ?? {};
          if (w.id) return [trackerTc].filter((r) => w.id!.in?.includes(r.id)).map((r) => ({ id: r.id, resultJson: r.resultJson }));
          if (w.turnId) return [trackerTc];
          if (w.turn) return [trackerTc];
          return [];
        }),
      },
    } as unknown as PrismaClient;

    // 收集零启发不动：状态账本照样进候选面（排除发生在选择规则层，不在收集层）
    const c = await collectWorkflowExtractCandidates("ses_day0", prisma);
    expect(c.plan.map((p) => p.source)).toContain("tracker.md");

    // prompt 可判别：标题骨架把「## 进度日志」账本信号直给 LLM + 判据规则在文
    const prompt = buildCandidatePrompt(c);
    expect(prompt).toContain("结构：# Day0 流程跟踪单 / ## Stage 1 步骤表 / ## 进度日志");
    expect(prompt).toContain("状态账本");
    // 勾选载体机械标注：账本 0 勾选（进度在状态列/日志，不在勾选框）
    expect(prompt).toContain("勾选 0 项");

    // LLM 按收紧判据判 plan=null → 规程单层直出（诚实留空，与单层行为同构）
    const runner = vi.fn(async () => ({ text: '{"regulation": "R1", "plan": null}', error: null }));
    const r = await llmExtractWorkflowDeclaration("ses_day0", prisma, runner);
    expect(r!.content).toBe(TURN0_BODY);
    expect(r!.source).toBe("turn0 (注入编排规程)");
    expect(r!.layers).toHaveLength(1);
  });
});


describe("getOrStartLlmExtract（job 缓存：失败不自动重启 + force 重试）", () => {
  afterEach(() => {
    __resetLlmExtractForTests();
  });

  /** 无候选 session：快速失败路径（不 spawn claude CLI，测试无外部依赖）。 */
  const emptyPrisma = {
    skillEvent: { findFirst: vi.fn().mockResolvedValue(null) },
    turn: { findUnique: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
    toolCall: { findMany: vi.fn().mockResolvedValue([]) },
  } as unknown as PrismaClient;

  it("失败 job：后续调用（无 force，模拟前端轮询）→ 同一 job 原样返回 error，不重启", async () => {
    const j1 = getOrStartLlmExtract("t1", "ses_1", emptyPrisma);
    expect(j1.loading).toBe(true);
    await vi.waitFor(() => expect(j1.loading).toBe(false));
    expect(j1.error).toBeTruthy();
    // 前端轮询再来（无 force）：同一 job 引用，loading 已 false——前端能看到 error 并停轮询
    const j2 = getOrStartLlmExtract("t1", "ses_1", emptyPrisma);
    expect(j2).toBe(j1);
    expect(j2.loading).toBe(false);
    expect(j2.error).toBe(j1.error);
  });

  it("失败 job + force（重试按钮 restart=1）→ 丢弃旧 job 重启新 job", async () => {
    const j1 = getOrStartLlmExtract("t2", "ses_1", emptyPrisma);
    await vi.waitFor(() => expect(j1.loading).toBe(false));
    const j2 = getOrStartLlmExtract("t2", "ses_1", emptyPrisma, { force: true });
    expect(j2).not.toBe(j1);
    expect(j2.loading).toBe(true);
    await vi.waitFor(() => expect(j2.loading).toBe(false)); // 无候选 → 再次失败（测试只验重启语义）
    expect(j2.error).toBeTruthy();
  });
});
