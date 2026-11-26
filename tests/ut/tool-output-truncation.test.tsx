// @vitest-environment happy-dom

// 工具输出截断提示 IT（数据驱动：tests/data/tool-output-truncation.json）——锁四件事：
// ①语义：toolOutputTruncationOf 逐例判定（正文引用、非固定位置、无横幅的零散标记
//   一律不算，宁缺毋假）；截断不是错误——不进轮级错误摘要（includeErrorDigest 的
//   摘要只记错误，仅截断的轮无摘要），总览头不出现任何截断提示；
// ②调用级：工具行带「工具输出截断」标记（不写「已截断」——会被当成模型输出截断），
//   展开结果时截断痕迹被衬出；未判截断的行既无标记也无衬色；
// ③事件级：run skills API 给每次技能读取带上 outputTruncation（截断调用读了哪个
//   技能，与摄取侧创建事件用同一检测），截断调用读的是别的技能时不串台；
// ④Skills 全景：选中技能的逐次调用行下方给出截断说明（规模 + agent 未看到全文），
//   完整读取的调用零噪音。

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { GET as runTurnsGET } from '@/app/api/observe/run/[runId]/turns/route';
import { GET as runSkillsGET } from '@/app/api/observe/run/[runId]/skills/route';
import { collectScopeTurns, type MergedTurnItem } from '@/lib/observe/collectors/turns';
import { resolveRunScope } from '@/lib/run/observe/scope';
import { buildTurnErrorDigest } from '@/lib/tool-call-errors';
import { OverviewPanels, type OverviewTurn } from '@/components/observe/OverviewPanels';
import { SkillsPanorama, type SkillsPanoramaData } from '@/components/observe/SkillsPanorama';
import { ToolCallList } from '@/components/observe/ToolCallList';
import { describeToolOutputTruncation, toolOutputTruncationOf, type ToolOutputTruncation } from '@/lib/tool-output-truncation';

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface Case {
  key: string;
  toolName: string;
  state: string;
  result: string;
  expect: ToolOutputTruncation | null;
}

type DigestItem = MergedTurnItem & { errorDigest?: { total: number; failed: number; details: Array<{ toolName: string; type: string }> } };

const fixture = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests/data/tool-output-truncation.json'), 'utf8')) as { cases: Case[] };
const cases: Case[] = fixture.cases;
const caseOf = (key: string) => cases.find(c => c.key === key)!;
const truncatedKeys = cases.filter(c => c.expect != null).map(c => c.key);
/** 组合轮里的两次截断调用复用这两例的原文 */
const COMBINED = ['codex-native', 'opencode-tail'] as const;
/** 全会话有错误摘要的轮：marker-without-banner（失败调用）+ 组合轮（一次失败） */
const ERROR_TURN_COUNT = 2;

/** 技能读取轮：每轮一个 use 事件 + 一次读取调用。clean 轮里另有一次被截断、
 *  但读的是别的技能（无事件）的调用——不得把截断串到 tot-skill-clean 上 */
const SKILL_TURNS = [
  { skill: 'tot-skill-shell', toolName: 'exec_command', args: { cmd: 'cat /root/.codex/skills/tot-skill-shell/SKILL.md' }, key: 'codex-native' },
  { skill: 'tot-skill-read', toolName: 'Read', args: { file_path: '/root/.claude/skills/tot-skill-read/SKILL.md' }, key: 'opencode-tail' },
  { skill: 'tot-skill-clean', toolName: 'Read', args: { file_path: '/root/.claude/skills/tot-skill-clean/SKILL.md' }, key: null },
] as const;
const SKILL_NAMES = [...SKILL_TURNS.map(s => s.skill)];

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-tool-output-truncation-'));
const ORIG_HOME = process.env.CONTEXT_INSIGHT_HOME;
const SID = 'tot-ses-notice';
const RUN_ID = `solo:${SID}`;

const ctx: {
  turnIds: Record<string, string>;
  combinedTurnId: string;
  cleanTurnId: string;
} = { turnIds: {}, combinedTurnId: '', cleanTurnId: '' };

