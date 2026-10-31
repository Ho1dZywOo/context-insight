// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

/**
 * 会话块（SessionBlock）并行派发 lane 展示 IT。
 *
 * 契约承自 TurnTimeline 并行组演进史：并行 lanes =「紧凑 chip 行 + 就地展开」
 * ——展开 lane 紧贴自己的 chip 下方全宽渲染（wrapper basis-full 独占一行），
 * 多 lane 可同时展开；chip 行 flex-wrap、组根 min-w-0（窄容器不撑破、不留白）。
 * 断言（happy-dom 无布局引擎，锁结构防回归）：
 *   ① SessionBlock：桥在 → 并行组渲染（⇄ + 汇总 + 双 chip）；无桥 → 无泳道
 *   ② 不再使用多列 grid 并排（grid-cols-2/3 不应出现）
 *   ③ 展开的 lane 全宽就地渲染（basis-full），turn 行完整（#N/工具数/token）
 *   ④ 嵌套子 lane 就地挂载：渲染在派发轮行后、父 lane 后续轮之前
 *   ⑤ 交互：点击第一个 chip，详情 DOM 顺序先于后续 chip；其他 lane 不连带展开
 */
import { describe, it, expect } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { createElement } from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { SessionBlock, SubagentLaneView, ParallelSubagentGroup, sessionBlockPropsEqual, toLaneDisplayTurn, type TurnsBridge, type TurnsNodeSession, type SubagentLane } from "@/components/run/RunTurnsNodes"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function makeTurn(turnIndex: number, overrides: Record<string, unknown> = {}) {
  return {
    turnId: `t-${turnIndex}`,
    turnIndex,
    role: "assistant",
    contentSummary: `turn ${turnIndex}`,
    agentName: null,
    isSubagent: false,
    subagentName: null,
    subagentSessionId: null,
    parentExecutionId: null,
    totalTokens: 100 * turnIndex,
    inputTokens: 0,
    inputMessagesCount: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    latencyMs: 0,
    createdAt: null,
    completedAt: null,
    model: null,
    contextWindowPct: null,
    toolCalls: [],
    skillEvents: [],
    ...overrides,
  }
}

function makeBridge(bridgeId: string, dispatchTurnId: string, sessionId: string, agentName: string) {
  return {
    bridgeId,
    dispatchTurnId,
    dispatchContent: `dispatch ${agentName}`,
    subagentSessionId: sessionId,
    subagentType: "general",
    subagentName: agentName,
    agentName,
    status: "completed",
    subagentTokens: 0,
    subagentLatencyMs: 0,
  }
}

function soloSession(taskId: string): TurnsNodeSession {
  return {
    taskId,
    label: taskId,
    role: "execute",
    attemptOrdinal: 1,
    ref: {
      taskId,
      framework: "",
      rowId: "",
      turns: 0,
      totalTokens: 0,
      durationMs: null,
      label: taskId,
      startTime: null,
      endTime: null,
      cacheReadTokens: null,
    },
  }
}

// 泳道行显示对象与生产同构（processed 内预构，不在渲染期新建）
const subTurn = (turnIndex: number, sid: string) =>
  toLaneDisplayTurn(makeTurn(turnIndex, {
    isSubagent: true,
    subagentSessionId: sid,
    subagentName: "worker",
    contentSummary: "相当长的摘要内容用于验证窄列下的截断与换行行为不在横向溢出",
    toolCalls: [{ toolCallId: `tc-${turnIndex}`, toolName: "read", state: "completed", durationMs: 10 }],
  }))

const mkCtx = (blocksByTurnId: Map<string, SubagentLane[]> = new Map(), expanded = new Set<string>()) => ({
  subagentBlocksByTurnId: blocksByTurnId,
  expandedSubagents: expanded,
  onToggleBridge: () => {},
  selectedTurnId: null,
  onSelectTurn: () => {},
})

