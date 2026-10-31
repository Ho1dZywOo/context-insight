// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * sift-runner：mock spawn，验证 stdout 进度解析（批 k/total + 完成 → 百分比）+ result/error 事件。
 */

const REPORT = { skill_name: "x", summary: { total: 2, pass: 1, fail: 1, na: 0 }, findings: [] }

// vi.mock 工厂会被提升到文件顶部，引用不到 it 内的局部变量；用 vi.hoisted 拿稳定引用。
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock("node:child_process", () => ({ spawn: spawnMock }))

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

/** spawn 桩用的假子进程：事件面 + 标准流；kill 记标记，可选携带被杀时的清理钩子。 */
class FakeChild extends FakeStream {
  readonly stdout = new FakeStream()
  readonly stderr = new FakeStream()
  killed = false
  private readonly onKill?: () => void
  constructor(onKill?: () => void) {
    super()
    this.onKill = onKill
  }
  kill(): boolean {
    this.killed = true
    this.onKill?.()
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

function happyImpl(progressLines: string[]) {
  return (_cmd: string, args: string[]) => {
    const child = new FakeChild()
    setTimeout(() => {
      for (const line of progressLines) child.stdout.emit("data", Buffer.from(line + "\n"))
      const outDir = outputDirOf(args)
      if (outDir) {
        fs.mkdirSync(outDir, { recursive: true })
        fs.writeFileSync(path.join(outDir, "audit-report.json"), JSON.stringify(REPORT))
        fs.writeFileSync(path.join(outDir, "audit-report.html"), "<!doctype html><body>STUB</body>")
      }
      child.emit("close", 0)
    }, 0)
    return child
  }
}

let tmpOut = ""
beforeEach(() => {
  tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "runner-out-"))
  spawnMock.mockReset()
})
afterEach(() => {
  fs.rmSync(tmpOut, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe("runSiftAuditStreaming (via makeStreamingAuditResponse)", () => {
  it("progress 解析 + result 事件", async () => {
    spawnMock.mockImplementation(happyImpl([
      "对账 transcript 1/1: session.json",
      "  [精筛] 判定 5 条…",
      "  [精筛] 完成 ⏱ 10s",
      "  [条件性] 批 1/2 判定 10 条…",
      "  [条件性] 批 1/2 完成 ⏱ 60s",
      "  [禁令] 判定 8 条…",
      "  [禁令] 完成 ⏱ 50s",
      "  [步骤] 判定 12 条…",
      "  [步骤] 完成 ⏱ 40s",
      "  [条件性] 批 2/2 判定 5 条…",
      "  [条件性] 批 2/2 完成 ⏱ 30s",
    ]))
    const { makeStreamingAuditResponse } = await import("@/lib/sift-runner")

    const res = makeStreamingAuditResponse(["audit", "/tmp/skill", "-o", tmpOut], tmpOut)
    const text = await res.text()
    const events = text.trim().split("\n").map((l) => JSON.parse(l))
    const stages = events.map((e: { stage: string }) => e.stage)
    expect(stages).toContain("progress")
    expect(stages.at(-1)).toBe("result")
    const result = events.at(-1) as { stage: string; report: unknown; _html: string; percent: number }
    expect(result.report).toMatchObject({ skill_name: "x" })
    expect(result._html).toContain("STUB")
    expect(result.percent).toBe(100)

    // 百分比单调非减
    const percents = events.filter((e: { stage: string }) => e.stage === "progress").map((e: { percent: number }) => e.percent)
    for (let i = 1; i < percents.length; i++) {
      expect(percents[i]).toBeGreaterThanOrEqual(percents[i - 1])
    }
    expect(percents.at(-1)).toBeGreaterThan(0)
  })

  it("ENOENT → error 事件（sift 未找到）", async () => {
    spawnMock.mockImplementation(() => {
      const child = new FakeChild()
      setImmediate(() => child.emit("error", Object.assign(new Error("enoent"), { code: "ENOENT" })))
      return child
    })
    const { makeStreamingAuditResponse } = await import("@/lib/sift-runner")

    const res = makeStreamingAuditResponse(["audit", "/tmp/skill", "-o", tmpOut], tmpOut)
    const text = await res.text()
    const events = text.trim().split("\n").map((l) => JSON.parse(l))
    expect(events.at(-1)).toMatchObject({ stage: "error" })
    expect((events.at(-1) as { msg: string }).msg).toMatch(/sift 未找到/)
  })

  it("非 0 退出 → error 事件带 exit code", async () => {
    spawnMock.mockImplementation(() => {
      const child = new FakeChild()
      setImmediate(() => {
        child.stderr.emit("data", Buffer.from("切段为空"))
        child.emit("close", 2)
      })
      return child
    })
    const { makeStreamingAuditResponse } = await import("@/lib/sift-runner")

    const res = makeStreamingAuditResponse(["audit", "/tmp/skill", "-o", tmpOut], tmpOut)
    const text = await res.text()
    const events = text.trim().split("\n").map((l) => JSON.parse(l))
    expect(events.at(-1)).toMatchObject({ stage: "error" })
    expect((events.at(-1) as { msg: string }).msg).toMatch(/exit 2/)
  })

  it("退出 0 但无 audit-report.json → error", async () => {
    spawnMock.mockImplementation(() => {
      const child = new FakeChild()
      setImmediate(() => child.emit("close", 0))
      return child
    })
    const { makeStreamingAuditResponse } = await import("@/lib/sift-runner")

    const res = makeStreamingAuditResponse(["audit", "/tmp/skill", "-o", tmpOut], tmpOut)
    const text = await res.text()
    const events = text.trim().split("\n").map((l) => JSON.parse(l))
    expect((events.at(-1) as { stage: string }).stage).toBe("error")
  })

  it("cleanup 在流结束后调用", async () => {
    spawnMock.mockImplementation(happyImpl([]))
    const { makeStreamingAuditResponse } = await import("@/lib/sift-runner")

    const cleanup = vi.fn()
    const res = makeStreamingAuditResponse(["audit", "/tmp/skill", "-o", tmpOut], tmpOut, cleanup)
    await res.text()
    expect(cleanup).toHaveBeenCalledTimes(1)
  })
})

describe("SiftProgressModel（完成行驱动进度模型）", () => {
  it("开始行不虚增进度（并行波一次性全发不算推进）", async () => {
    const { SiftProgressModel } = await import("@/lib/sift-runner")
    const m = new SiftProgressModel(8)
    for (let k = 1; k <= 7; k++) m.onLine(`[精筛] 批 ${k}/7 判定 10 条…`)
    expect(m.percent()).toBeLessThanOrEqual(10)
  })

  it("完成行才入账；精筛 + headline（rich 吞标签后的裸批行）合计不超 15%", async () => {
    const { SiftProgressModel } = await import("@/lib/sift-runner")
    const m = new SiftProgressModel(8)
    for (let k = 1; k <= 7; k++) m.onLine(`[精筛] 批 ${k}/7 完成 ⏱ 5s`)
    for (let k = 1; k <= 7; k++) m.onLine(`批 ${k}/7 完成 ⏱ 8s`)
    expect(m.percent()).toBeGreaterThan(3)
    expect(m.percent()).toBeLessThanOrEqual(15)
  })

  it("真实时间线：判定段跨切片累计、全程单调、收口不冒进（旧锯齿 95→23→95 回归锁）", async () => {
    const { SiftProgressModel } = await import("@/lib/sift-runner")
    const m = new SiftProgressModel(8)
    const pcts: number[] = []
    const step = (l: string): void => {
      m.onLine(l)
      pcts.push(m.percent())
    }
    for (let k = 1; k <= 7; k++) step(`[精筛] 批 ${k}/7 判定 10 条…`)
    for (let k = 1; k <= 7; k++) step(`[精筛] 批 ${k}/7 完成 ⏱ 5s`)
    for (let k = 1; k <= 7; k++) step(`批 ${k}/7 判定 10 条…`)
    for (let k = 1; k <= 7; k++) step(`批 ${k}/7 完成 ⏱ 8s`)
    expect(m.percent()).toBeLessThanOrEqual(15)
    for (let s = 1; s <= 8; s++) {
      step(`对账 transcript ${s}/8: member-${s}.jsonl`)
      step(`[条件性] 判定 3 条…`)
      for (let k = 1; k <= 3; k++) step(`[禁令] 批 ${k}/3 判定 10 条…`)
      for (let k = 1; k <= 3; k++) step(`[步骤] 批 ${k}/3 判定 10 条…`)
      step(`[条件性] 完成 ⏱ 23s`)
      for (let k = 1; k <= 3; k++) step(`[禁令] 批 ${k}/3 完成 ⏱ 9s`)
      for (let k = 1; k <= 3; k++) step(`[步骤] 批 ${k}/3 完成 ⏱ 19s`)
      for (let k = 1; k <= 2; k++) step(`[控制流] 批 ${k}/2 判定 10 条…`)
      for (let k = 1; k <= 2; k++) step(`[控制流] 批 ${k}/2 完成 ⏱ 10s`)
    }
    for (let i = 1; i < pcts.length; i++) expect(pcts[i]).toBeGreaterThanOrEqual(pcts[i - 1])
    expect(m.percent()).toBeGreaterThan(80)
    expect(m.percent()).toBeLessThanOrEqual(95)
  })

  it("缓存命中精筛（滤除/无候选，无批行）→ 零成本收口", async () => {
    const { SiftProgressModel } = await import("@/lib/sift-runner")
    const m = new SiftProgressModel(1)
    m.onLine("[精筛] 滤除 3 条")
    m.onLine("[条件性] 判定 3 条…")
    expect(m.describe()).toBe("判定 0/9 批")
    m.onLine("[条件性] 完成 ⏱ 23s")
    expect(m.describe()).toBe("判定 1/9 批")
  })

  it("describe：多切片带 transcript 序号", async () => {
    const { SiftProgressModel } = await import("@/lib/sift-runner")
    const m = new SiftProgressModel(8)
    m.onLine("对账 transcript 3/8: x.jsonl")
    m.onLine("[禁令] 批 1/3 判定 10 条…")
    m.onLine("[禁令] 批 1/3 完成 ⏱ 9s")
    expect(m.describe()).toBe("判定 1/72 批 · transcript 3/8")
  })
})

describe("多 slice（--kind skill 切片）进度", () => {
  it("新 transcript 开始时进度不回落（跨切片累计；旧模型回落 95→23 的锯齿回归锁）", async () => {
    // 真实场景：skill 被切成 2 个 slice（小 1-1 + 大 1-2）。旧 bug：slice 1 三类完成后
    // 状态虚满 → 一上来就 95%，slice 2 重置又砸回 23%。新模型完成行跨切片累计、单调不减。
    spawnMock.mockImplementation(happyImpl([
      "对账 transcript 1/2: tmpX-skill-1-1.jsonl",
      "  [精筛] 无候选",
      "  [条件性] 批 1/1 判定 4 条…",
      "  [条件性] 批 1/1 完成 ⏱ 60s",
      "  [禁令] 批 1/1 判定 6 条…",
      "  [禁令] 批 1/1 完成 ⏱ 55s",
      "  [步骤] 批 1/1 判定 8 条…",
      "  [步骤] 批 1/1 完成 ⏱ 70s",
      "对账 transcript 2/2: tmpX-skill-1-2.jsonl",
      "  [条件性] 批 1/5 判定 10 条…",
      "  [步骤] 批 1/7 判定 10 条…",
    ]))
    const { makeStreamingAuditResponse } = await import("@/lib/sift-runner")

    const res = makeStreamingAuditResponse(["audit", "/tmp/skill", "-o", tmpOut], tmpOut)
    const text = await res.text()
    const events = text.trim().split("\n").map((l) => JSON.parse(l))
    const progressPcts = events
      .filter((e: { stage: string }) => e.stage === "progress")
      .map((e: { percent: number }) => e.percent)
    // slice 1 结束：只完成 1/2 切片 → 远未到头（旧模型三类 done 即虚满 95%）
    const atSlice1End = progressPcts[7]
    expect(atSlice1End).toBeGreaterThan(3)
    expect(atSlice1End).toBeLessThan(50)
    // slice 2 开始 + 批号揭示（分母外推修正）→ 不回落
    const atSlice2Start = progressPcts[progressPcts.length - 1]
    expect(atSlice2Start).toBeGreaterThanOrEqual(atSlice1End)
  })
})

describe("静默看门狗", () => {
  it("静默超阈值 → SIGKILL + error 事件（带最后输出上下文）", async () => {
    vi.useFakeTimers()
    try {
      spawnMock.mockImplementation(() => {
        const child = new FakeChild()
        // 输出一行进度后彻底静默（模拟进程崩溃/close 丢失）
        setImmediate(() => child.stdout.emit("data", Buffer.from("  [步骤] 批 5/24 判定 10 条…\n")))
        return child
      })
      const { makeStreamingAuditResponse, SILENCE_KILL_MS } = await import("@/lib/sift-runner")

      const res = makeStreamingAuditResponse(["audit", "/tmp/skill", "-o", tmpOut], tmpOut)
      const textPromise = res.text()
      // 推进到静默阈值 + 1s（fake timer 不自动跑，需手动 advance）
      await vi.advanceTimersByTimeAsync(SILENCE_KILL_MS + 1000)
      const events = (await textPromise).trim().split("\n").map((l) => JSON.parse(l))
      const last = events.at(-1) as { stage: string; msg: string }
      expect(last.stage).toBe("error")
      expect(last.msg).toMatch(/无任何输出/)
      expect(last.msg).toContain("[步骤] 批 5/24")
      expect(last.msg).toMatch(/挂死/)
    } finally {
      vi.useRealTimers()
    }
  })

  it("持续输出喂狗 → 看门狗不触发（长时间运行被允许）", async () => {
    vi.useFakeTimers()
    try {
      spawnMock.mockImplementation(() => {
        const child = new FakeChild()
        // 每 5 分钟输出一行（模拟慢 LLM 批次间的重试提示），3 轮共 15min > 12min 阈值
        const lines = ["  [步骤] 批 1/3 判定 10 条…", "  [步骤] 批 1/3 重试 1/4…", "  [步骤] 批 2/3 判定 10 条…"]
        let i = 0
        const emitNext = (): void => {
          if (i < lines.length) {
            child.stdout.emit("data", Buffer.from(lines[i++] + "\n"))
            setTimeout(emitNext, 5 * 60 * 1000)
          } else {
            fs.mkdirSync(tmpOut, { recursive: true })
            fs.writeFileSync(path.join(tmpOut, "audit-report.json"), JSON.stringify(REPORT))
            child.emit("close", 0)
          }
        }
        setImmediate(emitNext)
        return child
      })
      const { makeStreamingAuditResponse, SILENCE_KILL_MS } = await import("@/lib/sift-runner")

      const res = makeStreamingAuditResponse(["audit", "/tmp/skill", "-o", tmpOut], tmpOut)
      const textPromise = res.text()
      // 总时长 3×5min = 15min > 12min 静默阈值，但每次输出都在重置看门狗
      await vi.advanceTimersByTimeAsync(3 * SILENCE_KILL_MS + 60_000)
      const events = (await textPromise).trim().split("\n").map((l) => JSON.parse(l))
      expect((events.at(-1) as { stage: string }).stage).toBe("result")
    } finally {
      vi.useRealTimers()
    }
  })

  it("总时限超时 → error 事件（LLM 判定过慢提示）", async () => {    vi.useFakeTimers()
    try {
      spawnMock.mockImplementation(() => {
        const child = new FakeChild(() => clearInterval(interval))
        // 持续输出喂狗（不触发静默看门狗），模拟判定一直在跑但跑不完
        const interval = setInterval(() => child.stdout.emit("data", Buffer.from("  [步骤] 批 1/24 判定 10 条…\n")), 60_000)
        return child
      })
      const { makeStreamingAuditResponse } = await import("@/lib/sift-runner")

      // 走内部 runSiftAuditStreaming 需经 makeStreamingAuditResponse（无 timeoutMs 参数）→
      // 用总时限 30min 默认值：advance 31min
      const res = makeStreamingAuditResponse(["audit", "/tmp/skill", "-o", tmpOut], tmpOut)
      const textPromise = res.text()
      await vi.advanceTimersByTimeAsync(31 * 60 * 1000)
      const events = (await textPromise).trim().split("\n").map((l) => JSON.parse(l))
      const last = events.at(-1) as { stage: string; msg: string }
      expect(last.stage).toBe("error")
      expect(last.msg).toMatch(/总时限/)
    } finally {
      vi.useRealTimers()
    }
  })
})
