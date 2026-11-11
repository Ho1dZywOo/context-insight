// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software that you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// cannbay-bundle IT（run 级上传：数据源 = insight，与会话上传同款「导入后
// 上传」链路）：本地导入 bundle → run-store 落盘（manifest + report 副本）
// → uploadLakeBundle(prisma, runId, …, category)（staging + 治理）→ push →
// 列表 → lake 导入 job 闭环。统一布局（目录即目录，按数据加载）：bundle 落
// <范式>/<runId>/（位置即身份，范式=所在目录）、缺省根级、换目录重传原子
// 迁移（runId 全仓唯一）、历史专区 opsbot-bundle/ 锚定兼容、同目录会话与
// bundle 共存（会话清单排除 bundle 内部）。治理熔断、manifest 深度清洗、
// 原子整体替换、DB 导出兜底、缺行成员容忍、大小限、路由 action。env 必须
// 在 lake 模块加载前设置。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';
import { seedLakeConfig } from '../helpers/lake-env';

function git(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: 'pipe', timeout: 60_000 }).toString();
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lake-bundle-it-'));
const BARE = path.join(TMP, 'remote.git');
const SEED = path.join(TMP, 'seed');
const CACHE = path.join(TMP, 'cache');
const HOME = path.join(TMP, 'home');           // CONTEXT_INSIGHT_HOME：run-store 隔离
const FIXTURES = path.join(TMP, 'fixtures');
const RUNS_ROOT = path.join(HOME, 'runs');

execSync(`git init --bare -b main "${BARE}"`, { stdio: 'pipe' });
git('git config uploadpack.allowFilter true', BARE);
git('git config uploadpack.allowAnySHA1InWant true', BARE);
execSync(`git clone --quiet "${BARE}" "${SEED}"`, { stdio: 'pipe' });
fs.writeFileSync(path.join(SEED, 'README.md'), '# lake bundle test\n');
// 含 *.jsonl/*.gz LFS 行：bundle 上传同款剔除防线（remote.lfs=false）
fs.writeFileSync(path.join(SEED, '.gitattributes'), '*.jsonl filter=lfs diff=lfs merge=lfs -text\n*.gz filter=lfs diff=lfs merge=lfs -text\n');
fs.mkdirSync(path.join(SEED, 'others'), { recursive: true });
fs.writeFileSync(path.join(SEED, 'others', '.gitkeep'), '');
fs.mkdirSync(path.join(SEED, 'reduction'), { recursive: true });
fs.writeFileSync(path.join(SEED, 'reduction', '.gitkeep'), '');
git('git add .', SEED);
git('git -c user.name=seed -c user.email=seed@t commit -q -m init', SEED);
git('git push -q origin main', SEED);

seedLakeConfig(TMP, { address: BARE });
process.env.LAKE_LFS = '0';
process.env.LAKE_CACHE_DIR = CACHE;
process.env.CONTEXT_INSIGHT_HOME = HOME;

// ── fixture 构造 ──────────────────────────────────────────────────────

const RUN_ID = 'bndit01';
const RUN_ID_KEY = 'bndit02';
const LEGACY_ID = 'legit01';

function sessionJsonl(sid: string, text: string): string {
  return [
    JSON.stringify({ type: 'user', message: { role: 'user', content: `bundle 会话 ${sid}：${text}` }, timestamp: '2026-10-10T03:00:00.000Z' }),
    JSON.stringify({ type: 'assistant', message: { id: `msg_${sid}`, role: 'assistant', content: [{ type: 'text', text: `完成 ${sid}` }], model: 'test-model', usage: { input_tokens: 100, output_tokens: 20 } }, timestamp: '2026-10-10T03:00:05.000Z' }),
  ].join('\n') + '\n';
}

function sessionMeta(sid: string): string {
  return JSON.stringify({ x_lake: { schema: 'cc-session-meta', version: 1, data: { producer: 'insight-export', framework: 'opencode', ccVersion: '1.19.0', sid } } });
}

interface MemberSeed { id: string; kind: 'session' | 'process'; name: string; sessionId?: string; location?: string | null; output?: { text: string } }