describe("会话块并行派发 lane 展示（chip 行 + 就地展开）", () => {
  const dispatchTurn = makeTurn(634, {
    totalTokens: 0,
    toolCalls: [
      { toolCallId: "tc-a", toolName: "task", state: "completed", durationMs: 5 },
      { toolCallId: "tc-b", toolName: "task", state: "completed", durationMs: 5 },
    ],
  })
  const turns = [
    dispatchTurn,
    subTurn(635, "ses_sub_a"),
    subTurn(636, "ses_sub_a"),
    subTurn(1078, "ses_sub_b"),
    subTurn(1079, "ses_sub_b"),
  ]
  const bridges = [
    makeBridge("br-a", "t-634", "ses_sub_a", "agent-one"),
    makeBridge("br-b", "t-634", "ses_sub_b", "agent-two"),
  ]

  it("桥在 → 派发轮下方渲染并行组（⇄ + 双 chip）；汇总轮数可见", () => {
    const html = renderToStaticMarkup(
      createElement(SessionBlock, {
        session: soloSession("ses-main"),
        state: { turns, total: turns.length, page: 1, loading: false },
        bridges,
        selectedTurnId: null,
        onSelectTurn: () => {},
        onLoadMore: () => {},
      })
    )
    expect(html).toContain("⇄")
    expect(html).toContain("并行子代理")
    expect(html).toContain("agent-one")
    expect(html).toContain("agent-two")
    // 不再并排 grid（grid-cols-2/3 属于被替换的旧布局）
    expect(html).not.toContain("grid-cols-2")
    expect(html).not.toContain("grid-cols-3")
    // chip 行可换行、组根可收缩（窄容器不撑破、不留白基线）
    expect(html).toContain("flex-wrap")
    expect(html).toContain("min-w-0")
  })

  it("失败派发不建桥 → 无泳道无 chip（toolCalls 计数不再虚标）", () => {
    const failedDispatch = makeTurn(800, {
      totalTokens: 0,
      toolCalls: [
        { toolCallId: "tc-f1", toolName: "spawn_agent", state: "completed", durationMs: 5 },
        { toolCallId: "tc-f2", toolName: "spawn_agent", state: "completed", durationMs: 5 },
      ],
    })
    const html = renderToStaticMarkup(
      createElement(SessionBlock, {
        session: soloSession("ses-main"),
        state: { turns: [failedDispatch], total: 1, page: 1, loading: false },
        bridges: [],
        selectedTurnId: null,
        onSelectTurn: () => {},
        onLoadMore: () => {},
      })
    )
    expect(html).not.toContain("⇄")
    expect(html).not.toContain("并行子代理")
  })

  it("ParallelSubagentGroup 直渲染：展开 lane 全宽就地（basis-full）+ turn 行完整", () => {
    const html = renderToStaticMarkup(
      createElement(ParallelSubagentGroup, {
        lanes: [
          {
            bridgeId: "br-a",
            sessionId: "ses_sub_a",
            name: "agent-one",
            type: "general",
            summary: "dispatch agent-one",
            turns: [{ ...subTurn(635, "ses_sub_a"), totalTokens: 12345 }, { ...subTurn(636, "ses_sub_a"), totalTokens: 0 }],
            status: "completed",
            totalTokens: 12345,
            latencyMs: 45000,
            turnCount: 2,
          },
          {
            bridgeId: "br-b",
            sessionId: "ses_sub_b",
            name: "agent-two",
            type: "general",
            summary: "dispatch agent-two",
            turns: [subTurn(1078, "ses_sub_b")],
            status: "error",
            totalTokens: 3000,
            latencyMs: 12000,
            turnCount: 1,
          },
        ],
        ctx: mkCtx(new Map(), new Set(["br-a"])),
      })
    )
    // 展开 lane 独占一行（就地全宽），未展开的保持 chip 折叠态
    expect(html).toContain("basis-full")
    // 展开区渲染 turn 行完整信息（#N / 工具计数 / token）——工具计数带
    // 扳手图标注记（旧「Nt」记法与泳道头「Nt=轮数」同形不同义，已退役）
    expect(html).toContain("#635")
    expect(html).toContain("1 个工具调用")
    expect(html).toContain("12.3k")
    // 错误态 chip 有 error 徽章
    expect(html).toContain("error")
  })

  it("SubagentLaneView 直渲染：轮次行完整（#N + 摘要 + 数值右对齐 tabular）", () => {
    const html = renderToStaticMarkup(
      createElement(SubagentLaneView, {
        lane: {
          bridgeId: "br-a",
          sessionId: "ses_sub_a",
          name: "agent-one",
          type: "general",
          summary: "dispatch agent-one",
          turns: [subTurn(635, "ses_sub_a"), subTurn(636, "ses_sub_a")],
          status: "completed",
          totalTokens: 12345,
          latencyMs: 45000,
          turnCount: 2,
        },
        ctx: mkCtx(new Map(), new Set(["br-a"])),
      })
    )
    expect(html).toContain("#635")
    expect(html).toContain("tabular-nums")
    expect(html).toContain("truncate")
  })

  it("嵌套子 lane 就地挂载：渲染在派发轮行后、父 lane 后续轮之前", () => {
    // 现场：designer lane 中段某轮派生的子 lane 若渲染在父 lane 全部轮次
    // 之后，会被读成「由父末轮启动」——子 lane 必须跟在派发轮行后
    const childLane = {
      bridgeId: "br-child",
      sessionId: "ses_child",
      name: "explore-child",
      type: "general",
      summary: "dispatch explore-child",
      turns: [subTurn(900, "ses_child")],
      status: "completed",
      totalTokens: 500,
      latencyMs: 8000,
      turnCount: 1,
    }
    const html = renderToStaticMarkup(
      createElement(SubagentLaneView, {
        lane: {
          bridgeId: "br-parent",
          sessionId: "ses_parent",
          name: "designer",
          type: "general",
          summary: "dispatch designer",
          turns: [subTurn(635, "ses_parent"), subTurn(636, "ses_parent"), subTurn(637, "ses_parent")],
          status: "completed",
          totalTokens: 12345,
          latencyMs: 45000,
          turnCount: 3,
        },
        ctx: mkCtx(new Map([["t-636", [childLane]]]), new Set(["br-parent"])),
      })
    )
    const i635 = html.indexOf("#635")
    const i636 = html.indexOf("#636")
    const i637 = html.indexOf("#637")
    const iChild = html.indexOf("explore-child")
    expect(i635).toBeGreaterThanOrEqual(0)
    expect(i637).toBeGreaterThan(i636)
    // 子 lane 在 #636（派发轮）之后、#637（父 lane 后续轮）之前
    expect(iChild).toBeGreaterThan(i636)
    expect(iChild).toBeLessThan(i637)
  })

  it("点击第一个 chip：详情紧跟其下（DOM 顺序先于后续 chip），其他 lane 仍折叠", async () => {
    // 现场场景三路并行（empty/group/base）：点第一个 chip，展开区必须在
    // 所属 chip 下方，而不是等在整个 chip 行末尾
    const mk = (idx: number, sid: string, mark: string) =>
      makeTurn(idx, {
        isSubagent: true,
        subagentSessionId: sid,
        subagentName: "worker",
        contentSummary: mark,
      })
    const turns3 = [
      makeTurn(100, {
        totalTokens: 0,
        toolCalls: [
          { toolCallId: "tc-a", toolName: "task", state: "completed", durationMs: 5 },
          { toolCallId: "tc-b", toolName: "task", state: "completed", durationMs: 5 },
          { toolCallId: "tc-c", toolName: "task", state: "completed", durationMs: 5 },
        ],
      }),
      mk(101, "ses_empty", "EMPTY-LANE-TURN"),
      mk(102, "ses_group", "GROUP-LANE-TURN"),
      mk(103, "ses_base", "BASE-LANE-TURN"),
    ]
    const bridges3 = [
      makeBridge("br-empty", "t-100", "ses_empty", "agent-empty"),
      makeBridge("br-group", "t-100", "ses_group", "agent-group"),
      makeBridge("br-base", "t-100", "ses_base", "agent-base"),
    ]

    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(createElement(SessionBlock, {
        session: soloSession("ses-main"),
        state: { turns: turns3, total: turns3.length, page: 1, loading: false },
        bridges: bridges3,
        selectedTurnId: null,
        onSelectTurn: () => {},
        onLoadMore: () => {},
      }))
    })

    const chipByName = (name: string) =>
      [...container.querySelectorAll("button")].find(b => b.textContent?.includes(name)) as HTMLElement
    // 折叠态：三个 chip 都在，无任何 lane 内容
    expect(chipByName("agent-empty")).toBeTruthy()
    expect(container.textContent).not.toContain("EMPTY-LANE-TURN")

    await act(async () => { chipByName("agent-empty").click() })

    // lane 内容出现，且 DOM 顺序先于后续两个 chip —— 详情在所属 chip 下方
    const laneRow = [...container.querySelectorAll("button")].find(b => b.textContent?.includes("EMPTY-LANE-TURN")) as HTMLElement
    expect(laneRow).toBeTruthy()
    expect(chipByName("agent-group").compareDocumentPosition(laneRow) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
    expect(chipByName("agent-base").compareDocumentPosition(laneRow) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
    // 其他 lane 未连带展开
    expect(container.textContent).not.toContain("GROUP-LANE-TURN")
    expect(container.textContent).not.toContain("BASE-LANE-TURN")

    root.unmount()
    container.remove()
  })
})

