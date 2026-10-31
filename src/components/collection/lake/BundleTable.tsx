// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

'use client';

// bundle 表格（统一布局：任意范式目录视图内的"工作流包"区块 + 导入弹窗
// 复用）：一行一个 workflow 包。导入 = 发起 run 导入 job + 轮询进度（复用
// import-bundle 状态端点）——完成后回调 onImported 刷新列表（imported 标记
// 翻转），不自动跳转（bundle 对应 runs 工作台的一行，跳转目标由用户自选）。

import { useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { formatDateTime } from '@/lib/collection/lake-view/format';

export interface BundleItemView {
  runId: string;
  name: string | null;
  status: string | null;
  exportDataComplete: boolean | null;
  memberCount: number | null;
  sessionCount: number | null;
  submitter: string | null;
  description: string | null;
  paradigm: string | null;
  opGen: 'success' | 'failure' | null;
  uploadedAt: string | null;
  commitTime: string;
  imported: boolean;
}

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  passed: { label: '通过', cls: 'bg-emerald-100 text-emerald-800' },
  success: { label: '通过', cls: 'bg-emerald-100 text-emerald-800' },
  failed: { label: '未通过', cls: 'bg-red-100 text-red-800' },
};

// 导入轮询上限（1s × 1800 = 30min）：覆盖大包（数百会话）物化 + 导入
const POLL_MAX_TICKS = 1800;

function copyRunId(runId: string) {
  void navigator.clipboard?.writeText(runId);
}