function manifestJson(runId: string, members: MemberSeed[], relations: Array<{ from: string; to: string }>, name = 'lake bundle IT'): string {
  return JSON.stringify({
    schema: 'workflow-bundle',
    version: 1,
    id: runId,
    kind: 'workflow',
    name,
    startedAt: null,
    finishedAt: null,
    data: {
      exportDataComplete: true,
      members: members.map(m => ({
        id: m.id, kind: m.kind, name: m.name, startedAt: null, finishedAt: null,
        ...(m.kind === 'session' ? { sessionId: m.sessionId ?? null, location: m.location ?? null } : {}),
        ...(m.output ? { output: m.output } : {}),
      })),
      relations: relations.map(r => ({ from: r.from, to: r.to, type: 'depends_on' })),
    },
  }, null, 1);
}

// 结构校验权威随包分发：本地组装 bundle 也带 workflow.schema.json（与真实导出件同源）
const SCHEMA_TEXT = fs.readFileSync(path.resolve(__dirname, '../ut/data/run/workflow-bundle.v1.schema.json'), 'utf-8');

function reportJson(status: string, members: number, sessionFiles: number): string {
  return JSON.stringify({ graph_id: RUN_ID, status, exportDataComplete: true, totals: { members, relations: 1, session_files: sessionFiles }, missing_source_sessions: [], orphan_sessions: [], undetermined_relations: [], problems: [] });
}

/** 组装一个本地 bundle 目录。sessionIds = 会话正文集合；stray 控制杂散文件。 */
function buildBundle(dir: string, runId: string, opts: { manifestName?: string; report?: string; members?: MemberSeed[]; sids: string[]; stray?: boolean; manifestOverride?: string }): void {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const members = opts.members ?? [
    ...opts.sids.map(sid => ({ id: sid, kind: 'session' as const, name: `${sid} 执行`, sessionId: sid, location: `sessions/${sid}` })),
    { id: 'M1', kind: 'process' as const, name: '打包', output: { text: 'done' } },
  ];
  // 关系端点从实际成员推导（session 成员 → 最后一个 process 成员）
  const processId = [...members].reverse().find(m => m.kind === 'process')?.id;
  const relations = processId != null
    ? members.filter(m => m.kind === 'session').map(m => ({ from: m.id, to: processId }))
    : [];
  fs.writeFileSync(path.join(dir, opts.manifestName ?? 'workflow.json'), opts.manifestOverride ?? manifestJson(runId, members, relations));
  fs.writeFileSync(path.join(dir, 'workflow.schema.json'), SCHEMA_TEXT);
  if (opts.report != null) fs.writeFileSync(path.join(dir, 'report.json'), opts.report);
  for (const sid of opts.sids) {
    fs.mkdirSync(path.join(dir, 'sessions', sid), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sessions', sid, `${sid}.jsonl`), sessionJsonl(sid, '正文'));
    fs.writeFileSync(path.join(dir, 'sessions', sid, `${sid}.meta.json`), sessionMeta(sid));
  }
  if (opts.stray) {
    fs.writeFileSync(path.join(dir, '.DS_Store'), 'junk');
    fs.writeFileSync(path.join(dir, 'sessions', opts.sids[0], '.DS_Store'), 'junk');
  }
}

const prisma = new PrismaClient();

// env 已设，动态加载 lake/bundle 链与路由
const lake = await import('../../src/lib/lake');
const bundle = await import('../../src/lib/lake/bundle');
const governance = await import('../../src/lib/lake/governance');
const importService = await import('../../src/lib/run/import-service');
const route = await import('../../src/app/api/ingest/lake/route');

const treeFiles = (): string[] => git('git ls-tree -r --name-only main', BARE).split('\n').filter(Boolean);

function makeRequest(body: unknown) {
  return new NextRequest('http://localhost/api/ingest/lake', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function waitForJob(jobId: string, timeoutMs = 30_000): Promise<NonNullable<ReturnType<typeof importService.getImportJob>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = importService.getImportJob(jobId);
    if (state && (state.step === 'done' || state.step === 'error')) return state;
    if (Date.now() > deadline) throw new Error(`import job ${jobId} timeout (step=${state?.step})`);
    await new Promise(r => setTimeout(r, 100));
  }
}

/** 本地导入 bundle（run 级上传的数据源准备）。 */
async function importLocalBundle(dir: string): Promise<void> {
  const validation = importService.validateBundleDir(dir);
  expect(validation.ok).toBe(true);
  const jobId = importService.createImportJob(dir, validation.manifest!, { prisma, root: RUNS_ROOT });
  const state = await waitForJob(jobId);
  expect(state.step).toBe('done');
  expect(state.error).toBeNull();
}

/** 直接经 seed 工作树向数据仓推送文件（legacy 布局/多重位置夹具构造）。
 *  seed 克隆落后于上传管道推进的 main（镜像直推）——commit 后 rebase 再
 *  push；git 命令中和 lfs filter（仓内 .gitattributes 带 filter=lfs 行，
 *  客户机无 git-lfs 时 add/checkout 会炸，与 mirror.runGit 同款纪律）。 */
function pushSeedFiles(files: Array<{ rel: string; content: string }>, message: string): void {
  const NEUTRAL = '-c filter.lfs.process= -c filter.lfs.smudge=cat -c filter.lfs.clean=cat -c filter.lfs.required=false';
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(SEED, f.rel)), { recursive: true });
    fs.writeFileSync(path.join(SEED, f.rel), f.content);
  }
  git(`git ${NEUTRAL} add .`, SEED);
  git(`git -c user.name=seed -c user.email=seed@t commit -q -m "${message}"`, SEED);
  git(`git ${NEUTRAL} pull --rebase -q origin main`, SEED);
  git(`git ${NEUTRAL} push -q origin main`, SEED);
}

