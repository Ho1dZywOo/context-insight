// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License).
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// thinking 吃掉 200 字符摘要预算（客户现场：turn 143 折叠预览全是
// <thinking> 开头，被误读为 output 未展示；正文实际在下方 text 块完整
// 可见）。两层修复的 IT：
//   ① 显示层——LlmOutputView 正文常驻完整渲染、thinking 独立折叠块
//      默认随开（输出即第一阅读主体，与 LLM Input 默认折叠成对）
//   ② ingest 层——splitIntoTurns 的 contentSummary 剥 <thinking>/<system-reminder>
//      后再截 200；content 全文保真不截
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { LlmOutputView } from '@/components/observe/LlmOutputView'
import { splitIntoTurns } from '@/lib/ingest/turn-split'
import type { RawInteraction } from '@/lib/shared/types'

// 现场 turn 143 原样（ses_f986a318…，854 字符 = thinking + 完整报告正文）
const TURN143_CONTENT = `<thinking>The report has been written. Give the final reply: report path + status + summary of the issue list.</thinking>

**报告路径**: \`/workspace/reduction/fusion_paradigm_xsx/plugins-official/ops-registry-invoke-IR/op-design-with-ir-flow/output/bn3d_training_update_grad/reviews/P1/requirements_review.md\`

**状态**: ✅通过

**问题清单摘要**：
- **MED-1 ⚠**（不阻塞）：行号虚指——属出处虚指而非结论无据，建议返工时改为如实表述。
- **LOW-1 已订正**（订正单范围）：ops_legacy 编译产物清单错误 → 已就地改为实测清单。

抽样复现 7 组均复现；核心结论独立证实成立。`

describe('① LlmOutputView：thinking 默认展开（输出是第一阅读主体），正文常驻完整渲染', () => {
  it('thinking 默认展开（头行常驻 token 计数），正文完整渲染（存量数据立即生效）', () => {
    const html = renderToStaticMarkup(createElement(LlmOutputView, {
      content: TURN143_CONTENT,
      contentJson: null,
      outputTokens: 340,
      reasoningTokens: 22,
      role: 'assistant',
    }))
    // 输出默认展开：thinking 正文随开，与 LLM Input 默认折叠成对
    expect(html).toContain('The report has been written')
    // thinking 头行常驻 token 计数（reasoning 构成可见）
    expect(html).toContain('22t')
    // 正文 text 块完整渲染
    expect(html).toContain('核心结论独立证实成立')
    // thinking 标签本身不进渲染（剥层后只留内容）
    expect(html).not.toContain('<thinking>')
  })

  it('无 thinking 的普通 turn 正文渲染不变（等价旧 fallback）', () => {
    const html = renderToStaticMarkup(createElement(LlmOutputView, {
      content: 'plain reply body',
      contentJson: null,
      outputTokens: 10,
      role: 'assistant',
    }))
    expect(html).toContain('plain reply body')
  })

  it('user turn 的 <system-reminder> 随正文全文保真渲染（wire 保真）', () => {
    // review 回归锁：wire 保真——reminder 与正文都在渲染面，不被静默剥离
    const html = renderToStaticMarkup(createElement(LlmOutputView, {
      content: '<system-reminder>internal noise</system-reminder>真实提示内容',
      contentJson: null,
      outputTokens: 0,
      role: 'user',
    }))
    expect(html).toContain('internal noise')
    expect(html).toContain('真实提示内容')
  })

  it('stopReason=length 的空输出轮渲染截断解释而非整块消失（现场 #1975）', () => {
    // 现场 vbYQjB 最后一轮：content=[]、32000 output token 全部消耗、
    // stopReason=length——修复前整块 return null，用户只看到"突然结束"
    const html = renderToStaticMarkup(createElement(LlmOutputView, {
      content: null,
      contentJson: null,
      outputTokens: 32000,
      reasoningTokens: 0,
      role: 'assistant',
      finishReason: 'length',
    }))
    expect(html).toContain('max_tokens 截断')
    expect(html).toContain('32.0kt 输出已消耗')
  })

  it('正常 end_turn 空轮不误标截断', () => {
    const html = renderToStaticMarkup(createElement(LlmOutputView, {
      content: null,
      contentJson: null,
      outputTokens: 0,
      role: 'assistant',
      finishReason: 'end_turn',
    }))
    expect(html).toBe('')
  })

  it('length 截断但有部分文本的轮：挂徽标、不弹空输出解释（正文可见）', () => {
    const html = renderToStaticMarkup(createElement(LlmOutputView, {
      content: '半截的回答文本，尚未写完就被',
      contentJson: null,
      outputTokens: 32000,
      role: 'assistant',
      finishReason: 'length',
    }))
    expect(html).toContain('max_tokens 截断')
    expect(html).toContain('半截的回答文本')
    expect(html).not.toContain('输出已消耗')
  })

  it('content_filter：审查截断空轮显示专属徽标与解释', () => {
    const html = renderToStaticMarkup(createElement(LlmOutputView, {
      content: null,
      contentJson: null,
      outputTokens: 800,
      role: 'assistant',
      finishReason: 'content_filter',
    }))
    expect(html).toContain('内容过滤截断')
    expect(html).toContain('内容审查策略截断')
  })

  it('refusal：拒答空轮显示专属徽标与解释', () => {
    const html = renderToStaticMarkup(createElement(LlmOutputView, {
      content: null,
      contentJson: null,
      outputTokens: 0,
      role: 'assistant',
      finishReason: 'refusal',
    }))
    expect(html).toContain('模型拒答')
    expect(html).toContain('拒绝了本次请求')
  })

  it('正常 finish 不挂异常徽标（中性 finish 不进详情段头）', () => {
    for (const fr of ['tool_calls', 'end_turn', 'stop_sequence', 'stop']) {
      const html = renderToStaticMarkup(createElement(LlmOutputView, {
        content: '正常回复',
        contentJson: null,
        outputTokens: 100,
        role: 'assistant',
        finishReason: fr,
      }))
      expect(html).toContain('正常回复')
      expect(html).not.toContain('⛔')
      expect(html).not.toContain('finish:')
    }
  })
})

