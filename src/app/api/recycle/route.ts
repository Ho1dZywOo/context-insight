// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 回收站 API：GET 列表 / POST 动作（restore 恢复回流 / purge 彻底删除 /
// empty 清空）。恢复后湖视图/评分/活跃缓存同步失效（与删除路由同一纪律）。

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { withRouteLog } from '@/lib/api-route';
import { logInfo } from '@/lib/logger';
import { listRecycleEntries, restoreRecycleEntry, purgeRecycleEntry, emptyRecycle } from '@/lib/recycle';
import { invalidateObservationCaches } from '@/lib/observe/invalidation';

export const GET = withRouteLog('recycle', async () => {
  return NextResponse.json({ entries: listRecycleEntries() });
});

export const POST = withRouteLog('recycle', async (request: NextRequest) => {
  const body = await request.json();
  const action = body?.action;

  if (action === 'restore') {
    if (typeof body.name !== 'string') {
      return NextResponse.json({ error: 'Missing name' }, { status: 400 });
    }
    try {
      const result = await restoreRecycleEntry(body.name, prisma);
      invalidateObservationCaches();
      return NextResponse.json({ ok: true, name: body.name, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Restore failed';
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  if (action === 'purge') {
    if (typeof body.name !== 'string') {
      return NextResponse.json({ error: 'Missing name' }, { status: 400 });
    }
    try {
      purgeRecycleEntry(body.name);
      return NextResponse.json({ ok: true, name: body.name });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Purge failed';
      return NextResponse.json({ error: message }, { status: 400 });
    }
  }

  if (action === 'empty') {
    const removed = emptyRecycle();
    logInfo('route:recycle', '回收站已清空', { removed });
    return NextResponse.json({ ok: true, removed });
  }

  return NextResponse.json({ error: `Unknown action: ${JSON.stringify(String(action ?? ''))}` }, { status: 400 });
});