beforeAll(async () => {
  // 直接 vitest（绕过 pretest 重建库）重跑时清掉上次导入的夹具行
  await prisma.session.deleteMany({ where: { taskId: { in: ['S1', 'S2', 'SK1', 'LEG1'] } } });
  buildBundle(path.join(FIXTURES, RUN_ID), RUN_ID, {
    sids: ['S1'],
    report: reportJson('failed', 2, 1),
    stray: true,
  });
  await importLocalBundle(path.join(FIXTURES, RUN_ID));
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: { in: ['S1', 'S2', 'SK1', 'LEG1'] } } }).catch(() => {});
  await prisma.$disconnect().catch(() => {});
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('run 本地导入（上传数据源 = insight）', () => {
  it('导入 job 完成：run-store 落盘 + report 随行副本 + 会话入库（framework 恢复）', async () => {
    const runsRoot = await import('../../src/lib/run/run-store');
    const stored = runsRoot.readRun(RUN_ID, RUNS_ROOT);
    expect(stored).toBeTruthy();
    expect(stored!.manifest.id).toBe(RUN_ID);
    // report.json 落 run 目录：源目录删除后仍可整包重传
    expect(fs.existsSync(path.join(RUNS_ROOT, RUN_ID, 'report.json'))).toBe(true);

    const row = await prisma.session.findFirst({ where: { taskId: 'S1' } });
    expect(row).toBeTruthy();
    expect(row!.framework).toBe('opencode');
  });
});

