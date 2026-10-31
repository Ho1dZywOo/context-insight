// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// Run 详情 Audit tab IT（四域审计重构）：URL 感知 fetch mock 驱动页面级验证——
// ①Skill 域目标注册表（跨成员合并 + 成员归因 pills，dispatch 目标分域不串）；
// ②选中目标 → 启动卡显式发起（选中 ≠ 发起）→ run 级对账（POST run audit
// 端点，NDJSON 流式 result 事件 → 报告自渲染：五态瓦片 + 指令组 + finding
// 成员归因徽标；已有结果选中即直接展示——resume 语义）；③Agent 域（dispatch 目标
// 单成员对账）；④Workflow 域（成员编排声明可恢复性探测 + root 单成员对账）；
// ⑤Run 域（左域导航布局 + 编排规程声明 × 全 run 的 sift run 级对账）。

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Suspense } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { parseAndIndex } from '@/lib/run/reader';
import { buildViewModel } from '@/lib/run/view-model';
import { attachSessionRefs } from '@/lib/run/session-link';
import type { RunImportMeta } from '@/lib/run/run-store';
import RunDetailPage from '@/app/run/[runId]/page';

const nav = vi.hoisted(() => ({ back: vi.fn(), replace: vi.fn() }));
const searchState = vi.hoisted(() => ({ current: '' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: nav.replace, back: nav.back, refresh: () => {} }),
  usePathname: () => '/run/minidemo01',
  useSearchParams: () => new URLSearchParams(searchState.current),
}));

const fixture = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, './data/run/mini-bundle/workflow.json'), 'utf-8'),
) as unknown;
const index = parseAndIndex(fixture);
const viewModel = buildViewModel(index);
attachSessionRefs(viewModel, new Map([
  ['ses_mini_a', {
    taskId: 'ses_mini_a', framework: 'opencode', rowId: 'row_a', turns: 2,
    totalTokens: 100, durationMs: 60000, label: '成员A',
    startTime: '2026-10-13T02:00:12.000Z', endTime: '2026-10-13T02:01:12.000Z',
    cacheReadTokens: 0, contextPeakPct: 95, model: 'volc-gateway/glm-4.7',
    totalCost: 0.2, version: null, totalLatencyMs: 60000,
  }],
  ['ses_mini_b', {
    taskId: 'ses_mini_b', framework: 'opencode', rowId: 'row_b', turns: 1,
    totalTokens: 200, durationMs: 30000, label: '成员B',
    startTime: '2026-10-13T02:02:00.000Z', endTime: '2026-10-13T02:02:30.000Z',
    cacheReadTokens: 0, contextPeakPct: 40, model: 'volc-gateway/glm-4.7',
    totalCost: 0.1, version: null, totalLatencyMs: 30000,
  }],
]));
const importMeta: RunImportMeta['data'] = {
  importedAt: '2026-10-15T10:00:00+08:00',
  sourceDir: '/bundle/mini',
  manifestFile: 'workflow.json',
  exportDataComplete: true,
  sessions: { total: 3, imported: 3, existing: 0, missingFile: 0, failed: 0 },
  failures: [],
  warnings: [],
};

const skillsAll = {
  skills: [{ skillName: 'rop-skill-x', version: 2, invocationCount: 5 }],
  events: [
    { skillName: 'rop-skill-x', eventType: 'invoke', member: { taskId: 'ses_mini_a', label: '成员A' } },
    { skillName: 'rop-skill-x', eventType: 'invoke', member: { taskId: 'ses_mini_b', label: '成员B' } },
    { skillName: 'rop-agent-z', eventType: 'dispatch', member: { taskId: 'ses_mini_b', label: '成员B' } },
  ],
  total: 3,
};

// run 级对账端点收到的请求体（kind/name/members 断言用）
const auditBodies: Array<Record<string, unknown>> = [];

const memberMap = {
  '成员A.json': { taskId: 'ses_mini_a', label: '成员A', framework: 'opencode' },
  '成员B.json': { taskId: 'ses_mini_b', label: '成员B', framework: 'opencode' },
};