describe("轮次行输出构成摘要（无正文轮不退化，工具轮可见）", () => {
  const renderBlock = (turns: ReturnType<typeof makeTurn>[]) =>
    renderToStaticMarkup(
      createElement(SessionBlock, {
        session: soloSession("ses-main"),
        state: { turns, total: turns.length, page: 1, loading: false },
        bridges: [],
        selectedTurnId: null,
        onSelectTurn: () => {},
        onLoadMore: () => {},
      })
    )

  it("纯工具轮：去重工具名替位空摘要（不再渲染 — 占位），计数带扳手注记", () => {
    const toolOnly = makeTurn(700, {
      contentSummary: "",
      toolCalls: [
        { toolCallId: "tc-1", toolName: "Bash", state: "completed", durationMs: 10 },
        { toolCallId: "tc-2", toolName: "Bash", state: "completed", durationMs: 10 },
        { toolCallId: "tc-3", toolName: "Read", state: "completed", durationMs: 5 },
      ],
    })
    const html = renderBlock([toolOnly])
    expect(html).toContain("Bash · Read")
    expect(html).toContain("3 个工具调用")
    // 空占位 — 只属于真正无内容的轮
    expect(html).not.toContain(">—</span>")
  })

  it("思考 + 工具轮（存量 summary 带 thinking 前缀）：思考片段着思考色，工具计数可见", () => {
    const thinkingTools = makeTurn(701, {
      contentSummary: "<thinking>先分析目录结构再决定读取顺序</thinking>",
      toolCalls: [{ toolCallId: "tc-4", toolName: "read", state: "completed", durationMs: 5 }],
    })
    const html = renderBlock([thinkingTools])
    expect(html).toContain("先分析目录结构再决定读取顺序")
    expect(html).toContain("text-purple-700/90")
    expect(html).toContain("1 个工具调用")
  })

  it("正文 + 工具轮：正文优先（thinking 块剥除），工具计数可见", () => {
    const textTools = makeTurn(702, {
      contentSummary: "<thinking>内部推理</thinking>分析完成，开始写报告。",
      toolCalls: [{ toolCallId: "tc-5", toolName: "write", state: "completed", durationMs: 5 }],
    })
    const html = renderBlock([textTools])
    expect(html).toContain("分析完成，开始写报告。")
    expect(html).not.toContain("内部推理")
    expect(html).toContain("text-foreground/85")
    expect(html).toContain("1 个工具调用")
  })

  it("真正无内容无工具的轮保持 — 占位（空态语义不变）", () => {
    const empty = makeTurn(703, { contentSummary: "" })
    const html = renderBlock([empty])
    expect(html).toContain(">—</span>")
  })

  it("思考标签统一剥离：截断残留（summary 200 字符预算砍掉闭标签）也按思考内容呈现", () => {
    // 现场 d01dfbaa：纯思考轮 contentSummary 为 null → API 兜底取 content
    // 头 200 字符 → 未闭合 <thinking> 前缀。旧的完整块正则剥不掉，行内
    // 露出字面量标签；开标签起整体按思考内容读
    const truncated = makeTurn(704, {
      contentSummary: "<thinking>Let me understand the task. I need to chec",
    })
    const html = renderBlock([truncated])
    expect(html).toContain("Let me understand the task. I need to chec")
    expect(html).not.toContain("<thinking>")
    expect(html).toContain("text-purple-700/90")
  })

  it("用户轮正文的字面量 <thinking> 是数据不是标记（思考解析只对 assistant）", () => {
    const userTurn = makeTurn(705, {
      role: "user",
      contentSummary: "thinking怎么有的剥掉了<thinking>，有的没剥掉",
    })
    const html = renderBlock([userTurn])
    // 静态标记里字面量按文本转义呈现，且不染思考色
    expect(html).toContain("thinking怎么有的剥掉了&lt;thinking&gt;，有的没剥掉")
    expect(html).not.toContain("text-purple-700/90")
  })
})