describe('bundle 上传（run → 数据仓，统一布局：落 <范式>/<runId>/）', () => {
  it('upload：manifest/report 落盘件出仓 + 成员会话装配（7z）+ meta 合成 + LFS 行剔除 + 杂散文件挡在仓外', async () => {
    const result = await bundle.uploadLakeBundle(prisma, RUN_ID, '提交人: 张三\n内容描述: bundle IT 上传', undefined, 'others');
    expect(result.runId).toBe(RUN_ID);
    expect(result.unchanged).toBe(false);
    expect(result.folder).toBe(`others/${RUN_ID}/`);
    expect(result.sessionCount).toBe(1);
    expect(result.missingSessions).toEqual([]);

    const files = treeFiles();
    const prefix = `others/${RUN_ID}/`;
    expect(files).toContain(`${prefix}workflow.json`);
    expect(files).toContain(`${prefix}report.json`);
    expect(files).toContain(`${prefix}bundle.meta.json`);
    expect(files).toContain(`${prefix}sessions/S1/S1.jsonl.7z`);
    expect(files).toContain(`${prefix}sessions/S1/S1.meta.json`);
    // 杂散文件（.DS_Store，源目录里有）不进仓——staging 按 manifest 装配
    expect(files.some(f => f.includes('.DS_Store'))).toBe(false);
    // .gitattributes 的 filter=lfs 行被剔除（seed 带 *.jsonl/*.gz）
    const ga = git('git show main:.gitattributes', BARE);
    expect(ga).not.toContain('filter=lfs');
  });

  it('schema 随包权威进仓：治理豁免，与源文本逐字一致', () => {
    const files = treeFiles();
    expect(files).toContain(`others/${RUN_ID}/workflow.schema.json`);
    // 治理深度清洗豁免 schema 文件——与受信任哈希源逐字一致（哈希闸的前提）
    expect(git(`git show main:others/${RUN_ID}/workflow.schema.json`, BARE)).toBe(SCHEMA_TEXT);
  });

  it('bundle.meta.json：cc-bundle-meta 信封 + 提交人/规模快照（无范式字段——位置即身份）', () => {
    const raw = git(`git show main:others/${RUN_ID}/bundle.meta.json`, BARE);
    const parsed = JSON.parse(raw);
    expect(parsed.x_lake.schema).toBe('cc-bundle-meta');
    expect(parsed.x_lake.version).toBe(1);
    expect(parsed.x_lake.data.runId).toBe(RUN_ID);
    expect(parsed.x_lake.data.submitter).toBe('张三');
    expect(parsed.x_lake.data.description).toBe('bundle IT 上传');
    expect(parsed.x_lake.data.sessionCount).toBe(1);
    expect(parsed.x_lake.data.memberCount).toBe(2);
    // 统一布局：范式不入 meta——由所在目录推导（列表 paradigm 字段）
    expect(parsed.x_lake.data.paradigm).toBeUndefined();
  });

  it('bundle-list：锚定目录 + report/meta 汇总 + 范式=所在目录；imported 标记（本地导入后即 true）', () => {
    const items = bundle.listLakeBundles(undefined, RUNS_ROOT);
    const entry = items.find(e => e.runId === RUN_ID);
    expect(entry).toBeTruthy();
    expect(entry!.name).toBe('lake bundle IT');
    expect(entry!.status).toBe('failed');
    expect(entry!.exportDataComplete).toBe(true);
    expect(entry!.memberCount).toBe(2);
    expect(entry!.sessionCount).toBe(1);
    expect(entry!.submitter).toBe('张三');
    expect(entry!.paradigm).toBe('others');
    expect(entry!.imported).toBe(true);
  });

  it('同目录共存：会话上传进含 bundle 的范式目录；bundle 成员会话不进 lake 会话列表', async () => {
    // 真实会话 S1 上传进 others/（bundle 也在该目录）——两类资产同目录并存
    await lake.uploadLakeSession(prisma, 'S1', '提交人: 张三\n内容描述: 同目录共存', undefined, 'others');
    const { sessions } = lake.listLakeOverview();
    // S1 恰与 bundle 成员 sid 同名：列表只出现真实会话位一条（others/S1/），
    // bundle 内部 others/bndit01/sessions/S1/ 被锚定排除，不产生第二条
    const s1 = sessions.filter(s => s.sid === 'S1');
    expect(s1).toHaveLength(1);
    expect(s1[0].paradigm).toBe('others');
  });

  it('未导入的 run 上传 → 明确报错（数据源是已导入 run）', async () => {
    await expect(
      bundle.uploadLakeBundle(prisma, 'no-such-run', '提交人: 张三\n内容描述: x', undefined, 'others'),
    ).rejects.toThrow(/未导入/);
  });

  it('旧版本导入的 run（run 目录缺 schema）上传 → 显式拒绝', async () => {
    // 模拟存量：导入后删掉 run 目录里的随包 schema（旧版本导入形态）
    const schemaInRun = path.join(RUNS_ROOT, RUN_ID, 'workflow.schema.json');
    const backup = fs.readFileSync(schemaInRun, 'utf-8');
    fs.rmSync(schemaInRun);
    try {
      await expect(
        bundle.uploadLakeBundle(prisma, RUN_ID, '提交人: 张三\n内容描述: 旧 run', undefined, 'others'),
      ).rejects.toThrow(/workflow\.schema\.json/);
    } finally {
      fs.writeFileSync(schemaInRun, backup);
    }
  });

  it('upload 带算子生成标注：meta 快照 + commit 范式行 + 列表呈现；非法范式拒绝', async () => {
    const result = await bundle.uploadLakeBundle(prisma, RUN_ID, '提交人: 王五\n内容描述: 归属标注', undefined, 'others', 'success');
    expect(result.unchanged).toBe(false);

    // bundle.meta.json：opGen 归属快照（范式不入 meta——位置即身份）
    const meta = JSON.parse(git(`git show main:others/${RUN_ID}/bundle.meta.json`, BARE));
    expect(meta.x_lake.schema).toBe('cc-bundle-meta');
    expect(meta.x_lake.data.opGen).toBe('success');
    expect(meta.x_lake.data.paradigm).toBeUndefined();
    expect(meta.x_lake.data.submitter).toBe('王五');

    // commit message 范式行（与人读 git log 同源，置于 body）
    const body = git('git log -1 --pretty=%b main', BARE);
    expect(body).toContain('范式: others');
    expect(body).toContain(`bundle: ${RUN_ID}`);

    // 列表读侧：范式（位置推导）/算子生成列数据
    const entry = bundle.listLakeBundles(undefined, RUNS_ROOT).find(e => e.runId === RUN_ID)!;
    expect(entry.paradigm).toBe('others');
    expect(entry.opGen).toBe('success');

    // 非法范式（数据仓不存在的顶层目录）→ 拒绝上传
    await expect(
      bundle.uploadLakeBundle(prisma, RUN_ID, '提交人: 王五\n内容描述: x', undefined, 'no-such-paradigm'),
    ).rejects.toThrow(/范式目录/);
  });

  it('缺省上传（无范式目录）→ 根级 <runId>/；meta 原子替换后标注清空', async () => {
    const result = await bundle.uploadLakeBundle(prisma, RUN_ID, '提交人: 王五\n内容描述: 无标注');
    expect(result.unchanged).toBe(false);
    expect(result.folder).toBe(`${RUN_ID}/`);

    // 根级落盘 + 旧位置（others/bndit01/）原子迁移删除——runId 全仓唯一
    const files = treeFiles();
    expect(files).toContain(`${RUN_ID}/workflow.json`);
    expect(files).toContain(`${RUN_ID}/sessions/S1/S1.jsonl.7z`);
    expect(files.some(f => f.startsWith(`others/${RUN_ID}/`))).toBe(false);

    // meta 是整包快照：原子替换后 opGen 清空（CLI/历史通道缺省不标注）
    const meta = JSON.parse(git(`git show main:${RUN_ID}/bundle.meta.json`, BARE));
    expect(meta.x_lake.data.opGen).toBeUndefined();

    // 列表范式 = null（根级无目录前缀）
    const entry = bundle.listLakeBundles(undefined, RUNS_ROOT).find(e => e.runId === RUN_ID)!;
    expect(entry.paradigm).toBeNull();
  });

  it('换目录重传 = 原子迁移：新目录落盘 + 旧根级位置同 commit 删除', async () => {
    const result = await bundle.uploadLakeBundle(prisma, RUN_ID, '提交人: 王五\n内容描述: 换目录迁移', undefined, 'reduction');
    expect(result.folder).toBe(`reduction/${RUN_ID}/`);
    const files = treeFiles();
    expect(files).toContain(`reduction/${RUN_ID}/workflow.json`);
    expect(files.some(f => f.startsWith(`${RUN_ID}/`))).toBe(false);
    expect(files.some(f => f.startsWith(`others/${RUN_ID}/`))).toBe(false);

    // 列表唯一一条，范式 = 新目录
    const entries = bundle.listLakeBundles(undefined, RUNS_ROOT).filter(e => e.runId === RUN_ID);
    expect(entries).toHaveLength(1);
    expect(entries[0].paradigm).toBe('reduction');
  });
});

