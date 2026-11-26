// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the
// License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// 恢复出的 SKILL.md「缺了哪些行」IT——链路：工具调用入库 → run skills / skill-content
// API（恢复层 skill-content + 行级证据）→ Skills 全景明细卡（SkillsPanorama）→
// 离线查看器的技能明细（SkillDetail）→ DOM → 复制。锁四件事：
// ①没恢复出全文时，页面明说缺了哪些行：结论条给覆盖面与缺失行段，正文里缺失的
//   行段是独立的标记行，落在对应的行号位置上（行号栏写真实文件行号）；
// ②标记不进正文：标记行是界面元素（不可选中），复制拿到的是确实读到的行——
//   与 API 的 content 逐字相同，不含任何「未读到」字样；
// ③成因分说：没读到 / 多次读取不一致而弃用 / 工具输出被截断（琥珀）；处置建议只有
//   一条（所在卡片已有的那条），展示面不自绘第二份；
// ④判得出多少说多少：全文零提示；文件尾部是否读完未知只标「未知」（中性）；
//   行号不可定的兜底通道明说「无法指出缺在哪一行」，不编行号；
// ⑤版面：缺失段很多时结论条封顶（列前几段 + 合计），不让卡片越撑越高。

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createElement, act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { GET as runSkillsGET } from '@/app/api/observe/run/[runId]/skills/route';
import { GET as runSkillContentGET } from '@/app/api/observe/run/[runId]/skill-content/route';
import { GET as runSkillContentAuditGET } from '@/app/api/observe/run/[runId]/skill-content-audit/route';
import { SkillsPanorama, type SkillsPanoramaData } from '@/components/observe/SkillsPanorama';
import { SkillDetail } from '@/components/observe/SkillDetail';
import { CODEX_LIMIT_ADVICE } from '@/lib/tool-output-truncation';

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests/data/tool-output-truncation.json'), 'utf8')) as {
  cases: Array<{ key: string; result: string }>;
};

const file = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `- ${prefix} 第 ${i + 1} 行`);
const slice = (f: string[], a: number, b: number) => f.slice(a - 1, b).join('\n') + '\n';
const numbered = (f: string[], a: number, b: number) =>
  f.slice(a - 1, b).map((l, i) => `${String(a + i).padStart(4, ' ')}\t${l}`).join('\n') + '\n';
const codexCut = (totalLines: number, head: string, tail: string) =>
  `Warning: truncated output (original token count: 900)\nTotal output lines: ${totalLines}\n\n${head}…300 tokens truncated…${tail}`;
const SKILL_DIR = '/w/.agents/skills';
const P = (skill: string) => `${SKILL_DIR}/${skill}/SKILL.md`;
const SH = (cmd: string) => ({ toolName: 'exec_command', args: { cmd } });

const GAP_FILE = file(10, 'gap');
const FULL_FILE = file(10, 'full');
const LONE_FILE = file(12, 'lone');
/** 24 行文件，第 5、22 行是空白行（选区复制不得丢）；每次读相邻两行、隔一行再读 */
const MANY_FILE = Array.from({ length: 24 }, (_, i) => (i === 4 || i === 21 ? '' : `- many 第 ${i + 1} 行`));
const MANY_READS = [[1, 2], [4, 5], [7, 8], [10, 11], [13, 14], [16, 17], [19, 20]];
/** 第 9 行与另一版不同：同号行内容矛盾 → 整体弃用并上报 */
const GAP_FILE_V2 = GAP_FILE.map((l, i) => (i === 8 ? '- gap 第 9 行（另一版）' : l));