describe('② splitIntoTurns：contentSummary 剥 thinking/reminder，content 全文保真', () => {
  it('assistant 摘要以正文开头，thinking 只留在 content', () => {
    const interactions: RawInteraction[] = [{
      role: 'assistant',
      content: TURN143_CONTENT,
      timestamp: new Date('2026-09-15T10:00:00Z').getTime(),
      usage: { input: 10, output: 340, reasoning: 22, total: 372 },
    } as unknown as RawInteraction]
    const { turns } = splitIntoTurns(interactions, 'test-session')
    const t = turns[0]
    expect(t.content).toBe(TURN143_CONTENT)
    expect(t.contentSummary).toBeTruthy()
    expect(t.contentSummary).not.toContain('<thinking>')
    expect(t.contentSummary).not.toContain('The report has been written')
    expect(t.contentSummary!.startsWith('**报告路径**')).toBe(true)
  })

  it('user turn 的 <system-reminder> 前缀剥除行为保留', () => {
    const interactions: RawInteraction[] = [{
      role: 'user',
      content: '<system-reminder>internal noise</system-reminder>真实提问内容',
      timestamp: new Date('2026-09-15T10:00:00Z').getTime(),
    } as unknown as RawInteraction]
    const { turns } = splitIntoTurns(interactions, 'test-session')
    expect(turns[0].content).toContain('<system-reminder>')
    expect(turns[0].contentSummary).toBe('真实提问内容')
  })
})

// 纯工具调用轮的输出块（现场：agent 轮只有 tool calls、无正文/思考——
// 旧渲染整块 return null，「LLM Output」字样消失，被读成"这轮没输出"）。
// 输出构成应是稳定概念：正文/思考/工具调用都是输出的形态，标签常驻。
describe('③ LlmOutputView：纯工具轮标签常驻 + 构成注记', () => {
  it('无正文无思考但有工具调用 → LLM Output 标签在，注记指明输出构成', () => {
    const html = renderToStaticMarkup(createElement(LlmOutputView, {
      content: null,
      contentJson: null,
      outputTokens: 780,
      role: 'assistant',
      toolCallCount: 2,
    }))
    expect(html).toContain('LLM Output')
    expect(html).toContain('输出为下方 2 个工具调用')
  })

  it('完全无输出（无正文/思考/工具/异常）→ 整块不渲染（null 语义保持）', () => {
    const html = renderToStaticMarkup(createElement(LlmOutputView, {
      content: null,
      contentJson: null,
      outputTokens: 0,
      role: 'assistant',
    }))
    expect(html).toBe('')
  })

  it('有正文的轮不出现构成注记（注记只属于纯工具轮）', () => {
    const html = renderToStaticMarkup(createElement(LlmOutputView, {
      content: '正文回复',
      contentJson: null,
      outputTokens: 10,
      role: 'assistant',
      toolCallCount: 1,
    }))
    expect(html).toContain('LLM Output')
    expect(html).toContain('正文回复')
    expect(html).not.toContain('个工具调用')
  })
})
