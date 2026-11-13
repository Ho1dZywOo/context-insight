// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. Do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { describe, it, expect } from 'vitest';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// tests/pipeline → 包根
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const GUARD = path.join(PROJECT_ROOT, 'scripts', 'build-guard.mjs');
const BOOT_SERVER = path.join(PROJECT_ROOT, 'tests', 'e2e', 'boot', 'boot-server.sh');
const NEXT_CONFIG = path.join(PROJECT_ROOT, 'next.config.ts');
const INSTRUMENTATION = path.join(PROJECT_ROOT, 'src', 'instrumentation.ts');
const PACKAGE_JSON = path.join(PROJECT_ROOT, 'package.json');
const GITIGNORE = path.join(PROJECT_ROOT, '.gitignore');

// 源级：构建/运行互斥三层防御接线齐全（拆任何一根即红——这套防线拆一半
// 比没有更危险：给人「已隔离」的错觉）
describe('构建/运行互斥——源级接线', () => {
  it('npm run build 挂 prebuild 守门钩子', () => {
    const scripts = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8')).scripts;
    expect(scripts.prebuild).toBe('node scripts/build-guard.mjs');
  });

  it('E2E 引导用隔离产物目录 .next-e2e（env 分流 + 新鲜度判定不再碰生产 .next）', () => {
    const src = fs.readFileSync(BOOT_SERVER, 'utf8');
    expect(src).toContain('export INSIGHT_DIST_DIR=".next-e2e"');
    expect(src).toContain('.next-e2e/BUILD_ID');
    // 共享 .next 是 2026-11-12 混代事故根因，新鲜度判定不得再指向生产产物
    expect(src).not.toMatch(/-newer \.next\/BUILD_ID/);
  });

  it('next.config.ts 按 INSIGHT_DIST_DIR 分流 distDir', () => {
    const src = fs.readFileSync(NEXT_CONFIG, 'utf8');
    expect(src).toContain('INSIGHT_DIST_DIR');
    expect(src).toMatch(/\bdistDir\b/);
  });

  it('.gitignore 与 .npmignore 均忽略隔离产物目录', () => {
    expect(fs.readFileSync(GITIGNORE, 'utf8')).toContain('/.next-e2e/');
    // npm pack 走 .npmignore（不是 .gitignore）——漏了会把 e2e 构建树混进包产物
    expect(fs.readFileSync(path.join(PROJECT_ROOT, '.npmignore'), 'utf8')).toContain('.next-e2e/');
  });

  it('服务端启动自报构建标识（instrumentation boot 行）', () => {
    const src = fs.readFileSync(INSTRUMENTATION, 'utf8');
    expect(src).toContain('build-identity');
    expect(src).toContain('boot 构建标识');
  });
});