interface Seed { skill: string; toolName: string; args: Record<string, string | number>; result: string }
const SEEDS: Seed[] = [
  // ssv-gap（10 行文件）：读到 2–8、10；第 1 行未读到；第 9 行两次带行号读取内容矛盾 → 弃用；
  // 其中一次读取被截断。范围宽过文件的 sed 读到文件末尾 → 判出文件共 10 行
  { skill: 'ssv-gap', ...SH(`nl -ba ${P('ssv-gap')} | sed -n '2,4p'`), result: numbered(GAP_FILE, 2, 4) },
  { skill: 'ssv-gap', ...SH(`nl -ba ${P('ssv-gap')} | sed -n '8,10p'`), result: numbered(GAP_FILE_V2, 8, 10) },
  { skill: 'ssv-gap', ...SH(`sed -n '5,300p' ${P('ssv-gap')}`), result: slice(GAP_FILE, 5, 10) },
  { skill: 'ssv-gap', ...SH(`nl -ba ${P('ssv-gap')} | sed -n '2,10p'`), result: codexCut(9, numbered(GAP_FILE, 2, 4), numbered(GAP_FILE, 9, 10)) },
  // ssv-full：整文件读到 → 全文
  { skill: 'ssv-full', ...SH(`cat ${P('ssv-full')}`), result: slice(FULL_FILE, 1, 10) },
  // ssv-lone（12 行文件）：只有一次有界读（7–9）→ 1–6 确定没读到；没读到文件末尾 → 尾部是否读完未知
  { skill: 'ssv-lone', ...SH(`sed -n '7,9p' ${P('ssv-lone')}`), result: slice(LONE_FILE, 7, 9) },
  // ssv-unproven（12 行文件）：从头读到尾、但后面跟着别的输出段 → 总行数判不出，没有任何确定缺失的行
  { skill: 'ssv-unproven', ...SH(`cat ${P('ssv-unproven')}; echo '--- end ---'`), result: `${slice(LONE_FILE, 1, 12)}--- end ---\n` },
  // ssv-many：7 段两行读 + 读到文件末尾（22–24）→ 第 3、6、…、21 行共 7 段缺失（结论条封顶的样本）
  ...MANY_READS.map(([a, b]): Seed => ({ skill: 'ssv-many', ...SH(`nl -ba ${P('ssv-many')} | sed -n '${a},${b}p'`), result: numbered(MANY_FILE, a, b) })),
  { skill: 'ssv-many', ...SH(`sed -n '22,300p' ${P('ssv-many')}`), result: slice(MANY_FILE, 22, 24) },
  // ssv-legacy：Read 工具的输出被运行环境截断且不带行号 → 行号不可定（兜底通道）
  { skill: 'ssv-legacy', toolName: 'Read', args: { file_path: '/root/.claude/skills/ssv-legacy/SKILL.md' }, result: fixture.cases.find(c => c.key === 'opencode-tail')!.result },
];
const SKILL_NAMES = [...new Set(SEEDS.map(s => s.skill))];

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-skill-source-view-'));
const ORIG_HOME = process.env.CONTEXT_INSIGHT_HOME;
const SID = 'ssv-ses';
const RUN_ID = `solo:${SID}`;

beforeAll(async () => {
  process.env.CONTEXT_INSIGHT_HOME = tmpHome;
  await prisma.session.deleteMany({ where: { taskId: SID } });
  const s = await prisma.session.create({
    data: { taskId: SID, framework: 'codex', model: 'demo-model', startTime: new Date('2026-11-20T03:00:00Z'), endTime: new Date('2026-11-20T03:10:00Z') },
  });
  await prisma.sessionSkill.createMany({
    data: SKILL_NAMES.map(skillName => ({ sessionId: s.id, skillName, skillVersion: 1, invocationCount: 1 })),
  });
  const base = Date.parse('2026-11-20T03:05:00Z');
  for (const [i, seed] of SEEDS.entries()) {
    const at = new Date(base + i * 1000);
    const t = await prisma.turn.create({
      data: { sessionId: s.id, turnIndex: i, role: 'assistant', createdAt_ts: at },
    });
    await prisma.skillEvent.create({
      data: { turnId: t.id, skillName: seed.skill, skillVersion: 1, eventType: 'use', success: true },
    });
    await prisma.toolCall.create({
      data: { turnId: t.id, toolCallId: `ssv-tc-${i}`, toolName: seed.toolName, state: 'completed', resultJson: seed.result, argsJson: JSON.stringify(seed.args), startedAt: at },
    });
  }
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: SID } });
  vi.unstubAllGlobals();
  if (ORIG_HOME == null) delete process.env.CONTEXT_INSIGHT_HOME; else process.env.CONTEXT_INSIGHT_HOME = ORIG_HOME;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

