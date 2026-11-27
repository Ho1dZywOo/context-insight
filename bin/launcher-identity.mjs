#!/usr/bin/env node
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 实例身份的启动器侧客户端——服务端 GET /api/instance/identity 自报
// 「我是哪个产品、哪份数据目录、哪个进程」，契约见 src/lib/instance-identity.ts。
// 它是跨平台的归属锚点（非 Linux 没有 /proc），也是诊断占用者的依据
// （另一个数据目录的 insight 实例 vs 无关进程，给用户的提示完全不同）。

import { samePath } from './launcher-context.mjs'

export const IDENTITY_PATH = '/api/instance/identity'

/** 取端口上服务的实例身份；不是 insight 实例 / 不应答 → null。 */
export async function fetchIdentity(port, timeoutMs = 1500) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(`http://127.0.0.1:${port}${IDENTITY_PATH}`, { signal: ac.signal })
    if (!res.ok) return null
    const body = await res.json()
    return isIdentity(body) ? body : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function isIdentity(value) {
  return !!value && typeof value === 'object'
    && typeof value.product === 'string' && typeof value.home === 'string' && Number.isInteger(value.pid)
}

/** 身份是否属于本数据目录的本产品实例。 */
export function identityOfHome(identity, ctx) {
  return !!identity && identity.product === ctx.pkgName && samePath(identity.home, ctx.dataDir)
}
