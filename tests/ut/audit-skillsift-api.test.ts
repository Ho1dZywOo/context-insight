// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { describe, it, expect, vi, beforeEach } from "vitest"
import fs from "node:fs"
import path from "node:path"

const FAKE_REPORT = {
  skill_name: "acme-crash-debug",
  transcript_sources: ["opencode"],
  summary: { total: 2, pass: 1, fail: 1, na: 0 },
  findings: [
    { instruction_text: "do x", source: "STEP", verdict: "PASS", method: "LLM", category: "step", evidence: "ok", seq: 0 },
  ],
}

let lastWrittenSkillMd: string | null = null

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock("node:child_process", () => ({ spawn: spawnMock }))

const { llmExtractMock } = vi.hoisted(() => ({ llmExtractMock: vi.fn() }))
vi.mock("@/lib/llm-workflow-extract", () => ({ llmExtractWorkflowDeclaration: llmExtractMock }))

const fakePrisma = {
  session: { findFirst: vi.fn() },
  skillEvent: { findFirst: vi.fn(), findMany: vi.fn() },
  interactionBridge: { findMany: vi.fn() },
  toolCall: { findMany: vi.fn() },
  turn: { findMany: vi.fn(), findFirst: vi.fn() },
}
vi.mock("@/lib/db", () => ({ prisma: fakePrisma }))

const { POST } = await import("@/app/api/ai/audit-skillsift/route")

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/ai/audit-skillsift", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
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

/** spawn 桩用的假子进程：事件面 + 标准流，kill 只记标记。 */
class FakeChild extends FakeStream {
  readonly stdout = new FakeStream()
  readonly stderr = new FakeStream()
  killed = false
  kill(): boolean {
    this.killed = true
    return true
  }
}

/** 从 CLI 参数里取 -o 指定的输出目录。 */
function outputDirOf(args: string[]): string | undefined {
  for (let i = 0; i + 1 < args.length; i += 1) {
    if (args[i] === "-o") return args[i + 1]
  }
  return undefined
}