type Ctx = { params: Promise<{ runId: string }> };
const ctxOf = (): Ctx => ({ params: Promise.resolve({ runId: RUN_ID }) });

async function getSkills(): Promise<SkillsPanoramaData> {
  const res = await runSkillsGET(new NextRequest(`http://localhost/api/observe/run/${RUN_ID}/skills`), ctxOf());
  expect(res.status).toBe(200);
  return res.json();
}

async function getContent(skillName: string) {
  const res = await runSkillContentGET(
    new NextRequest(`http://localhost/api/observe/run/${RUN_ID}/skill-content?skillName=${encodeURIComponent(skillName)}`),
    ctxOf(),
  );
  expect(res.status).toBe(200);
  return res.json() as Promise<{
    content: string | null; source: string | null; fullRead: boolean;
    evidence: { lineNumbers: number[]; fileLines: number | null; gaps: Array<{ from: number; to: number }>; truncated: boolean; conflictLines: number[] };
  }>;
}

/** 页面取数走真实 run 成员视图端点（成员闸 + 委托恢复层）；与正文无关的面返回空对象 */
function stubFetch(only: string[]) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost');
    const name = url.pathname.split('/').pop()!;
    const target = new NextRequest(`http://localhost/api/observe/run/${RUN_ID}/${name}${url.search}`);
    if (name === 'skill-content') return runSkillContentGET(target, ctxOf());
    if (name === 'skill-content-audit') return runSkillContentAuditGET(target, ctxOf());
    void only;
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }));
}

async function mount(el: ReactElement): Promise<{ container: HTMLElement; unmount: () => void }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(el); });
  return { container, unmount: () => { act(() => { root.unmount(); }); container.remove(); } };
}

const click = (el: Element) => act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });

/** 页面取数是真实的异步 IO（路由 → 恢复层 → 库）：等展示面落到 DOM；超时把页面文字带进断言 */
async function awaitSource(container: HTMLElement): Promise<void> {
  for (let waited = 0; waited < 4000; waited += 25) {
    if (container.querySelector('[data-slot="skill-source"]')) return;
    await act(async () => { await new Promise(r => setTimeout(r, 25)); });
  }
  expect(container.textContent, '展示面出现').toContain('SKILL.md');
  expect(container.querySelector('[data-slot="skill-source"]'), '展示面出现').toBeTruthy();
}

type LineRow = { kind: 'line'; gutter: string | null; text: string };
type GapRow = { kind: 'gap' | 'conflict' | 'tail-unknown'; from?: string; to?: string; text: string; unselectable: boolean };
type Row = LineRow | GapRow;

/** 展示面（SkillSourceView）的 DOM 契约：结论条、缺失行段清单、正文行序 */
function contractOf(container: HTMLElement) {
  const root = container.querySelector<HTMLElement>('[data-slot="skill-source"]');
  expect(root, '展示面存在').toBeTruthy();
  const notice = root!.querySelector<HTMLElement>('[data-slot="skill-source-notice"]');
  const body = root!.querySelector<HTMLElement>('[data-slot="skill-source-body"]')!;
  const rows: Row[] = [];
  for (const el of Array.from(body.children) as HTMLElement[]) {
    if (el.dataset.slot === 'skill-source-gap') {
      rows.push({ kind: el.dataset.kind as GapRow['kind'], from: el.dataset.from, to: el.dataset.to, text: el.textContent ?? '', unselectable: el.classList.contains('select-none') });
    } else if (el.dataset.slot === 'skill-source-line') {
      const prev = el.previousElementSibling;
      rows.push({ kind: 'line', gutter: prev?.hasAttribute('aria-hidden') ? prev.textContent ?? '' : null, text: el.textContent ?? '' });
    }
  }
  return {
    notice: notice?.textContent ?? null,
    noticeTone: notice?.dataset.tone ?? null,
    located: notice?.dataset.located ?? null,
    tags: Array.from(root!.querySelectorAll<HTMLElement>('[data-slot="skill-source-gaps"] > li')).map(li => [li.dataset.gapKind, li.dataset.from ?? '', li.dataset.to ?? '', li.textContent] .join('|')),
    rows,
    footer: root!.lastElementChild?.textContent ?? '',
  };
}