// 行为级：守门在假包根上仿真（BUILD_GUARD_ROOT 锚点覆盖，真实例零波及）。
// 仿真进程 cmdline 含 next-server + cwd 在锚定根内，命中守门匹配面。
describe('构建守门 build-guard.mjs——行为级', () => {
  const spawnFakeNext = (cwd: string, ignoreSigterm: boolean): ChildProcess => {
    fs.writeFileSync(
      path.join(cwd, 'next-server-fake.js'),
      [
        "const fs = require('node:fs');",
        "fs.writeFileSync(__dirname + '/next-server-fake.ready', '1');",
        ignoreSigterm ? "process.on('SIGTERM', () => {});" : '',
        'setInterval(() => {}, 1000);',
        '',
      ].join('\n'),
    );
    return spawn(process.execPath, [path.join(cwd, 'next-server-fake.js')], {
      cwd,
      stdio: 'ignore',
    });
  };

  const waitReady = async (dir: string) => {
    const marker = path.join(dir, 'next-server-fake.ready');
    for (let i = 0; i < 40; i += 1) {
      if (fs.existsSync(marker)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('fake next-server not ready within 4s');
  };

  const runGuard = (root: string, extraEnv: Record<string, string> = {}) => {
    execSync(`node ${JSON.stringify(GUARD)}`, {
      env: { ...process.env, BUILD_GUARD_ROOT: root, ...extraEnv },
      encoding: 'utf8',
      stdio: 'pipe',
    });
  };

  const exitedWithSignal = (child: ChildProcess) =>
    new Promise<string | null>((resolve) => {
      child.on('exit', (code, signal) => resolve(signal));
    });

  it('自家实例（cwd 在包根内）构建前被 SIGTERM 停掉', async () => {
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'build-guard-own-'));
    try {
      const fake = spawnFakeNext(fakeRoot, false);
      const signal = exitedWithSignal(fake);
      await waitReady(fakeRoot);
      runGuard(fakeRoot);
      expect(await signal).toBe('SIGTERM');
    } finally {
      fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
  }, 10_000);

  it('自家实例落在符号链接目录下仍被停掉（锚定两侧同一规范化）', async () => {
    // procCwd 报内核解析后的真实路径，BUILD_GUARD_ROOT 若只 path.resolve 不解
    // symlink，二者在 /tmp→/private/tmp 这类平台 symlink 下永不匹配、守门漏杀
    const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'build-guard-real-'));
    const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), 'build-guard-linkdir-'));
    const linkRoot = path.join(linkParent, 'link');
    fs.symlinkSync(realRoot, linkRoot);
    try {
      const fake = spawnFakeNext(linkRoot, false); // cwd 走 symlink，内核解析到 realRoot
      const signal = exitedWithSignal(fake);
      await waitReady(linkRoot);
      runGuard(linkRoot); // BUILD_GUARD_ROOT 用 symlink 路径，realpath 后与 procCwd 对齐
      expect(await signal).toBe('SIGTERM');
    } finally {
      fs.rmSync(linkRoot, { force: true }); // 仅删 symlink，不删 target
      fs.rmSync(linkParent, { recursive: true, force: true });
      fs.rmSync(realRoot, { recursive: true, force: true });
    }
  }, 10_000);

  it('无关实例（cwd 在包根外）不受波及', async () => {
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'build-guard-scope-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'build-guard-outside-'));
    try {
      const fake = spawnFakeNext(outside, false);
      await waitReady(outside);
      runGuard(fakeRoot);
      expect(fake.exitCode).toBeNull(); // 仍存活
      expect(() => process.kill(fake.pid!, 0)).not.toThrow();
      fake.kill('SIGKILL');
    } finally {
      fs.rmSync(fakeRoot, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }, 10_000);

  it('INSIGHT_DIST_DIR 指向隔离目录时放行（E2E 构建不误杀生产实例）', async () => {
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'build-guard-e2e-'));
    try {
      const fake = spawnFakeNext(fakeRoot, false);
      await waitReady(fakeRoot);
      runGuard(fakeRoot, { INSIGHT_DIST_DIR: '.next-e2e' });
      expect(fake.exitCode).toBeNull(); // 仍存活
      expect(() => process.kill(fake.pid!, 0)).not.toThrow();
      fake.kill('SIGKILL');
    } finally {
      fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
  }, 10_000);

  it('忽略 SIGTERM 的挂死实例在宽限后被 SIGKILL 补刀', async () => {
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'build-guard-kill-'));
    try {
      const fake = spawnFakeNext(fakeRoot, true);
      const signal = exitedWithSignal(fake);
      await waitReady(fakeRoot);
      runGuard(fakeRoot); // 守门内部含 3s 宽限，阻塞至补刀完成
      expect(await signal).toBe('SIGKILL');
    } finally {
      fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
  }, 15_000);

  it('无自家实例时直接放行（exit 0）', () => {
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'build-guard-idle-'));
    try {
      runGuard(fakeRoot); // execSync 非零退出即抛——不抛即通过
    } finally {
      fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
  });
});