/** skill 域报告：跨两成员三条判定（成员B 一 FAIL 一 PASS，成员A 一 PASS）。 */
const skillReport = {
  skill_name: 'rop-skill-x',
  transcripts: ['成员A.json', '成员B.json'],
  summary: { total: 3, pass: 2, fail: 1, na: 0, unresolved: 0, indeterminate: 0 },
  findings: [
    {
      instruction_text: '必须先跑测试', headline: '先跑测试', source: 'CONSTRAINT',
      verdict: 'FAIL', method: 'LLM', category: 'prohibition',
      evidence: '成员B 未跑测试直接提交', transcript: '成员B.json', turn_refs: [3], seq: 1,
    },
    {
      instruction_text: '必须先跑测试', headline: '先跑测试', source: 'CONSTRAINT',
      verdict: 'PASS', method: 'PROGRAMMATIC', category: 'prohibition',
      evidence: '成员B 第二处调用前先跑了测试', transcript: '成员B.json', seq: 2,
    },
    {
      instruction_text: '保持输出简洁', headline: '保持输出简洁', source: 'STEP',
      verdict: 'PASS', method: 'PROGRAMMATIC', category: 'step',
      evidence: '成员A 输出符合约束', transcript: '成员A.json', seq: 3,
    },
  ],
  coverage: {
    total: 2,
    covered: 2,
    uncovered: 0,
    unknown: 0,
    coverage_rate: 1,
    sections: [
      {
        section: '执行纪律', total: 2, covered: 2, uncovered: 0, unknown: 0, coverage_rate: 1,
        instructions: [
          { instruction_text: '必须先跑测试', source: 'CONSTRAINT', category: 'prohibition', section: '执行纪律', status: 'covered', pass_count: 1, fail_count: 1, na_count: 0, total: 2, seqs: [1, 2] },
          { instruction_text: '保持输出简洁', source: 'STEP', category: 'step', section: '执行纪律', status: 'covered', pass_count: 1, fail_count: 0, na_count: 0, total: 1, seqs: [3] },
        ],
      },
    ],
  },
  // 声明文本覆盖：对账结果回指上卷到声明原文单元（2 绿触达 / 1 黄未验证 / 2 灰未建模，
  // 另 1 条指令未落回原文），着色基准 = skill_body 原文快照（单元间空行/围栏原样保留）
  text_coverage: {
    total_units: 5,
    covered: 2,
    uncovered: 1,
    unmodeled: 2,
    coverage_rate: 2 / 3,
    modeled_ratio: 0.6,
    unmapped_instructions: ['Consult reference material (2 alternative category references)'],
    units: [
      { kind: 'heading', text: '# rop-skill-x 工作流', state: '' },
      { kind: 'heading', text: '## 执行纪律', state: '' },
      { kind: 'bullet', text: '- 必须先跑测试', state: 'covered', instructions: [{ instruction_text: '必须先跑测试', headline: '先跑测试', status: 'covered' }] },
      { kind: 'bullet', text: '- 保持输出简洁', state: 'covered', instructions: [{ instruction_text: '保持输出简洁', headline: '保持输出简洁', status: 'covered' }] },
      { kind: 'bullet', text: '- 提交前跑全量回归门禁', state: 'uncovered', instructions: [{ instruction_text: '提交前跑全量回归门禁', headline: '提交前跑回归门禁', status: 'uncovered' }] },
      { kind: 'paragraph', text: '以上规则如有疑问，先与维护者确认再行动。', state: 'unmodeled' },
      { kind: 'codeblock', text: '状态：✅完成/❌未完成', state: 'unmodeled', heading: '## 执行纪律' },
    ],
  },
  skill_body: [
    '# rop-skill-x 工作流',
    '',
    '## 执行纪律',
    '',
    '- 必须先跑测试',
    '- 保持输出简洁',
    '- 提交前跑全量回归门禁',
    '',
    '以上规则如有疑问，先与维护者确认再行动。',
    '',
    '```json',
    '状态：✅完成/❌未完成',
    '```',
    '',
  ].join('\n'),
};

