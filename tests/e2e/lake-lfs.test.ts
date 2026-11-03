// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// lake LFS 模式 IT（与 cpx tests/lake-lfs.test.ts 对位）：remote.lfs
// 显式构造（不走 env，隔离干净），file:// 本地 bare + git-lfs standalone
// 传输。镜像层闭环验证：
//   ① uploadFolder：.jsonl.gz 出仓为 LFS 指针、实体落 bare.git/lfs/objects、
//      .gitattributes 保留 filter=lfs 行（缺行自动补）、meta.json 普通 blob
//   ② materializeSession：指针经 cat-file --filters（smudge 按需取实体）
//      恢复真实 gzip 字节——LFS 仓导入闭环
//   ③ listSessions：meta.json 是普通 blob，type 列照常可读
//   ④ 幂等 unchanged（指针级）
//   ⑤ 注入面回归锁：repoPath 含 shell 元字符（引号/分号/空格）的文件名
//      （ls-tree -z 原始输出，除 NUL 外任意字节都可能）物化不得执行注入
//      命令——cat-file 必须走 spawnSync argv 形式，不得内插 shell 字符串
//   ⑥ 工作树 .gitattributes 过期回归锁：默认模式上传剔除过 lfs 行的副本
//      留在镜像工作树，LFS 导入前必须按"缺声明"判定刷新（不是仅看文件
//      存在）——否则 --filters 不做 smudge，指针文本被当 gzip 落盘
//   ⑦ uploadBundleFolder：bundle 内 .jsonl.7z 指针出仓 + 实体落 LFS 存储
//      + manifest（workflow.json）普通 blob + *.7z 声明进仓
//   ⑧ materializeBundle：指针 → 真实字节（--filters smudge）+ 工作树
//      .gitattributes 过期刷新（⑥ 的 bundle 版——该路径此前缺失就绪准备，
//      过期副本下指针文本会被当 7z 落盘、git-lfs 缺失时 git 原文直抛）
// 客户机无 git-lfs 时整组跳过（LFS 模式的硬前置；无 git-lfs 机器的
// fail-fast 指引由 ut lake-lfs-read-prep-it.test.ts 锁定）。

import { describe, it, expect, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { hasGitLfs } from '../../src/lib/lake/mirror';
import type { LakeRemote } from '../../src/lib/lake/remote';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lake-lfsmode-it-'));
const BARE = path.join(TMP, 'remote.git');
const BARE_URL = `file://${BARE}`;
const SEED = path.join(TMP, 'seed');
const STAGING = path.join(TMP, 'staging');
const CACHE = path.join(TMP, 'cache');

const SID = 'ses_lfsmode01ffeetestAA';
// 注入探针文件名：内插进双引号 shell 字符串时 `"; touch <PWN_NAME>; "` 会截断
// 命令并执行 touch（旧实现 execSync 的 cwd=镜像目录，文件落在镜像根）——
// argv 形式下只是普通文件名。文件名不能带 /（会被当目录分隔符），哨兵用相对名
const PWN_NAME = 'pwned-by-injection';
const EVIL_NAME = `evil"; touch ${PWN_NAME}; ".jsonl.gz`;
const EVIL_GZ = zlib.gzipSync('{"type":"user","message":{"role":"user","content":"sub"}}\n');

function git(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: 'pipe', timeout: 60_000 }).toString();
}

function buildRemote(): LakeRemote {
  return {
    pullUrl: BARE_URL,
    pushUrl: BARE_URL,
    pushAuth: null,
    pullAuth: null,
    branch: 'main',
    rootDir: 'sessions',
    cacheDir: CACHE,
    lfs: true,
  };
}

