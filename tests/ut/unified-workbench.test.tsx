// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// 统一工作台 run 行 IT（design: docs/design/unified-workbench/design.md §3）：
// /runs 页退役后，run 以行形态混入统一表（store → list-service → page →
// AssetList）。锁：run 行渲染（徽标/详情链接/Σtokens 通路的形状）、header
// 双导入入口（刀2 合一前的过渡态）、行内 bundle 上传流（导入后上传，与会话
// 同款）、删除 run 的级联确认文案。

import { describe, it, expect, afterEach, afterAll, beforeAll, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Home from '@/app/page';
import { AssetList } from '@/components/collection/AssetList';
import { UploadHudHost, dismissAllUploadHuds } from '@/components/collection/UploadResultHud';
import { parseAndIndex } from '@/lib/run/reader';
import { saveRun, type RunImportMeta } from '@/lib/run/run-store';
import { sessionDurationMs } from '@/lib/session-duration';
import { prisma } from '@/lib/db';

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(''),
}))

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-unified-workbench-'));
const ORIG_HOME = process.env.CONTEXT_INSIGHT_HOME;

// 成员 sid 文件级前缀：共享 test.db 下与 collection-list（种 ses_mini_*）并行
// 互不串扰——join 与隔离闸都按 taskId 精确命中，前缀即隔离
const MEMBER_SIDS = ['uw-ses-mini-a', 'uw-ses-mini-b', 'uw-ses-mini-c'];

beforeAll(async () => {
  process.env.CONTEXT_INSIGHT_HOME = tmpHome;
  const rewrite = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(/^ses_mini_/, 'uw-ses-mini-');
    if (Array.isArray(v)) return v.map(rewrite);
    if (v != null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, rewrite(val)]));
    }
    return v;
  };
  const manifest = parseAndIndex(
    rewrite(JSON.parse(fs.readFileSync(path.resolve(__dirname, './data/run/mini-bundle/workflow.json'), 'utf-8'))) as Parameters<typeof parseAndIndex>[0],
  ).manifest;
  const meta: RunImportMeta = {
    schema: 'insight-run-import',
    version: 1,
    data: {
      importedAt: '2026-10-15T10:00:00+08:00',
      sourceDir: '/bundle/mini',
      manifestFile: 'workflow.json',
      exportDataComplete: true,
      sessions: { total: 3, imported: 3, existing: 0, missingFile: 0, failed: 0 },
      failures: [],
      warnings: [],
      // 隔离闸：声明 owned 对，成员行不进独立会话域（否则双重计数）
      ownedSessions: MEMBER_SIDS.map(sid => ({ sid, framework: 'opencode' })),
    },
  };
  saveRun(manifest, meta);
  // 成员会话入库（run 行 Σ 指标 + 汇总卡的数据源）：大数值 tokens/cost 使其
  // 主导卡片期望值；原生 framework（无 -proxy 后缀）命中 joinSessionRefs 消歧
  await prisma.session.deleteMany({ where: { taskId: { in: MEMBER_SIDS } } });
  await prisma.session.createMany({
    data: [
      { taskId: MEMBER_SIDS[0]!, framework: 'opencode', model: 'volc-gateway/glm-4.7', totalTokens: 250_000_000, totalCost: 1.25, startTime: new Date('2026-10-14T09:00:00Z'), endTime: new Date('2026-10-14T09:05:00Z') },
      { taskId: MEMBER_SIDS[1]!, framework: 'opencode', model: 'volc-gateway/glm-4.7', totalTokens: 249_800_000, totalCost: 1.10, startTime: new Date('2026-10-14T10:00:00Z'), endTime: new Date('2026-10-14T10:04:00Z') },
      { taskId: MEMBER_SIDS[2]!, framework: 'opencode', model: 'deepseek/glm-5.3', totalTokens: 100_000, totalCost: 0.05, startTime: new Date('2026-10-14T11:00:00Z'), endTime: new Date('2026-10-14T11:01:00Z') },
    ],
  });
  // Errors 卡：成员 a 一条失败工具调用（经 Turn 挂到成员行——run 行在首页时
  // 其成员错误计入页级 Errors）
  const a = await prisma.session.findFirst({ where: { taskId: MEMBER_SIDS[0] }, select: { id: true } });
  const turn = await prisma.turn.create({ data: { sessionId: a!.id, turnIndex: 0, role: 'assistant' } });
  await prisma.toolCall.create({ data: { turnId: turn.id, toolCallId: 'uw-tc-1', toolName: 'Bash', state: 'error' } });
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
  // 上传结果 HUD 模块态清空（宿主随测试树卸载，残留通知不渗入后续用例）
  act(() => { dismissAllUploadHuds() })
})

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  if (ORIG_HOME === undefined) delete process.env.CONTEXT_INSIGHT_HOME;
  else process.env.CONTEXT_INSIGHT_HOME = ORIG_HOME;
})

