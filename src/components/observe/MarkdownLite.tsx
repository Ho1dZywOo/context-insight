"use client"
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 极简 markdown 渲染（LLM Output 正文用）：覆盖 agent 输出的高频子集——
// 围栏代码块 / 标题 / 无序有序列表（含任务项）/ 引用 / 分割线 / 段落 +
// 行内 code / 粗体 / 斜体 / 链接。全部构建 React 节点，零 HTML 注入面
//（不用 dangerouslySetInnerHTML，链接仅放行 http(s)）。表格等少数结构
// 退化为段落文本（可读性可接受），不引第三方 md 库（与「图表纯 SVG、
// 无重依赖」的仓内约定一致）。
import { type ReactNode, memo } from "react"

type Block =
  | { kind: "code"; lang: string; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "hr" }
  | { kind: "para"; lines: string[] }

export function parseMarkdownBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const blocks: Block[] = []
  let para: string[] = []

  const flushPara = (): void => {
    if (para.length > 0) {
      blocks.push({ kind: "para", lines: para })
      para = []
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    const fence = line.match(/^```(\S*)\s*$/)
    if (fence) {
      flushPara()
      const codeLines: string[] = []
      i++
      for (; i < lines.length; i++) {
        if (/^```\s*$/.test(lines[i])) break
        codeLines.push(lines[i])
      }
      blocks.push({ kind: "code", lang: fence[1] ?? "", text: codeLines.join("\n") })
      continue
    }

    if (!line.trim()) {
      flushPara()
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      flushPara()
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] })
      continue
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara()
      blocks.push({ kind: "hr" })
      continue
    }

    if (line.trimStart().startsWith(">")) {
      flushPara()
      const quoteLines: string[] = []
      for (; i < lines.length; i++) {
        const q = lines[i].match(/^\s*>\s?(.*)$/)
        if (!q) break
        quoteLines.push(q[1])
      }
      i--
      blocks.push({ kind: "quote", lines: quoteLines })
      continue
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/)
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/)
    if (bullet || ordered) {
      flushPara()
      const isOrdered = !!ordered && !bullet
      const itemRe = isOrdered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/
      const items: string[] = []
      for (; i < lines.length; i++) {
        const m = lines[i].match(itemRe)
        if (!m) {
          // 缩进续行并入上一项（多行列表项）
          if (items.length > 0 && /^\s+\S/.test(lines[i])) {
            items[items.length - 1] += ` ${lines[i].trim()}`
            continue
          }
          break
        }
        items.push(m[1])
      }
      i--
      blocks.push({ kind: "list", ordered: isOrdered, items })
      continue
    }

    para.push(line)
  }
  flushPara()
  return blocks
}

// 行内元素：`code` / **bold** / *italic* / [text](http(s) url)。
// 其余原样文本节点——React 文本节点天然转义，无注入面。
const INLINE_RE = /(`[^`]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g

export function renderInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let last = 0
  let key = 0
  for (const m of text.matchAll(INLINE_RE)) {
    const idx = m.index ?? 0
    if (idx > last) nodes.push(text.slice(last, idx))
    const tok = m[0]
    if (tok.startsWith("`")) {
      nodes.push(<code key={key++} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{tok.slice(1, -1)}</code>)
    } else if (tok.startsWith("**")) {
      nodes.push(<strong key={key++} className="font-semibold">{tok.slice(2, -2)}</strong>)
    } else if (tok.startsWith("*")) {
      nodes.push(<em key={key++}>{tok.slice(1, -1)}</em>)
    } else {
      const link = tok.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/)
      if (link) {
        nodes.push(<a key={key++} href={link[2]} target="_blank" rel="noopener noreferrer" className="text-blue-600 dark:text-blue-400 underline underline-offset-2">{link[1]}</a>)
      } else {
        nodes.push(tok)
      }
    }
    last = idx + tok.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

function renderLines(lines: string[]): ReactNode[] {
  return lines.map((l, i) => (
    <span key={i}>
      {i > 0 && <br />}
      {renderInlineMarkdown(l)}
    </span>
  ))
}

function renderListItem(item: string, key: number): ReactNode {
  const task = item.match(/^\[([ xX])\]\s+(.*)$/)
  if (task) {
    return (
      <li key={key} className="list-none -ml-5 flex gap-1.5">
        <span className="select-none text-muted-foreground">{task[1].trim() ? "☑" : "☐"}</span>
        <span>{renderInlineMarkdown(task[2])}</span>
      </li>
    )
  }
  return <li key={key}>{renderInlineMarkdown(item)}</li>
}

// memo：走查高频路径上（缓存命中 + 后台 revalidate 双渲染）text 不变则
// 整棵 markdown 树跳过重解析重构建——长输出重解析是切换卡顿的可观来源
export const MarkdownLite = memo(function MarkdownLite({ text }: { text: string }) {
  const blocks = parseMarkdownBlocks(text)
  return (
    <div className="text-sm space-y-2.5 break-words">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "code":
            return (
              <pre key={i} className="rounded-md border bg-muted/60 dark:bg-muted/30 p-2.5 overflow-x-auto font-mono text-[13px] leading-relaxed">
                {b.lang && <div className="text-[11px] text-muted-foreground mb-1.5 select-none">{b.lang}</div>}
                <code>{b.text}</code>
              </pre>
            )
          case "heading": {
            const cls = b.level <= 2
              ? "text-base font-semibold pt-1"
              : b.level === 3
                ? "text-sm font-semibold pt-0.5"
                : "text-sm font-medium"
            return <div key={i} className={cls}>{renderInlineMarkdown(b.text)}</div>
          }
          case "list":
            return b.ordered ? (
              <ol key={i} className="list-decimal pl-5 space-y-1">{b.items.map((it, j) => <li key={j}>{renderInlineMarkdown(it)}</li>)}</ol>
            ) : (
              <ul key={i} className="list-disc pl-5 space-y-1">{b.items.map(renderListItem)}</ul>
            )
          case "quote":
            return <blockquote key={i} className="border-l-2 border-muted-foreground/40 pl-3 text-muted-foreground space-y-1">{b.lines.map((l, j) => <div key={j}>{renderInlineMarkdown(l)}</div>)}</blockquote>
          case "hr":
            return <hr key={i} className="border-t" />
          default:
            return <p key={i} className="whitespace-pre-wrap leading-relaxed">{renderLines(b.lines)}</p>
        }
      })}
    </div>
  )
})