// ── seed：带 *.gz lfs 声明的 .gitattributes + others/ 范式目录 ──
execSync(`git init --bare -b main "${BARE}"`, { stdio: 'pipe' });
execSync(`git clone --quiet "${BARE_URL}" "${SEED}"`, { stdio: 'pipe' });
fs.writeFileSync(path.join(SEED, '.gitattributes'), '*.gz filter=lfs diff=lfs merge=lfs -text\n');
fs.mkdirSync(path.join(SEED, 'others'), { recursive: true });
fs.writeFileSync(path.join(SEED, 'others', '.gitkeep'), '');
git('git add .', SEED);
git('git -c user.name=seed -c user.email=seed@t commit -q -m init', SEED);
git('git push -q origin main', SEED);

// ── staging：sessions/<sid>/<sid>.jsonl.gz + meta.json（镜像层接口约定） ──
const SESSION_LINES = [
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'lfs mode fixture' }, timestamp: '2026-09-15T03:00:00.000Z' }),
  JSON.stringify({ type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'ok' }], model: 'test-model', usage: { input_tokens: 10, output_tokens: 2 } }, timestamp: '2026-09-15T03:00:05.000Z' }),
].join('\n') + '\n';
const MAIN_GZ = zlib.gzipSync(SESSION_LINES);
fs.mkdirSync(path.join(STAGING, 'sessions', SID), { recursive: true });
fs.writeFileSync(path.join(STAGING, 'sessions', SID, `${SID}.jsonl.gz`), MAIN_GZ);
fs.writeFileSync(path.join(STAGING, 'sessions', SID, `${SID}.meta.json`), JSON.stringify({
  x_lake: { schema: 'cc-session-meta', version: 1, data: { producer: 'cpx', framework: 'claude-code', ccVersion: '9.9.9', sid: SID } },
}));
// subagents/ 下放注入探针文件（随 ① 的 uploadFolder 出仓为 LFS 指针）
fs.mkdirSync(path.join(STAGING, 'sessions', SID, 'subagents'), { recursive: true });
fs.writeFileSync(path.join(STAGING, 'sessions', SID, 'subagents', EVIL_NAME), EVIL_GZ);

// ── bundle staging：staging-bundle/<runId>/ = workflow.json + 压缩会话（⑦⑧ 用）──
const RUN_ID = 'run_lfsbundle01';
const SID_B = 'ses_lfsbundle01ffeetestAA';
// .jsonl.7z 出仓形态的实体（无需真 7z 归档——物化只锁字节级往返，解压归编排层）
const SEVEN_Z = Buffer.from('fake-7z-payload-for-lfs-roundtrip\n');
const STAGING_BUNDLE = path.join(TMP, 'staging-bundle');
fs.mkdirSync(path.join(STAGING_BUNDLE, RUN_ID, 'sessions', SID_B), { recursive: true });
fs.writeFileSync(path.join(STAGING_BUNDLE, RUN_ID, 'workflow.json'), '{"schema":"workflow-bundle"}');
fs.writeFileSync(path.join(STAGING_BUNDLE, RUN_ID, 'sessions', SID_B, `${SID_B}.jsonl.7z`), SEVEN_Z);

const { uploadFolder, materializeSession, listSessions, uploadBundleFolder, materializeBundle } = await import('../../src/lib/lake/mirror');
const { privateLfsBinDir } = await import('../../src/lib/lake/lfs-setup');

// skip 探测前把私有件前置 PATH：纯私有件机器（无系统 git-lfs、自举产物在
// ~/.context-insight/bin 在位——生产运行时 ensurePrivateLfsOnPath 同款注入）
// 上整组照跑，贴近用户现场形态。forks 池进程复用下用例后还原。
const SAVED_PATH = process.env.PATH;
const privBin = privateLfsBinDir();
if (fs.existsSync(path.join(privBin, 'git-lfs')) && !(process.env.PATH ?? '').split(path.delimiter).includes(privBin)) {
  process.env.PATH = `${privBin}${path.delimiter}${process.env.PATH ?? ''}`;
}
afterAll(() => { process.env.PATH = SAVED_PATH; });

function blobBuffer(repoPath: string): Buffer {
  const oid = git(`git rev-parse main:${repoPath}`, BARE).trim();
  return execSync(`git cat-file -p ${oid}`, { cwd: BARE, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }) as Buffer;
}