describe('bundle 导入：物化 → 解压 → run 导入 job → Run 工作台可见', () => {
  it('bundle-import（runId 全仓搜索）：job 完成（既有会话幂等）、物化目录自清理', async () => {
    const handle = await bundle.importLakeBundle(RUN_ID, { prisma, root: RUNS_ROOT });
    expect(handle.state.runId).toBe(RUN_ID);
    const state = await waitForJob(handle.jobId);
    expect(state.step).toBe('done');
    expect(state.error).toBeNull();
    // S1 已在本地导入时入库 → 幂等走 existing
    expect(state.existing).toBe(1);

    // 列表 imported 维持
    expect(bundle.listLakeBundles(undefined, RUNS_ROOT).find(e => e.runId === RUN_ID)!.imported).toBe(true);

    // 物化 tmp 目录由 job 终态自清理（.finally 在 done 后落定）——只查本
    // runId 前缀：并行 worker 里其它测试文件的物化目录不该被误伤
    await new Promise(r => setTimeout(r, 300));
    const leftovers = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith(`lake-bundle-import-${RUN_ID}-`));
    expect(leftovers).toEqual([]);
  });

  it('路由 action：bundle-list / bundle-import（paradigm 精确定位 + 4xx 校验）/ bundle-upload（runId 通道）', async () => {
    const listRes = await route.POST(makeRequest({ action: 'bundle-list' }));
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.items.some((e: { runId: string }) => e.runId === RUN_ID)).toBe(true);
    // 目录清单与会话范式注册表同源（导入弹窗目录选择阶段数据）
    expect(Array.isArray(listBody.dirs)).toBe(true);
    expect(listBody.dirs).toContain('others');
    expect(listBody.dirs).toContain('reduction');

    expect((await route.POST(makeRequest({ action: 'bundle-import' }))).status).toBe(400); // 缺 runId
    expect((await route.POST(makeRequest({ action: 'bundle-upload' }))).status).toBe(400); // 缺 runId
    const soloRes = await route.POST(makeRequest({
      action: 'bundle-upload',
      runId: 'solo:94b6ab9d-b603-4777-910a-24d13e15c9c4',
      description: '提交人: 张三',
    }));
    expect(soloRes.status).toBe(400);
    expect(await soloRes.json()).toMatchObject({
      reason: 'solo-run-not-bundle',
      taskId: '94b6ab9d-b603-4777-910a-24d13e15c9c4',
      action: 'upload',
    });
    expect((await route.POST(makeRequest({ action: 'nope' }))).status).toBe(400);

    // paradigm 透传 = 精确物化（所在目录 reduction）
    const impRes = await route.POST(makeRequest({ action: 'bundle-import', runId: RUN_ID, paradigm: 'reduction' }));
    expect(impRes.status).toBe(200);
    const impHandle = await impRes.json() as { jobId: string };
    const impState = await waitForJob(impHandle.jobId);
    expect(impState.step).toBe('done');

    // paradigm 指错目录（bundle 不在该目录）→ 明确报错
    const wrongRes = await route.POST(makeRequest({ action: 'bundle-import', runId: RUN_ID, paradigm: 'others' }));
    expect(wrongRes.status).toBe(500);

    // bundle-upload 路由通道：category = 物理落点（迁移 reduction → others）
    const upRes = await route.POST(makeRequest({
      action: 'bundle-upload',
      runId: RUN_ID,
      description: '提交人: 李四\n内容描述: 路由通道上传',
      category: 'others',
      opGen: 'failure',
    }));
    expect(upRes.status).toBe(200);
    const upBody = await upRes.json();
    expect(upBody.runId).toBe(RUN_ID);
    expect(upBody.sessionCount).toBe(1);
    expect(upBody.missingSessions).toEqual([]);
    // opGen 路由透传 → meta；物理位置 = others/
    const meta = JSON.parse(git(`git show main:others/${RUN_ID}/bundle.meta.json`, BARE));
    expect(meta.x_lake.data.opGen).toBe('failure');
    expect(treeFiles().some(f => f.startsWith(`reduction/${RUN_ID}/`))).toBe(false);
  });
});

