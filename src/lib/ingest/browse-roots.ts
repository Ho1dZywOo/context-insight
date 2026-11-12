// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 文件系统根层级（browse-directory 的平台差异单点）。
//
// 浏览导航不能假设「单一根的树」：Windows 多盘符、无公共根——盘根
// （C:\）之上没有父目录（path.dirname('C:\\') === 'C:\\'），向上导航
// 在盘根死锁，其他盘结构性不可达。故引入「根层级」概念：
//
//   POSIX  根层级 = '/'（真实目录，走普通浏览分支，仅 parentOf 到顶返回 null）
//   win32  根层级 = ''（虚拟层级 = 盘符列表；盘根的 parent 即根层级）
//
// platform 与盘符探测器均可注入——语义可在任意开发平台单测。

import fs from 'node:fs';
import path from 'node:path';

/** 根层级条目（与 browse-directory 响应的目录条目同形——前端零特判）。 */
export interface RootLevelEntry {
  name: string;
  fullPath: string;
  isDir: boolean;
  size: number;
  mtime: number;
  isImportableFile: boolean;
  importableType: string | null;
}

export interface FsRoots {
  /** 根层级标识（浏览请求传它即进入根层级）。 */
  readonly rootLevelPath: string;
  /** 是否为需要特殊分支的虚拟根层级（仅 win32 的 ''；POSIX '/' 是真实目录）。 */
  isRootLevel(p: string): boolean;
  /** 导航父级：普通目录 = dirname；win32 盘根/UNC 根 → 根层级；POSIX '/' → null（到顶）。 */
  parentOf(resolved: string): string | null;
  /** 列出根层级条目（win32 = 盘符探测；POSIX 不可达——'/' 走普通分支）。 */
  listRootLevel(): RootLevelEntry[];
}

const DRIVE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

function driveEntry(root: string, mtime: number): RootLevelEntry {
  return {
    name: root.slice(0, 2),
    fullPath: root,
    isDir: true,
    size: 0,
    mtime,
    isImportableFile: false,
    importableType: null,
  };
}

export function fsRootsFor(
  platform: NodeJS.Platform,
  statFn: (p: string) => fs.Stats = (p) => fs.statSync(p),
): FsRoots {
  if (platform === 'win32') {
    return {
      rootLevelPath: '',
      isRootLevel: (p) => p === '',
      parentOf(resolved) {
        const parent = path.win32.dirname(resolved);
        return parent === resolved ? '' : parent;
      },
      listRootLevel() {
        const out: RootLevelEntry[] = [];
        for (const letter of DRIVE_LETTERS) {
          const root = `${letter}:\\`;
          try {
            const s = statFn(root);
            if (s.isDirectory()) out.push(driveEntry(root, s.mtimeMs));
          } catch { /* 盘不存在（无介质/未分配）——跳过 */ }
        }
        return out;
      },
    };
  }
  return {
    rootLevelPath: '/',
    isRootLevel: () => false,
    parentOf(resolved) {
      const parent = path.posix.dirname(resolved);
      return parent === resolved ? null : parent;
    },
    listRootLevel() {
      return []; // POSIX 根是真实目录，isRootLevel 恒 false，本方法不可达
    },
  };
}

/** 运行时入口（路由消费）：绑定真实平台与 stat。 */
export function fsRoots(): FsRoots {
  return fsRootsFor(process.platform);
}
