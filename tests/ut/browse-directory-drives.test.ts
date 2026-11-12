// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. Do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// browse-directory win32 盘符列表 IT：模块级 mock browse-roots 为 win32 实现
// （注入假盘符探测器 C:/D:），锁路由接线——空串请求进入根层级分支并返回
// 盘符条目。根层级语义本身由 browse-roots.test.ts 单测锁定。

import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/ingest/browse-directory/route';

vi.mock('@/lib/ingest/browse-roots', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ingest/browse-roots')>('@/lib/ingest/browse-roots');
  return {
    fsRoots: () => actual.fsRootsFor('win32', (p: string) => {
      if (p === 'C:\\' || p === 'D:\\') {
        return { isDirectory: () => true, mtimeMs: 1700000000000 } as never;
      }
      throw new Error(`ENOENT: ${p}`);
    }),
  };
});

function req(dirPath: string): NextRequest {
  return new NextRequest('http://localhost/api/ingest/browse-directory', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dirPath }),
  });
}

describe('POST /api/ingest/browse-directory — win32 盘符列表', () => {
  it('空串 → 根层级：列出的盘符即条目，currentPath 为空串、parentPath 为 null', async () => {
    const res = await POST(req(''));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.isDirectory).toBe(true);
    expect(data.isRootLevel).toBe(true);
    expect(data.currentPath).toBe('');
    expect(data.parentPath).toBe(null);
    expect(data.entries.map((e: { name: string }) => e.name)).toEqual(['C:', 'D:']);
    expect(data.entries[0]).toMatchObject({ fullPath: 'C:\\', isDir: true, isImportableFile: false });
  });
});
