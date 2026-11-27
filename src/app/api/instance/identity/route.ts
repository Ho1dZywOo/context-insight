// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See the License in the root of the software repository for the full text of the License.

// GET /api/instance/identity —— 实例身份自报（只读、不碰库）。npm 启动器用它判断
// 端口上的服务是否属于本数据目录（bin/launcher-identity.mjs）：请求不带 Origin，
// 不被 proxy 的浏览器跨源守卫拦。身份随进程恒定，禁缓存。
import { NextResponse } from 'next/server';
import { withRouteLog } from '@/lib/api-route';
import { readInstanceIdentity } from '@/lib/instance-identity';

export const GET = withRouteLog('instance/identity', async () => {
  const res = NextResponse.json(readInstanceIdentity());
  res.headers.set('Cache-Control', 'no-store');
  return res;
});