function lfsObjectPath(oidHex: string): string {
  return path.join(BARE, 'lfs', 'objects', oidHex.slice(0, 2), oidHex.slice(2, 4), oidHex);
}

const DESC = '提交人: 王五\n内容描述: lfs mode it';

describe.skipIf(!hasGitLfs())('lake LFS 模式（file:// bare + standalone 传输）', () => {
  it('① uploadFolder：指针出仓 + 实体落 LFS 存储 + .gitattributes 保留', async () => {
    const r = await uploadFolder(STAGING, SID, DESC, buildRemote(), 'others');
    expect(r.folder).toBe(`others/${SID}/`);
    expect(r.gitattributesFixed).toBe(false);

    const pointer = blobBuffer(`others/${SID}/${SID}.jsonl.gz`).toString('utf8');
    const oidHex = createHash('sha256').update(MAIN_GZ).digest('hex');
    expect(pointer.startsWith('version https://git-lfs.github.com/spec/v1')).toBe(true);
    expect(pointer).toContain(`oid sha256:${oidHex}`);
    expect(pointer).toContain(`size ${MAIN_GZ.length}`);
    expect(fs.existsSync(lfsObjectPath(oidHex))).toBe(true);
    expect(fs.readFileSync(lfsObjectPath(oidHex)).equals(MAIN_GZ)).toBe(true);

    const meta = blobBuffer(`others/${SID}/${SID}.meta.json`).toString('utf8');
    expect(meta).toContain('"framework":"claude-code"');
    expect(meta).not.toContain('git-lfs');

    expect(blobBuffer('.gitattributes').toString('utf8')).toContain('*.gz filter=lfs');
  });

  it('② materializeSession：指针 → 真实 gzip 字节（--filters smudge）', () => {
    const mainJsonl = materializeSession(SID, buildRemote());
    expect(path.basename(mainJsonl)).toBe(`${SID}.jsonl.gz`);
    expect(fs.readFileSync(mainJsonl).equals(MAIN_GZ)).toBe(true);
  });

  it('③ listSessions：meta.json 普通 blob，type 列照常', () => {
    const sessions = listSessions(buildRemote());
    const entry = sessions.find(s => s.sid === SID);
    expect(entry).toBeTruthy();
    expect(entry!.framework).toBe('claude-code');
    expect(entry!.ccVersion).toBe('9.9.9');
    expect(entry!.paradigm).toBe('others');
  });

  it('④ 幂等：重复上传同内容 → 指针级 unchanged', async () => {
    const commitsBefore = git('git rev-list --count main', BARE).trim();
    const r = await uploadFolder(STAGING, SID, DESC, buildRemote(), 'others');
    expect(r.unchanged).toBe(true);
    expect(git('git rev-list --count main', BARE).trim()).toBe(commitsBefore);
  });

  it('⑤ 注入面：repoPath 含 shell 元字符（引号/分号/空格）物化不执行注入命令', () => {
    const mainJsonl = materializeSession(SID, buildRemote());
    // 主件照常恢复（怪名文件在同树中，不拖垮整仓物化）
    expect(fs.readFileSync(mainJsonl).equals(MAIN_GZ)).toBe(true);
    // 探针文件字节级恢复（subagents/ 前缀重排到 <sid>/subagents/）
    const matSub = path.join(path.dirname(mainJsonl), SID, 'subagents', EVIL_NAME);
    expect(fs.existsSync(matSub)).toBe(true);
    expect(fs.readFileSync(matSub).equals(EVIL_GZ)).toBe(true);
    // 关键断言：注入命令未被执行——旧实现内插 shell 字符串，touch 的相对
    // 哨兵名会落在 execSync 的 cwd（镜像根 = materialized/<sid> 的上两级）
    const mirrorRoot = path.resolve(path.dirname(mainJsonl), '..', '..');
    expect(fs.existsSync(path.join(mirrorRoot, PWN_NAME))).toBe(false);
  });

  it('⑥ 工作树 .gitattributes 过期（默认模式上传剔除过 lfs 行）：导入前刷新，指针不被当 gzip 落盘', () => {
    // 复现序列：同一镜像默认模式 uploadFolder 把剔除 filter=lfs 的
    // .gitattributes 写回工作树（LFS 免疫操作）→ 远端（cpx 侧）切回 LFS 模式
    // 上传加回声明 → 本机 LFS 导入读到的还是过期副本
    const gaPath = path.join(CACHE, '.gitattributes');
    expect(fs.readFileSync(gaPath, 'utf8')).toContain('*.gz filter=lfs'); // 前置：当前副本带声明
    const stripped = fs.readFileSync(gaPath, 'utf8').split('\n').filter(l => !l.includes('filter=lfs')).join('\n');
    fs.writeFileSync(gaPath, stripped);
    expect(fs.readFileSync(gaPath, 'utf8')).not.toContain('filter=lfs'); // 前置：副本已过期

    const mainJsonl = materializeSession(SID, buildRemote());
    // 工作树副本已从 origin/main 刷新（声明回归）
    expect(fs.readFileSync(gaPath, 'utf8')).toContain('*.gz filter=lfs');
    // 实体照常恢复——不是指针文本（指针 gunzip 必炸且字节不等）
    expect(fs.readFileSync(mainJsonl).equals(MAIN_GZ)).toBe(true);
  });

  it('⑦ uploadBundleFolder：bundle .jsonl.7z 指针出仓 + 实体落 LFS 存储 + manifest 普通 blob', async () => {
    const r = await uploadBundleFolder(STAGING_BUNDLE, RUN_ID, DESC, buildRemote(), 'others');
    expect(r.folder).toBe(`others/${RUN_ID}/`);
    expect(r.gitattributesFixed).toBe(false);

    const pointer = blobBuffer(`others/${RUN_ID}/sessions/${SID_B}/${SID_B}.jsonl.7z`).toString('utf8');
    const oidHex = createHash('sha256').update(SEVEN_Z).digest('hex');
    expect(pointer.startsWith('version https://git-lfs.github.com/spec/v1')).toBe(true);
    expect(pointer).toContain(`oid sha256:${oidHex}`);
    expect(pointer).toContain(`size ${SEVEN_Z.length}`);
    expect(fs.existsSync(lfsObjectPath(oidHex))).toBe(true);
    expect(fs.readFileSync(lfsObjectPath(oidHex)).equals(SEVEN_Z)).toBe(true);

    // manifest（workflow.json）非 lfs 声明覆盖 → 普通 blob，不被指针化
    const manifest = blobBuffer(`others/${RUN_ID}/workflow.json`).toString('utf8');
    expect(manifest).toContain('workflow-bundle');
    expect(manifest).not.toContain('git-lfs');

    // ensureLfsGitattributes 补 *.7z 声明进仓（新形态）
    expect(blobBuffer('.gitattributes').toString('utf8')).toContain('*.7z filter=lfs');
  });

  it('⑧ materializeBundle：指针 → 真实字节（--filters smudge）+ 工作树 .gitattributes 过期刷新', () => {
    // ⑥ 的 bundle 版：过期副本（剔除过 lfs 行）会让 --filters 不做 smudge
    const gaPath = path.join(CACHE, '.gitattributes');
    const stripped = fs.readFileSync(gaPath, 'utf8').split('\n').filter(l => !l.includes('filter=lfs')).join('\n');
    fs.writeFileSync(gaPath, stripped);

    const out = materializeBundle(RUN_ID, path.join(TMP, 'mat-bundle'), buildRemote(), 'others');
    // 实体字节级恢复——不是指针文本
    expect(fs.readFileSync(path.join(out, 'sessions', SID_B, `${SID_B}.jsonl.7z`)).equals(SEVEN_Z)).toBe(true);
    // 工作树副本已从 origin/main 刷新（*.7z 声明回归）
    expect(fs.readFileSync(gaPath, 'utf8')).toContain('*.7z filter=lfs');
  });
});
