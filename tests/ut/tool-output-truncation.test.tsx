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
// 技能读取的逐次调用行（截断 + 部分读取）另见文末同名 describe。

// 技能读取的逐次调用行 IT（数据驱动种子见 SEEDS）——锁三件事：
// ①run skills API：事件带截断事实 outputTruncation 与读取覆盖面 readCoverage
//   （full / partial / unproven 三态，只在可证时下结论）；
// ②标记合成：输出被截断 → 琥珀「工具输出截断」（行号可定时说明行写 agent 实际读到
//   的行，否则写输出规模）；命令自带行范围没读全 → 中性「部分读取」；读完 / 证明
//   不了 / 无从判定 → 零标记（含「范围宽过文件」「同轮补齐」两个易误报形态）；
// ③明细卡标题行的次数汇总与逐次调用行的标记数一致。

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

// 技能读取轮：每轮一个 use 事件 + 读取调用。事件带两个正交事实——outputTruncation
// （输出被截断）与 readCoverage（这次读到文件的哪些行，full/partial/unproven）；
// 逐次调用行的标记由二者合成（skillReadMarkOf）。demo 是一份 10 行的 SKILL.md，
// 多种读法各占一轮：总行数在自己判不出时借用同文件其他读取的。
const DEMO_FILE = Array.from({ length: 10 }, (_, i) => `- 第 ${i + 1} 行`);
const LONE_FILE = Array.from({ length: 12 }, (_, i) => `- lone 第 ${i + 1} 行`);
const DEMO_PATH = '/w/.agents/skills/tot-skill-demo/SKILL.md';
const LONE_PATH = '/w/.agents/skills/tot-skill-lone/SKILL.md';
const slice = (file: string[], a: number, b: number) => file.slice(a - 1, b).join('\n') + '\n';
const numbered = (file: string[], a: number, b: number) =>
  file.slice(a - 1, b).map((l, i) => `${String(a + i).padStart(4, ' ')}\t${l}`).join('\n') + '\n';
/** codex 截断形态：banner + 头段 + 中缝丢弃标记 + 尾段（totalLines = 截断前的流总行数） */
const codexCut = (totalLines: number, head: string, tail: string) =>
  `Warning: truncated output (original token count: 900)\nTotal output lines: ${totalLines}\n\n${head}…300 tokens truncated…${tail}`;
const SH = (cmd: string) => ({ toolName: 'exec_command', args: { cmd } });

