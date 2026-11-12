// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// browse-directory 根层级 IT（POSIX 真实文件系统）：空串 = 根层级，等价浏览
// '/'；'/' 到顶 parentPath 为 null（向上按钮消失，不再自指）；子目录父链与
// 入参校验不变。

import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { POST } from '@/app/api/ingest/browse-directory/route';

function req(dirPath: string): NextRequest {
  return new NextRequest('http://localhost/api/ingest/browse-directory', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dirPath }),
  });
}

const FIXTURE = `.insight-browse-root-it-${process.pid}-${Date.now().toString(36)}`;

describe('POST /api/ingest/browse-directory — 根层级（POSIX）', () => {
  it('空串 dirPath → 等价浏览 /（根层级的平台中立入口）', async () => {
    const res = await POST(req(''));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.isDirectory).toBe(true);
    expect(data.currentPath).toBe('/');
    expect(data.parentPath).toBe(null);
    expect(data.entries.length).toBeGreaterThan(0);
  });

  it('"/" 到顶：parentPath 为 null（不再自指）', async () => {
    const res = await POST(req('/'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.currentPath).toBe('/');
    expect(data.parentPath).toBe(null);
  });

  it('子目录父链不变（回归锁）', async () => {
    const sub = path.join(os.tmpdir(), FIXTURE, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    try {
      const res = await POST(req(sub));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.parentPath).toBe(path.join(os.tmpdir(), FIXTURE));
    } finally {
      fs.rmSync(path.join(os.tmpdir(), FIXTURE), { recursive: true, force: true });
    }
  });

  it('非字符串 dirPath 仍 400（空串合法化不放松类型校验）', async () => {
    const r = new NextRequest('http://localhost/api/ingest/browse-directory', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dirPath: 123 }),
    });
    const res = await POST(r);
    expect(res.status).toBe(400);
  });
});