describe('bundle 治理：jsonl 全量清洗 + manifest 深度清洗 + 复检熔断', () => {
  it('manifest output.text 含厂商 key：深度清洗后上传，仓内件已掩码', async () => {
    buildBundle(path.join(FIXTURES, RUN_ID_KEY), RUN_ID_KEY, {
      sids: ['SK1'],
      members: [
        { id: 'SK1', kind: 'session', name: '执行', sessionId: 'SK1', location: 'sessions/SK1' },
        { id: 'M9', kind: 'process', name: '打包', output: { text: 'key 是 sk-ant-api03-AAAA1111BBBB2222CCCC3333DDDD4444EEEE5' } },
      ],
    });
    await importLocalBundle(path.join(FIXTURES, RUN_ID_KEY));
    await bundle.uploadLakeBundle(prisma, RUN_ID_KEY, '提交人: 张三\n内容描述: key 清洗', undefined, 'others');
    const raw = git(`git show main:others/${RUN_ID_KEY}/workflow.json`, BARE);
    expect(raw).not.toContain('AAAA1111BBBB');
    expect(raw).toContain('…');
  });

  it('复检残留 → 熔断拒绝上传，远端不推进', async () => {
    const before = git('git rev-parse main', BARE).trim();
    const spy = vi.spyOn(governance, 'governText').mockReturnValue({ output: '', residue: ['S1.jsonl: sk-ant-RESIDUE…'] });
    try {
      await expect(
        bundle.uploadLakeBundle(prisma, RUN_ID, '提交人: 张三\n内容描述: breaker', undefined, 'others'),
      ).rejects.toThrow(/熔断/);
    } finally {
      spy.mockRestore();
    }
    expect(git('git rev-parse main', BARE).trim()).toBe(before);
  });

  it('bundle 总量上限（压缩后字节）→ 熔断', async () => {
    const original = bundle.MAX_BUNDLE_BYTES.value;
    bundle.MAX_BUNDLE_BYTES.value = 1;
    try {
      await expect(
        bundle.uploadLakeBundle(prisma, RUN_ID, '提交人: 张三\n内容描述: size', undefined, 'others'),
      ).rejects.toThrow(/总量上限/);
    } finally {
      bundle.MAX_BUNDLE_BYTES.value = original;
    }
  });
});