describe('恢复出的 SKILL.md：没恢复出全文时明说缺了哪些行，标记不进正文', () => {
  let data: SkillsPanoramaData;
  beforeAll(async () => { data = await getSkills(); });

  async function openInPanorama(skillName: string) {
    stubFetch([]);
    const m = await mount(createElement(SkillsPanorama, { runId: RUN_ID, data, onOpenTurn: vi.fn() }));
    const row = m.container.querySelector<HTMLElement>(`[data-skill-row="${skillName}"]`);
    expect(row, skillName).toBeTruthy();
    await click(row!);
    const btn = Array.from(m.container.querySelectorAll<HTMLElement>('[role="button"]')).find(el => el.title.startsWith('查看 SKILL.md 恢复出的内容'));
    expect(btn, '全文按钮').toBeTruthy();
    await click(btn!);
    await awaitSource(m.container);
    return m;
  }

  it('恢复层口径：证据对象如实给出覆盖面、缺口、冲突与截断', async () => {
    const gap = await getContent('ssv-gap');
    expect(gap.content!.split('\n')).toEqual(['- gap 第 2 行', '- gap 第 3 行', '- gap 第 4 行', '- gap 第 5 行', '- gap 第 6 行', '- gap 第 7 行', '- gap 第 8 行', '- gap 第 10 行']);
    expect(gap.fullRead).toBe(false);
    expect(gap.evidence).toMatchObject({ lineNumbers: [2, 3, 4, 5, 6, 7, 8, 10], fileLines: 10, gaps: [{ from: 1, to: 1 }, { from: 9, to: 9 }], conflictLines: [9], truncated: true });

    const full = await getContent('ssv-full');
    expect(full.fullRead).toBe(true);
    expect(full.evidence).toMatchObject({ fileLines: 10, gaps: [], truncated: false, conflictLines: [] });

    const lone = await getContent('ssv-lone');
    expect(lone.fullRead).toBe(false);
    expect(lone.evidence).toMatchObject({ lineNumbers: [7, 8, 9], fileLines: null, gaps: [{ from: 1, to: 6 }], truncated: false });

    const unproven = await getContent('ssv-unproven');
    expect(unproven.fullRead).toBe(false);
    expect(unproven.evidence).toMatchObject({ lineNumbers: Array.from({ length: 12 }, (_, i) => i + 1), fileLines: null, gaps: [], truncated: false, conflictLines: [] });
  });

  it('Skills 全景明细卡：未读到 + 冲突弃用 + 被截断——结论条列全缺失行段，正文里的标记行落在对应行号位置', async () => {
    const { container, unmount } = await openInPanorama('ssv-gap');
    const c = contractOf(container);

    expect(c.notice).toContain('未恢复全文');
    expect(c.notice).toContain('已读 8/10 行');
    expect(c.notice).toContain('缺 2 行');
    expect(c.noticeTone).toBe('amber');
    expect(c.located).toBe('true');
    // 处置建议：卡片上方那一条折叠条（单一视觉源）有且只有一条；结论条里不自绘第二份
    expect(container.querySelectorAll('[data-slot="truncation-advice"]')).toHaveLength(1);
    expect(c.notice).not.toContain(CODEX_LIMIT_ADVICE);
    expect(c.tags).toEqual([
      'truncated|||读取该文件的工具输出被截断',
      'unread|1|1|第 1 行未读到',
      'conflict|9|9|第 9 行多次读取内容不一致，已弃用',
    ]);

    const gaps = c.rows.filter(r => r.kind !== 'line');
    expect(gaps.map(r => [r.kind, r.from, r.to, r.text, r.unselectable])).toEqual([
      ['gap', '1', '1', '⋯ 第 1 行未读到', true],
      ['conflict', '9', '9', '⋯ 第 9 行多次读取内容不一致，已弃用', true],
    ]);
    const lines = c.rows.filter((r): r is Extract<Row, { kind: 'line' }> => r.kind === 'line');
    expect(lines.map(l => [l.gutter, l.text])).toEqual([
      ['2', '- gap 第 2 行'], ['3', '- gap 第 3 行'], ['4', '- gap 第 4 行'], ['5', '- gap 第 5 行'],
      ['6', '- gap 第 6 行'], ['7', '- gap 第 7 行'], ['8', '- gap 第 8 行'], ['10', '- gap 第 10 行'],
    ]);
    // 标记行夹在对应行号位置：1 在第 2 行之前；9 在第 8 与第 10 行之间
    expect(c.rows.map(r => (r.kind === 'line' ? r.gutter : `${r.from}-${r.to}`))).toEqual(['1-1', '2', '3', '4', '5', '6', '7', '8', '9-9', '10']);
    expect(c.footer).toContain('Shell 读取 · 8 行 · 标记行是界面标注，复制与下载的正文不含');
    unmount();
  });

  it('标记不进正文：复制拿到的是确实读到的行，与 API 的 content 逐字相同', async () => {
    const api = await getContent('ssv-gap');
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { container, unmount } = await openInPanorama('ssv-gap');
    const copy = container.querySelector<HTMLElement>('[data-slot="skill-source"] [title="Copy"]');
    expect(copy, '复制按钮').toBeTruthy();
    await click(copy!);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]![0]).toBe(api.content);
    expect(writeText.mock.calls[0]![0]).not.toContain('未读到');
    // 选中整块正文时，标记行不参与选区（界面元素）
    for (const el of Array.from(container.querySelectorAll('[data-slot="skill-source-gap"]'))) {
      expect(el.classList.contains('select-none')).toBe(true);
    }
    unmount();
  });

  it('选区复制逐字还原：空白行不丢、行号栏与标记行不混入；只擦到行尾 / 行首的行不算选中', async () => {
    const { container, unmount } = await openInPanorama('ssv-many');
    const body = container.querySelector<HTMLElement>('[data-slot="skill-source-body"]')!;
    const lines = Array.from(body.querySelectorAll<HTMLElement>('[data-slot="skill-source-line"]'));
    expect(lines.length).toBe(17);

    /** 最小选区模型：边界点 + 经过了哪些正文行；Range 取正文行内的字符区间 */
    function installSelection(sel: { start?: [number, number]; end?: [number, number]; through: number[] }) {
      const start = sel.start ? { node: lines[sel.start[0]]!.firstChild!, offset: sel.start[1] } : { node: body, offset: 0 };
      const end = sel.end ? { node: lines[sel.end[0]]!.firstChild!, offset: sel.end[1] } : { node: body, offset: body.children.length };
      vi.spyOn(window, 'getSelection').mockReturnValue({
        isCollapsed: false, rangeCount: 1,
        getRangeAt: () => ({
          commonAncestorContainer: body, startContainer: start.node, startOffset: start.offset, endContainer: end.node, endOffset: end.offset,
          intersectsNode: (n: Node) => sel.through.includes(lines.indexOf(n as HTMLElement)),
        }),
      } as unknown as Selection);
      vi.spyOn(document, 'createRange').mockImplementation(() => {
        const r = {
          el: null as Node | null, s: -1, e: -1,
          selectNodeContents(n: Node) { r.el = n; },
          setStart(n: Node, o: number) { if (n === r.el?.firstChild) r.s = o; },
          setEnd(n: Node, o: number) { if (n === r.el?.firstChild) r.e = o; },
          get collapsed() { return r.toString() === ''; },
          toString() { const t = r.el?.textContent ?? ''; return t.slice(Math.max(0, r.s), r.e < 0 ? t.length : r.e); },
        };
        return r as unknown as Range;
      });
    }
    const copied: string[] = [];
    const copyText = () => {
      const ev = new Event('copy', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clipboardData', { value: { setData: (_type: string, v: string) => copied.push(v) } });
      const notPrevented = body.dispatchEvent(ev);
      return notPrevented;
    };

    // 全选正文区：17 行逐字还原（含第 5、22 行两个空白行），没有行号、没有标记文字
    installSelection({ through: lines.map((_, i) => i) });
    expect(copyText()).toBe(false);
    expect(copied.at(-1)!.split('\n')).toEqual(MANY_FILE.filter((_, i) => (i + 1) % 3 !== 0 || i === 23));
    expect(copied.at(-1)!.split('\n').filter(t => t === '')).toHaveLength(2);
    expect(copied.at(-1)).not.toContain('未读到');
    expect(copied.at(-1)).not.toMatch(/^\s*\d+\s/m);

    // 跨过标记行的局部选区：第 1–4 个正文行（文件第 1、2、4、5 行），中间缺的第 3 行不出现
    installSelection({ through: [0, 1, 2, 3] });
    copyText();
    expect(copied.at(-1)!.split('\n')).toEqual(['- many 第 1 行', '- many 第 2 行', '- many 第 4 行', '']);

    // 选区从某行行尾起、到下一行行首止：两行都只是被擦到 → 不接管，交给浏览器
    installSelection({ start: [1, MANY_FILE[1]!.length], end: [2, 0], through: [1, 2] });
    expect(copyText()).toBe(true);
    expect(copied).toHaveLength(2);
    vi.restoreAllMocks();
    unmount();
  });

  it('缺失段很多：结论条只列前 6 段并给合计，正文里的标记行一段不少', async () => {
    const { container, unmount } = await openInPanorama('ssv-many');
    const c = contractOf(container);
    expect(c.notice).toContain('已读 17/24 行');
    expect(c.notice).toContain('缺 7 行');
    expect(c.tags.filter(t => t.startsWith('unread'))).toHaveLength(6);
    expect(c.tags.at(-1)).toMatch(/^rest\|\|\|另有 1 段共 1 行$/);
    expect(c.tags.some(t => t.includes('第 21 行未读到'))).toBe(false);
    expect(c.rows.filter((r): r is GapRow => r.kind === 'gap').map(r => r.from)).toEqual(['3', '6', '9', '12', '15', '18', '21']);
    unmount();
  });

  it('全文：零提示、零标记行，行号栏 1..N', async () => {
    const { container, unmount } = await openInPanorama('ssv-full');
    const c = contractOf(container);
    expect(c.notice).toBeNull();
    expect(c.tags).toEqual([]);
    expect(c.rows.every(r => r.kind === 'line')).toBe(true);
    expect(c.rows.map(r => (r as Extract<Row, { kind: 'line' }>).gutter)).toEqual(Array.from({ length: 10 }, (_, i) => String(i + 1)));
    expect(c.footer).toBe('Shell 读取 · 10 行');
    unmount();
  });

  it('只读了中段：之前的行确定没读到（列出来），文件尾部是否读完未知（中性，标「未知」不编行号）', async () => {
    const { container, unmount } = await openInPanorama('ssv-lone');
    const c = contractOf(container);
    expect(c.notice).toContain('未恢复全文');
    expect(c.notice).toContain('已读 3 行');
    expect(c.notice).toContain('缺 6 行');
    expect(c.notice).not.toContain('工具输出被截断');
    expect(c.noticeTone).toBe('neutral');
    expect(c.notice).not.toContain(CODEX_LIMIT_ADVICE);
    expect(c.tags).toEqual(['unread|1|6|第 1–6 行未读到', 'tail-unknown|||文件到此是否结束未知']);
    expect(c.rows.map(r => (r.kind === 'line' ? r.gutter : `${r.kind}:${r.from}-${r.to}`))).toEqual(['gap:1-6', '7', '8', '9', 'tail-unknown:undefined-undefined']);
    expect(c.rows[0]).toEqual(expect.objectContaining({ text: '⋯ 第 1–6 行未读到', unselectable: true }));
    expect(c.rows.at(-1)).toEqual(expect.objectContaining({ text: '⋯ 第 9 行之后是否还有内容：未知', unselectable: true }));
    expect(c.rows.slice(1, 4).map(r => r.text)).toEqual(['- lone 第 7 行', '- lone 第 8 行', '- lone 第 9 行']);
    unmount();
  });

  it('没有任何确定缺失的行、只是判不出尾部：「未确认是全文」，正文原样、末尾一行未知', async () => {
    const { container, unmount } = await openInPanorama('ssv-unproven');
    const c = contractOf(container);
    expect(c.notice).toContain('未确认是全文');
    expect(c.notice).toContain('已读 12 行');
    expect(c.notice).not.toContain('缺 ');
    expect(c.noticeTone).toBe('neutral');
    expect(c.tags).toEqual(['tail-unknown|||文件到此是否结束未知']);
    expect(c.rows).toHaveLength(13);
    expect(c.rows.slice(0, 12).map(r => [(r as Extract<Row, { kind: 'line' }>).gutter, r.text])).toEqual(
      Array.from({ length: 12 }, (_, i) => [String(i + 1), `- lone 第 ${i + 1} 行`]),
    );
    expect(c.rows.at(-1)).toEqual(expect.objectContaining({ kind: 'tail-unknown', text: '⋯ 第 12 行之后是否还有内容：未知' }));
    unmount();
  });

  it('行号不可定（兜底通道）：明说无法指出缺在哪一行，不给行号栏、不编标记行', async () => {
    const api = await getContent('ssv-legacy');
    expect(api.content, '兜底通道恢复了正文').toBeTruthy();
    expect(api.fullRead).toBe(false);
    const { container, unmount } = await openInPanorama('ssv-legacy');
    const c = contractOf(container);
    expect(c.located).toBe('false');
    expect(c.notice).toContain('未恢复全文');
    expect(c.tags).toEqual(['truncated|||读取该文件的工具输出被截断', 'unlocated|||行号不可定，无法指出缺在哪一行']);
    expect(c.rows.every(r => r.kind === 'line')).toBe(true);
    expect(c.rows.every(r => (r as Extract<Row, { kind: 'line' }>).gutter === null)).toBe(true);
    // 截断的是 Read 通道：没有可调开关 → 不附处置建议
    expect(c.notice).not.toContain(CODEX_LIMIT_ADVICE);
    unmount();
  });

  it('离线查看器的技能明细（SkillDetail）：同一展示面、同一结论', async () => {
    stubFetch([]);
    const m = await mount(createElement(SkillDetail, {
      taskId: SID,
      sessionSkills: SKILL_NAMES.map(skillName => ({ skillName, version: 1, invocationCount: 1 })),
      // 事件取库里真实行：没有 load/use 事件的技能会被判成「仅派发的子代理」，本就没有正文按钮
      skillEvents: (await prisma.skillEvent.findMany({ where: { turn: { session: { taskId: SID } } }, include: { turn: { select: { turnIndex: true } } } }))
        .map(e => ({
          id: e.id, skillName: e.skillName, skillVersion: e.skillVersion, eventType: e.eventType, success: e.success,
          errorMessage: null, durationMs: 0, turnIndex: e.turn.turnIndex, agentName: null, isSubagent: false, subagentSessionId: null,
          turnTokens: { totalTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        })) as never,
    }));
    const tr = Array.from(m.container.querySelectorAll<HTMLElement>('tbody tr')).find(el => el.textContent?.includes('ssv-gap'));
    expect(tr, '技能行').toBeTruthy();
    const expand = tr!.querySelector<HTMLElement>('td:first-child [role="button"]');
    expect(expand, '技能行展开钮').toBeTruthy();
    await click(expand!);
    const btn = Array.from(m.container.querySelectorAll<HTMLElement>('[role="button"]')).find(el => el.textContent?.trim() === '全文' && !el.title.startsWith('查看 agent'));
    expect(btn, '全文按钮').toBeTruthy();
    await click(btn!);
    await awaitSource(m.container);
    const c = contractOf(m.container);
    expect(c.notice).toContain('已读 8/10 行');
    expect(c.tags.map(t => t.split('|').slice(0, 2).join('|'))).toEqual(['truncated|', 'unread|1', 'conflict|9']);
    expect(c.rows.map(r => (r.kind === 'line' ? r.gutter : `${r.from}-${r.to}`))).toEqual(['1-1', '2', '3', '4', '5', '6', '7', '8', '9-9', '10']);
    // 离线查看器没有卡片级的建议条：结论条内用同一个视觉源给（codex 形态）
    const advice = m.container.querySelector<HTMLElement>('[data-slot="skill-source-notice"] [data-slot="truncation-advice"]');
    expect(advice?.dataset.harness).toBe('codex');
    // 同页的加载校验卡也在取数：等它落定再卸载，不留游离的状态更新
    await act(async () => { await new Promise(r => setTimeout(r, 150)); });
    m.unmount();
  });
});