/** spawn 桩：伪造 sift CLI——抓取写入的 SKILL.md、往 -o 目录落假报告文件，随后异步收尾 close 0。 */
function happySpawn() {
  return vi.fn((_cmd: string, args: string[]) => {
    const child = new FakeChild()
    setTimeout(() => {
      try {
        lastWrittenSkillMd = fs.readFileSync(path.join(args[1], "SKILL.md"), "utf8")
      } catch {
        lastWrittenSkillMd = null
      }
      const outDir = outputDirOf(args)
      if (outDir) {
        fs.mkdirSync(outDir, { recursive: true })
        fs.writeFileSync(path.join(outDir, "audit-report.json"), JSON.stringify(FAKE_REPORT))
        fs.writeFileSync(path.join(outDir, "audit-report.html"), "<!doctype html><body>STUB AUDIT HTML</body>")
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

function seedSkillBody(): void {
  fakePrisma.skillEvent.findFirst.mockResolvedValue({ turnId: "t1" })
  fakePrisma.toolCall.findMany.mockResolvedValue([
    {
      toolName: "skill",
      argsJson: '{"name":"acme-crash-debug"}',
      resultJson: '<skill_content name="acme-crash-debug">BODY</skill_content>',
    },
  ])
}

describe("audit-skillsift route", () => {
  beforeEach(() => {
    lastWrittenSkillMd = null
    spawnMock.mockReset()
    llmExtractMock.mockReset()
    fakePrisma.session.findFirst.mockReset()
    fakePrisma.skillEvent.findFirst.mockReset()
    fakePrisma.skillEvent.findMany.mockReset().mockResolvedValue([])
    fakePrisma.interactionBridge.findMany.mockReset().mockResolvedValue([])
    fakePrisma.toolCall.findMany.mockReset()
    fakePrisma.turn.findMany.mockReset()
    fakePrisma.turn.findFirst.mockReset()
  })

  it("happy：恢复正文 → spawn sift → NDJSON result 事件", async () => {
    fakePrisma.session.findFirst.mockResolvedValue({ id: "ses_cuid_1", sourcePath: "/tmp/fake.db", framework: "opencode" })
    seedSkillBody()
    spawnMock.mockImplementation(happySpawn())

    const res = await POST(makeRequest({ taskId: "ses_1", skillName: "acme-crash-debug" }))
    expect(res.status).toBe(200)
    const events = await readNdjson(res)
    const last = events.at(-1) as { stage: string; report: { skill_name: string; summary: { fail: number } }; _html: string }
    expect(last.stage).toBe("result")
    expect(last.report.skill_name).toBe("acme-crash-debug")
    expect(last.report.summary.fail).toBe(1)
    expect(last._html).toContain("STUB AUDIT HTML")

    const [, args] = spawnMock.mock.calls[0]
    expect(args[0]).toBe("audit")
    expect(args).toContain("--db")
    expect(args).toContain("/tmp/fake.db")
    expect(args).toContain("--session")
    expect(args).toContain("ses_1")
    expect(lastWrittenSkillMd?.startsWith("---")).toBe(true)
    expect(lastWrittenSkillMd).toContain("name: acme-crash-debug")
    expect(lastWrittenSkillMd).toContain("BODY")
  })

  it("kind=root → LLM 提取单层规程 → --kind root + 物化 main-agent-workflow（无分层标题）", async () => {
    fakePrisma.session.findFirst.mockResolvedValue({ id: "ses_cuid_1", sourcePath: "/tmp/fake.db", framework: "opencode" })
    llmExtractMock.mockResolvedValue({
      content: "# Task 调用参数\n\n## 1.1 开发准备\n\n- [ ] 开发日志已创建\n- [ ] 问题目录已创建\n- [ ] 环境检查已执行\n" + "x".repeat(120),
      source: "task-prompts.md",
      layers: [{ kind: "regulation", label: "编排规程", source: "task-prompts.md", content: "REG" }],
    })
    spawnMock.mockImplementation(happySpawn())

    const res = await POST(makeRequest({ taskId: "ses_1", skillName: "主 agent 编排", kind: "root" }))
    await readNdjson(res)
    expect(res.status).toBe(200)
    const [, args] = spawnMock.mock.calls[0]
    expect(args).toContain("--kind")
    expect(args[args.indexOf("--kind") + 1]).toBe("root")
    expect(lastWrittenSkillMd).toContain("开发准备")
    expect(lastWrittenSkillMd).toContain("name: main-agent-workflow")
    // 单层直出，无分层标题（装配单点 assembleCombinedDeclaration 的既有语义）
    expect(lastWrittenSkillMd).not.toContain("## 二、任务计划")
    // 声明来自 LLM 提取单点（root 恒 LLM，不走确定性插件路）
    expect(llmExtractMock).toHaveBeenCalledWith("ses_cuid_1", expect.anything())
  })

  it("kind=root → LLM 提取双层 → 分层拼接 + result 事件回传 _layers", async () => {
    fakePrisma.session.findFirst.mockResolvedValue({ id: "ses_cuid_1", sourcePath: "/tmp/fake.db", framework: "opencode" })
    const resourceContent = "# Task 调用参数\n\n## 1.1 开发准备\n\n- [ ] 开发日志已创建\n- [ ] 问题目录已创建\n- [ ] 环境检查已执行\n" + "x".repeat(120)
    const stateContent = "# STATE\n\n## Tasks\n\n- [ ] 1. 派发 developer\n- [ ] 2. 验收 st-verifier\n- [ ] 3. 收尾归档\n" + "y".repeat(120)
    llmExtractMock.mockResolvedValue({
      content: `# Workflow 声明（主 agent）\n\n## 一、编排规程\n\n${resourceContent}\n\n## 二、任务计划\n\n${stateContent}\n`,
      source: "规程: task-prompts.md + 计划: STATE.md",
      layers: [
        { kind: "regulation", label: "编排规程", source: "task-prompts.md", content: resourceContent },
        { kind: "plan", label: "任务计划", source: "STATE.md", content: stateContent },
      ],
    })
    spawnMock.mockImplementation(happySpawn())

    const res = await POST(makeRequest({ taskId: "ses_1", skillName: "主 agent 编排", kind: "root" }))
    const events = (await readNdjson(res)) as Array<{ stage: string; _layers?: Array<{ kind: string; source: string }> }>
    expect(res.status).toBe(200)
    // 物化的 SKILL.md = 分层拼接（规程在前、计划在后）
    expect(lastWrittenSkillMd).toContain("## 一、编排规程")
    expect(lastWrittenSkillMd).toContain("开发准备")
    expect(lastWrittenSkillMd).toContain("## 二、任务计划")
    expect(lastWrittenSkillMd).toContain("派发 developer")
    expect(lastWrittenSkillMd!.indexOf("## 一、编排规程")).toBeLessThan(lastWrittenSkillMd!.indexOf("## 二、任务计划"))
    // result 事件带层信息（前端 finding 归层徽章）
    const last = events.at(-1)!
    expect(last.stage).toBe("result")
    expect(last._layers).toHaveLength(2)
    expect(last._layers![0].kind).toBe("regulation")
    expect(last._layers![0].source).toBe("task-prompts.md")
    expect(last._layers![1].kind).toBe("plan")
    expect(last._layers![1].source).toBe("STATE.md")
  })

  it("kind=root → LLM 提取无输出（无候选/选择无效）→ 404", async () => {
    fakePrisma.session.findFirst.mockResolvedValue({ id: "ses_cuid_1", sourcePath: "/tmp/fake.db", framework: "opencode" })
    llmExtractMock.mockResolvedValue(null)
    const res = await POST(makeRequest({ taskId: "ses_1", kind: "root" }))
    expect(res.status).toBe(404)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it("kind=root → claude CLI 失败（认证 403）→ 502 + 具体原因（不吞成笼统 404）；llm-root 别名同语义", async () => {
    fakePrisma.session.findFirst.mockResolvedValue({ id: "ses_cuid_1", sourcePath: "/tmp/fake.db", framework: "opencode" })
    llmExtractMock.mockRejectedValue(new Error("claude CLI 退出码 1：Failed to authenticate. API Error: 403 invalid api-key"))
    const res = await POST(makeRequest({ taskId: "ses_1", kind: "root" }))
    expect(res.status).toBe(502)
    const d = await res.json()
    expect(d.error).toContain("403 invalid api-key")
    expect(spawnMock).not.toHaveBeenCalled()

    // 退役前别名 llm-root 收敛到 root 同语义（不 400、不双轨）
    const resAlias = await POST(makeRequest({ taskId: "ses_1", kind: "llm-root" }))
    expect(resAlias.status).toBe(502)
  })

  it("缺 taskId → 400", async () => {
    const res = await POST(makeRequest({ skillName: "x" }))
    expect(res.status).toBe(400)
  })

  it("session 无 sourcePath → 404", async () => {
    fakePrisma.session.findFirst.mockResolvedValue({ id: "ses_cuid_1", sourcePath: null })
    const res = await POST(makeRequest({ taskId: "ses_1", skillName: "x" }))
    expect(res.status).toBe(404)
  })

  it("session 不存在 → 404", async () => {
    fakePrisma.session.findFirst.mockResolvedValue(null)
    const res = await POST(makeRequest({ taskId: "ses_1", skillName: "x" }))
    expect(res.status).toBe(404)
  })

  it("skill 正文恢复不到（无候选工具调用）→ 404", async () => {
    fakePrisma.session.findFirst.mockResolvedValue({ id: "ses_cuid_1", sourcePath: "/tmp/fake.db", framework: "opencode" })
    fakePrisma.toolCall.findMany.mockResolvedValue([])
    const res = await POST(makeRequest({ taskId: "ses_1", skillName: "ghost" }))
    expect(res.status).toBe(404)
  })

  it("codex shell 通道（exec_command cat SKILL.md）→ 正文恢复 + 终端壳/横幅剥除 + frontmatter 名对齐", async () => {
    // 真机形态（cpx 捕获 codex-proxy 会话）：resultJson 带 Chunk ID 元数据头，
    // 正文含模型自印横幅行 + SKILL.md 自带 YAML frontmatter
    fakePrisma.session.findFirst.mockResolvedValue({
      id: "ses_cuid_1",
      sourcePath: "/tmp/codex-capture/cpx-ses_1.jsonl.7z",
      framework: "codex-proxy",
    })
    fakePrisma.toolCall.findMany.mockResolvedValue([
      {
        toolName: "exec_command",
        argsJson: JSON.stringify({ cmd: "echo '======== cannbay-report/SKILL.md ========'; cat /home/u/.codex/skills/cannbay-report/SKILL.md" }),
        resultJson: 'Chunk ID: 9014f0\nWall time: 0.0000 seconds\nProcess exited with code 0\nOriginal token count: 410\nOutput:\n======== cannbay-report/SKILL.md ========\n---\nname: "cannbay-report"\ndescription: "审计报告格式规范"\n---\n\n# CANNbay 审计报告规范\n\n五个必备章节。\n',
      },
    ])
    fakePrisma.turn.findMany.mockResolvedValue([])
    spawnMock.mockImplementation(happySpawn())

    const res = await POST(makeRequest({ taskId: "ses_1", skillName: "cannbay-report" }))
    expect(res.status).toBe(200)
    await readNdjson(res)
    // 落盘的 SKILL.md：单头 frontmatter（自带头保留、名字对齐锚点）、无终端壳、无横幅
    expect(lastWrittenSkillMd).not.toContain("Chunk ID")
    expect(lastWrittenSkillMd).not.toContain("========")
    expect((lastWrittenSkillMd?.match(/^---$/gm) ?? []).length).toBe(2)
    expect(lastWrittenSkillMd).toContain('name: cannbay-report')
    expect(lastWrittenSkillMd).toContain("# CANNbay 审计报告规范")
  })

  it("kind=root → 所选声明不完整 → result 事件回传 _evidence（层标签 + 来源 + 行级证据）", async () => {
    fakePrisma.session.findFirst.mockResolvedValue({ id: "ses_cuid_1", sourcePath: "/tmp/fake.db", framework: "opencode" })
    const regContent = "# 规程\n\n- [ ] 已读的指令\n" + "x".repeat(120)
    const planContent = "# 计划\n\n- [ ] 派发\n" + "y".repeat(120)
    const regEvidence = {
      lineNumbers: [1, 3], fileLines: 4, gaps: [{ from: 2, to: 2 }], truncated: true, conflictLines: [], readCount: 3,
    }
    llmExtractMock.mockResolvedValue({
      content: `# Workflow 声明（主 agent）\n\n## 一、编排规程\n\n${regContent}\n\n## 二、任务计划\n\n${planContent}\n`,
      source: "规程: demo (SKILL.md) + 计划: STATE.md",
      layers: [
        { kind: "regulation", label: "编排规程", source: "demo (SKILL.md)", content: regContent, evidence: regEvidence },
        { kind: "plan", label: "任务计划", source: "STATE.md", content: planContent },
      ],
      evidence: [{ source: "demo (SKILL.md)", layer: "编排规程", evidence: regEvidence }],
    })
    spawnMock.mockImplementation(happySpawn())

    const res = await POST(makeRequest({ taskId: "ses_1", skillName: "主 agent 编排", kind: "root" }))
    const events = (await readNdjson(res)) as Array<{ stage: string; _evidence?: unknown[] }>
    expect(res.status).toBe(200)
    expect(events.at(-1)!._evidence).toEqual([
      { source: "demo (SKILL.md)", layer: "编排规程", evidence: regEvidence },
    ])
  })

  it("codex 截断会话（cat 头尾 + nl -ba 管道多段读同一 SKILL.md）→ 物化正文按行号拼回已读行 + result 事件带 _evidence", async () => {
    const data = JSON.parse(fs.readFileSync(path.join(process.cwd(), "tests/data/skill-content-stitch.json"), "utf8")) as {
      skillName: string
      file: { lines: string[] }
      reads: Array<{ cmd: string; total?: number; prefix?: string; head?: string; tail?: string; output?: string }>
      expected: { fileLines: number; lineNumbers: number[]; gaps: Array<{ from: number; to: number }>; conflictLines: number[] }
    }
    fakePrisma.session.findFirst.mockResolvedValue({
      id: "ses_cuid_1",
      sourcePath: "/tmp/codex-capture/cpx-ses_1.jsonl",
      framework: "codex-proxy",
    })
    const header = "Chunk ID: 7f3a9c\nWall time: 0.0041 seconds\nProcess exited with code 0\nOutput:\n"
    fakePrisma.toolCall.findMany.mockResolvedValue(
      data.reads.map((read, i) => ({
        toolName: "exec_command",
        argsJson: JSON.stringify({ cmd: read.cmd }),
        resultJson: read.output != null
          ? header + read.output
          : header + (read.prefix ?? "") + `Warning: truncated output (original token count: 5000)\nTotal output lines: ${read.total}\n\n`
            + read.head + "…9876 tokens truncated…" + read.tail,
        startedAt: new Date(Date.parse("2026-11-17T10:00:00Z") + i * 60_000),
      })),
    )
    fakePrisma.turn.findMany.mockResolvedValue([])
    spawnMock.mockImplementation(happySpawn())

    const res = await POST(makeRequest({ taskId: "ses_1", skillName: data.skillName }))
    expect(res.status).toBe(200)
    const events = (await readNdjson(res)) as Array<{
      stage: string
      _evidence?: Array<{ source: string; evidence: { fileLines: number; gaps: unknown; conflictLines: number[] } }>
    }>

    // 物化的声明 = 只含确实读到的行（多段按行号拼回），缺口处没有任何标记行
    expect(lastWrittenSkillMd).toContain(data.file.lines[158])
    expect(lastWrittenSkillMd).not.toContain("第 68 行")
    expect(lastWrittenSkillMd).not.toContain("未读到")
    expect(lastWrittenSkillMd).not.toContain("truncated")
    expect(events.at(-1)!._evidence).toHaveLength(1)
    expect(events.at(-1)!._evidence![0]!.source).toBe(data.skillName)
    expect(events.at(-1)!._evidence![0]!.evidence).toMatchObject({
      fileLines: data.expected.fileLines,
      gaps: data.expected.gaps,
      conflictLines: data.expected.conflictLines,
    })
  })

  it("sift 不在 PATH（spawn ENOENT）→ NDJSON error 事件", async () => {
    fakePrisma.session.findFirst.mockResolvedValue({ id: "ses_cuid_1", sourcePath: "/tmp/fake.db", framework: "opencode" })
    seedSkillBody()
    spawnMock.mockImplementation(() => {
      const child = new FakeChild()
      setImmediate(() => child.emit("error", Object.assign(new Error("enoent"), { code: "ENOENT" })))
      return child
    })
    const res = await POST(makeRequest({ taskId: "ses_1", skillName: "acme-crash-debug" }))
    expect(res.status).toBe(200)
    const events = await readNdjson(res)
    const last = events.at(-1) as { stage: string; msg: string }
    expect(last.stage).toBe("error")
    expect(last.msg).toMatch(/sift 未找到/)
  })

  it("sift 非零退出 → NDJSON error 事件带 exit code", async () => {
    fakePrisma.session.findFirst.mockResolvedValue({ id: "ses_cuid_1", sourcePath: "/tmp/fake.db", framework: "opencode" })
    seedSkillBody()
    spawnMock.mockImplementation(() => {
      const child = new FakeChild()
      setImmediate(() => {
        child.stderr.emit("data", Buffer.from("切段为空"))
        child.emit("close", 2)
      })
      return child
    })
    const res = await POST(makeRequest({ taskId: "ses_1", skillName: "acme-crash-debug" }))
    expect(res.status).toBe(200)
    const events = await readNdjson(res)
    const last = events.at(-1) as { stage: string; msg: string }
    expect(last.stage).toBe("error")
    expect(last.msg).toMatch(/exit 2/)
  })

  it("framework=cannbot-insight → --transcript 结构化 JSON(不走 --db)", async () => {
    fakePrisma.session.findFirst.mockResolvedValue({ id: "ses_cuid_1", sourcePath: "/tmp/fake.jsonl", framework: "cannbot-insight" })
    seedSkillBody()
    fakePrisma.turn.findMany.mockResolvedValue([
      { id: "t1", turnIndex: 0, role: "assistant", content: "调用 skill", agentName: "kernel-developer" },
    ])
    spawnMock.mockImplementation(happySpawn())
    const res = await POST(
      makeRequest({ taskId: "ses_1", skillName: "acme-crash-debug", framework: "cannbot-insight" }),
    )
    expect(res.status).toBe(200)
    const [, args] = spawnMock.mock.calls[0]
    expect(args).toContain("--transcript")
    expect(args).not.toContain("--db")
    expect(args.some((a: unknown) => typeof a === "string" && (a as string).endsWith("session.json"))).toBe(true)
  })

  it("framework=opencode + sourcePath=jsonl（lake 导入/proxy 捕获）→ --transcript（喂法按 sourcePath 形态，不看 framework）", async () => {
    // 回归：ses_0515cc95（lake 导入，meta framework=opencode，sourcePath 是物化 jsonl）
    // 走 --db 被 sift 当 sqlite 打开 → OpencodeDbError → exit 3 必失败。
    fakePrisma.session.findFirst.mockResolvedValue({
      id: "ses_cuid_1",
      sourcePath: "/tmp/lake-cache/materialized/ses_xxx.jsonl",
      framework: "opencode",
    })
    seedSkillBody()
    fakePrisma.turn.findMany.mockResolvedValue([
      { id: "t1", turnIndex: 0, role: "assistant", content: "调用 skill", agentName: "kernel-developer" },
    ])
    spawnMock.mockImplementation(happySpawn())
    const res = await POST(makeRequest({ taskId: "ses_1", skillName: "acme-crash-debug" }))
    expect(res.status).toBe(200)
    const [, args] = spawnMock.mock.calls[0]
    expect(args).toContain("--transcript")
    expect(args).not.toContain("--db")
    expect(args.some((a: unknown) => typeof a === "string" && (a as string).endsWith("session.json"))).toBe(true)
  })

  it("framework=opencode + sourcePath=jsonl.gz（压缩形态）→ --transcript", async () => {
    fakePrisma.session.findFirst.mockResolvedValue({
      id: "ses_cuid_1",
      sourcePath: "/tmp/cpx-ses_xxx.jsonl.gz",
      framework: "opencode",
    })
    seedSkillBody()
    fakePrisma.turn.findMany.mockResolvedValue([
      { id: "t1", turnIndex: 0, role: "assistant", content: "调用 skill", agentName: "kernel-developer" },
    ])
    spawnMock.mockImplementation(happySpawn())
    const res = await POST(makeRequest({ taskId: "ses_1", skillName: "acme-crash-debug" }))
    expect(res.status).toBe(200)
    const [, args] = spawnMock.mock.calls[0]
    expect(args).toContain("--transcript")
    expect(args).not.toContain("--db")
  })
})
