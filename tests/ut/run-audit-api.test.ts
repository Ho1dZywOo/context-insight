// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software you can redistribute it and/or modify it under the terms and
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// run 级对账端点 IT：双编排路径验证——
// ① `--run` 原生对账（源 bundle 在盘）：spawn 带 --run 不带 --transcript，result
//    事件 _members 由 report.run.units × sessionId 权威映射；
// ② DB transcript 回落（solo run / 源目录已删 / root 域 / S1 型 run 域）：全体
//    成员各物化一个 transcript 文件（受控成员标签命名）+ 一次 spawn + result
//    事件 _members；`--kind` 切片名（`{stem}-{name}-{ti}-{i}.jsonl`，即
//    findings.transcript）按 stem 前缀回映射成员；
// ③ run 域：编排规程层声明 × 全体成员整会话——S2 型（有真名）走 --run 宽松
//    模式（无 --kind），S1 型（无真名）回落 DB 路径（恒无 --kind）；
// ④成员子集/未知成员/无会话；⑤agent 域 system 注入恢复；⑥root 域恒单成员
//    （组合声明 + _layers）；⑦声明恢复失败 404/503。
// 声明恢复与 records 序列化的内部逻辑由 sift-audit 既有测试覆盖，此处以桩注入。

import { describe, it, expect, vi, beforeEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const FAKE_REPORT = {
  skill_name: "rop-skill-x",
  transcripts: ["成员A.json", "成员B.json"],
  summary: { total: 2, pass: 1, fail: 1, na: 0 },
  findings: [
    { instruction_text: "do x", source: "STEP", verdict: "PASS", method: "LLM", category: "step", evidence: "ok", seq: 0 },
  ],
}

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock("node:child_process", () => ({ spawn: spawnMock }))

const fakePrisma = {
  session: { findFirst: vi.fn() },
  interactionBridge: { findMany: vi.fn() },
}
vi.mock("@/lib/db", () => ({ prisma: fakePrisma }))

const { recoverSkillBodyMock, recoverCombinedMock, recoverWorkflowMock, resolveWorkflowNameMock, buildRecordsMock, recoverAgentSystemMock, scanRootMock } = vi.hoisted(() => ({
  recoverSkillBodyMock: vi.fn(),
  recoverCombinedMock: vi.fn(),
  recoverWorkflowMock: vi.fn(),
  resolveWorkflowNameMock: vi.fn(),
  buildRecordsMock: vi.fn(),
  recoverAgentSystemMock: vi.fn(),
  scanRootMock: vi.fn(),
}))
vi.mock("@/lib/sift-audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sift-audit")>()
  return {
    ...actual,
    recoverSkillBody: recoverSkillBodyMock,
    recoverCombinedWorkflowDeclaration: recoverCombinedMock,
    recoverWorkflowDeclaration: recoverWorkflowMock,
    resolveWorkflowSkillName: resolveWorkflowNameMock,
    buildStructuredRecords: buildRecordsMock,
  }
})
vi.mock("@/lib/agent-md-session-recover", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent-md-session-recover")>()
  return { ...actual, recoverAgentMdFromSystem: recoverAgentSystemMock }
})
vi.mock("@/lib/agent-md-scan", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent-md-scan")>()
  return { ...actual, resolveScanRoot: scanRootMock }
})

const { resolveRunScopeMock, readRunMock } = vi.hoisted(() => ({ resolveRunScopeMock: vi.fn(), readRunMock: vi.fn() }))
vi.mock("@/lib/run/observe/scope", () => ({ resolveRunScope: resolveRunScopeMock }))
vi.mock("@/lib/run/run-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/run/run-store")>()
  return { ...actual, readRun: readRunMock }
})

const { POST } = await import("@/app/api/observe/run/[runId]/audit/route")

const RUN_ID = "run01"
const SCOPE = {
  kind: "run" as const,
  runId: RUN_ID,
  members: [
    { rowId: "row_a", taskId: "ses_a", framework: "opencode", label: "成员A", structure: null },
    { rowId: "row_b", taskId: "ses_b", framework: "opencode", label: "成员B", structure: null },
  ],
}

