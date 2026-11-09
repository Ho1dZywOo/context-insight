// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// the CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// score 导出文件名单一源回归锁（review fix）：页面按钮与 score-export 端点此前
// 各算一份命名（session_/run_ 前缀 + 安全字符收敛），solo 分支客户端还漏了收敛，
// 存在漂移风险。本锁钉住共享 helper 的命名规则——solo 会话口径 / bundle run 身份，
// 全路径统一安全字符收敛。

import { describe, it, expect } from 'vitest';
import { scoreExportFileName } from '@/lib/observe/score-export-name';

describe('score 导出文件名单一源', () => {
  it('solo：会话口径 session_<taskId>，安全字符统一收敛', () => {
    expect(scoreExportFileName({ solo: true, runId: 'solo:ses_x', taskId: 'ses_x' }))
      .toBe('session_ses_x_score.json');
    // 此前客户端 solo 分支漏收敛：含路径/空白字符的 taskId 会与服务端漂移
    expect(scoreExportFileName({ solo: true, runId: 'solo:ses x/y', taskId: 'ses x/y' }))
      .toBe('session_ses_x_y_score.json');
  });

  it('bundle：run 身份 run_<name>，缺名回落 runId', () => {
    expect(scoreExportFileName({ solo: false, runId: 'run1', runName: 'My Run' }))
      .toBe('run_My_Run_score.json');
    expect(scoreExportFileName({ solo: false, runId: 'run1', runName: null }))
      .toBe('run_run1_score.json');
  });

  it('solo 缺 taskId 回落 runId（防御性，正常 solo taskId 恒在场）', () => {
    expect(scoreExportFileName({ solo: true, runId: 'solo:ses_x', taskId: null }))
      .toBe('session_solo_ses_x_score.json');
  });
});