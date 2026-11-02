// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { NextRequest, NextResponse } from 'next/server';
import { listLakeOverview, listLakeSessions, importLakeSession, uploadLakeSessionWithNative, GovernanceError, listParadigmDirs } from '@/lib/lake';
import { prewarmLfsBinary } from '@/lib/lake/lfs-setup';
import { resolveNativeCounterpart } from '@/lib/ingest/native-counterpart';
import { agentFrameworkOf } from '@/lib/shared/session-format';
import { listLakeBundles, uploadLakeBundle, importLakeBundle } from '@/lib/lake/bundle';
import { resolveLakeRemote, resolveAdhocRemote, testLakeRemote, listRemoteBranches, redactRemoteSecrets, normalizeDirPrefix } from '@/lib/lake/remote';
import { classifyLakeError, lakeLfsNotEnabledMessage } from '@/lib/lake/auth';
import { listRemoteDirs } from '@/lib/lake/mirror';
import type { LakeRemoteInput } from '@/lib/lake-config';
import { prisma } from '@/lib/db';
import { logError, logWarn } from '@/lib/logger';
import { putScorecard, readRecords, NotesConflictError, type SessionLoc } from '@/lib/lake/notes';
import { getScorecard } from '@/app/lake_viewer/_lib/insight-data';

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  // 单源架构：数据动作（list/dirs/import/upload）的远端一律 resolveLakeRemote()
  // 读服务端 lake-config.json，请求体 config 对它们无意义（忽略）。探测动作
  // （test/branches/dirs 浏览）走 resolveAdhocRemote 拿编辑态显式值。remote
  // 在各分支内按需 resolve；fail() 脱敏消费 nullable remote
  let remote: ReturnType<typeof resolveLakeRemote> | null = null;
  let secrets: (string | undefined)[] = [];
  // 错误出边界统一走这里：消息脱敏 + classifyLakeError 产出结构化 code
  // （no-credentials/auth-failed/forbidden/quota/lfs-not-enabled/unknown）——
  // 前端据 code 给「前往设置页配置凭据」等定向引导，而不是让用户看脱敏后
  // 的 git 原文；lfs-not-enabled 用白话文案整段替换（凭据无问题的结论 +
  // 平台侧出路，见 lakeLfsNotEnabledMessage）
  const fail = (err: unknown, status = 500) => {
    const code = classifyLakeError(err);
    const message = code === 'lfs-not-enabled'
      ? lakeLfsNotEnabledMessage()
      : redactRemoteSecrets(
          err instanceof Error ? err.message : String(err), remote ?? undefined, secrets,
        );
    logError('route:ingest/lake', 'lake action 失败', { code, error: message });
    return NextResponse.json({ error: message, code }, { status: code === 'no-credentials' ? 400 : status });
  };
  try {
    const body = await request.json();
    const { action, config } = body as { action?: string; config?: LakeRemoteInput };
    secrets = [config?.account, config?.password, config?.token];

    // test/branches：编辑态探测（adhoc）——校验异常按 400 出。branches 是
    // 分支选择器：容忍用户正在编辑的脏 branch 字段（不消费它）
    if (config && (action === 'test' || action === 'branches')) {
      const toValidate = action === 'branches' ? { ...config, branch: undefined } : config;
      try {
        resolveAdhocRemote(toValidate);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Invalid lake config';
        return NextResponse.json({ error: message }, { status: 400 });
      }
    }

    if (action === 'test') {
      return NextResponse.json(await testLakeRemote(config));
    }

    if (action === 'branches') {
      try {
        return NextResponse.json({ branches: listRemoteBranches(config) });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to list branches';
        return NextResponse.json({ error: message }, { status: 500 });
      }
    }

    if (action === 'dirs') {
      // 目录浏览（设置页选择上传目录）：编辑态地址（adhoc）——浏览的就是
      // 用户正在输入/已保存表单里的远端
      const { prefix } = body as { prefix?: string };
      try {
        remote = resolveAdhocRemote(config);
        const dirs = listRemoteDirs(remote, normalizeDirPrefix(prefix));
        return NextResponse.json({ dirs });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Invalid prefix';
        return NextResponse.json({ error: message }, { status: 400 });
      }
    }

    // 原生对位预检（只读）：上传弹窗勾选「同步上传原生会话」时即时探测——
    // DB 直查 + 本机磁盘发现，不导入不上传，不触碰数据仓（无 lake 配置也可
    // 用）。found 时 sid = 原生行 taskId（codex 与捕获 sid 不同）
    if (action === 'native-preview') {
      const { taskId, framework } = body as { taskId?: string; framework?: string };
      if (!taskId) {
        return NextResponse.json({ error: 'Missing taskId' }, { status: 400 });
      }
      try {
        const session = await prisma.session.findFirst({
          where: framework ? { taskId, framework } : { taskId },
          select: { taskId: true, framework: true, startTime: true, endTime: true, query: true },
        });
        if (!session) {
          return NextResponse.json({ error: `Session not found: "${taskId}"` }, { status: 404 });
        }
        const resolution = await resolveNativeCounterpart(prisma, {
          taskId: session.taskId,
          framework: session.framework,
          startTime: session.startTime ?? null,
          endTime: session.endTime ?? null,
          query: session.query ?? null,
        });
        const resolutionView = resolution.status === 'not-found'
          ? { status: resolution.status, reason: resolution.reason }
          : resolution.origin === 'db'
            ? { status: resolution.status, origin: resolution.origin, sid: resolution.taskId, framework: resolution.framework }
            : { status: resolution.status, origin: resolution.origin, sid: resolution.hit.sessionId, framework: agentFrameworkOf(session.framework) };
        return NextResponse.json({ resolution: resolutionView });
      } catch (err) {
        return fail(err);
      }
    }

    // 数据动作：单源（服务端 lake-config.json），忽略请求体 config
    try {
      remote = resolveLakeRemote();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid lake config';
      return NextResponse.json({ error: message }, { status: 400 });
    }

    // LFS 预热：首个数据动作即后台自举 git-lfs（fire-and-forget，不阻塞响应；
    // 上传/导入路径的同步就绪检查兜底）——用户浏览/填表期间把环境备好，
    // 正式操作时零等待
    if (remote.lfs) prewarmLfsBinary();

    // lake-notes：会话级实验记录（notes）读写——评分卡「上报到数据湖」的统一切入
    // 点（原 /lake_viewer/api/runs/[sid]/notes 语义平移至单源 /api/ingest/lake）。
    // kind 缺省 = 读（上报前「先弹确认」取已有快照）；kind='scorecard' = 覆盖写
    // 评分卡快照（快照取自本地 DB 当时刻值）。会话定位（paradigm/baseline/
    // recording）权威来自数据仓布局（listLakeSessions），不信任请求体直传。
    if (action === 'lake-notes') {
      const { sid, recording, kind } = body as { sid?: string; recording?: string; kind?: string };
      if (!sid) {
        return NextResponse.json({ error: 'Missing sid' }, { status: 400 });
      }
      if (recording != null && recording !== 'capture' && recording !== 'native') {
        return NextResponse.json({ error: `Invalid recording: "${recording}" (capture | native)` }, { status: 400 });
      }
      try {
        const matches = listLakeSessions(remote).filter(x => x.sid === sid);
        const s = (recording === 'capture' || recording === 'native'
          ? matches.find(x => x.recording === recording)
          : undefined) ?? matches.find(x => x.recording === 'capture') ?? matches[0];
        if (!s || !s.paradigm) {
          return NextResponse.json({ error: `Session not found in lake: "${sid}"` }, { status: 404 });
        }
        const loc: SessionLoc = { sid: s.sid, paradigm: s.paradigm, isBaseline: s.isBaseline, recording: s.recording };
        if (kind === 'scorecard') {
          // 真双记录（仓内两位并存）才传 recording 给取卡：快照必须取本记录行
          // 的卡；单记录位（存量裸目录）不传——其 DB 行 framework 无 -proxy 后
          // 缀，按 capture→-proxy 启发式查会永远落空，把已评分会话误判 409
          const dual = matches.some(x => x.recording === 'capture') && matches.some(x => x.recording === 'native');
          const card = await getScorecard(sid, undefined, dual ? (loc.recording === 'native' ? 'native' : 'capture') : undefined);
          if (!card) return NextResponse.json({ error: '无评分卡（该会话未导入或未评分）' }, { status: 409 });
          const records = await putScorecard(loc, card, remote);
          return NextResponse.json({ sid, records });
        }
        const records = await readRecords(loc, remote);
        return NextResponse.json({ sid, records });
      } catch (err) {
        if (err instanceof NotesConflictError) {
          return NextResponse.json({ error: err.message }, { status: 409 });
        }
        return fail(err);
      }
    }

    if (action === 'list') {
      // sessions + 顶层目录（dirs）一次返回：导入对话框的范式下拉 + 会话表
      // 共享单轮 mirror fetch（原先 dirs/list 两路各 fetch 一次 ~1s×2）
      const { sessions, topDirs } = listLakeOverview(remote);
      return NextResponse.json({ sessions, dirs: topDirs });
    }

    if (action === 'import') {
      const { sid, recording } = body as { sid: string; recording?: string };
      if (!sid) {
        return NextResponse.json({ error: 'Missing sid' }, { status: 400 });
      }
      // 记录类（同 sid 双记录）：native = <sid>.native/ 目录（原生 claude 会话），
      // 缺省 capture = 裸 <sid>/ 目录（wire 捕获 / 主位上传）
      if (recording != null && recording !== 'capture' && recording !== 'native') {
        return NextResponse.json({ error: `Invalid recording: "${recording}" (capture | native)` }, { status: 400 });
      }
      try {
        const result = await importLakeSession(sid, prisma, remote, recording === 'native' ? 'native' : 'capture');
        return NextResponse.json({ result });
      } catch (err) {
        return fail(err);
      }
    }

    if (action === 'upload') {
      const { taskId, description, category, baseline, opGen, framework, withNative } = body as { taskId: string; description?: string; category?: string; baseline?: boolean; opGen?: string; framework?: string; withNative?: boolean };
      if (!taskId) {
        return NextResponse.json({ error: 'Missing taskId' }, { status: 400 });
      }
      // opGen（任务结果标注）：只认 success/failure，其余值视为未标注
      const opGenValue = opGen === 'success' || opGen === 'failure' ? opGen : undefined;
      try {
        // framework：同 sid 双行（方案一）消歧——从捕获行页面上传必须带
        // withNative：捕获行上传成功后同步上传本机原生会话（可选）
        const result = await uploadLakeSessionWithNative(prisma, taskId, {
          description,
          category: typeof category === 'string' ? category : undefined,
          baseline: baseline === true,
          opGen: opGenValue,
          framework: typeof framework === 'string' ? framework : undefined,
          withNative: withNative === true,
        }, remote);
        return NextResponse.json(result);
      } catch (err) {
        if (err instanceof GovernanceError) {
          logWarn('route:ingest/lake', '上传熔断拒绝', { sid: taskId, error: err.message });
          return NextResponse.json({ error: err.message, governance: true }, { status: 422 });
        }
        return fail(err);
      }
    }

    if (action === 'bundle-list') {
      // bundle 专区（opsbot-bundle/<runId>/）：列表含 imported 标记（run-store
      // 已有该 runId）+ 顶层目录清单（与会话范式注册表同源——导入弹窗目录
      // 选择阶段与 sessions lake 步同构，归一基础）
      try {
        const items = listLakeBundles(remote);
        const dirs = listParadigmDirs(remote);
        return NextResponse.json({ items, dirs });
      } catch (err) {
        return fail(err);
      }
    }

    if (action === 'bundle-upload') {
      // 已导入 run → opsbot-bundle/<runId>/（原子整体替换；数据源 = insight，
      // 与会话上传同款「导入后上传」链路）
      const { runId, description } = body as { runId?: string; description?: string };
      if (!runId) {
        return NextResponse.json({ error: 'Missing runId' }, { status: 400 });
      }
      try {
        const result = await uploadLakeBundle(prisma, runId, description, remote);
        return NextResponse.json(result);
      } catch (err) {
        if (err instanceof GovernanceError) {
          logWarn('route:ingest/lake', 'bundle 上传熔断拒绝', { runId, error: err.message });
          return NextResponse.json({ error: err.message, governance: true }, { status: 422 });
        }
        return fail(err);
      }
    }

    if (action === 'bundle-import') {
      // 数据仓 bundle → 物化 → run 域导入 job（fire-and-forget，轮询状态）
      const { runId } = body as { runId?: string };
      if (!runId) {
        return NextResponse.json({ error: 'Missing runId' }, { status: 400 });
      }
      try {
        const handle = importLakeBundle(runId, { prisma }, remote);
        return NextResponse.json(handle);
      } catch (err) {
        return fail(err);
      }
    }

    return NextResponse.json({ error: `Unknown action: "${action}". Supported: list, import, upload, bundle-list, bundle-upload, bundle-import, lake-notes, test, branches, dirs` }, { status: 400 });
  } catch (err) {
    return fail(err);
  }
}
