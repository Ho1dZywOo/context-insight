// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// E2E 播种层：Playwright 起 webServer（boot-server.sh：重建 e2e.db → 构建 →
// next start）并等健康 URL 探针通过后，才跑 globalSetup——此刻服务已在，
// 播种直接走**真实 HTTP 导入管线**（与 UI 向导同一端点同一代码路径）：
//
//   ① mini-bundle → run minidemo01（POST /api/ingest/import-bundle 起后台
//      job，轮询 status 至 done）——run 工作台 9 tab 的全套语料
//   ② claude-sample.jsonl → solo 会话（伞形列会话 + 逐条 import-file）
//
// 播种即冒烟：这两条路走不通时，UI 导入旅程必然也是坏的——globalSetup
// 给出可行动报错（而非让每个 spec 各自超时）。测试断言不依赖播种条数之外
// 的隐式状态；e2e.db 每次 boot 重建，run-to-run 确定性。

import { BASE_URL, CLAUDE_SAMPLE_JSONL, MINI_BUNDLE_DIR, TOOL_BUNDLE_DIR } from "./constants";

interface ImportJobState {
  step: "validate" | "store" | "import" | "done" | "error";
  imported: number;
  existing: number;
  total: number;
  error?: string;
}

async function postJson(pathname: string, body: unknown): Promise<Response> {
  return fetch(`${BASE_URL}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readError(res: Response, context: string): Promise<string> {
  let detail = "";
  try {
    detail = JSON.stringify(await res.json());
  } catch {
    /* 非 JSON 响应（如纯文本 500）——保留空详情 */
  }
  return `seed: ${context} → HTTP ${res.status} ${detail}`;
}

/** job 化 bundle 导入轮询（与 ImportDialog 的 1s 轮询同契约，这里 500ms 加速）。 */
async function pollImportJob(jobId: string): Promise<ImportJobState> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const res = await fetch(`${BASE_URL}/api/ingest/import-bundle/status?jobId=${encodeURIComponent(jobId)}`);
    if (!res.ok) throw new Error(await readError(res, "import-bundle/status"));
    const { job } = (await res.json()) as { job: ImportJobState };
    if (job.step === "done") return job;
    if (job.step === "error") throw new Error(`seed: import-bundle job failed: ${job.error ?? "unknown"}`);
    if (Date.now() > deadline) throw new Error("seed: import-bundle job timed out (90s)");
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** job 化 bundle 导入（起 job → 轮询 status 至 done），并校验导入会话数——
 *  半路丢件时给出可行动报错（好过让每个 spec 各自超时）。 */
async function seedBundle(dirPath: string, minSessions: number): Promise<ImportJobState> {
  const res = await postJson("/api/ingest/import-bundle", { dirPath });
  if (!res.ok) throw new Error(await readError(res, `import-bundle (${dirPath})`));
  const { jobId } = (await res.json()) as { jobId: string; runId: string };
  const job = await pollImportJob(jobId);
  if (job.imported + job.existing < minSessions) {
    throw new Error(
      `seed: import-bundle (${dirPath}) imported suspiciously few sessions ` +
        `(imported=${job.imported}, existing=${job.existing}, total=${job.total})`,
    );
  }
  return job;
}

export default async function globalSetup(): Promise<void> {
  // 健康双确认：webServer.url 探针已守卫过；这里失败时给出 E2E 语境报错
  const health = await fetch(`${BASE_URL}/api/observe/data?pageSize=1`);
  if (!health.ok) {
    throw new Error(`seed: server not healthy at ${BASE_URL} (HTTP ${health.status}) — check e2e/boot/boot-server.sh output`);
  }

  // ① mini-bundle → run minidemo01（结构语料：图/代际/验收/子图）
  const miniJob = await seedBundle(MINI_BUNDLE_DIR, 3);

  // ② tool-bundle → run e2e-tools01（工具语料：Read/bash/Grep + 真实时长）
  await seedBundle(TOOL_BUNDLE_DIR, 3);

  // ③ claude-sample.jsonl → solo 会话（伞形 'jsonl' 列出 → 按条目具体源导入）
  const listRes = await postJson("/api/ingest/import-file/sessions", {
    source: "jsonl",
    filePath: CLAUDE_SAMPLE_JSONL,
  });
  if (!listRes.ok) throw new Error(await readError(listRes, "import-file/sessions"));
  const { sessions } = (await listRes.json()) as {
    sessions: Array<{ id: string; source: string }>;
  };
  if (sessions.length === 0) {
    throw new Error(`seed: no sessions listed from ${CLAUDE_SAMPLE_JSONL}`);
  }
  for (const s of sessions) {
    const res = await postJson("/api/ingest/import-file", {
      sessionId: s.id,
      filePath: CLAUDE_SAMPLE_JSONL,
      source: s.source,
    });
    if (!res.ok) throw new Error(await readError(res, `import-file (${s.id})`));
  }

  // eslint 不再需要摘要豁免（globalSetup 的 stdout 由 playwright 呈现）
  console.log(`[e2e-seed] corpus ready: minidemo01 (${miniJob.imported} sessions) + e2e-tools01 + ${sessions.length} solo claude session(s)`);
}
