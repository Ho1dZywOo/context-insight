// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. Do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import fs from 'node:fs';
import path from 'node:path';
import { VERSION } from '@/lib/version';

export interface BuildIdentity {
  /** 版本（@/lib/version 构建期常量——进程所跑代码的版本，混代进程报旧值即实锤） */
  version: string;
  /** 构建号（distDir/BUILD_ID，启动时刻磁盘态） */
  buildId: string;
  /** 生效产物目录（INSIGHT_DIST_DIR 覆盖时为隔离目录，如 E2E 的 .next-e2e） */
  distDir: string;
}

// 启动自报的构建标识：让「这个进程跑的是哪个构建」永远可以从日志回答
// （2026-11-12 事故排查主障碍：产物被新构建抽换后，长跑实例内存里仍是
// 启动时预载的旧模块，行为静默错乱而日志无进程身份锚点）。BUILD_ID 取
// 启动时刻磁盘态——事后构建抽换不影响已写出的 boot 行，boot 行与事后
// 磁盘对不上本身就是混代实锤。
export function readBuildIdentity(opts?: {
  cwd?: string;
  env?: Record<string, string | undefined>;
}): BuildIdentity {
  const cwd = opts?.cwd ?? process.cwd();
  const env = opts?.env ?? process.env;
  const distDir = env.INSIGHT_DIST_DIR?.trim() || '.next';
  let buildId: string | null = null;
  try {
    buildId = fs.readFileSync(path.join(cwd, distDir, 'BUILD_ID'), 'utf8').trim() || null;
  } catch {
    buildId = null;
  }
  return { version: VERSION, buildId: buildId ?? 'unknown', distDir };
}
