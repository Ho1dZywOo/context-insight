// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// browse-directory 软链归类 IT：Dirent.isDirectory() 对指向目录的软链恒 false
// （不跟随），分组时须对软链补一次 stat 解析——指向目录的软链并入目录组（可
// 导航），指向文件的软链并入文件组（stat 跟随链取真值 size），悬空软链降级
// 为文件占位不炸。回归锁：旧实现（软链一律丢进 fileNames）下「软链目录」会被
// 当普通文件展示、点击不可导航。
import { describe, it, expect, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { POST } from '@/app/api/ingest/browse-directory/route';

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-browse-symlink-'));
afterAll(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

function req(dirPath: string): NextRequest {
  return new NextRequest('http://localhost/api/ingest/browse-directory', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dirPath }),
  });
}

describe('POST /api/ingest/browse-directory — 软链归类', () => {
  it('指向目录的软链并入目录组（可导航）；指向文件的软链并入文件组（stat 跟随链）；悬空软链降级不炸', async () => {
    // 真实目录与文件
    const realDir = path.join(fixtureRoot, 'real-dir');
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(path.join(realDir, 'inner.txt'), 'x');
    const realFile = path.join(fixtureRoot, 'real-file.txt');
    const CONTENT = 'hello symlink';
    fs.writeFileSync(realFile, CONTENT);

    // 软链：目录链 / 文件链 / 悬空链
    const dirLink = path.join(fixtureRoot, 'link-dir');
    const fileLink = path.join(fixtureRoot, 'link-file.txt');
    const danglingLink = path.join(fixtureRoot, 'link-dangling');
    fs.symlinkSync(realDir, dirLink, 'dir');
    fs.symlinkSync(realFile, fileLink, 'file');
    fs.symlinkSync(path.join(fixtureRoot, 'no-such-target'), danglingLink, 'file');

    const res = await POST(req(fixtureRoot));
    expect(res.status).toBe(200);
    const data = await res.json();
    const byName = new Map<string, { name: string; fullPath: string; isDir: boolean; size: number }>(
      data.entries.map((e: { name: string; fullPath: string; isDir: boolean; size: number }) => [e.name, e]),
    );

    // 基准：真实目录 / 文件归类不受影响
    expect(byName.get('real-dir')?.isDir).toBe(true);
    expect(byName.get('real-file.txt')?.isDir).toBe(false);

    // 关键：指向目录的软链必须可导航（旧实现归入文件组、isDir=false 当普通文件）
    const linkDirEntry = byName.get('link-dir');
    expect(linkDirEntry?.isDir).toBe(true);
    expect(linkDirEntry?.fullPath).toBe(dirLink);

    // 指向文件的软链：文件组，size 取软链目标的真实大小（stat 跟随链）
    const linkFileEntry = byName.get('link-file.txt');
    expect(linkFileEntry?.isDir).toBe(false);
    expect(linkFileEntry?.size).toBe(Buffer.byteLength(CONTENT));

    // 悬空软链：降级为文件占位（size 0），不抛 500
    const danglingEntry = byName.get('link-dangling');
    expect(danglingEntry).toBeDefined();
    expect(danglingEntry?.isDir).toBe(false);
  });
});