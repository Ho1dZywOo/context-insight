// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// browse-roots 单测：文件系统根层级的平台语义。platform 与盘符探测器可注入，
// 任意开发平台均可模拟 win32 多盘行为。

import { describe, it, expect } from 'vitest';
import type fs from 'node:fs';
import { fsRootsFor } from '@/lib/ingest/browse-roots';

/** 假盘符探测器：keys=存在的盘根，'dir'/'file'=stat 结果；缺失即抛（=盘不存在）。 */
function fakeStat(drives: Record<string, 'dir' | 'file'>) {
  return (p: string): fs.Stats => {
    const kind = drives[p];
    if (!kind) throw new Error(`ENOENT: ${p}`);
    return { isDirectory: () => kind === 'dir', mtimeMs: 1700000000000 } as unknown as fs.Stats;
  };
}

describe('fsRootsFor — win32（多盘符，无公共根）', () => {
  it('根层级标识为空串；盘根/UNC 根的父级是根层级（不再自指死锁）', () => {
    const roots = fsRootsFor('win32');
    expect(roots.rootLevelPath).toBe('');
    expect(roots.isRootLevel('')).toBe(true);
    expect(roots.isRootLevel('C:\\')).toBe(false);
    expect(roots.parentOf('C:\\')).toBe('');
    expect(roots.parentOf('\\\\server\\share')).toBe('');
    expect(roots.parentOf('C:\\Users\\x')).toBe('C:\\Users');
  });

  it('listRootLevel 探测 A-Z：只列真实存在的目录盘', () => {
    const roots = fsRootsFor('win32', fakeStat({
      'C:\\': 'dir',
      'D:\\': 'dir',
      'E:\\': 'file', // 非目录（无介质光驱等）跳过
      // 其余盘符不存在
    }));
    const entries = roots.listRootLevel();
    expect(entries.map(e => e.name)).toEqual(['C:', 'D:']);
    expect(entries[0]).toMatchObject({
      fullPath: 'C:\\',
      isDir: true,
      size: 0,
      mtime: 1700000000000,
      isImportableFile: false,
      importableType: null,
    });
  });
});

describe('fsRootsFor — POSIX（单一根）', () => {
  it('根层级即真实目录 /：无虚拟层级分支，到顶父级为 null', () => {
    const roots = fsRootsFor('linux');
    expect(roots.rootLevelPath).toBe('/');
    expect(roots.isRootLevel('')).toBe(false);
    expect(roots.isRootLevel('/')).toBe(false);
    expect(roots.parentOf('/')).toBe(null);
    expect(roots.parentOf('/home')).toBe('/');
    expect(roots.parentOf('/home/x')).toBe('/home');
  });
});