beforeAll(async () => {
  process.env.CONTEXT_INSIGHT_HOME = tmpHome;
  await prisma.session.deleteMany({ where: { taskId: SID } });
  const s = await prisma.session.create({
    data: { taskId: SID, framework: 'codex', model: 'demo-model', startTime: new Date('2026-11-20T02:00:00Z'), endTime: new Date('2026-11-20T02:10:00Z') },
  });
  let index = 0;
  const mkTurn = async () => {
    const t = await prisma.turn.create({
      data: { sessionId: s.id, turnIndex: index++, role: 'assistant', createdAt_ts: new Date(Date.parse('2026-11-20T02:00:00Z') + index * 1000) },
    });
    return t;
  };
  const mkCall = async (turnId: string, toolCallId: string, toolName: string, state: string, resultJson: string | null, argsJson: string | null = null) => {
    await prisma.toolCall.create({ data: { turnId, toolCallId, toolName, state, resultJson, argsJson } });
  };
  for (const c of cases) {
    const t = await mkTurn();
    ctx.turnIds[c.key] = t.id;
    await mkCall(t.id, `tot-tc-${c.key}`, c.toolName, c.state, c.result);
  }
  // 组合轮：一次失败调用 + 两次不同工具的截断调用——摘要只记那一次失败
  const combined = await mkTurn();
  ctx.combinedTurnId = combined.id;
  await mkCall(combined.id, 'tot-tc-combined-exit', 'Bash', 'ok', 'Exit code 1\nboom');
  for (const [i, key] of COMBINED.entries()) {
    const c = caseOf(key);
    await mkCall(combined.id, `tot-tc-combined-${i}`, c.toolName, c.state, c.result);
  }
  const clean = await mkTurn();
  ctx.cleanTurnId = clean.id;
  await mkCall(clean.id, 'tot-tc-clean', 'Read', 'completed', 'plain file body');
  // 技能读取轮：事件落在读取调用所在的轮（与摄取侧 turn-split 同构）
  await prisma.sessionSkill.createMany({
    data: SKILL_NAMES.map(skillName => ({ sessionId: s.id, skillName, skillVersion: 1, invocationCount: 1 })),
  });
  for (const [i, st] of SKILL_TURNS.entries()) {
    const t = await mkTurn();
    ctx.turnIds[`skill:${st.skill}`] = t.id;
    await prisma.skillEvent.create({
      data: { turnId: t.id, skillName: st.skill, skillVersion: 1, eventType: 'use', success: true },
    });
    await mkCall(t.id, `tot-tc-skill-${i}`, st.toolName, 'completed', st.key ? caseOf(st.key).result : 'plain skill body', JSON.stringify(st.args));
  }
  await mkCall(
    ctx.turnIds['skill:tot-skill-clean'], 'tot-tc-skill-foreign', 'exec_command', 'completed',
    caseOf('codex-native').result,
    JSON.stringify({ cmd: 'cat /root/.codex/skills/tot-skill-other/SKILL.md' }),
  );
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: SID } });
  if (ORIG_HOME == null) delete process.env.CONTEXT_INSIGHT_HOME; else process.env.CONTEXT_INSIGHT_HOME = ORIG_HOME;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

async function getTurns(query: string): Promise<{ status: number; items: DigestItem[] }> {
  const res = await runTurnsGET(
    new NextRequest(`http://localhost/api/observe/run/${RUN_ID}/turns${query}`),
    { params: Promise.resolve({ runId: RUN_ID }) },
  );
  return { status: res.status, items: (await res.json()).items };
}

async function getSkills(): Promise<SkillsPanoramaData> {
  const res = await runSkillsGET(
    new NextRequest(`http://localhost/api/observe/run/${RUN_ID}/skills`),
    { params: Promise.resolve({ runId: RUN_ID }) },
  );
  expect(res.status).toBe(200);
  return res.json();
}

function renderSync(el: ReactElement): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(el); });
  return container;
}

