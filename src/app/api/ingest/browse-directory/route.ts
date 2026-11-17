// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { NextRequest, NextResponse } from 'next/server';
import { sniffImportableFile } from '@/lib/ingest/adapters/registry';
import { expandHome, checkImportablePath } from '@/lib/ingest/import-paths';
import { fsRoots } from '@/lib/ingest/browse-roots';
import { MANIFEST_FILENAMES } from '@/lib/run/model';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { logError, logWarn } from '@/lib/logger';

// 目录条目数无界（如 /tmp 顶层 12 万+ 临时目录），浏览接口的性能纪律：
// - 条目全量返回（浏览是找东西，不裁剪数据——大目录靠前端虚拟滚动消化）
// - IO 分批并发、每条目至多一次 stat（withFileTypes 一次 readdir 完成分组，
//   不再有排序比较器×2 + map 的重复 stat 风暴）
// - bundle manifest 探测设目录数上限：探测是 isBundleDir 高亮的锦上添花，
//   每目录 2 次 access——12 万目录级（实测命中恒 0 的工具临时目录海）跳过；
//   普通工作目录（<上限）保持真值探测
const PROBE_DIR_LIMIT = 2000;
const IO_BATCH = 256;

interface EntryPayload {
  name: string;
  fullPath: string;
  isDir: boolean;
  size: number;
  mtime: number;
  isImportableFile: boolean;
  importableType: string | null;
  isBundleDir: boolean;
}

async function statFile(dir: string, name: string): Promise<EntryPayload> {
  const full = path.join(dir, name);
  try {
    const s = await fsp.stat(full);
    // importableType 单点判定（agent-source-framework 注册表嗅探）：声明序即
    // 优先级——前缀精确嗅探（context_session_ / rollout-）先于扩展名兜底
    // （.db / .jsonl），codex 的 rollout-*.jsonl 不再误判成 claude 捕获件；
    // 压缩三形态（.jsonl.7z/.gz）由 claude 兜底覆盖
    const importableType = sniffImportableFile(name);
    return {
      name,
      fullPath: full,
      isDir: false,
      size: s.size,
      mtime: s.mtimeMs,
      isImportableFile: importableType != null,
      importableType,
      isBundleDir: false,
    };
  } catch (e) {
    logWarn('route:ingest/browse-directory', '目录项读取失败', { name, error: e instanceof Error ? e.message : String(e) });
    return {
      name,
      fullPath: full,
      isDir: false,
      size: 0,
      mtime: 0,
      isImportableFile: false,
      importableType: null,
      isBundleDir: false,
    };
  }
}

// 分批并发：一次全量 Promise.all 在 10 万级条目下会压垮事件循环回调队列
async function mapBatched<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += IO_BATCH) {
    const batch = items.slice(i, i + IO_BATCH);
    out.push(...await Promise.all(batch.map(fn)));
  }
  return out;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { dirPath } = body;

    if (typeof dirPath !== 'string') {
      return NextResponse.json(
        { error: 'Missing required field: dirPath' },
        { status: 400 },
      );
    }

    // 空串 = 文件系统根层级（win32 盘符列表 / POSIX '/'），平台差异见 browse-roots
    const roots = fsRoots();
    const target = dirPath === '' ? roots.rootLevelPath : dirPath;

    // 根层级是导航入口（win32 虚拟盘符列表 / POSIX '/'），不是真实数据访问：
    // 白名单不拦导航，否则开了 CONTEXT_INSIGHT_IMPORT_ROOTS 的部署连盘符列表/
    // 根目录都看不到；真正进入某个盘/目录后（非根层级）才按白名单拦。
    if (target !== roots.rootLevelPath) {
      // 白名单收紧（CONTEXT_INSIGHT_IMPORT_ROOTS 设置时）先于一切目录读取
      const pathDecision = checkImportablePath(target);
      if (!pathDecision.ok) {
        return NextResponse.json(
          { error: `Path "${dirPath}" is outside the allowed import roots: ${pathDecision.roots.join(', ')}`, reason: 'path-outside-import-roots' },
          { status: 403 },
        );
      }
    }

    // win32 根层级是虚拟层级（无真实目录），直接返回盘符列表
    if (roots.isRootLevel(target)) {
      return NextResponse.json({
        isDirectory: true,
        isRootLevel: true,
        entries: roots.listRootLevel(),
        currentPath: roots.rootLevelPath,
        parentPath: null,
      });
    }

    const resolved = path.resolve(expandHome(target));

    if (!fs.existsSync(resolved)) {
      return NextResponse.json(
        { error: `Path does not exist: ${resolved}` },
        { status: 404 },
      );
    }

    const stats = fs.statSync(resolved);
    if (!stats.isDirectory()) {
      return NextResponse.json({
        isDirectory: false,
        entries: [],
        parentPath: roots.parentOf(resolved),
        currentPath: resolved,
      });
    }

    // withFileTypes：Dirent 自带 isDirectory，一次 readdir 同时完成分组——
    // 每个条目至多再花一次 stat，消灭排序比较器×2 + map 的重复 stat 风暴
    const dirents = fs.readdirSync(resolved, { withFileTypes: true });
    const dirNames: string[] = [];
    const fileNames: string[] = [];
    for (const d of dirents) {
      if (d.isDirectory()) dirNames.push(d.name);
      else fileNames.push(d.name);
    }
    dirNames.sort((a, b) => a.localeCompare(b));

    // 文件：并发 stat（size/mtime/importable 嗅探在 stat 内完成）
    const fileEntries = await mapBatched(fileNames, (name) => statFile(resolved, name));

    // 目录：manifest 探测仅在目录数上限内做（isBundleDir 高亮）；目录 mtime
    // 恒 0（组内名字序，消费方 sortDirEntries 单点）。超限目录海（如 /tmp 顶层
    // 12 万+）跳过探测——浏览照常全量可见可导航，只是 bundle 高亮不标。
    const probe = dirNames.length <= PROBE_DIR_LIMIT;
    const dirEntries = await mapBatched(dirNames, async (name) => {
      const full = path.join(resolved, name);
      // run 域展示提示：目录内含 bundle 清单文件（workflow.json/manifest.json，
      // 候选名与 import-service 共用 model.MANIFEST_FILENAMES 同一事实源）即
      // 标记——BundleImport 浏览视图高亮可导入的 workflow-bundle 目录
      let isBundleDir = false;
      if (probe) {
        for (const n of MANIFEST_FILENAMES) {
          if (await fsp.access(path.join(full, n)).then(() => true, () => false)) {
            isBundleDir = true;
            break;
          }
        }
      }
      return {
        name,
        fullPath: full,
        isDir: true,
        size: 0,
        mtime: 0,
        isImportableFile: false,
        importableType: null,
        isBundleDir,
      } satisfies EntryPayload;
    });

    // 目录优先置顶；组内排序交给消费方（前端 sortDirEntries 单点）
    return NextResponse.json({
      isDirectory: true,
      entries: [...dirEntries, ...fileEntries],
      parentPath: roots.parentOf(resolved),
      currentPath: resolved,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logError('route:ingest/browse-directory', '浏览失败', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