export function BundleTable({
  items,
  onImported,
}: {
  items: BundleItemView[];
  onImported: () => void;
}) {
  const [importing, setImporting] = useState<Set<string>>(new Set());
  const [importErrors, setImportErrors] = useState<Map<string, string>>(new Map());
  const [progress, setProgress] = useState<Map<string, string>>(new Map());

  const importBundle = async (runId: string, paradigm: string | null) => {
    setImporting(prev => new Set(prev).add(runId));
    setImportErrors(prev => { const m = new Map(prev); m.delete(runId); return m; });
    setProgress(prev => { const m = new Map(prev); m.set(runId, '发起导入…'); return m; });
    try {
      const res = await fetch('/api/ingest/lake', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // paradigm = 列表行所在目录（位置即身份）：透传即精确物化，免全仓搜索
        body: JSON.stringify({ action: 'bundle-import', runId, ...(paradigm != null ? { paradigm } : {}) }),
      });
      const data = await res.json() as { jobId?: string; error?: string };
      if (!res.ok || !data.jobId) throw new Error(data.error ?? `HTTP ${res.status}`);
      for (let tick = 0; tick < POLL_MAX_TICKS; tick++) {
        await new Promise(r => setTimeout(r, 1000));
        let st: { job?: { step: string; imported: number; existing: number; total: number; error: string | null } } | null = null;
        try {
          st = await fetch(`/api/ingest/import-bundle/status?jobId=${encodeURIComponent(data.jobId)}`).then(r => r.json());
        } catch {
          continue; // 瞬时网络失败，下一轮重试
        }
        if (!st?.job) continue; // job 过期/丢失——保持轮询到上限
        const j = st.job;
        if (j.step === 'done') {
          onImported();
          toast.success(`Bundle ${runId.slice(0, 8)} 导入完成`, {
            description: `新导入 ${j.imported} · 已存在 ${j.existing}`,
          });
          return;
        }
        if (j.step === 'error') throw new Error(j.error ?? '导入失败');
        setProgress(prev => { const m = new Map(prev); m.set(runId, `导入会话 ${(j.imported ?? 0) + (j.existing ?? 0)}/${j.total}`); return m; });
      }
      throw new Error('导入超时（30 分钟）——可在 runs 工作台确认进度后重试');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setImportErrors(prev => new Map(prev).set(runId, msg));
      toast.error('导入失败', { description: msg });
    } finally {
      setImporting(prev => { const s = new Set(prev); s.delete(runId); return s; });
      setProgress(prev => { const m = new Map(prev); m.delete(runId); return m; });
    }
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 border-b border-neutral-200 bg-white">
          <tr className="text-left">
            <th className="px-3 py-2 font-medium text-neutral-500">Bundle</th>
            <th className="px-3 py-2 font-medium text-neutral-500">名称</th>
            <th className="px-3 py-2 font-medium text-neutral-500">范式</th>
            <th className="px-3 py-2 font-medium text-neutral-500">体检状态</th>
            <th className="px-3 py-2 font-medium text-neutral-500">成员 / 会话</th>
            <th className="px-3 py-2 font-medium text-neutral-500">提交人</th>
            <th className="px-3 py-2 font-medium text-neutral-500">任务结果</th>
            <th className="px-3 py-2 font-medium text-neutral-500">描述</th>
            <th className="px-3 py-2 font-medium text-neutral-500">上传时间</th>
            <th className="px-3 py-2 font-medium text-neutral-500">导入</th>
            <th className="px-3 py-2 font-medium text-neutral-500">操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map(b => {
            const busy = importing.has(b.runId);
            const badge = b.status ? STATUS_BADGE[b.status] : null;
            return (
              <tr key={b.runId} className="border-b border-neutral-100 hover:bg-neutral-50">
                <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">
                  <span className="inline-flex items-center gap-1.5">
                    <span title={b.runId}>{b.runId.slice(0, 12)}</span>
                    <button
                      type="button"
                      className="text-neutral-400 hover:text-neutral-700"
                      title="复制完整 runId"
                      onClick={() => copyRunId(b.runId)}
                    >
                      ⧉
                    </button>
                  </span>
                </td>
                <td className="max-w-[14rem] px-3 py-2 text-xs text-neutral-600">
                  <span className="block truncate" title={b.name ?? undefined}>
                    {b.name ?? <span className="text-neutral-300">—</span>}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-xs text-neutral-600">
                  {b.paradigm ?? <span className="text-neutral-300" title="根级包（无范式目录）">—</span>}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-xs">
                  {b.status == null ? (
                    <span className="text-neutral-300" title="包内无体检报告">—</span>
                  ) : badge ? (
                    <span className={`inline-block rounded px-1.5 py-0.5 ${badge.cls}`}>{badge.label}</span>
                  ) : (
                    <span className="text-neutral-600">{b.status}</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-xs tabular-nums text-neutral-700">
                  {b.memberCount ?? <span className="text-neutral-300">—</span>}
                  <span className="text-neutral-400"> / </span>
                  {b.sessionCount ?? <span className="text-neutral-300">—</span>}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-xs text-neutral-600">
                  {b.submitter ?? <span className="text-neutral-300">—</span>}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-xs">
                  {b.opGen === 'success' && <span className="text-emerald-600" title="任务成功">✓</span>}
                  {b.opGen === 'failure' && <span className="text-red-600" title="任务失败">✗</span>}
                  {b.opGen == null && <span className="text-neutral-300" title="未标注">—</span>}
                </td>
                <td className="max-w-[16rem] px-3 py-2 text-xs text-neutral-600">
                  <span className="block truncate" title={b.description ?? undefined}>
                    {b.description ?? <span className="text-neutral-300">—</span>}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-xs tabular-nums text-neutral-700">
                  {formatDateTime(b.uploadedAt ?? (b.commitTime || null))}
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  {b.imported
                    ? <span className="text-xs text-emerald-700">已导入</span>
                    : <span className="text-xs text-neutral-400" title="runs 工作台尚无此 run">未导入</span>}
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  {busy ? (
                    <span className="rounded border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-700" title="后台导入中，导入完成自动刷新">
                      {progress.get(b.runId) ?? '导入中…'}
                    </span>
                  ) : importErrors.has(b.runId) ? (
                    <button
                      type="button"
                      onClick={() => void importBundle(b.runId, b.paradigm)}
                      className="rounded border border-red-300 px-2 py-0.5 text-xs text-red-600 hover:bg-red-50"
                      title={importErrors.get(b.runId)}
                    >
                      重试导入
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void importBundle(b.runId, b.paradigm)}
                      className="rounded border border-sky-300 px-2 py-0.5 text-xs text-sky-700 hover:bg-sky-50"
                      title="下载该包并导入到本地，导入后 runs 工作台可见"
                    >
                      {b.imported ? '重新导入' : '导入查看'}
                    </button>
                  )}
                  {b.imported && !busy && (
                    <Link
                      href="/?kind=run"
                      className="ml-1.5 rounded border border-neutral-300 px-2 py-0.5 text-xs text-neutral-700 hover:bg-neutral-100"
                    >
                      查看运行
                    </Link>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
