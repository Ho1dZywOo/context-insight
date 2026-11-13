// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// lake 文件根锚定 IT：lake-config/lake-auth/lfs-bin 此前只认 CONTEXT_PROXY_DIR
// ?? 真实 home，漏认 CONTEXT_INSIGHT_HOME——e2e boot 设了该变量但 lake 层不理会，
// 测试服务直接读写真实 ~/.context-insight 的配置（真机配了数据仓后 e2e 的
// 「未配置」前提翻车）。本文件锁定锚定优先级：
// CONTEXT_PROXY_DIR > CONTEXT_INSIGHT_HOME > 真实 home。

import { describe, it, expect, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'

import { serverConfigPath, lakeFilesRoot } from '../../src/lib/lake/server-config'
import { authFilePath } from '../../src/lib/lake/auth'
import { privateLfsBinDir } from '../../src/lib/lake/lfs-setup'

const REAL_HOME = path.join(os.homedir(), '.context-insight')

afterEach(() => {
  delete process.env.CONTEXT_PROXY_DIR
  delete process.env.CONTEXT_INSIGHT_HOME
})

describe('lake 文件根锚定：CONTEXT_PROXY_DIR > CONTEXT_INSIGHT_HOME > 真实 home', () => {
  it('CONTEXT_INSIGHT_HOME 隔离：lake 配置/凭据/bin 全部落进隔离 home', () => {
    process.env.CONTEXT_INSIGHT_HOME = '/tmp/e2e-isolated-home'
    expect(lakeFilesRoot()).toBe('/tmp/e2e-isolated-home')
    expect(serverConfigPath()).toBe('/tmp/e2e-isolated-home/lake-config.json')
    expect(authFilePath()).toBe('/tmp/e2e-isolated-home/lake-auth.json')
    expect(privateLfsBinDir()).toBe('/tmp/e2e-isolated-home/bin')
  })

  it('CONTEXT_PROXY_DIR 重定向优先（既有测试隔离通道不被改变）', () => {
    process.env.CONTEXT_INSIGHT_HOME = '/tmp/e2e-isolated-home'
    process.env.CONTEXT_PROXY_DIR = '/tmp/sandbox/proxy'
    expect(lakeFilesRoot()).toBe('/tmp/sandbox')
    expect(serverConfigPath()).toBe('/tmp/sandbox/lake-config.json')
    expect(authFilePath()).toBe('/tmp/sandbox/lake-auth.json')
  })

  it('两者均缺省：回落真实 home（生产行为不变）', () => {
    expect(lakeFilesRoot()).toBe(REAL_HOME)
    expect(serverConfigPath()).toBe(path.join(REAL_HOME, 'lake-config.json'))
  })
})
