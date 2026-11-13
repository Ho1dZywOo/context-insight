// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. Do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readBuildIdentity } from '@/lib/build-identity';
import { VERSION } from '@/lib/version';

// 数据驱动：临时包根摆不同磁盘态，锁标识读取的解析规则（trim / env 分流 /
// 缺损回落），不依赖真实仓库的 .next（构建产物存在性不影响用例结果）
describe('build-identity 构建标识读取', () => {
  const makeRoot = (files: Record<string, string>): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-identity-'));
    for (const [rel, content] of Object.entries(files)) {
      const file = path.join(root, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    return root;
  };

  it('版本取 @/lib/version 构建期常量，BUILD_ID 读默认产物目录（trim）', () => {
    const root = makeRoot({ '.next/BUILD_ID': '  abc123  \n' });
    try {
      expect(readBuildIdentity({ cwd: root, env: {} })).toEqual({
        version: VERSION,
        buildId: 'abc123',
        distDir: '.next',
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('INSIGHT_DIST_DIR 指向隔离目录（E2E）：读隔离目录的 BUILD_ID，不碰生产产物', () => {
    const root = makeRoot({
      '.next/BUILD_ID': 'prod-build',
      '.next-e2e/BUILD_ID': 'e2e-build',
    });
    try {
      expect(readBuildIdentity({ cwd: root, env: { INSIGHT_DIST_DIR: '.next-e2e' } })).toEqual({
        version: VERSION,
        buildId: 'e2e-build',
        distDir: '.next-e2e',
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('BUILD_ID 缺失或空白、INSIGHT_DIST_DIR 空白：回落 unknown / 默认目录', () => {
    const root = makeRoot({
      '.next/BUILD_ID': '   \n',
      '.next-e2e/BUILD_ID': 'e2e-build',
    });
    try {
      expect(readBuildIdentity({ cwd: root, env: { INSIGHT_DIST_DIR: '   ' } })).toEqual({
        version: VERSION,
        buildId: 'unknown',
        distDir: '.next',
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
