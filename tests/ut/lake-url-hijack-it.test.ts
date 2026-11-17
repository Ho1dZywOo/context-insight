// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program and free software comes with NO WARRANTY, unless required by
// applicable law. Licensed under CANN OSL v2.0 — see LICENSE at repo root.

// 现场事故回放（合同模型锁定）：客户机全局 gitconfig 的 url.*.insteadOf 把
// UI 显式配置的 https 数据仓静默改道 ssh（22 端口不通即超时，
// classifyLakeError 只能 unknown）。本用例在机器默认全局位（$HOME/.gitconfig
// ——与事故同位）放置 insteadOf 劫持重写，锁定四件事：
//   ① 夹具活性：裸 git（不走 lake 环境构建器）在劫持 HOME 下 ls-remote 被
//      改道到不存在路径而失败——绿态断言不可能空转（红态即事故本身）
//   ② 镜像克隆：ensureMirror 在劫持环境下正常成形（runGit 面：clone/fetch）
//   ③ 协议真相：镜像 origin 仍是显式配置的 URL——机器未改写合同
//   ④ 物化面：listSessions 走 spawnGitAuthed（cat-file/ls-tree）不炸
// 边界：显式 process.env.GIT_CONFIG_GLOBAL 穿透不在此测（cred UT 的诱饵
// helper 用例覆盖）；系统层保留（GIT_CONFIG_SYSTEM 由本测试指空求确定性，
// 属测试自身隔离，非产品行为）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seedLakeConfig } from '../helpers/lake-env';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lake-url-hijack-'));
const BARE = path.join(TMP, 'bare.git');
const REMOTE_URL = `file://${BARE}`;
// 劫持重写目标：不存在的路径（错误即时报、无网络依赖——重写命中即失败）
const HIJACK_TARGET = `${TMP}/nonexistent-rewritten.git`;
const HIJACK_HOME = path.join(TMP, 'hijack-home');

const savedEnv: Record<string, string | undefined> = {};

function git(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: 'pipe', timeout: 60_000 }).toString();
}

beforeAll(() => {
  for (const k of ['HOME', 'CONTEXT_PROXY_DIR', 'LAKE_CACHE_DIR', 'LAKE_LFS', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) {
    savedEnv[k] = process.env[k];
  }

  // 夹具：bare 仓 + 一个可解析的 main 提交（本地路径操作，不受劫持影响）
  execSync(`git init --bare -b main "${BARE}"`, { stdio: 'pipe' });
  git('git config uploadpack.allowFilter true', BARE);
  git('git config uploadpack.allowAnySHA1InWant true', BARE);
  const seed = path.join(TMP, 'seed');
  execSync(`git clone --quiet "${BARE}" "${seed}"`, { stdio: 'pipe' });
  fs.writeFileSync(path.join(seed, 'README.md'), '# lake\n');
  git('git add .', seed);
  git('git -c user.name=seeder -c user.email=s@t commit -q -m "init"', seed);
  git('git push -q origin main', seed);

  // 劫持配置就位于机器默认全局位（与现场事故同位：客户 ~/.gitconfig）
  fs.mkdirSync(HIJACK_HOME, { recursive: true });
  fs.writeFileSync(
    path.join(HIJACK_HOME, '.gitconfig'),
    `[url "${HIJACK_TARGET}"]\n\tinsteadOf = ${REMOTE_URL}\n`,
  );

  // 测试环境：HOME 指向劫持沙箱；GIT_CONFIG_GLOBAL 必须删除——显式设置会被
  // lakeGitEnv 尊重穿透（合同模型的 ① 边界），只有缺省态才吃 /dev/null 隔离
  process.env.HOME = HIJACK_HOME;
  delete process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_SYSTEM = '/dev/null';
  process.env.LAKE_CACHE_DIR = path.join(TMP, 'cache');
  process.env.LAKE_LFS = '0';
  seedLakeConfig(TMP, { address: REMOTE_URL });
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

const mirror = await import('../../src/lib/lake/mirror');
const remoteMod = await import('../../src/lib/lake/remote');

describe('lake URL 劫持隔离（全局 insteadOf 不改写显式合同）', () => {
  it('① 夹具活性：裸 git 在劫持 HOME 下被 insteadOf 改道（红态即事故形态）', () => {
    let stderr = '';
    try {
      execSync(`git ls-remote "${REMOTE_URL}" HEAD`, { stdio: 'pipe', timeout: 30_000 });
    } catch (e) {
      stderr = String((e as { stderr?: Buffer }).stderr ?? '');
    }
    // 改道证据：错误信息里出现劫持目标路径，而非原 URL
    expect(stderr).toContain('nonexistent-rewritten');
    expect(stderr).toContain('Could not read from remote repository');
  });

  it('② 镜像克隆：劫持环境下 ensureMirror 正常成形（runGit 面）', () => {
    const dir = mirror.ensureMirror();
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(true);
  });

  it('③ 协议真相：镜像 origin 是显式配置的 URL，未被机器改写', () => {
    const dir = mirror.ensureMirror();
    expect(git('git config --get remote.origin.url', dir).trim()).toBe(REMOTE_URL);
  });

  it('④ 物化面：listSessions 走 spawnGitAuthed 在劫持环境下不炸', () => {
    const remote = remoteMod.resolveLakeRemote();
    expect(() => mirror.listSessions(remote)).not.toThrow();
  });
});
