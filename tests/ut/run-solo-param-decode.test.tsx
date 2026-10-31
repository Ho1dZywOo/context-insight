// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// run-first 回归锁：Next 客户端导航时 use(params) 的动态段可能保持 URL 编码
// 形态（solo%3A…；SSR/直刷为解码形态）。旧 session 路由的 taskId（UUID）无需
// 编码从未暴露；run-first 后 runId 带 `:`，页面若不归一化会双重编码（%253A），
// API 解一层后收到 solo%3A… → isSoloRunId 判假 → 「Run not found」。锁两件事：
// ① normalizeRunIdParam 归一化幂等；② 页面以编码形态 params 渲染时取数 URL
// 恰好单层编码、不出现 Run not found 错误态。

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createElement } from 'react';
import { Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import RunDetailPage from '@/app/run/[runId]/page';
import { normalizeRunIdParam } from '@/lib/run/identity';

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, refresh: () => {} }),
  usePathname: () => '/run/solo%3Auw-ses-decode',
  useSearchParams: () => new URLSearchParams(''),
}))

const fetchCalls: string[] = []
vi.stubGlobal('fetch', (u: string) => {
  fetchCalls.push(u)
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({
      run: { runId: 'solo:uw-ses-decode', kind: 'solo', name: '解码会话', status: 'completed', exportDataComplete: true },
      viewModel: { views: [], nodes: [], rollbacks: [] },
    }),
  })
})

let root: Root | null = null

afterEach(() => {
  act(() => { root?.unmount() })
  root = null
  document.body.innerHTML = ''
  fetchCalls.length = 0
})

describe('run-first：动态段编码归一化（客户端导航 solo%3A → solo:）', () => {
  it('normalizeRunIdParam：编码形态解码、明文形态幂等、畸形态原样', () => {
    expect(normalizeRunIdParam('solo%3Auw-ses-decode')).toBe('solo:uw-ses-decode');
    expect(normalizeRunIdParam('solo:uw-ses-decode')).toBe('solo:uw-ses-decode');
    expect(normalizeRunIdParam('minidemo01')).toBe('minidemo01');
    expect(normalizeRunIdParam('bad%')).toBe('bad%');
  });

  it('页面以编码形态 params 渲染：取数 URL 恰好单层编码，不出现 Run not found', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        createElement(
          Suspense,
          { fallback: null },
          createElement(RunDetailPage, { params: Promise.resolve({ runId: 'solo%3Auw-ses-decode' }) }),
        ),
      )
    })
    await act(async () => {
      await new Promise(r => setTimeout(r, 0))
    })

    // 修复前：runId 保持 solo%3A… 再被 encodeURIComponent → %253A（双重编码）
    expect(fetchCalls).toContain('/api/observe/run/solo%3Auw-ses-decode')
    expect(fetchCalls.some(u => u.includes('%253A'))).toBe(false)
    expect(document.body.textContent ?? '').not.toContain('Run not found')
  });
});