describe("换选渲染预算（会话块 memo：无关会话零重渲）", () => {
  // 60 节点大 run 的换选/走查卡顿主源：一次全量重渲所有会话块的所有行。
  // memo bailout 在 DOM 输出上不可观测（这正是它难测的原因），锁两层：
  // ① 结构——SessionBlock 必须是 memo 组件（摘掉 memo 立即红）；
  // ② 语义——比较器只在选中轮「进出本会话」时判不等
  it("SessionBlock 是 memo 组件，比较器只对本会话相关的换选判不等", () => {
    expect((SessionBlock as unknown as { $$typeof?: symbol }).$$typeof).toBe(Symbol.for("react.memo"))

    const turnsA = [makeTurn(1, { contentSummary: "A-1" }), makeTurn(2, { contentSummary: "A-2" })]
    const sessionA = soloSession("ses-a")
    const stateA = { turns: turnsA, total: turnsA.length, page: 1, loading: false }
    const noBridges: TurnsBridge[] = []
    const handlers = { onSelectTurn: () => {}, onLoadMore: () => {} }
    const props = (selectedTurnId: string | null) => ({ session: sessionA, state: stateA, bridges: noBridges, selectedTurnId, ...handlers })

    // 选中轮与本会话无关（深链到别处/别处换选）：判等 → 整块跳过
    expect(sessionBlockPropsEqual(props(null), props("t-9"))).toBe(true)
    expect(sessionBlockPropsEqual(props("t-9"), props("t-8"))).toBe(true)
    // 选中轮进出本会话（高亮/泳道自动展开必须更新）：判不等
    expect(sessionBlockPropsEqual(props(null), props("t-1"))).toBe(false)
    expect(sessionBlockPropsEqual(props("t-1"), props("t-2"))).toBe(false)
    expect(sessionBlockPropsEqual(props("t-1"), props("t-9"))).toBe(false)
    // 数据/回调身份变化：判不等（内容更新必须渲染）
    expect(sessionBlockPropsEqual(
      { ...props(null), state: { ...stateA, loading: true } },
      props(null),
    )).toBe(false)
  })
})