function auditResultEvent(fail: number, total: number, transcript: string, evidence: string, headline: string) {
  return {
    stage: 'result',
    percent: 100,
    report: {
      skill_name: 'target',
      transcripts: [transcript],
      summary: { total, pass: total - fail, fail, na: 0, unresolved: 0, indeterminate: 0 },
      findings: [
        {
          instruction_text: '必须先跑测试', headline, source: 'CONSTRAINT',
          verdict: fail > 0 ? 'FAIL' : 'PASS', method: 'LLM', category: 'prohibition',
          evidence, transcript, turn_refs: [3],
        },
      ],
    },
    _members: memberMap,
  };
}

/** 最小 NDJSON 流面（不依赖运行时 Response 流实现）。 */
function ndjsonResponse(events: unknown[]) {
  const text = `${events.map(e => JSON.stringify(e)).join('\n')}\n`;
  let done = false;
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () => {
          if (done) return { done: true, value: undefined };
          done = true;
          return { done: false, value: new TextEncoder().encode(text) };
        },
      }),
    },
  };
}

const fetchCalls: string[] = [];

vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
  fetchCalls.push(url);
  const u = new URL(url, 'http://localhost');
  const json = (body: unknown) => ({ ok: true, json: async () => body });
  if (u.pathname === '/api/observe/run/minidemo01') {
    return json({
      run: {
        runId: 'minidemo01', name: index.manifest.name ?? null, status: viewModel.status,
        exportDataComplete: true, startedAt: null, finishedAt: null, import: importMeta,
      },
      viewModel,
    });
  }
  if (u.pathname === '/api/observe/run/minidemo01/skills') {
    return json(skillsAll);
  }
  if (u.pathname === '/api/observe/run/minidemo01/main-agent-workflow') {
    return json(u.searchParams.get('member') === 'ses_mini_a'
      ? { available: true, name: 'orchestrator' }
      : { available: false, name: null });
  }
  if (u.pathname === '/api/observe/run/minidemo01/turn-digest') {
    // 成员B 的 turn 3 → turn_b_3（finding turn 深链解析）
    if (u.searchParams.get('member') === 'ses_mini_b') {
      return json({ turns: [{ turnId: 'turn_b_3', turnIndex: 3, isSubagent: false }], skillEvents: [] });
    }
    return json({ turns: [], skillEvents: [] });
  }
  if (u.pathname === '/api/observe/run/minidemo01/audit') {
    auditBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    const kind = (JSON.parse(String(init?.body ?? '{}')) as { kind?: string }).kind ?? 'skill';
    if (kind === 'root') {
      return ndjsonResponse([
        {
          stage: 'result',
          percent: 100,
          report: {
            skill_name: 'main-agent-workflow',
            transcripts: ['成员A.json'],
            summary: { total: 1, pass: 1, fail: 0, na: 0, unresolved: 0, indeterminate: 0 },
            findings: [
              {
                instruction_text: '必须先跑测试', headline: '按编排规程执行', source: 'CONSTRAINT',
                verdict: 'PASS', method: 'LLM', category: 'prohibition',
                evidence: '成员A 按规程编排执行', transcript: '成员A.json',
              },
            ],
          },
          _members: memberMap,
          _layers: [
            { kind: 'regulation', label: '编排规程', source: 'task-prompts.md', content: '规程：必须先跑测试后方可收尾' },
          ],
        },
      ]);
    }
    if (kind === 'agent') {
      return ndjsonResponse([auditResultEvent(1, 2, '成员B.json', '成员B 的子代理未按声明执行', '子代理须遵守 .md 声明')]);
    }
    if (kind === 'run') {
      return ndjsonResponse([
        {
          stage: 'result',
          percent: 100,
          report: {
            skill_name: 'orchestrator',
            transcripts: ['成员A.json', '成员B.json'],
            summary: { total: 2, pass: 1, fail: 1, na: 0, unresolved: 0, indeterminate: 0 },
            findings: [
              {
                instruction_text: '必须先跑测试', headline: '按编排规程收尾', source: 'CONSTRAINT',
                verdict: 'PASS', method: 'PROGRAMMATIC', category: 'prohibition',
                evidence: '成员A 全程遵守规程', transcript: '成员A.json',
              },
              {
                instruction_text: '必须先跑测试', headline: '按编排规程收尾', source: 'CONSTRAINT',
                verdict: 'FAIL', method: 'PROGRAMMATIC', category: 'prohibition',
                evidence: '成员B 未按规程收尾', transcript: '成员B.json', turn_refs: [3],
              },
            ],
            run: { runId: 'minidemo01', bundlePath: 'bundle', matchedSessionCount: 2, targetCallCount: 2, auditUnitCount: 2, units: [], warnings: [] },
          },
          _members: memberMap,
          _layers: [
            { kind: 'regulation', label: '编排规程', source: 'task-prompts.md', content: '规程：必须先跑测试后方可收尾' },
          ],
        },
      ]);
    }
    return ndjsonResponse([{ stage: 'result', percent: 100, report: { ...skillReport, run: { runId: 'minidemo01', bundlePath: 'bundle', matchedSessionCount: 2, targetCallCount: 3, auditUnitCount: 3, units: [], warnings: [] } }, _members: memberMap }]);
  }
  return json({ items: [], total: 0 });
}));