/** API 轮 → 总览面板轮（补上面板要求的可空字段） */
function toOverviewTurn(item: DigestItem): OverviewTurn {
  return {
    turnId: item.turnId,
    turnIndex: item.turnIndex,
    role: item.role,
    contentSummary: item.contentSummary,
    agentName: item.agentName,
    isSubagent: item.isSubagent,
    subagentName: item.subagentName,
    subagentSessionId: item.subagentSessionId,
    model: item.model,
    finishReason: item.finishReason,
    totalTokens: item.totalTokens,
    createdAt: item.createdAt,
    toolCalls: item.toolCalls.map(tc => ({ toolCallId: tc.toolCallId, toolName: tc.toolName, state: tc.state, durationMs: tc.durationMs, resultJson: null })),
    skillEvents: item.skillEvents,
    member: item.member,
    ...(item.errorDigest ? { errorDigest: item.errorDigest as OverviewTurn['errorDigest'] } : {}),
  };
}

describe('工具输出截断：语义（数据集逐例）', () => {
  it('每个形态的解析结果与期望逐字段相等；引用 / 非固定位置 / 零散标记判空', () => {
    for (const c of cases) {
      expect(toolOutputTruncationOf(c.result), c.key).toEqual(c.expect);
    }
  });

  it('用户可读说明只陈述事实：规模与行范围，不含处置建议', () => {
    expect(describeToolOutputTruncation(caseOf('codex-native').expect!)).toBe('输出被截断，原始 2707 tokens、共 96 行');
    expect(describeToolOutputTruncation(caseOf('codex-bytes-omitted').expect!)).toBe('输出被截断，原始 275875 tokens');
    expect(describeToolOutputTruncation(caseOf('opencode-tail').expect!)).toBe('输出被截断，仅显示第 19–34 行（共 34 行）');
  });
});

describe('工具输出截断不是错误：run turns API 轮级摘要', () => {
  it('includeErrorDigest：仅截断的轮无错误摘要；错误轮的摘要里没有截断项', async () => {
    const { status, items } = await getTurns('?page=1&pageSize=50&includeErrorDigest=true');
    expect(status).toBe(200);
    const byTurnId = new Map(items.map(i => [i.turnId, i]));
    for (const c of cases) {
      const digest = byTurnId.get(ctx.turnIds[c.key])!.errorDigest;
      if (c.key === 'marker-without-banner') {
        // 失败调用：有错误摘要，但不判截断
        expect(digest, c.key).toBeDefined();
        expect(digest!.details).toEqual([{ toolName: c.toolName, type: 'failed' }]);
        continue;
      }
      expect(digest, c.key).toBeUndefined();
    }
    const combined = byTurnId.get(ctx.combinedTurnId)!.errorDigest!;
    expect(combined.total).toBe(1);
    expect(combined.failed).toBe(1);
    expect(combined.details).toEqual([{ toolName: 'Bash', type: 'failed' }]);
    for (const skillName of SKILL_NAMES) {
      expect(byTurnId.get(ctx.turnIds[`skill:${skillName}`])!.errorDigest, skillName).toBeUndefined();
    }
    expect(byTurnId.get(ctx.cleanTurnId)!.errorDigest).toBeUndefined();
  });

  it('默认请求：轻投影不携带摘要与原文', async () => {
    const { items } = await getTurns('?page=1&pageSize=50');
    for (const item of items) {
      expect(item.errorDigest).toBeUndefined();
      for (const tc of item.toolCalls) expect(tc.resultJson).toBeUndefined();
    }
  });

  it('服务端摘要与客户端原文计算逐值同口径（摘要组装单点）', async () => {
    const scope = (await resolveRunScope(RUN_ID, prisma))!;
    const server = await collectScopeTurns(prisma, scope, { page: 1, pageSize: 50, includeErrorDigest: true });
    const raw = await collectScopeTurns(prisma, scope, { page: 1, pageSize: 50, includeToolResult: true });
    expect(server.items.length).toBe(raw.items.length);
    let withDigest = 0;
    for (const s of server.items) {
      const r = raw.items.find(i => i.turnId === s.turnId)!;
      const client = buildTurnErrorDigest(
        r.toolCalls.map(tc => ({ toolName: tc.toolName, state: tc.state, resultJson: tc.resultJson ?? null })),
        r.skillEvents,
        r.finishReason,
      );
      expect(s.errorDigest, s.turnId).toEqual(client ?? undefined);
      if (s.errorDigest) withDigest++;
    }
    expect(withDigest).toBe(ERROR_TURN_COUNT);
  });
});

