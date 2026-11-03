// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details on how to use this file. You may only use this file in accordance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// lake LFS 读路径 fail-fast IT（git-lfs 全不可见时锁定）：materializeBundle 的
// LFS 分支此前缺失就绪检查——git-lfs 缺失时 git 原文
// （"git-lfs filter-process: 1: git-lfs: not found"）直抛给用户；现在
// materializeSession / materializeBundle 统一走 prepareLfsReadPath，给出
// 可操作指引（三条出路）。
// 环境语义：CONTEXT_PROXY_DIR 沙箱重定向让私有件（~/.context-insight/bin 的
// 自举产物）对本文件不可见——纯私有件机器（无系统 git-lfs、自举产物在位，
// 即用户现场形态）也走"全不可见"分支；ensurePrivateLfsOnPath 因二进制不在
// 而不注入 PATH，fail-fast 指引如期触发。私有件可见形态的 smudge 全链路
// 由 e2e lake-lfs.test.ts 锁定（其 skip 探测前先把私有件前置 PATH）。
// 夹具用手工指针 blob 模拟真 git-lfs 客户端推送的仓形态（指针只是普通文本
// blob，无需 git-lfs 即可构造）。有系统 git-lfs 的客户机整组跳过。
import { describe, it, expect, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { materializeSession, materializeBundle, hasGitLfs, type LakeRemote } from '../../src/lib/lake/mirror';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lake-lfs-readprep-it-'));
const BARE = path.join(TMP, 'remote.git');
const SEED = path.join(TMP, 'seed');

const SID = 'ses_readprep01ffeetestAA';
const RUN_ID = 'run_readprep01';

// 私有件不可见（沙箱重定向；forks 池进程复用下用例后还原）
const SAVED_PROXY_DIR = process.env.CONTEXT_PROXY_DIR;
process.env.CONTEXT_PROXY_DIR = path.join(TMP, 'home', 'proxy');
afterAll(() => {
  if (SAVED_PROXY_DIR === undefined) delete process.env.CONTEXT_PROXY_DIR;
  else process.env.CONTEXT_PROXY_DIR = SAVED_PROXY_DIR;
});

// 手工 LFS 指针（真实 git-lfs 客户端 push 后仓内的 blob 形态）
const POINTER = 'version https://git-lfs.github.com/spec/v1\n'
  + `oid sha256:${'a1b2c3d4'.repeat(8)}\nsize 4096\n`;

function git(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: 'pipe', timeout: 60_000 }).toString();
}

// seed：*.7z lfs 声明 + 会话（sessions/<sid>/）与 bundle（专区/<runId>/）
// 各带一个指针形态的 .jsonl.7z
execSync(`git init --bare -b main "${BARE}"`, { stdio: 'pipe' });
execSync(`git clone --quiet "${BARE}" "${SEED}"`, { stdio: 'pipe' });
fs.writeFileSync(path.join(SEED, '.gitattributes'), '*.7z filter=lfs diff=lfs merge=lfs -text\n');
fs.mkdirSync(path.join(SEED, 'sessions', SID), { recursive: true });
fs.writeFileSync(path.join(SEED, 'sessions', SID, `${SID}.jsonl.7z`), POINTER);
fs.mkdirSync(path.join(SEED, 'opsbot-bundle', RUN_ID, 'sessions', SID), { recursive: true });
fs.writeFileSync(path.join(SEED, 'opsbot-bundle', RUN_ID, 'workflow.json'), '{"schema":"workflow-bundle"}');
fs.writeFileSync(path.join(SEED, 'opsbot-bundle', RUN_ID, 'sessions', SID, `${SID}.jsonl.7z`), POINTER);
git('git add .', SEED);
git('git -c user.name=seed -c user.email=seed@t commit -q -m init', SEED);
git('git push -q origin main', SEED);

function buildRemote(): LakeRemote {
  return {
    pullUrl: `file://${BARE}`,
    pushUrl: `file://${BARE}`,
    pushAuth: null,
    pullAuth: null,
    branch: 'main',
    rootDir: 'sessions',
    cacheDir: path.join(TMP, 'cache'),
    lfs: true,
  };
}

describe.skipIf(hasGitLfs())('lake LFS 读路径 fail-fast（git-lfs 全不可见）', () => {
  it('materializeBundle：git-lfs 缺失 → 指引报错（不再是 git 原文）', () => {
    // 用户现场形态的底层分支：仓内 .jsonl.7z 为指针 blob（真 git-lfs 客户端
    // 推送），本机 git-lfs 全不可见 → 此前 cat-file --filters 直抛
    // "git-lfs filter-process: 1: git-lfs: not found"；现在物化前 fail-fast
    // 给指引
    expect(() => materializeBundle(RUN_ID, path.join(TMP, 'mat-bundle'), buildRemote()))
      .toThrow(/LFS 模式需要 git-lfs.*LAKE_LFS=0/);
  });

  it('materializeSession：同款 fail-fast（共用 prepareLfsReadPath）', () => {
    expect(() => materializeSession(SID, buildRemote()))
      .toThrow(/LFS 模式需要 git-lfs.*LAKE_LFS=0/);
  });
});