let root: Root | null = null;

async function renderPage(initialSearch = '') {
  searchState.current = initialSearch;
  nav.replace.mockClear();
  fetchCalls.length = 0;
  auditBodies.length = 0;
  sessionStorage.clear();
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      createElement(
        Suspense,
        { fallback: null },
        createElement(RunDetailPage, { params: Promise.resolve({ runId: 'minidemo01' }) }),
      ),
    );
  });
  await act(async () => { await new Promise(r => setTimeout(r, 20)) });
}

async function switchDomain(label: string) {
  const tab = document.querySelector('[data-run-tab="audit"]');
  const btn = tab!.querySelector<HTMLButtonElement>(`[data-audit-domain="${label.toLowerCase()}"]`);
  expect(btn).toBeTruthy();
  await act(async () => {
    btn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

/** 启动卡上显式发起对账（选中 ≠ 发起的两步式交互第二步）。 */
async function startAudit() {
  const btn = document.querySelector<HTMLButtonElement>('[data-audit-start]');
  expect(btn).toBeTruthy();
  await act(async () => {
    btn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('Run 详情 Audit tab（四域审计重构）', () => {
  it('Skill 域目标注册表：跨成员合并 + 成员归因，dispatch 目标分域不串', async () => {
    await renderPage('?tab=audit');

    const tab = document.querySelector('[data-run-tab="audit"]');
    expect(tab).toBeTruthy();
    // 域摘要：目标 1 · 涉事成员 2
    expect(tab!.textContent).toContain('目标');
    expect(tab!.textContent).toContain('涉事成员');
    // skill 域目标行：两成员归因 pill
    const row = tab!.querySelector('[data-audit-target="skill:rop-skill-x"]');
    expect(row).toBeTruthy();
    expect(row!.textContent).toContain('rop-skill-x');
    expect(row!.textContent).toContain('成员A');
    expect(row!.textContent).toContain('成员B');
    expect(row!.textContent).toContain('2');
    // dispatch 目标不在 skill 域
    expect(tab!.querySelector('[data-audit-target="agent:rop-agent-z"]')).toBeNull();
  });

  it('选中 skill 目标 → 启动卡显式发起 → run 级对账（跨成员 POST）→ 报告自渲染（五态瓦片 + 指令组 + 成员归因徽标）', async () => {
    await renderPage('?tab=audit');

    const row = document.querySelector('[data-audit-target="skill:rop-skill-x"]')!;
    await act(async () => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    // 选中 ≠ 发起：右栏先弹启动卡（目标摘要 + 显式按钮），未发任何对账 POST
    expect(auditBodies.length).toBe(0);
    const tab = document.querySelector('[data-run-tab="audit"]')!;
    expect(tab.textContent).toContain('开始对账');
    expect(tab.textContent).toContain('2 个成员 · 2 次调用');
    await startAudit();
    await act(async () => { await new Promise(r => setTimeout(r, 30)) });

    // run 级端点：跨两成员一次对账
    expect(fetchCalls.some(u => u === '/api/observe/run/minidemo01/audit')).toBe(true);
    expect(auditBodies[0]).toMatchObject({
      kind: 'skill',
      name: 'rop-skill-x',
      members: ['ses_mini_a', 'ses_mini_b'],
    });

    // 报告头：失败计数 + 跨成员口径
    const panel = document.querySelector('[data-audit-report="rop-skill-x"]');
    expect(panel).toBeTruthy();
    // 工作台卡片语法：tab 沉入浅灰画布，左右卡片浮起（分层投影而非描边）
    expect(document.querySelector('[data-run-audit]')?.className).toContain('bg-muted/30');
    expect(panel!.className).toContain('0_12px_32px_-22px');
    const text = panel!.textContent ?? '';
    expect(text).toContain('1 项失败');
    expect(text).toContain('3 条判定');
    expect(text).toContain('run 溯源 · 命中 2 会话 / 3 次调用');
    // 五态瓦片计数
    expect(text).toContain('通过');
    expect(text).toContain('失败');
    // 指令组：headline + 失败成员分布 pill
    expect(text).toContain('先跑测试');
    expect(text).toContain('成员B');

    // 成员分布：两成员各带 失败/判定 计数
    const stats = panel!.querySelector('[data-audit-member-stats]');
    expect(stats).toBeTruthy();
    expect(stats!.textContent).toContain('成员B');
    expect(stats!.textContent).toContain('成员A');
    expect(stats!.textContent).toContain('1/2');
    expect(stats!.textContent).toContain('0/1');

    // 声明覆盖（原文快照）：默认收起，头部带可评文本覆盖摘要（covered/modeled + 迷你三色条）
    const cov = panel!.querySelector('[data-audit-text-coverage]');
    expect(cov).toBeTruthy();
    expect(cov!.textContent).toContain('声明覆盖');
    expect(cov!.textContent).toContain('原文快照');
    expect(cov!.textContent).toContain('16/59 · 27%');
    // 收起态：着色原文未挂载（三级披露——先看总览指标，再展开整篇原文）
    expect(cov!.querySelector('pre')).toBeNull();
    await act(async () => {
      cov!.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    // 展开 → 整篇原文逐字呈现（bullet/说明文字/代码块；单元间空行与围栏原样保留）
    const painted = cov!.querySelector('pre');
    expect(painted).toBeTruthy();
    expect(painted!.textContent).toContain('- 提交前跑全量回归门禁');
    expect(painted!.textContent).toContain('以上规则如有疑问，先与维护者确认再行动。');
    expect(painted!.textContent).toContain('状态：✅完成/❌未完成');
    expect(painted!.textContent).toContain('```json');
    // 三色直接涂在文本上（绿=已触达 / 黄=未验证 / 灰=未建模）
    expect(painted!.innerHTML).toContain('bg-emerald-500/15');
    expect(painted!.innerHTML).toContain('bg-amber-500/20');
    expect(painted!.innerHTML).toContain('bg-muted/60');
    // 指标瓦片（标签上/值下）：指令覆盖（条数）与文本覆盖/建模完整度（字数口径）三种含义分报
    const covText = cov!.textContent ?? '';
    expect(covText).toContain('指令覆盖');
    expect(covText).toContain('文本覆盖');
    expect(covText).toContain('建模完整度');
    expect(covText).toContain('28/59');
    // 未落回原文的指令诚实计数（不静默吞）
    expect(covText).toContain('另有 1 条指令未落回原文');
    expect(covText).toContain('Consult reference material');

    // 点选成员B → 明细收窄到该成员的两条判定
    const chipB = [...stats!.querySelectorAll('button')].find(b => b.textContent?.includes('成员B'))!;
    await act(async () => {
      chipB.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(panel!.textContent).toContain('2 条');
    // 清除过滤回到全体
    const clear = [...panel!.querySelectorAll('button')].find(b => b.textContent === '清除过滤')!;
    await act(async () => {
      clear.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(panel!.textContent).toContain('3 条');

    // 展开指令组 → finding 明细：证据 + 成员归因徽标 + turn 深链
    const groupBtn = [...panel!.querySelectorAll('button')].find(b => b.textContent?.includes('先跑测试'));
    expect(groupBtn).toBeTruthy();
    await act(async () => {
      groupBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    const detail = panel!.textContent ?? '';
    expect(detail).toContain('成员B 未跑测试直接提交');

    // turn 深链：#3 → 成员 turn-digest 解析 → navigate 写 URL 镜像（tab=turns&turn=…）
    const turnLink = panel!.querySelector('[data-audit-turn-link="ses_mini_b:3"]')!;
    await act(async () => {
      turnLink.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await act(async () => { await new Promise(r => setTimeout(r, 20)) });
    expect(fetchCalls.some(u => u.includes('turn-digest') && u.includes('member=ses_mini_b'))).toBe(true);
    expect(nav.replace.mock.calls.some(c => String(c[0]).includes('turn=turn_b_3'))).toBe(true);
    expect(nav.replace.mock.calls.some(c => String(c[0]).includes('tab=turns'))).toBe(true);

    // resume：取消选择后再选同一目标 → store 已有结果直接展示报告，不再发 POST、也不再弹启动卡
    await act(async () => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await act(async () => { await new Promise(r => setTimeout(r, 20)) });
    expect(auditBodies.length).toBe(1);
    expect(document.querySelector('[data-audit-report="rop-skill-x"]')).toBeTruthy();
    expect(document.querySelector('[data-audit-start]')).toBeNull();
  });

  it('Agent 域：dispatch 目标单成员对账', async () => {
    await renderPage('?tab=audit');
    await switchDomain('Agent');

    const row = document.querySelector('[data-audit-target="agent:rop-agent-z"]')!;
    expect(row.textContent).toContain('rop-agent-z');
    expect(row.textContent).toContain('成员B');
    await act(async () => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    // 选中 ≠ 发起：启动卡先行
    expect(auditBodies.length).toBe(0);
    await startAudit();
    await act(async () => { await new Promise(r => setTimeout(r, 30)) });

    expect(auditBodies[0]).toMatchObject({
      kind: 'agent',
      name: 'rop-agent-z',
      members: ['ses_mini_b'],
    });
    const panel = document.querySelector('[data-audit-report="rop-agent-z"]');
    expect(panel).toBeTruthy();
    expect(panel!.textContent).toContain('子代理须遵守 .md 声明');
    // 展开指令组 → finding 明细证据
    const groupBtn = [...panel!.querySelectorAll('button')].find(b => b.textContent?.includes('子代理须遵守'));
    await act(async () => {
      groupBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(panel!.textContent).toContain('成员B 的子代理未按声明执行');
  });

  it('Workflow 域：成员编排声明可恢复性探测 + root 单成员对账', async () => {
    await renderPage('?tab=audit');
    await switchDomain('Workflow');

    // 可恢复性探测：A 可对账，B 无声明禁用
    expect(fetchCalls.some(u => u.includes('main-agent-workflow') && u.includes('member=ses_mini_a'))).toBe(true);
    await act(async () => { await new Promise(r => setTimeout(r, 20)) });
    const rowA = document.querySelector<HTMLButtonElement>('[data-audit-target="root:ses_mini_a"]')!;
    const rowB = document.querySelector<HTMLButtonElement>('[data-audit-target="root:ses_mini_b"]')!;
    expect(rowA.textContent).toContain('主 agent 编排');
    expect(rowA.disabled).toBe(false);
    expect(rowB.disabled).toBe(true);

    await act(async () => {
      rowA.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    // 选中 ≠ 发起：启动卡先行
    expect(auditBodies.length).toBe(0);
    await startAudit();
    await act(async () => { await new Promise(r => setTimeout(r, 30)) });

    expect(auditBodies[0]).toMatchObject({ kind: 'root', name: 'ses_mini_a', members: ['ses_mini_a'] });
    const panel = document.querySelector('[data-audit-report="ses_mini_a"]');
    expect(panel).toBeTruthy();
    expect(panel!.textContent).toContain('全部通过');
    // root 组合声明的层信息：finding 按指令文本归层打徽章（规程层）
    const groupBtn = [...panel!.querySelectorAll('button')].find(b => b.textContent?.includes('按编排规程执行'));
    await act(async () => {
      groupBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(panel!.textContent).toContain('成员A 按规程编排执行');
    expect(panel!.textContent).toContain('编排规程');
  });

  it('Run 域：左域导航布局 + 编排规程声明 × 全 run 的 sift run 级对账', async () => {
    await renderPage('?tab=audit');

    // 左栏域导航：四域在列；右栏域导览引导
    const tab = document.querySelector('[data-run-tab="audit"]');
    for (const d of ['skill', 'agent', 'workflow', 'run']) {
      expect(tab!.querySelector(`[data-audit-domain="${d}"]`)).toBeTruthy();
    }
    expect(tab!.textContent).toContain('从左侧选择目标开始对账');
    // 左栏从画布截出（发丝分区隔左右），不再叠卡片
    const aside = tab!.querySelector('aside');
    expect(aside?.className).toContain('lg:border-r');
    expect(aside?.className).not.toContain('bg-card');

    // 挂载即探测声明源：Run 域导航计数在进域前就绪（不再进域后才变 1）
    await act(async () => { await new Promise(r => setTimeout(r, 20)) });
    expect(tab!.querySelector('[data-audit-domain="run"]')!.textContent).toContain('1');

    await switchDomain('Run');
    // 声明源已缓存（成员A 可恢复 / 成员B 无）→ run 域唯一目标行
    await act(async () => { await new Promise(r => setTimeout(r, 20)) });
    const row = document.querySelector<HTMLButtonElement>('[data-audit-target="run:ses_mini_a"]');
    expect(row).toBeTruthy();
    expect(row!.disabled).toBe(false);
    expect(row!.textContent).toContain('全 run');
    // 右栏域导览（run 域）：对账范围瓦片
    expect(tab!.textContent).toContain('对账范围');
    expect(tab!.textContent).toContain('2 成员');

    await act(async () => {
      row!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    // 选中 ≠ 发起：启动卡先行
    expect(auditBodies.length).toBe(0);
    await startAudit();
    await act(async () => { await new Promise(r => setTimeout(r, 30)) });

    // run 级端点：规程层声明 × 全体成员整会话（宽松）
    expect(auditBodies[0]).toMatchObject({
      kind: 'run',
      name: 'ses_mini_a',
      members: ['ses_mini_a', 'ses_mini_b'],
    });
    const panel = document.querySelector('[data-audit-report="ses_mini_a"]');
    expect(panel).toBeTruthy();
    const text = panel!.textContent ?? '';
    // run 溯源副标题 + 跨成员判定
    expect(text).toContain('run 溯源 · 命中 2 会话 / 2 次调用');
    expect(text).toContain('成员A');
    expect(text).toContain('成员B');
    // 旧报告（无 text_coverage / skill_body 字段）不渲染声明覆盖总览
    expect(panel!.querySelector('[data-audit-text-coverage]')).toBeNull();
    // 展开指令组 → finding 明细：成员归因徽标 + 规程层归层徽章
    const groupBtn = [...panel!.querySelectorAll('button')].find(b => b.textContent?.includes('按编排规程收尾'));
    await act(async () => {
      groupBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(panel!.textContent).toContain('成员B 未按规程收尾');
    expect(panel!.textContent).toContain('编排规程');
    // turn 深链：#3 → 成员 turn-digest 解析 → navigate 写 URL 镜像
    const turnLink = panel!.querySelector('[data-audit-turn-link="ses_mini_b:3"]')!;
    await act(async () => {
      turnLink.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await act(async () => { await new Promise(r => setTimeout(r, 20)) });
    expect(nav.replace.mock.calls.some(c => String(c[0]).includes('turn=turn_b_3'))).toBe(true);
  });
});