describe('工具输出截断：观测面与调用级提示', () => {
  let serverItems: DigestItem[] = [];
  beforeAll(async () => {
    serverItems = (await getTurns('?page=1&pageSize=50&includeErrorDigest=true')).items;
  });

  function renderOverview(turns: OverviewTurn[]) {
    const container = renderSync(createElement(OverviewPanels, {
      identity: {
        framework: 'codex', frameworkVersion: '0.169.0', memberCount: 1, model: 'demo-model',
        startTime: '2026-11-20T02:00:00.000Z', endTime: '2026-11-20T02:10:00.000Z', sourcePath: null,
        run: { title: 'demo', kindLabel: '会话', kindVariant: 'blue', incomplete: false, runId: RUN_ID },
      },
      metrics: { totalTokens: 0, totalCost: 0, wallMs: null, activeMs: null, llmActiveMs: null, llmCallCount: 0, toolCallCount: 0, subagentCount: 0, errorCount: 1 },
      turns,
      skills: [],
      onOpenTurns: vi.fn(),
    }));
    return container;
  }

  it('总览不展示截断：全是截断调用的会话，总览头无截断提示、也不进 Error Turns 卡', () => {
    const onlyTruncated = serverItems
      .filter(i => truncatedKeys.some(k => ctx.turnIds[k] === i.turnId))
      .map(toOverviewTurn);
    expect(onlyTruncated.length).toBe(truncatedKeys.length);
    const container = renderOverview(onlyTruncated);
    expect(container.querySelector('[data-slot="output-truncation-chip"]')).toBeNull();
    expect(container.querySelector('[data-slot="output-truncation-note"]')).toBeNull();
    expect(container.textContent).not.toContain('工具输出截断');
    expect(container.textContent).not.toContain('Error Turns');
    expect(container.textContent).not.toContain('🔧');
  });

  it('组合轮：Error Turns 卡只列错误项，截断的两次调用不混入', () => {
    const container = renderOverview([toOverviewTurn(serverItems.find(i => i.turnId === ctx.combinedTurnId)!)]);
    const text = container.textContent ?? '';
    expect(text).toContain('Error Turns (1)');
    expect(text).toContain('1 failed');
    expect(text.match(/🔧/g)?.length).toBe(1);
    expect(text).not.toContain('工具输出截断');
  });

  it('工具行：截断调用带「工具输出截断」标记并把截断痕迹衬出；未判截断的行无标记无衬色', async () => {
    const rows = cases.map(c => ({
      id: `row-${c.key}`, toolCallId: `tot-tc-${c.key}`, toolName: c.toolName, argsJson: null,
      resultJson: c.result, state: c.state, errorType: null, errorMessage: null, durationMs: 5, isSkillRelated: false,
    }));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(ToolCallList, { toolCalls: rows })); });
    // 展开全部行（三角是唯一触发点；CopyButton 同为 role=button，须排除）
    await act(async () => {
      for (const tri of Array.from(container.querySelectorAll('[role="button"]'))) {
        if (tri.textContent?.trim() === '▶') tri.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }
    });
    const blocks = Array.from(container.firstElementChild!.children) as HTMLElement[];
    expect(blocks.length).toBe(cases.length);
    const seamsOf = (block: HTMLElement) => Array.from(block.querySelectorAll('[data-slot="output-seam"]')).map(el => el.textContent ?? '');
    cases.forEach((c, i) => {
      const chips = blocks[i].querySelectorAll('[data-slot="output-truncation-chip"]');
      if (c.expect == null) {
        expect(chips.length, c.key).toBe(0);
        expect(seamsOf(blocks[i]).length, c.key).toBe(0);
        return;
      }
      expect(chips.length, c.key).toBe(1);
      // 文案带「工具输出」：不与模型输出截断混淆
      expect(chips[0].textContent?.trim(), c.key).toBe('工具输出截断');
    });
    // codex：横幅 + 中缝丢弃标记都被衬出
    const nativeSeams = seamsOf(blocks[cases.findIndex(c => c.key === 'codex-native')]);
    expect(nativeSeams.some(s => s.includes('Warning: truncated output (original token count: 2707)'))).toBe(true);
    expect(nativeSeams).toContain('…217 chars truncated…');
    // proxy 壳后的横幅同样衬出
    expect(seamsOf(blocks[cases.findIndex(c => c.key === 'codex-proxy-shell')]).some(s => s.includes('Warning: truncated output'))).toBe(true);
    // opencode：末尾的落盘行被衬出
    expect(seamsOf(blocks[cases.findIndex(c => c.key === 'opencode-tail')]).some(s => s.includes('full output saved to'))).toBe(true);
  });
});