describe('run 重导入 + 原子整体替换 + insight 数据源韧性', () => {
  it('v2 重导入（manifest.json 命名 + 换会话集合 + 新 report）→ 上传替换 v1', async () => {
    buildBundle(path.join(FIXTURES, `${RUN_ID}-v2`), RUN_ID, {
      manifestName: 'manifest.json', // 源命名差异化 → run 目录统一 manifest.json → 仓内统一 workflow.json
      sids: ['S2'],
      report: reportJson('passed', 2, 1),
    });
    await importLocalBundle(path.join(FIXTURES, `${RUN_ID}-v2`));
    const result = await bundle.uploadLakeBundle(prisma, RUN_ID, '提交人: 王五\n内容描述: 整体替换', undefined, 'others');
    expect(result.unchanged).toBe(false);

    const files = treeFiles();
    const prefix = `others/${RUN_ID}/`;
    expect(files).toContain(`${prefix}workflow.json`);      // 源 manifest.json 仓内统一命名
    expect(files).toContain(`${prefix}sessions/S2/S2.jsonl.7z`);
    expect(files.some(f => f.startsWith(`${prefix}sessions/S1/`))).toBe(false); // 旧会话整体消失

    const entry = bundle.listLakeBundles(undefined, RUNS_ROOT).find(e => e.runId === RUN_ID)!;
    expect(entry.status).toBe('passed');
    expect(entry.sessionCount).toBe(1);
    expect(entry.submitter).toBe('王五'); // meta 快照随重传刷新
  });

  it('源目录删除 → DB 导出兜底：仍可整包上传（report 走 run 目录副本）', async () => {
    fs.rmSync(path.join(FIXTURES, `${RUN_ID}-v2`), { recursive: true, force: true });
    const result = await bundle.uploadLakeBundle(prisma, RUN_ID, '提交人: 赵六\n内容描述: DB 导出兜底', undefined, 'others');
    expect(result.runId).toBe(RUN_ID);
    expect(result.sessionCount).toBe(1);
    expect(result.missingSessions).toEqual([]);

    const files = treeFiles();
    const prefix = `others/${RUN_ID}/`;
    expect(files).toContain(`${prefix}sessions/S2/S2.jsonl.7z`); // DB 导出重建正文
    expect(files).toContain(`${prefix}report.json`);            // run 目录副本兜底
    expect(files).toContain(`${prefix}bundle.meta.json`);
  });

  it('成员会话不在 insight（已删除）→ missingSessions 提示 + 包内缺正文，不阻断', async () => {
    await prisma.session.deleteMany({ where: { taskId: 'S2' } });
    const result = await bundle.uploadLakeBundle(prisma, RUN_ID, '提交人: 钱七\n内容描述: 缺行容忍', undefined, 'others');
    expect(result.sessionCount).toBe(0);
    expect(result.missingSessions).toEqual(['S2']);
    expect(result.warnings[0]).toMatch(/S2/);

    const files = treeFiles();
    expect(files.some(f => f.startsWith(`others/${RUN_ID}/sessions/`))).toBe(false);
    // manifest/report/meta 仍在——包结构完整，只是缺该成员正文
    expect(files).toContain(`others/${RUN_ID}/workflow.json`);
  });
});