interface Seed {
  skill: string;
  toolName: string;
  args: Record<string, string | number>;
  result: string;
  /** 同轮的后续调用（与首个调用同属一个事件）：[toolName, args, result] */
  more?: Array<[string, Record<string, string | number>, string]>;
}
const SEEDS: Seed[] = [
  // 截断 + 行号可定：说明行写 agent 实际读到的行（尾部两行 9–10 压在范围上界 → 自己判不出总行数，借同文件的）
  { skill: 'tot-skill-demo', ...SH(`nl -ba ${DEMO_PATH} | sed -n '2,10p'`), result: codexCut(9, numbered(DEMO_FILE, 2, 4), numbered(DEMO_FILE, 9, 10)) },
  { skill: 'tot-skill-demo', ...SH(`cat ${DEMO_PATH}`), result: slice(DEMO_FILE, 1, 10) },
  { skill: 'tot-skill-demo', ...SH(`nl -ba ${DEMO_PATH} | sed -n '3,5p'`), result: numbered(DEMO_FILE, 3, 5) },
  { skill: 'tot-skill-demo', ...SH(`sed -n '1,300p' ${DEMO_PATH}`), result: slice(DEMO_FILE, 1, 10) },
  { skill: 'tot-skill-demo', ...SH(`cat ${DEMO_PATH}; echo '--- end ---'`), result: `${slice(DEMO_FILE, 1, 10)}--- end ---\n` },
  { skill: 'tot-skill-demo', ...SH(`tail -3 ${DEMO_PATH}`), result: slice(DEMO_FILE, 8, 10) },
  { skill: 'tot-skill-demo', toolName: 'Read', args: { file_path: DEMO_PATH, offset: 6, limit: 2 }, result: DEMO_FILE.slice(5, 7).map((l, i) => `${6 + i}\t${l}`).join('\n') },
  // 同轮两次读取：被截断的那次缺的部分由后一次整文件读取补齐 → 这次调用拿到了全文，不标
  {
    skill: 'tot-skill-demo', ...SH(`cat ${DEMO_PATH}`), result: codexCut(10, slice(DEMO_FILE, 1, 3), slice(DEMO_FILE, 9, 10)),
    more: [['exec_command', { cmd: `cat ${DEMO_PATH}` }, slice(DEMO_FILE, 1, 10)]],
  },
  // 没有同文件的其他读取：总行数未知，只写读到的行
  { skill: 'tot-skill-lone', ...SH(`sed -n '7,9p' ${LONE_PATH}`), result: slice(LONE_FILE, 7, 9) },
  // cat 之后跟着别的输出、总行数判不出、命令又没限范围：证明不了 → 不标（API 给 unproven）
  { skill: 'tot-skill-lone', ...SH(`cat ${LONE_PATH}; echo '--- end ---'`), result: `${slice(LONE_FILE, 1, 12)}--- end ---\n` },
  // 截断但行号归因不了（过滤管道）：退回输出规模的说法
  { skill: 'tot-skill-shell', toolName: 'exec_command', args: { cmd: `cat /root/.codex/skills/tot-skill-shell/SKILL.md | sed -n '1,80p'` }, result: caseOf('codex-native').result },
  { skill: 'tot-skill-read', toolName: 'Read', args: { file_path: '/root/.claude/skills/tot-skill-read/SKILL.md' }, result: caseOf('opencode-tail').result },
];
const SKILL_NAMES = [...new Set(SEEDS.map(s => s.skill))];
/** 带标记的种子（与下方断言一一对应）：skill → 期望标记种类 */
const MARKED = { 'tot-skill-demo': ['truncated', 'partial', 'partial'], 'tot-skill-lone': ['partial'] } as const;

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
  const mkCall = async (turnId: string, toolCallId: string, toolName: string, state: string, resultJson: string | null, argsJson: string | null = null, startedAt?: Date) => {
    await prisma.toolCall.create({ data: { turnId, toolCallId, toolName, state, resultJson, argsJson, ...(startedAt ? { startedAt } : {}) } });
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
  const skillBase = Date.parse('2026-11-20T02:05:00Z');
  for (const [i, seed] of SEEDS.entries()) {
    const t = await mkTurn();
    ctx.turnIds[`skill:${seed.skill}#${i}`] = t.id;
    await prisma.skillEvent.create({
      data: { turnId: t.id, skillName: seed.skill, skillVersion: 1, eventType: 'use', success: true },
    });
    const at = new Date(skillBase + i * 1000);
    await mkCall(t.id, `tot-tc-skill-${i}`, seed.toolName, 'completed', seed.result, JSON.stringify(seed.args), at);
    for (const [j, [toolName, args, result]] of (seed.more ?? []).entries()) {
      await mkCall(t.id, `tot-tc-skill-${i}-${j}`, toolName, 'completed', result, JSON.stringify(args), new Date(at.getTime() + 500));
    }
  }
  // 同轮里被截断的调用读的是别的技能（无事件）：不得把截断串到这一轮的事件上
  await mkCall(
    ctx.turnIds['skill:tot-skill-demo#1'], 'tot-tc-skill-foreign', 'exec_command', 'completed',
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
    for (const seed of SEEDS) {
      expect(byTurnId.get(ctx.turnIds[`skill:${seed.skill}#${SEEDS.indexOf(seed)}`])!.errorDigest, seed.skill).toBeUndefined();
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
    expect(container.querySelector('[data-slot="fact-chip"]')).toBeNull();
    expect(container.querySelector('[data-slot="fact-note"]')).toBeNull();
    expect(container.textContent).not.toContain('工具输出截断');
    expect(container.textContent).not.toContain('部分读取');
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
      const chips = blocks[i].querySelectorAll('[data-slot="fact-chip"][data-tone="amber"]');
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

describe('技能读取的逐次调用行：截断与部分读取', () => {
  let data: SkillsPanoramaData;
  beforeAll(async () => {
    data = await getSkills();
  });

  /** 种子序号 → 该轮的事件（事件按 turnId 对位） */
  const eventOf = (i: number) => data.events.find(e => e.turnId === ctx.turnIds[`skill:${SEEDS[i]!.skill}#${i}`])!;
  const turnIdOf = (i: number) => ctx.turnIds[`skill:${SEEDS[i]!.skill}#${i}`];

  it('run skills API：截断事实与读取覆盖面各归各位；没有事件的技能不凭空产生事件', () => {
    expect(eventOf(0).outputTruncation, '截断的编号读').toMatchObject({ harness: 'codex', totalLines: 9 });
    expect(eventOf(1).outputTruncation, '整文件读取').toBeNull();
    // 没有事件的技能不凭空产生事件
    expect(data.events.some(e => e.skillName === 'tot-skill-other')).toBe(false);
    expect(eventOf(10).outputTruncation, '过滤管道截断').toMatchObject({ harness: 'codex', totalLines: 96 });
    expect(eventOf(11).outputTruncation, 'Read 截断').toMatchObject({ harness: 'opencode', shownLines: { from: 19, to: 34 } });
  });

  it('run skills API：读取覆盖面三态——全文 / 部分 / 证明不了；总行数自己判不出时借同文件的', () => {
    const cov = (i: number) => eventOf(i).readCoverage;
    // 截断的编号读：尾部压在范围上界，自己判不出总行数 → 借同文件整文件读取的 10 行
    // 紧贴截断缝的尾段首行按残行保守丢弃 → 尾部只剩第 10 行
    expect(cov(0)).toEqual({ kind: 'partial', lines: [{ from: 2, to: 4 }, { from: 10, to: 10 }], fileLines: 10 });
    // 整文件 cat：总行数自证
    expect(cov(1)).toEqual({ kind: 'full', lines: [{ from: 1, to: 10 }], fileLines: 10 });
    // 有界读：总行数借同文件的
    expect(cov(2)).toEqual({ kind: 'partial', lines: [{ from: 3, to: 5 }], fileLines: 10 });
    // 范围宽过文件（1,300 读 10 行文件）= 读完了，不是部分读取
    expect(cov(3)).toEqual({ kind: 'full', lines: [{ from: 1, to: 10 }], fileLines: 10 });
    // cat 后跟 echo：行号可定，总行数借同文件的 → 全文
    expect(cov(4)).toEqual({ kind: 'full', lines: [{ from: 1, to: 10 }], fileLines: 10 });
    // tail：没有文件行号语义 → 无从判定
    expect(cov(5)).toBeNull();
    // Read 工具 offset/limit
    expect(cov(6)).toEqual({ kind: 'partial', lines: [{ from: 6, to: 7 }], fileLines: 10 });
    // 同轮：截断的 cat + 整文件 cat → 这次调用拿到了全文
    expect(cov(7)).toEqual({ kind: 'full', lines: [{ from: 1, to: 10 }], fileLines: 10 });
    // 没有同文件的其他读取：总行数未知，但命令限了范围 → 确定是部分
    expect(cov(8)).toEqual({ kind: 'partial', lines: [{ from: 7, to: 9 }], fileLines: null });
    // cat 后跟别的输出：总行数未知、命令没限范围 → 证明不了
    expect(cov(10)).toBeNull();
    expect(cov(11)).toBeNull();
    const loneCat = data.events.find(e => e.skillName === 'tot-skill-lone' && e.eventType === 'use' && e.turnId !== turnIdOf(8))!;
    expect(loneCat.readCoverage).toEqual({ kind: 'unproven', lines: [{ from: 1, to: 12 }], fileLines: null });
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

  /** 逐次调用行：turnId → 行元素（行上带跳转按钮 data-skill-jump、事件锚点 data-skill-event） */
  function rowOf(container: HTMLElement, turnId: string): HTMLElement {
    const row = container.querySelector(`[data-skill-jump="${turnId}"]`)!.closest('[data-skill-event]') as HTMLElement | null;
    expect(row, turnId).toBeTruthy();
    return row!;
  }

  it('截断且行号可定：琥珀「工具输出截断」+ 说明行写 agent 实际读到的行；悬停另给输出规模', () => {
    const container = renderPanorama();
    selectSkill(container, 'tot-skill-demo');
    const row = rowOf(container, turnIdOf(0));
    expect(row.dataset.skillReadMark).toBe('truncated');
    const chip = row.querySelector('[data-slot="fact-chip"]')!;
    expect(chip.getAttribute('data-tone')).toBe('amber');
    expect(chip.textContent?.trim()).toBe('工具输出截断');
    expect(row.querySelector('[data-slot="fact-note"]')!.textContent).toBe('输出被截断，SKILL.md 共 10 行，agent 读到第 2–4、10 行。');
    act(() => { container.remove(); });
  });

  it('命令自带行范围没读全：中性「部分读取」+ 说明行写读到的行与文件总行数', () => {
    const container = renderPanorama();
    selectSkill(container, 'tot-skill-demo');
    for (const [i, ranges] of [[2, '3–5'], [6, '6–7']] as const) {
      const row = rowOf(container, turnIdOf(i));
      expect(row.dataset.skillReadMark, `seed ${i}`).toBe('partial');
      const chip = row.querySelector('[data-slot="fact-chip"]')!;
      expect(chip.getAttribute('data-tone'), `seed ${i}`).toBe('neutral');
      expect(chip.textContent?.trim(), `seed ${i}`).toBe('部分读取');
      expect(row.querySelector('[data-slot="fact-note"]')!.textContent, `seed ${i}`).toBe(`agent 只读取了第 ${ranges} 行（SKILL.md 共 10 行）。`);
    }
    act(() => { container.remove(); });
  });

  it('总行数未知的有界读：只写读到的行，不编总行数', () => {
    const container = renderPanorama();
    selectSkill(container, 'tot-skill-lone');
    const row = rowOf(container, turnIdOf(8));
    expect(row.dataset.skillReadMark).toBe('partial');
    expect(row.querySelector('[data-slot="fact-note"]')!.textContent).toBe('agent 只读取了 SKILL.md 的第 7–9 行。');
    act(() => { container.remove(); });
  });

  it('读完 / 证明不了 / 无从判定：零标记零说明——含「范围宽过文件」与「同轮补齐」两个易误报形态', () => {
    const container = renderPanorama();
    selectSkill(container, 'tot-skill-demo');
    // 1 整文件 cat；3 范围宽过文件；4 cat 后跟 echo；5 tail；7 同轮截断 + 整文件
    for (const i of [1, 3, 4, 5, 7]) {
      const row = rowOf(container, turnIdOf(i));
      expect(row.dataset.skillReadMark, `seed ${i}`).toBeUndefined();
      expect(row.querySelector('[data-slot="fact-chip"]'), `seed ${i}`).toBeNull();
      expect(row.querySelector('[data-slot="fact-note"]'), `seed ${i}`).toBeNull();
    }
    act(() => { container.remove(); });
    const lone = renderPanorama();
    selectSkill(lone, 'tot-skill-lone');
    const unproven = Array.from(lone.querySelectorAll('[data-skill-read-mark]')) as HTMLElement[];
    expect(unproven.map(r => r.dataset.skillReadMark)).toEqual(['partial']);
    act(() => { lone.remove(); });
  });

  it('截断但行号归因不了：退回输出规模的说法（两种运行环境）', () => {
    const container = renderPanorama();
    selectSkill(container, 'tot-skill-shell');
    expect(rowOf(container, turnIdOf(10)).querySelector('[data-slot="fact-note"]')!.textContent)
      .toBe('输出被截断，原始 2707 tokens、共 96 行，agent 未看到全文。');
    act(() => { container.remove(); });
    const read = renderPanorama();
    selectSkill(read, 'tot-skill-read');
    expect(rowOf(read, turnIdOf(11)).querySelector('[data-slot="fact-note"]')!.textContent)
      .toBe('输出被截断，仅显示第 19–34 行（共 34 行），agent 未看到全文。');
    act(() => { read.remove(); });
  });

  it('明细卡标题行汇总次数：截断与部分读取分列，与逐次调用行的标记数一致', () => {
    const container = renderPanorama();
    selectSkill(container, 'tot-skill-demo');
    const counts = Array.from(container.querySelectorAll('[data-slot="skill-read-count"]')).map(el => el.textContent?.trim());
    expect(counts).toEqual(['1 次输出截断', '2 次部分读取']);
    const marks = Array.from(container.querySelectorAll<HTMLElement>('[data-skill-read-mark]')).map(r => r.dataset.skillReadMark);
    expect(marks).toEqual([...MARKED['tot-skill-demo']]);
    act(() => { container.remove(); });
  });
});
