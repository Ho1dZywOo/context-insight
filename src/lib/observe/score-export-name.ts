// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// the CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// score 导出文件名单一源：页面按钮（fallbackDownload）与 score-export 端点
// （content-disposition）共用同一命名规则——solo 用会话口径（session_<taskId>），
// bundle 用 run 身份（run_<name>），统一做文件系统安全字符收敛。此前客户端与
// 服务端各算一份，solo 分支客户端还漏了收敛，命名漂移风险由本模块收口。
// 离线 HTML 档案同 URL 应答时客户端据此算名——档案只存 JSON body 不存 headers，
// 故不依赖响应头 content-disposition 取名。

const UNSAFE_FILENAME_RE = /[\\/:*?"<>|\s]+/g;

export function scoreExportFileName(opts: {
  solo: boolean;
  runId: string;
  /** solo 成员任务 id（bundle 忽略） */
  taskId?: string | null;
  /** bundle run 显示名（solo 忽略） */
  runName?: string | null;
}): string {
  const nameBase = opts.solo ? opts.taskId ?? opts.runId : opts.runName ?? opts.runId;
  const safeBase = String(nameBase).replace(UNSAFE_FILENAME_RE, '_');
  return `${opts.solo ? 'session' : 'run'}_${safeBase}_score.json`;
}