describe('legacy 专区兼容 + 多重位置数据卫生（统一布局：锚定规则同构）', () => {
  // 手工在历史专区位置 opsbot-bundle/<runId>/ 推送 bundle（存量数据形态）
  beforeAll(() => {
    pushSeedFiles([
      { rel: `opsbot-bundle/${LEGACY_ID}/workflow.json`, content: manifestJson(LEGACY_ID, [
        { id: 'LEG1', kind: 'session', name: 'LEG1 执行', sessionId: 'LEG1', location: 'sessions/LEG1' },
        { id: 'M1', kind: 'process', name: '打包', output: { text: 'done' } },
      ], [{ from: 'LEG1', to: 'M1' }]) },
      { rel: `opsbot-bundle/${LEGACY_ID}/workflow.schema.json`, content: SCHEMA_TEXT },
      { rel: `opsbot-bundle/${LEGACY_ID}/sessions/LEG1/LEG1.jsonl`, content: sessionJsonl('LEG1', 'legacy 正文') },
      { rel: `opsbot-bundle/${LEGACY_ID}/sessions/LEG1/LEG1.meta.json`, content: sessionMeta('LEG1') },
    ], 'legacy zone bundle');
  });

  it('listBundles：历史专区位置同构识别（范式=opsbot-bundle）；成员会话不进会话列表', () => {
    const entries = bundle.listLakeBundles(undefined, RUNS_ROOT);
    const entry = entries.find(e => e.runId === LEGACY_ID);
    expect(entry).toBeTruthy();
    expect(entry!.paradigm).toBe('opsbot-bundle');
    expect(entry!.sessionCount).toBe(1);

    // 专区目录下的成员会话（LEG1）不进会话列表——锚定排除覆盖历史布局
    const { sessions } = lake.listLakeOverview();
    expect(sessions.some(s => s.sid === 'LEG1')).toBe(false);
    // 同目录真实会话（others/S1）不受影响
    expect(sessions.some(s => s.sid === 'S1' && s.paradigm === 'others')).toBe(true);
  });

  it('bundle-import（runId 搜索）：历史专区位置可导入', async () => {
    const handle = await bundle.importLakeBundle(LEGACY_ID, { prisma, root: RUNS_ROOT });
    const state = await waitForJob(handle.jobId);
    expect(state.step).toBe('done');
    expect(state.error).toBeNull();
    const row = await prisma.session.findFirst({ where: { taskId: 'LEG1' } });
    expect(row).toBeTruthy();
    expect(row!.framework).toBe('opencode');
  });

  it('同 runId 多处并存（手工推送产生）→ 裸 runId 导入报错列位置；paradigm 精确定位可用', async () => {
    // 手工把同一 runId 再推一份到 others/（绕过上传管道的迁移防线，模拟
    // 布局卫生问题）——runId 裸搜索应报错并列出两处位置
    pushSeedFiles([
      { rel: `others/${LEGACY_ID}/workflow.json`, content: manifestJson(LEGACY_ID, [
        { id: 'LEG1', kind: 'session', name: 'LEG1 执行', sessionId: 'LEG1', location: 'sessions/LEG1' },
        { id: 'M1', kind: 'process', name: '打包', output: { text: 'done' } },
      ], [{ from: 'LEG1', to: 'M1' }]) },
      { rel: `others/${LEGACY_ID}/workflow.schema.json`, content: SCHEMA_TEXT },
      { rel: `others/${LEGACY_ID}/sessions/LEG1/LEG1.jsonl`, content: sessionJsonl('LEG1', '重复位置正文') },
      { rel: `others/${LEGACY_ID}/sessions/LEG1/LEG1.meta.json`, content: sessionMeta('LEG1') },
    ], 'duplicate runId in others');

    const entries = bundle.listLakeBundles(undefined, RUNS_ROOT).filter(e => e.runId === LEGACY_ID);
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map(e => e.paradigm))).toEqual(new Set(['opsbot-bundle', 'others']));

    // 裸 runId：多重位置报错（数据卫生，交用户清理）
    await expect(bundle.importLakeBundle(LEGACY_ID, { prisma, root: RUNS_ROOT })).rejects.toThrow(/多个目录/);

    // paradigm 精确定位：按目录物化可用
    const handle = await bundle.importLakeBundle(LEGACY_ID, { prisma, root: RUNS_ROOT }, undefined, 'others');
    const state = await waitForJob(handle.jobId);
    expect(state.step).toBe('done');
  });
});