describe('工具输出截断：Skills 逐次调用行', () => {
  let data: SkillsPanoramaData;
  beforeAll(async () => {
    data = await getSkills();
  });

  it('run skills API：被截断的读取带上截断事实，完整读取为 null', () => {
    const eventOf = (skillName: string) => data.events.find(e => e.skillName === skillName)!;
    for (const st of SKILL_TURNS) {
      expect(eventOf(st.skill).outputTruncation, st.skill).toEqual(st.key ? caseOf(st.key).expect : null);
    }
    // 没有事件的技能不凭空产生事件
    expect(data.events.some(e => e.skillName === 'tot-skill-other')).toBe(false);
  });

  function renderPanorama(): HTMLElement {
    const container = renderSync(createElement(SkillsPanorama, { runId: RUN_ID, data, onOpenTurn: vi.fn() }));
    return container;
  }

  function selectSkill(container: HTMLElement, skillName: string) {
    const row = container.querySelector(`[data-skill-row="${skillName}"]`) as HTMLElement | null;
    expect(row, skillName).toBeTruthy();
    act(() => { row!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
  }

  it('截断的调用：行内带标记，行下方说明这一次读取被截、agent 未看到全文', () => {
    const container = renderPanorama();
    selectSkill(container, 'tot-skill-shell');
    const blocks = Array.from(container.querySelectorAll('[data-skill-truncation]')) as HTMLElement[];
    expect(blocks.length).toBe(1);
    expect(blocks[0].textContent).toContain('use');
    const chip = blocks[0].querySelector('[data-slot="output-truncation-chip"]')!;
    expect(chip.textContent?.trim()).toBe('工具输出截断');
    const note = blocks[0].querySelector('[data-slot="output-truncation-note"]')!;
    expect(note.textContent).toBe('输出被截断，原始 2707 tokens、共 96 行，agent 未看到全文。');
    act(() => { container.remove(); });
  });

  it('opencode 形态：说明写出实际看到的行范围', () => {
    const container = renderPanorama();
    selectSkill(container, 'tot-skill-read');
    const note = container.querySelector('[data-skill-truncation] [data-slot="output-truncation-note"]')!;
    expect(note.textContent).toBe('输出被截断，仅显示第 19–34 行（共 34 行），agent 未看到全文。');
    act(() => { container.remove(); });
  });

  it('完整读取：无标记无说明；同轮里被截断的调用读的是别的技能，不串台', () => {
    const container = renderPanorama();
    selectSkill(container, 'tot-skill-clean');
    expect(container.querySelector('[data-skill-truncation]')).toBeNull();
    expect(container.querySelector('[data-slot="output-truncation-chip"]')).toBeNull();
    expect(container.querySelector('[data-slot="output-truncation-note"]')).toBeNull();
  });
});
