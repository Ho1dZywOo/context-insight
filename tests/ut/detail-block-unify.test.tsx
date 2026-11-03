// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License).
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// Turn 详情页统一文本块语法的契约锁：正文 / thinking / 工具调用（含
// skill 派发）/ 输入消息共用同一容器（detail-blocks：圆角灰底块、块内
// 发丝分节、状态与类型只用字色）。此前四种语法并存——正文裸文本、
// thinking 紫色左线引用、工具调用描边盒 + 灰 pre、skill 黄色左边框——
// 同屏不同口径。语法源头单点在 detail-blocks.ts，改样式只改一处。
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import { LlmOutputView } from '@/components/observe/LlmOutputView'
import { ToolCallList } from '@/components/observe/ToolCallList'
import { TurnInputCard } from '@/components/observe/TurnInputCard'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const OUTPUT_PROPS = {
  content: '<thinking>思考过程内容</thinking>正文内容',
  contentJson: null,
  outputTokens: 10,
  reasoningTokens: 5,
  role: 'assistant',
}

describe('Turn 详情页统一文本块', () => {
  it('LlmOutputView：thinking 与正文同容器（灰底圆角块），thinking 只以字色区分', () => {
    const html = renderToStaticMarkup(createElement(LlmOutputView, OUTPUT_PROPS))
    // 两块同容器语法（thinking + text）
    expect((html.match(/rounded-xl bg-muted\/60/g) ?? []).length).toBe(2)
    // 旧紫色左线引用形态退役
    expect(html).not.toContain('border-l-2')
    // thinking 只以字色区分（紫色标签）
    expect(html).toContain('text-purple-600 dark:text-purple-400')
  })

  it('copy 下沉到文本块：段头整段 copy 退役，thinking 块与文本块各一枚', () => {
    const html = renderToStaticMarkup(createElement(LlmOutputView, OUTPUT_PROPS))
    // 两块各一枚块级 copy（thinking 行内 + 文本块 hover 角标），无第三枚
    expect((html.match(/title="Copy"/g) ?? []).length).toBe(2)
    // 文本块 copy 是 hover 显形角标（不在段头）
    expect(html).toContain('group/copy')
    expect(html).toContain('group-hover/copy:opacity-100')
  })

  it('ToolCallList：skill 与普通调用同容器同结构；状态 = 字色，Args/Result 走发丝分节', () => {
    // highlight 命中 args → 渲染期自动展开（与 trace 跳转同一机制），
    // 静态标记里可见 Args/Result 分节
    const html = renderToStaticMarkup(createElement(ToolCallList, {
      toolCalls: [
        { id: 'a', toolCallId: 'a', toolName: 'Bash', argsJson: '{"cmd":"ls"}', resultJson: 'ok', state: 'ok', errorType: null, errorMessage: null, durationMs: 5, isSkillRelated: false },
        { id: 'b', toolCallId: 'b', toolName: 'task', argsJson: null, resultJson: null, state: 'ok', errorType: null, errorMessage: null, durationMs: 0, isSkillRelated: true },
      ],
      highlight: { keyword: 'ls', matchField: 'toolArgs' },
    } as never))
    // skill 与普通调用同容器（两行两块）
    expect((html.match(/rounded-xl bg-muted\/60/g) ?? []).length).toBe(2)
    // 旧形态退役：黄色左边框 / 描边盒 / Badge 药丸底色
    expect(html).not.toContain('border-l-3')
    expect(html).not.toContain('bg-yellow-50/20')
    expect(html).not.toContain('bg-emerald-50/30')
    // 状态 = 字色
    expect(html).toContain('text-emerald-600 dark:text-emerald-400')
    // skill 前缀 = ⚡ 图标（amber 字色）
    expect(html).toContain('text-amber-500')
    // Args/Result 分节 = 发丝线（不再是灰底 pre 盒）
    expect(html).toContain('>Args</span>')
    expect(html).toContain('border-t border-foreground/[0.06]')
    expect(html).not.toContain('bg-muted/30')
  })

  it('TurnInputCard：默认折叠一行收纳；展开后消息行同容器，块内分节发丝线（不再是 bg-muted 条带/橙色派发盒）', async () => {
    // 输入默认折叠（与输出默认展开成对）：静态输出只有三段收纳行头，
    // 消息行要展开①「本轮新增」后才可见
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(createElement(TurnInputCard, {
        inputMessagesJson: JSON.stringify([
          { role: 'user', content: '历史消息' },
          { role: 'user', content: '问题内容' },
        ]),
        inputMessagesCount: 2,
        inputMessagesTokens: 20,
        prevInputMessagesCount: 1,
      } as never))
    })
    // 默认折叠：消息行未出现
    expect(container.textContent).not.toContain('问题内容')
    const newSectionRow = [...container.querySelectorAll('[role="button"]')]
      .find(el => el.textContent?.includes('本轮新增')) as HTMLElement
    await act(async () => { newSectionRow.click() })
    expect(container.textContent).toContain('问题内容')
    // 展开后：统一块语法
    const html = container.innerHTML
    expect(html).toContain('rounded-xl bg-muted/60')
    expect(html).toContain('border-t border-foreground/[0.06]')
    // 旧形态退役：消息条带底色 / 橙色派发盒
    expect(html).not.toContain('bg-muted/30')
    expect(html).not.toContain('bg-orange-50/30')
    root.unmount()
    container.remove()
  })
})
