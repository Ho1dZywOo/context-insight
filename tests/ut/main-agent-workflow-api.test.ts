// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This file is licensed under the CANN Open Software License Agreement Version 2.0.
// You may not use this file except in compliance with the License.
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { describe, it, expect, vi, beforeEach } from "vitest"

const fakePrisma = {
  session: { findFirst: vi.fn() },
  skillEvent: { findFirst: vi.fn() },
  toolCall: { findMany: vi.fn() },
  turn: { findFirst: vi.fn() },
}
vi.mock("@/lib/db", () => ({ prisma: fakePrisma }))

// 探测面走 LLM 提取模块的廉价探测（候选收集非空）；候选收集本身由
// llm-workflow-extract.test.ts 覆盖，此处桩注入只测 handler 的编排语义。
const { hasCandidatesMock } = vi.hoisted(() => ({ hasCandidatesMock: vi.fn() }))
vi.mock("@/lib/llm-workflow-extract", () => ({ hasWorkflowExtractCandidates: hasCandidatesMock }))

const { GET } = await import("@/lib/observe/session-handlers/main-agent-workflow")

function makeRequest(qs: string): Request {
  return new Request(`http://localhost/api/observe/session/main-agent-workflow?${qs}`)
}

describe("main-agent-workflow route（root 对账可用性探测 = 候选探测）", () => {
  beforeEach(() => {
    fakePrisma.session.findFirst.mockReset()
    fakePrisma.skillEvent.findFirst.mockReset()
    hasCandidatesMock.mockReset()
    fakePrisma.session.findFirst.mockResolvedValue({ id: "ses_cuid_1" })
  })

  it("缺 taskId → 400", async () => {
    const res = await GET(makeRequest(""))
    expect(res.status).toBe(400)
  })

  it("session 不存在 → 404", async () => {
    fakePrisma.session.findFirst.mockResolvedValue(null)
    const res = await GET(makeRequest("taskId=ses_1"))
    expect(res.status).toBe(404)
  })

  it("有候选 + 主 agent Skill invoke → available + 真名；source 恒 null（声明在对账时 LLM 选择后才可知）", async () => {
    hasCandidatesMock.mockResolvedValue(true)
    fakePrisma.skillEvent.findFirst.mockResolvedValue({ skillName: "ops-registry-invoke-workflow" })
    const res = await GET(makeRequest("taskId=ses_1"))
    expect(res.status).toBe(200)
    const d = await res.json()
    expect(d.available).toBe(true)
    expect(d.name).toBe("ops-registry-invoke-workflow")
    expect(d.source).toBeNull()
  })

  it("有候选 + 无 invoke → available + 回退合成名", async () => {
    hasCandidatesMock.mockResolvedValue(true)
    fakePrisma.skillEvent.findFirst.mockResolvedValue(null)
    const res = await GET(makeRequest("taskId=ses_1"))
    expect(res.status).toBe(200)
    const d = await res.json()
    expect(d.available).toBe(true)
    expect(d.name).toBe("主 agent 编排")
    expect(d.source).toBeNull()
  })

  it("无候选（规程/计划皆空）→ available=false", async () => {
    hasCandidatesMock.mockResolvedValue(false)
    const res = await GET(makeRequest("taskId=ses_1"))
    expect(res.status).toBe(200)
    const d = await res.json()
    expect(d.available).toBe(false)
    expect(d.name).toBeNull()
    expect(d.source).toBeNull()
  })
})
