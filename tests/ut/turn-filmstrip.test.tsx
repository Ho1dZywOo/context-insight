// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License).
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// Turn 播放器胶片轨（详情页顶部时间线）重设计的契约锁：
//   ① 少轮收窄居中——行宽上限 = 柱数 × 单柱宽（纯数学，SSR 即正确），
//      柱不再 flex 拉伸成宽胖块；多轮/桶化时上限大于容器自然满宽
//   ② 柱即指示——当前轮柱全亮、其余压暗悬停提亮，灰色播放头（旧位置
//      指示竖线）退役，不再有独立于柱的选中标记
//   ③ 刻度尺退役——位置由导航标题 n/total 与当前柱高亮承担（少轮时旧
//      刻度还会输出重复标签）
//   ④ 既有能力不回退——危险色覆盖（窗口>80% 红 / 慢轮琥珀）与超容量
//      聚桶（点击跳桶首轮）保留
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { TurnFilmstrip, type FilmstripTurn } from '@/components/observe/TurnFilmstrip'

const mk = (i: number, over: Partial<FilmstripTurn> = {}): FilmstripTurn => ({
  turnId: `t${i}`,
  turnIndex: i,
  role: i % 2 === 0 ? 'user' : 'assistant',
  isSubagent: false,
  totalTokens: 100 * (i + 1),
  latencyMs: 500,
  ...over,
})

const render = (turns: FilmstripTurn[], selectedTurnId: string) =>
  renderToStaticMarkup(createElement(TurnFilmstrip, { turns, selectedTurnId, onSelect: () => {} }))

describe('Turn 胶片轨（详情页顶部时间线）', () => {
  it('少轮收窄居中：行宽上限 = 柱数 × 15px；当前柱全亮、其余压暗悬停提亮，播放头退役', () => {
    const html = render([mk(0), mk(1), mk(2)], 't1')
    // 3 柱 × (14+1)px − 1px = 44px：纯数学上限，不依赖容器量测
    expect(html).toContain('max-width:44px')
    expect(html).toContain('mx-auto')
    // 当前柱全亮（唯一位置指示），其余压暗、悬停才提亮
    expect((html.match(/opacity-100/g) ?? []).length).toBe(1)
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('opacity-35 hover:opacity-80')
    // 灰色播放头（旧位置指示竖线）与刻度尺均退役
    expect(html).not.toContain('filmstrip-playhead')
    expect(html).not.toContain('font-mono')
    // 单轮时间线更纤细（h-9）
    expect(html).toContain('h-9')
  })

  it('危险色保留：窗口>80% 红、慢轮琥珀，覆盖角色色', () => {
    const html = render(
      [mk(0, { contextWindowPct: 90 }), mk(1, { latencyMs: 20000 }), mk(3)],
      't0',
    )
    expect(html).toContain('bg-red-500')
    expect(html).toContain('bg-amber-500')
    // 常规轮仍走角色色（assistant 绿）
    expect(html).toContain('bg-emerald-500')
  })

  it('超容量聚桶保留：300 轮 → 150 桶柱，高亮落在选中 turn 所属桶柱', () => {
    const turns = Array.from({ length: 300 }, (_, i) => mk(i))
    const html = render(turns, 't150')
    // happy-dom 无量测 → 保守容量 240 → bucketSize=2 → 150 根桶柱
    expect((html.match(/data-testid="filmstrip-turn-/g) ?? []).length).toBe(150)
    // idx 150 属第 75 桶（桶首 idx 150）：整桶柱全亮，其余压暗
    expect((html.match(/opacity-100/g) ?? []).length).toBe(1)
    expect(html).toContain('data-testid="filmstrip-turn-150"')
    // 桶标题标注合并范围与峰值
    expect(html).toContain('turns 合并')
  })
})
