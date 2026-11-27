// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import os from 'node:os';
import path from 'node:path';
import { BRAND_CONFIG_DIR_SUFFIX, BRAND_NAME, BRAND_SLUG } from '@/lib/branding';
import { readBuildIdentity } from '@/lib/build-identity';

/**
 * 实例身份——服务端对「我是哪个产品、哪份数据、哪个进程」的自报，单一来源。
 * 消费方：GET /api/instance/identity（npm 启动器 bin/launcher-identity.mjs 据此
 * 判断端口上的服务是不是本数据目录的实例——记录缺失、安装目录变更、非 Linux
 * 无 /proc 时，这是跨平台的归属锚点），以及端口占用诊断（另一个数据目录的
 * insight 实例 vs 无关进程）。只读、不碰数据库。
 */
export interface InstanceIdentity {
  /** 产品标识（= 包名：context-insight / cannbot-insight） */
  product: string;
  /** 显示名 */
  brand: string;
  /** 版本（进程所跑代码的版本） */
  version: string;
  /** 构建号（distDir/BUILD_ID，启动时刻磁盘态） */
  buildId: string;
  /** 本服务进程 PID */
  pid: number;
  /** 监听端口（next start 写入的 PORT） */
  port: number | null;
  /** 实例数据目录（库文件所在；启动器写入 CONTEXT_INSIGHT_HOME） */
  home: string;
  /** 安装目录（进程工作目录） */
  packageDir: string;
  /** 拉起本进程的启动器 PID（启动器写入；start.sh / next dev 直接拉起时为 null） */
  launcherPid: number | null;
  /** 本进程启动时刻 */
  startedAt: string;
}

const STARTED_AT = new Date().toISOString();

export function readInstanceIdentity(env: Record<string, string | undefined> = process.env): InstanceIdentity {
  const build = readBuildIdentity();
  const port = Number.parseInt(env.PORT ?? '', 10);
  const launcherPid = Number.parseInt(env.CONTEXT_INSIGHT_LAUNCHER_PID ?? '', 10);
  return {
    product: BRAND_SLUG,
    brand: BRAND_NAME,
    version: build.version,
    buildId: build.buildId,
    pid: process.pid,
    port: Number.isInteger(port) && port > 0 ? port : null,
    home: env.CONTEXT_INSIGHT_HOME || path.join(os.homedir(), BRAND_CONFIG_DIR_SUFFIX),
    packageDir: process.cwd(),
    launcherPid: Number.isInteger(launcherPid) && launcherPid > 0 ? launcherPid : null,
    startedAt: STARTED_AT,
  };
}