function makeRequest(body: unknown): Request {
  return new Request(`http://localhost/api/observe/run/${RUN_ID}/audit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

function callRoute(body: unknown) {
  return POST(makeRequest(body), { params: Promise.resolve({ runId: RUN_ID }) })
}

/** 手写最小事件面（on/emit），与 node:events 的测试 mock 惯用法零重合。 */
class FakeStream {
  private readonly handlers = new Map<string, Array<(chunk: unknown) => void>>()
  on(event: string, fn: (chunk: unknown) => void): this {
    const list = this.handlers.get(event) ?? []
    list.push(fn)
    this.handlers.set(event, list)
    return this
  }
  emit(event: string, chunk?: unknown): void {
    for (const fn of this.handlers.get(event) ?? []) fn(chunk)
  }
}

class FakeChild extends FakeStream {
  readonly stdout = new FakeStream()
  readonly stderr = new FakeStream()
  killed = false
  kill(): boolean {
    this.killed = true
    return true
  }
}

function outputDirOf(args: string[]): string | undefined {
  for (let i = 0; i + 1 < args.length; i += 1) {
    if (args[i] === "-o") return args[i + 1]
  }
  return undefined
}

function transcriptArgsOf(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i + 1 < args.length; i += 1) {
    if (args[i] === "--transcript") out.push(args[i + 1])
  }
  return out
}

/** spawn 桩：伪造 sift CLI——抓声明文件与 transcript 内容、落假报告、异步收尾 close 0。 */
const written = { declaration: null as string | null, transcripts: {} as Record<string, unknown> }

function happySpawn(report: Record<string, unknown> = FAKE_REPORT) {
  return vi.fn((_cmd: string, args: string[]) => {
    const child = new FakeChild()
    setTimeout(() => {
      // 声明文件：skill/root 是目录下的 SKILL.md；agent 是单文件 .md
      try {
        const stat = fs.statSync(args[1])
        written.declaration = stat.isDirectory()
          ? fs.readFileSync(path.join(args[1], "SKILL.md"), "utf8")
          : fs.readFileSync(args[1], "utf8")
      } catch {
        written.declaration = null
      }
      // transcript 实参文件内容（cleanup 前落袋）
      for (const t of transcriptArgsOf(args)) {
        try {
          written.transcripts[path.basename(t)] = JSON.parse(fs.readFileSync(t, "utf8"))
        } catch {
          /* 读不到忽略 */
        }
      }
      const outDir = outputDirOf(args)
      if (outDir) {
        fs.mkdirSync(outDir, { recursive: true })
        fs.writeFileSync(path.join(outDir, "audit-report.json"), JSON.stringify(report))
      }
      child.emit("close", 0)
    }, 0)
    return child
  })
}

async function readNdjson(res: Response): Promise<unknown[]> {
  const text = await res.text()
  return text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
}

beforeEach(() => {
  spawnMock.mockReset()
  written.declaration = null
  written.transcripts = {}
  resolveRunScopeMock.mockReset().mockResolvedValue(SCOPE)
  readRunMock.mockReset().mockReturnValue(null)
  fakePrisma.session.findFirst.mockReset().mockImplementation(async (q: { where: { taskId: string } }) =>
    q.where.taskId === "ses_a"
      ? { id: "cuid_a", sourcePath: "/tmp/fake-a.jsonl" }
      : q.where.taskId === "ses_b"
        ? { id: "cuid_b", sourcePath: "/tmp/fake-b.jsonl" }
        : null,
  )
  fakePrisma.interactionBridge.findMany.mockReset().mockResolvedValue([])
  recoverSkillBodyMock.mockReset()
  recoverCombinedMock.mockReset()
  recoverWorkflowMock.mockReset()
  resolveWorkflowNameMock.mockReset().mockResolvedValue(null)
  buildRecordsMock.mockReset().mockImplementation(async (id: string) => [{ type: "user", text: `records-of-${id}`, ts: 0, parent_tool_use_id: null, agent: null }])
  recoverAgentSystemMock.mockReset().mockReturnValue(null)
  scanRootMock.mockReset().mockReturnValue(null)
})

describe("run 级对账端点（多 --transcript 编排）", () => {
  it("skill 域 happy：全体成员各一个 transcript 文件 + 一次 spawn + result 事件带 _members", async () => {
    recoverSkillBodyMock.mockImplementation(async (id: string) => (id === "cuid_a" ? "RECOVERED BODY X" : null))
    spawnMock.mockImplementation(happySpawn())

    const res = await callRoute({ kind: "skill", name: "rop-skill-x" })
    expect(res.status).toBe(200)

    const events = (await readNdjson(res)) as Array<{
      stage: string
      report: { skill_name: string }
      _members?: Record<string, { taskId: string; label: string }>
    }>
    const last = events.at(-1)!
    expect(last.stage).toBe("result")
    expect(last.report.skill_name).toBe("rop-skill-x")
    expect(last._members).toEqual({
      "成员A.json": { taskId: "ses_a", label: "成员A", framework: "opencode" },
      "成员B.json": { taskId: "ses_b", label: "成员B", framework: "opencode" },
    })

    const [, args] = spawnMock.mock.calls[0]
    expect(args[0]).toBe("audit")
    const transcripts = transcriptArgsOf(args)
    expect(transcripts).toHaveLength(2)
    expect(transcripts.map((t) => path.basename(t))).toEqual(["成员A.json", "成员B.json"])
    // transcript 文件内容 = 各成员会话的序列化 records
    expect(written.transcripts["成员A.json"]).toEqual([{ type: "user", text: "records-of-cuid_a", ts: 0, parent_tool_use_id: null, agent: null }])
    expect((written.transcripts["成员B.json"] as Array<{ text: string }>)[0].text).toBe("records-of-cuid_b")
    // 声明物化：frontmatter name = skill 名 + 恢复正文
    expect(written.declaration).toContain("name: rop-skill-x")
    expect(written.declaration).toContain("RECOVERED BODY X")
    // 切段与定位开关
    expect(args[args.indexOf("--kind") + 1]).toBe("skill")
    expect(args).toContain("--turn-refs")
  })

  it("skill 域 --run 原生对账：源 bundle 在盘 → spawn 带 --run 无 --transcript，_members 由 report.run.units 权威映射", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rsd-audit-run-"))
    const bundleDir = path.join(tmpRoot, "bundle")
    fs.mkdirSync(path.join(bundleDir, "sessions"), { recursive: true })
    fs.writeFileSync(path.join(bundleDir, "workflow.schema.json"), "{}")
    fs.writeFileSync(path.join(bundleDir, "workflow.json"), '{"schema":"workflow-bundle","version":1}')
    try {
      readRunMock.mockReturnValue({
        runId: RUN_ID,
        manifest: null,
        index: null,
        meta: {
          schema: "insight-run-import",
          version: 1,
          data: {
            importedAt: "",
            sourceDir: bundleDir,
            manifestFile: "workflow.json",
            exportDataComplete: true,
            sessions: { total: 0, imported: 0, existing: 0, missingFile: 0, failed: 0 },
            failures: [],
            warnings: [],
          },
        },
      })
      recoverSkillBodyMock.mockImplementation(async (id: string) => (id === "cuid_a" ? "RECOVERED BODY X" : null))
      spawnMock.mockImplementation(
        happySpawn({
          ...FAKE_REPORT,
          transcripts: ["ses_a-rop-skill-x-1-1.jsonl", "ses_b-rop-skill-x-2-1.jsonl"],
          findings: [
            { instruction_text: "do x", source: "STEP", verdict: "PASS", method: "LLM", category: "step", evidence: "ok", seq: 0, transcript: "ses_a-rop-skill-x-1-1.jsonl" },
            { instruction_text: "do x", source: "STEP", verdict: "PASS", method: "LLM", category: "step", evidence: "ok", seq: 1, transcript: "ses_b-rop-skill-x-2-1.jsonl" },
          ],
          run: {
            runId: RUN_ID,
            bundlePath: "bundle",
            matchedSessionCount: 2,
            targetCallCount: 2,
            auditUnitCount: 2,
            units: [
              { auditUnitId: "ses_a-rop-skill-x-1-1.jsonl", memberId: "m1", sessionId: "ses_a", source: "sessions/ses_a.native/ses_a.jsonl", scope: "invocation", matchedToolUseIds: ["u1"] },
              { auditUnitId: "ses_b-rop-skill-x-2-1.jsonl", memberId: "m2", sessionId: "ses_b", source: "sessions/ses_b.native/ses_b.jsonl", scope: "invocation", matchedToolUseIds: ["u2"] },
            ],
          },
        }),
      )

      const res = await callRoute({ kind: "skill", name: "rop-skill-x" })
      expect(res.status).toBe(200)

      const events = (await readNdjson(res)) as Array<{
        stage: string
        report: { run?: { matchedSessionCount: number } }
        _members?: Record<string, { taskId: string; label: string }>
      }>
      const last = events.at(-1)!
      expect(last.stage).toBe("result")
      // report 原样回传（run 溯源随报告到前端）
      expect(last.report.run?.matchedSessionCount).toBe(2)
      // _members = units × sessionId（sift 权威归因，切片显示名为键）
      expect(last._members).toEqual({
        "ses_a-rop-skill-x-1-1.jsonl": { taskId: "ses_a", label: "成员A", framework: "opencode" },
        "ses_b-rop-skill-x-2-1.jsonl": { taskId: "ses_b", label: "成员B", framework: "opencode" },
      })

      const [, args] = spawnMock.mock.calls[0]
      expect(args[0]).toBe("audit")
      expect(args[args.indexOf("--run") + 1]).toBe(bundleDir)
      // --run 与 --transcript 互斥：不再逐成员物化 transcript
      expect(transcriptArgsOf(args)).toEqual([])
      expect(args[args.indexOf("--kind") + 1]).toBe("skill")
      expect(args).toContain("--turn-refs")
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it("skill 域 DB 回落：--kind 切片名按 stem 前缀回映射成员（findings.transcript 归因不丢）", async () => {
    recoverSkillBodyMock.mockImplementation(async (id: string) => (id === "cuid_a" ? "RECOVERED BODY X" : null))
    const sliceName = "成员A-rop-skill-x-1-1.jsonl"
    spawnMock.mockImplementation(
      happySpawn({
        ...FAKE_REPORT,
        transcripts: [sliceName],
        findings: [{ instruction_text: "do x", source: "STEP", verdict: "PASS", method: "LLM", category: "step", evidence: "ok", seq: 0, transcript: sliceName }],
      }),
    )

    const res = await callRoute({ kind: "skill", name: "rop-skill-x" })
    expect(res.status).toBe(200)

    const events = (await readNdjson(res)) as Array<{ _members?: Record<string, { taskId: string }> }>
    const last = events.at(-1)!
    // 原始键保留 + 切片名（= findings.transcript 的取值域）补齐映射
    expect(last._members?.["成员A.json"]?.taskId).toBe("ses_a")
    expect(last._members?.[sliceName]).toEqual({ taskId: "ses_a", label: "成员A", framework: "opencode" })
  })

  it("skill 域源 bundle 悬空（sourceDir 已删）→ 回落 DB transcript 路径", async () => {
    readRunMock.mockReturnValue({
      runId: RUN_ID,
      manifest: null,
      index: null,
      meta: { schema: "insight-run-import", version: 1, data: { importedAt: "", sourceDir: path.join(os.tmpdir(), "rsd-gone-bundle"), manifestFile: "workflow.json", exportDataComplete: true, sessions: { total: 0, imported: 0, existing: 0, missingFile: 0, failed: 0 }, failures: [], warnings: [] } },
    })
    recoverSkillBodyMock.mockImplementation(async (id: string) => (id === "cuid_a" ? "RECOVERED BODY X" : null))
    spawnMock.mockImplementation(happySpawn())

    const res = await callRoute({ kind: "skill", name: "rop-skill-x" })
    expect(res.status).toBe(200)

    const [, args] = spawnMock.mock.calls[0]
    expect(args).not.toContain("--run")
    expect(transcriptArgsOf(args)).toHaveLength(2)
  })

  it("run 域 S2 型：规程层声明 × 全 run，--run 宽松模式（无 --kind）+ 真名锚定 + units 归因", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rsd-audit-runmode-"))
    const bundleDir = path.join(tmpRoot, "bundle")
    fs.mkdirSync(path.join(bundleDir, "sessions"), { recursive: true })
    fs.writeFileSync(path.join(bundleDir, "workflow.schema.json"), "{}")
    fs.writeFileSync(path.join(bundleDir, "workflow.json"), '{"schema":"workflow-bundle","version":1}')
    try {
      readRunMock.mockReturnValue({
        runId: RUN_ID,
        manifest: null,
        index: null,
        meta: { schema: "insight-run-import", version: 1, data: { importedAt: "", sourceDir: bundleDir, manifestFile: "workflow.json", exportDataComplete: true, sessions: { total: 0, imported: 0, existing: 0, missingFile: 0, failed: 0 }, failures: [], warnings: [] } },
      })
      recoverWorkflowMock.mockResolvedValue({ content: "REGULATION BODY: 必须先跑测试", source: "task-prompts.md" })
      resolveWorkflowNameMock.mockResolvedValue("orchestrator")
      spawnMock.mockImplementation(
        happySpawn({
          ...FAKE_REPORT,
          transcripts: ["ses_a.json", "ses_b.json"],
          findings: [
            { instruction_text: "必须先跑测试", source: "CONSTRAINT", verdict: "PASS", method: "PROGRAMMATIC", category: "prohibition", evidence: "ok", seq: 0, transcript: "ses_a.json" },
            { instruction_text: "必须先跑测试", source: "CONSTRAINT", verdict: "FAIL", method: "PROGRAMMATIC", category: "prohibition", evidence: "bad", seq: 1, transcript: "ses_b.json" },
          ],
          run: {
            runId: RUN_ID,
            bundlePath: "bundle",
            matchedSessionCount: 2,
            targetCallCount: 2,
            auditUnitCount: 2,
            units: [
              { auditUnitId: "ses_a.json", memberId: "m1", sessionId: "ses_a", source: "sessions/ses_a.native/ses_a.jsonl", scope: "session", matchedToolUseIds: ["u1"] },
              { auditUnitId: "ses_b.json", memberId: "m2", sessionId: "ses_b", source: "sessions/ses_b.native/ses_b.jsonl", scope: "session", matchedToolUseIds: ["u2"] },
            ],
          },
        }),
      )

      const res = await callRoute({ kind: "run", name: "ses_a", members: ["ses_a", "ses_b"] })
      expect(res.status).toBe(200)

      const events = (await readNdjson(res)) as Array<{
        stage: string
        report: { run?: { matchedSessionCount: number } }
        _layers?: Array<{ kind: string; label: string }>
        _members?: Record<string, { taskId: string }>
      }>
      const last = events.at(-1)!
      expect(last.stage).toBe("result")
      expect(last.report.run?.matchedSessionCount).toBe(2)
      // 宽松模式：审计单元 = 整会话（scope=session），成员归因按 units × sessionId
      expect(last._members).toEqual({
        "ses_a.json": { taskId: "ses_a", label: "成员A", framework: "opencode" },
        "ses_b.json": { taskId: "ses_b", label: "成员B", framework: "opencode" },
      })
      // run 域声明只带规程层（finding 归层徽章）
      expect(last._layers).toEqual([
        { kind: "regulation", label: "编排规程", source: "task-prompts.md", content: "REGULATION BODY: 必须先跑测试" },
      ])

      // 声明物化（流收尾后桩已落袋）：规程层正文 + 真名 frontmatter（--run 按名匹配 bundle 成员）
      expect(written.declaration).toContain("name: orchestrator")
      expect(written.declaration).toContain("REGULATION BODY")

      const [, args] = spawnMock.mock.calls[0]
      expect(args[args.indexOf("--run") + 1]).toBe(bundleDir)
      // 宽松对账：无 --kind（整会话不切段）、无 --transcript（sift 原生选成员）
      expect(args).not.toContain("--kind")
      expect(transcriptArgsOf(args)).toEqual([])
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it("run 域 S1 型（无真名）：sift 无法按名匹配 → 回落 DB 全成员 transcript（无 --kind）", async () => {
    recoverWorkflowMock.mockResolvedValue({ content: "TURN0 REGULATION", source: "turn0 (注入编排规程)" })
    resolveWorkflowNameMock.mockResolvedValue(null)
    spawnMock.mockImplementation(happySpawn())

    const res = await callRoute({ kind: "run", name: "ses_a" })
    expect(res.status).toBe(200)

    const events = (await readNdjson(res)) as Array<{ _layers?: Array<{ kind: string }> }>
    expect(events.at(-1)!._layers).toEqual([
      { kind: "regulation", label: "编排规程", source: "turn0 (注入编排规程)", content: "TURN0 REGULATION" },
    ])

    // 声明物化（流收尾后桩已落袋）：S1 型无真名 → 合成名 frontmatter
    expect(written.declaration).toContain("name: 主 agent 编排")
    expect(written.declaration).toContain("TURN0 REGULATION")
    // 全体成员各物化一个 transcript（缺省 members = run 全体）
    expect(Object.keys(written.transcripts).sort()).toEqual(["成员A.json", "成员B.json"])

    const [, args] = spawnMock.mock.calls[0]
    expect(args).not.toContain("--run")
    expect(args).not.toContain("--kind")
    expect(transcriptArgsOf(args)).toHaveLength(2)
  })

  it("run 域：声明不可恢复 → 404；声明源成员不在 run → 400", async () => {
    recoverWorkflowMock.mockResolvedValue(null)
    const res = await callRoute({ kind: "run", name: "ses_a" })
    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toMatchObject({ reason: "no-declaration" })

    const res2 = await callRoute({ kind: "run", name: "ghost" })
    expect(res2.status).toBe(400)
  })

  it("成员子集：只物化选中成员的 transcript", async () => {
    recoverSkillBodyMock.mockResolvedValue("BODY")
    spawnMock.mockImplementation(happySpawn())

    const res = await callRoute({ kind: "skill", name: "rop-skill-x", members: ["ses_b"] })
    expect(res.status).toBe(200)
    await readNdjson(res)

    const [, args] = spawnMock.mock.calls[0]
    const transcripts = transcriptArgsOf(args)
    expect(transcripts.map((t) => path.basename(t))).toEqual(["成员B.json"])
  })

  it("未知成员 → 400", async () => {
    const res = await callRoute({ kind: "skill", name: "rop-skill-x", members: ["ses_ghost"] })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; reason: string }
    expect(body.reason).toBe("member-not-in-run")
  })

  it("skill 域：全体成员均恢复不到正文 → 404", async () => {
    recoverSkillBodyMock.mockResolvedValue(null)
    const res = await callRoute({ kind: "skill", name: "rop-skill-x" })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { reason: string }
    expect(body.reason).toBe("no-declaration")
  })

  it("agent 域：system 注入恢复 → 物化 agent.md + --kind agent", async () => {
    recoverAgentSystemMock.mockImplementation((_p: string, taskId: string) =>
      taskId === "ses_b" ? { content: "AGENT DECL BODY" } : null,
    )
    spawnMock.mockImplementation(happySpawn())

    const res = await callRoute({ kind: "agent", name: "rop-agent-z", members: ["ses_b"] })
    expect(res.status).toBe(200)
    await readNdjson(res)

    const [, args] = spawnMock.mock.calls[0]
    expect(args[args.indexOf("--kind") + 1]).toBe("agent")
    expect(written.declaration).toContain("name: rop-agent-z")
    expect(written.declaration).toContain("AGENT DECL BODY")
  })

  it("agent 域：system 无注入且无扫描根 → 503", async () => {
    spawnMock.mockImplementation(happySpawn())
    const res = await callRoute({ kind: "agent", name: "rop-agent-z", members: ["ses_b"] })
    expect(res.status).toBe(503)
    const body = (await res.json()) as { reason: string }
    expect(body.reason).toBe("no-declaration")
  })

  it("root 域：恒单成员 + 组合声明 + result 事件回传 _layers", async () => {
    recoverCombinedMock.mockResolvedValue({
      content: "REG + PLAN",
      source: "task-prompts.md",
      layers: [{ kind: "regulation", label: "编排规程", source: "task-prompts.md", content: "REG" }],
    })
    spawnMock.mockImplementation(happySpawn())

    const res = await callRoute({ kind: "root", name: "ses_a", members: ["ses_a"] })
    expect(res.status).toBe(200)
    const events = (await readNdjson(res)) as Array<{ stage: string; _layers?: Array<{ kind: string }> }>
    const last = events.at(-1)!
    expect(last.stage).toBe("result")
    expect(last._layers).toHaveLength(1)
    expect(last._layers![0].kind).toBe("regulation")

    const [, args] = spawnMock.mock.calls[0]
    expect(args[args.indexOf("--kind") + 1]).toBe("root")
    expect(transcriptArgsOf(args).map((t) => path.basename(t))).toEqual(["成员A.json"])
    expect(written.declaration).toContain("name: main-agent-workflow")
    expect(written.declaration).toContain("REG + PLAN")
  })

  it("root 域：多成员 → 400；声明不可恢复 → 404", async () => {
    const res400 = await callRoute({ kind: "root", name: "whatever" })
    expect(res400.status).toBe(400)

    recoverCombinedMock.mockResolvedValue(null)
    const res404 = await callRoute({ kind: "root", name: "ses_a", members: ["ses_a"] })
    expect(res404.status).toBe(404)
    const body = (await res404.json()) as { reason: string }
    expect(body.reason).toBe("no-declaration")
  })

  it("run 不存在 → 404", async () => {
    resolveRunScopeMock.mockResolvedValue(null)
    const res = await callRoute({ kind: "skill", name: "rop-skill-x" })
    expect(res.status).toBe(404)
  })
})