let root: Root | null = null

const click = (el: Element): void => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

const settle = async (): Promise<void> => {
  await act(async () => { await new Promise(r => setTimeout(r, 20)) })
}

async function renderHome(): Promise<void> {
  const tree = await Home({ searchParams: Promise.resolve({}) })
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // 上传结果 HUD 宿主随树挂载（生产由 app layout 常驻提供，此处对齐）
  await act(async () => { root!.render(createElement('div', null, tree, createElement(UploadHudHost))) })
  await settle()
}

describe('统一工作台：run 行混入单表（store → list-service → page → AssetList）', () => {
  it('已导入 run 渲染为行：Run 徽标 + 详情链接 + 规模副行；指标卡首卡并列 Run 计数', async () => {
    await renderHome()

    expect(document.body.textContent).toContain('mini-bundle')
    expect(document.body.textContent).not.toContain('暂无导入的 Run')
    // run 行详情链接 → /run/<runId>（详情路由不动）
    const runLink = document.querySelector('a[href="/run/minidemo01"]') as HTMLAnchorElement | null
    expect(runLink).not.toBeNull()
    // 类型徽标 + 状态徽标（mini-bundle 视图模型汇总口径 = failed）
    expect(document.body.textContent).toContain('Run')
    expect(document.body.textContent).toContain('failed')
    // 规模副行（节点/会话成员）
    expect(document.body.textContent).toContain('节点')
    // 指标卡首卡：Sessions N + Run 1 并列
    expect(document.body.textContent).toContain('+ 1')
  })

  it('run 行 Σ成员会话指标渲染：Model 分布 / Start→End 兜底 / ΣTokens / ΣCost（memberStats → AssetList）', async () => {
    // 组件层：真 DB 全链路（join → aggregateMemberStats）由 collection-list IT
    // 锁形状；本用例锁渲染口径。manifest 起止缺失 → Start→End 走成员会话
    // 聚合兜底；多模型显示主模型 +N
    const runItem = {
      kind: 'run' as const,
      key: 'run:minidemo01',
      runId: 'minidemo01',
      name: 'mini-bundle',
      status: 'passed',
      exportDataComplete: true,
      startedAt: null,
      finishedAt: null,
      importedAt: '2026-10-15T10:00:00+08:00',
      generations: [],
      nodeCount: 3,
      memberCount: 5,
      sessionMemberCount: 3,
      rollbackCount: 0,
      subgraphCount: 0,
      warnings: [],
      memberStats: {
        joinedCount: 3,
        totalTokens: 2_300,
        totalCost: 0.2,
        totalTurns: 7,
        totalActiveMs: 1_110_000,
        totalDurationMs: 7_440_000,
        memberRowIds: [],
        models: [
          { model: 'glm-4.7', count: 2 },
          { model: 'glm-5.3', count: 1 },
        ],
        earliestStart: '2026-10-14T09:00:00.000Z',
        latestEnd: '2026-10-14T11:04:00.000Z',
      },
    };
    const sessionItem = {
      kind: 'session' as const,
      key: 'session:uw-ses-model',
      sessionId: 'row-model',
      taskId: 'uw-ses-model',
      query: '模型列展示归一',
      framework: 'claude-code',
      version: null,
      startTime: '2026-10-14T09:00:00.000Z',
      importedAt: '2026-10-15T10:00:00+08:00',
      endTime: '2026-10-14T09:05:00.000Z',
      totalTokens: 100,
      totalCost: 0.01,
      totalLatencyMs: 1_000,
      totalToolCallCount: 0,
      totalSkillLoadCount: 0,
      totalSubagentCount: 0,
      model: 'volc-gateway/deepseek-v4-pro',
      user: 'u',
      sourcePath: null,
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(createElement(AssetList, { items: [runItem, sessionItem], total: 2, page: 1, pageSize: 20, kind: 'all' }));
    });
    await settle();

    const runRow = document.querySelector('a[href="/run/minidemo01"]')?.closest('[data-asset-row]') as HTMLElement | null;
    expect(runRow).not.toBeNull();
    const runText = runRow!.textContent ?? '';
    const stat = (name: string): string => runRow!.querySelector(`[data-stat="${name}"]`)?.textContent ?? '';

    // Model：主模型（按会话计数、去 provider 前缀归一）glm-4.7，多模型 +1
    expect(runText.includes('glm-4.7') && runText.includes('+1')).toBe(true);
    // Start → End：manifest 无起止 → 成员会话极值兜底（earliest → latest，本地时区格式）
    const fmt = (iso: string): string => {
      const d = new Date(iso);
      const p = (n: number) => String(n).padStart(2, '0');
      return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    };
    expect(runText).toContain(fmt('2026-10-14T09:00:00.000Z'));
    expect(runText).toContain(fmt('2026-10-14T11:04:00.000Z'));
    // ΣTokens 2300 → 2.3K；ΣCost → $0.20
    expect(stat('Tokens')).toBe('2.3K');
    expect(stat('Cost')).toBe('$0.20');
    // Active / Wall：Σ成员活跃 18.5min / Run 跨度墙钟 2.1h（09:00→11:04）
    expect(stat('Active / Wall')).toBe('18.5min / 2.1h');

    // 会话行 Model：展示口径去 provider 前缀（悬停 title 保留原始值）
    const sesRow = document.querySelector('a[href^="/run/solo:uw-ses-model"]')?.closest('[data-asset-row]') as HTMLElement | null;
    expect(sesRow).not.toBeNull();
    const sesText = sesRow!.textContent ?? '';
    expect(sesText.includes('deepseek-v4-pro')).toBe(true);
    expect(sesText.includes('volc-gateway')).toBe(false);
    expect(sesRow!.querySelector('span[title="volc-gateway/deepseek-v4-pro"]')).not.toBeNull();

    // memberStats = null（join 失败 / 无 prisma）→ 指标列降级 —
    document.body.innerHTML = '';
    const container2 = document.createElement('div');
    document.body.appendChild(container2);
    root = createRoot(container2);
    await act(async () => {
      root!.render(createElement(AssetList, { items: [{ ...runItem, memberStats: null }], total: 1, page: 1, pageSize: 20, kind: 'all' }));
    });
    await settle();
    const row2 = document.querySelector('a[href="/run/minidemo01"]')?.closest('[data-asset-row]') as HTMLElement | null;
    expect(row2).not.toBeNull();
    expect(row2!.textContent ?? '').toContain('— → —');
    expect(row2!.querySelector('[data-stat="Tokens"]')?.textContent ?? '').toBe('—');
  })

  it('指标卡系统总消耗口径：Σtokens/Σcost/平均时长/Errors = 独立会话 + run 成员（页面层）', async () => {
    // 期望 = Σ全库会话行：本文件的 run 恰好拥有自己种的 3 个成员（join 全命中
    // + ownedSessions 隔离），Σ独立 + Σrun成员 = Σ全行；其他并行文件的会话从
    // 本 home 看是独立会话，等式两侧同计。共享 test.db 下并行文件可能在快照与
    // 页面取数之间落种子——行数变化则重渲染重比（收敛后容差只需吸收格式舍入
    // 与罕见的原行更新）
    const readRows = () => prisma.session.findMany({
      select: { totalTokens: true, totalCost: true, startTime: true, endTime: true, totalLatencyMs: true },
    });
    let rows = await readRows();
    for (let attempt = 0; attempt < 3; attempt++) {
      await renderHome();
      if ((await prisma.session.count()) === rows.length) break;
      act(() => root?.unmount());
      document.body.innerHTML = '';
      rows = await readRows();
    }
    const expTokens = rows.reduce((s, r) => s + Number(r.totalTokens), 0);
    const expCost = rows.reduce((s, r) => s + r.totalCost, 0);
    const expTotalMs = rows.reduce((s, r) => s + sessionDurationMs(r.startTime, r.endTime, Number(r.totalLatencyMs)), 0);

    const values = [...document.querySelectorAll('p.text-2xl')].map(el => el.textContent ?? '');
    expect(values.length).toBe(5); // Sessions / Tokens / Cost / Total Duration / Errors
    const parseNum = (text: string): number => {
      const m = text.match(/([\d.]+)\s*([KM]?)/);
      return m ? parseFloat(m[1]!) * (m[2] === 'K' ? 1e3 : m[2] === 'M' ? 1e6 : 1) : NaN;
    };
    const parseDur = (text: string): number => {
      const m = text.match(/([\d.]+)\s*(ms|min|h|s)/);
      if (!m) return NaN;
      return parseFloat(m[1]!) * (m[2] === 'h' ? 3_600_000 : m[2] === 'min' ? 60_000 : m[2] === 's' ? 1_000 : 1);
    };
    // Tokens / Cost：Σ全库（成员 Σ 主导期望值；双计会让 tokens 翻倍，1% 容差必炸）
    expect(Math.abs(parseNum(values[1]!) - expTokens)).toBeLessThanOrEqual(expTokens * 0.01);
    expect(Math.abs(parseFloat(values[2]!.replace('$', '')) - expCost)).toBeLessThanOrEqual(Math.max(0.05, expCost * 0.01));
    // Total Duration：Σ全库时长（独立 + run 成员；漏并成员会少 ~10min，2% 容差必炸）
    expect(Math.abs(parseDur(values[3]!) - expTotalMs)).toBeLessThanOrEqual(Math.max(5_000, expTotalMs * 0.02));
    // Sessions = 全库 − 本 run 的 3 个成员（隔离闸：成员不双计；±2 吸收残余竞态，
    // 双计会 +3 必超）；副行说明成员规模
    expect(Math.abs(parseInt(values[0]!, 10) - (rows.length - 3))).toBeLessThanOrEqual(2);
    expect(document.body.textContent).toContain('3 member sessions');
    // Errors：run 行在首页，其成员的失败工具调用计入页级 Errors
    expect(parseInt(values[4]!, 10)).toBeGreaterThanOrEqual(1);
  })

  it('header 单一导入入口（统一向导，刀2 合一）+ 设置入口保留', async () => {
    await renderHome()

    const importBtn = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('Import'))
    expect(importBtn).toBeTruthy()
    // 旧双入口（Import Session / 导入 Bundle）已退役
    expect([...document.querySelectorAll('button')].find(b => b.textContent?.includes('Import Session'))).toBeUndefined()
    expect([...document.querySelectorAll('button')].find(b => b.textContent?.includes('导入 Bundle'))).toBeUndefined()
    const settingsLink = document.querySelector('a[href="/settings"]') as HTMLAnchorElement | null
    expect(settingsLink).not.toBeNull()
    expect(settingsLink!.textContent).toContain('Settings')
  })

  it('类型过滤行（全部/会话/Run）：kind=run 客户端取数走 /api/observe/data?kind=run', async () => {
    const fetchUrls: string[] = []
    const origFetch = globalThis.fetch
    ;(globalThis as { fetch: typeof fetch }).fetch = ((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      fetchUrls.push(url)
      const kind = new URL(url, 'http://x').searchParams.get('kind')
      const items = kind === 'run'
        ? [{ kind: 'run', key: 'run:minidemo01', runId: 'minidemo01', name: 'mini-bundle', status: 'passed', exportDataComplete: true, startedAt: null, finishedAt: null, importedAt: '2026-10-15T10:00:00+08:00', generations: [], nodeCount: 3, memberCount: 5, sessionMemberCount: 3, rollbackCount: 0, subgraphCount: 0, warnings: [], memberStats: null }]
        : []
      return Promise.resolve(new Response(JSON.stringify({ items, total: kind === 'run' ? 1 : 0, page: 1 }), { status: 200, headers: { 'content-type': 'application/json' } }))
    }) as typeof fetch

    try {
      const container = document.createElement('div')
      document.body.appendChild(container)
      root = createRoot(container)
      await act(async () => {
        root!.render(createElement(AssetList, { items: [], total: 0, page: 1, pageSize: 20, kind: 'all' }))
      })
      // 切到 Run：行过滤器触发客户端取数（kind=run），行内渲染 run 数据
      await act(async () => { click([...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Runs')!) })
      await settle()
      expect(fetchUrls.some(u => u.includes('kind=run'))).toBe(true)
      expect(document.body.textContent).toContain('mini-bundle')
      // URL 同步 ?kind=run（可分享，非视图切换）
      expect(window.location.search).toContain('kind=run')
      container.remove()
      window.history.replaceState(null, '', '/')
    } finally {
      ;(globalThis as { fetch: typeof fetch }).fetch = origFetch
    }
  })
})

describe('统一工作台 Run 上传流（导入后上传，与会话行同款表单）', () => {
  const lakeCalls: Array<{ action?: string; runId?: string; description?: string; category?: string; opGen?: string }> = []
  let lakeResponse: { status: number; value: Record<string, unknown> } = { status: 200, value: {} }
  const origFetch = globalThis.fetch

  beforeAll(() => {
    ;(globalThis as { fetch: typeof fetch }).fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const json = (data: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }))
      if (url.includes('/api/settings/lake-config')) {
        return json({ configured: true, address: 'https://example.com/lake.git', branch: 'main' })
      }
      if (url.includes('/api/ingest/lake')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        // 范式目录下拉数据源（上传表单打开即拉，不计入上传调用断言）
        if (body.action === 'list') return json({ sessions: [], dirs: ['others'] })
        lakeCalls.push(body as { action?: string; runId?: string; description?: string; category?: string; opGen?: string })
        return json(lakeResponse.value, lakeResponse.status)
      }
      return json({})
    }) as typeof fetch
  })

  afterAll(() => {
    ;(globalThis as { fetch: typeof fetch }).fetch = origFetch
  })

  const setInputValue = (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }

  const setTextAreaValue = (ta: HTMLTextAreaElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(ta, value)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  }

  const setSelectValue = (select: HTMLSelectElement, value: string) => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  }

  // 会话同款必选项填充：范式目录 + 提交人 + 任务结果（内容描述预填 run 名称，
  // 可改）；返回确认上传按钮
  const fillRunUploadForm = (submitter: string): HTMLButtonElement => {
    setSelectValue(document.querySelector('select') as HTMLSelectElement, 'others')
    setInputValue(document.querySelector('input[placeholder="必填：真实姓名或账号"]') as HTMLInputElement, submitter)
    click([...document.querySelectorAll('button')].find(b => b.textContent?.trim() === '成功')!)
    return [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === '确认上传') as HTMLButtonElement
  }

  it('行内上传按钮 → 会话同款表单（范式/提交人/任务结果必选）→ POST bundle-upload（范式=物理落点）→ 成功提示', async () => {
    lakeCalls.length = 0
    lakeResponse = { status: 200, value: { runId: 'minidemo01', unchanged: false, sessionCount: 3, missingSessions: [], warnings: [] } }
    await renderHome()

    const uploadBtn = document.querySelector('button[aria-label^="上传 run"]') as HTMLButtonElement
    expect(uploadBtn).not.toBeNull()
    click(uploadBtn)
    await settle()
    expect(document.body.textContent).toContain('上传 Run 到')
    // 会话同款四件套在表单中呈现
    expect(document.body.textContent).toContain('范式目录')
    expect(document.body.textContent).toContain('任务结果')
    // 内容描述预填 run 名称
    expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('mini-bundle')

    // 必选项未填：确认上传禁用
    const submitBtn = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === '确认上传') as HTMLButtonElement
    expect(submitBtn.disabled).toBe(true)

    setTextAreaValue(document.querySelector('textarea') as HTMLTextAreaElement, '演示 run')
    const filledBtn = fillRunUploadForm('张三')
    await settle()
    expect(filledBtn.disabled).toBe(false)
    click(filledBtn)
    await settle()

    expect(lakeCalls).toEqual([{ action: 'bundle-upload', runId: 'minidemo01', description: '提交人: 张三\n内容描述: 演示 run', category: 'others', opGen: 'success' }])
    // 干净成功：HUD 顶部确认 + 上传弹窗即关
    expect(document.body.textContent).toContain('已上传 3 个成员会话')
    expect(document.querySelector('[role="dialog"]')?.textContent ?? '').not.toContain('上传 Run 到')
  })

  it('治理熔断（422）→ 错误展示；缺行成员提示（warnings）', async () => {
    lakeCalls.length = 0
    lakeResponse = { status: 422, value: { error: '上传熔断：清洗后仍检出疑似密钥残留', governance: true } }
    await renderHome()
    click(document.querySelector('button[aria-label^="上传 run"]')!)
    await settle()
    const submitBtn = fillRunUploadForm('张三')
    await settle()
    click(submitBtn)
    await settle()
    expect(document.body.textContent).toContain('上传熔断')
    expect(lakeCalls).toHaveLength(1)

    // 成功但缺行成员：warnings 呈现（包内缺正文，不阻断）
    lakeResponse = { status: 200, value: { runId: 'minidemo01', unchanged: false, sessionCount: 2, missingSessions: ['S9'], warnings: ['成员会话 S9 不在 insight（导入缺文件或已删除），包内缺该正文'] } }
    click([...document.querySelectorAll('button')].find(b => b.textContent?.trim() === '关闭')!)
    await settle()
    click(document.querySelector('button[aria-label^="上传 run"]')!)
    await settle()
    const retryBtn = fillRunUploadForm('李四')
    await settle()
    click(retryBtn)
    await settle()
    expect(document.body.textContent).toContain('已上传 2 个成员会话')
    expect(document.body.textContent).toContain('S9')
  })
})

describe('统一工作台 Run 删除流（级联确认）', () => {
  const deleteUrls: string[] = []
  const origFetch = globalThis.fetch

  beforeAll(() => {
    ;(globalThis as { fetch: typeof fetch }).fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/api/observe/run/')) {
        deleteUrls.push(`${init?.method ?? 'GET'} ${url}`)
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }))
      }
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } }))
    }) as typeof fetch
  })

  afterAll(() => {
    ;(globalThis as { fetch: typeof fetch }).fetch = origFetch
  })

  it('删除按钮 → 级联语义确认弹窗（含成员会话级联提示）→ DELETE /api/observe/run/<runId>', async () => {
    deleteUrls.length = 0
    await renderHome()

    click(document.querySelector('button[title="Delete run"]')!)
    await settle()
    expect(document.body.textContent).toContain('Delete Run')
    expect(document.body.textContent).toContain('级联删除由它导入的成员会话')

    click([...document.querySelectorAll('button')].find(b => b.textContent?.trim() === '确认删除')!)
    await settle()
    expect(deleteUrls).toEqual(['DELETE /api/observe/run/minidemo01'])
  })
})
