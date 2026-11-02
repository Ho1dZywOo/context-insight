// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 回归锁：importSession 结果 → reason 四态单一真身（import-file 路由与数据仓
// lake 导入共用）。lake 侧此前缺 reason，前端 importResultMessage 把「空捕获 /
// 无交互」一律错标成「Already exists (merged)」。此表锁定 local/lake 同口径的
// imported+query → reason 映射，改任一侧语义必先改这里。

import { describe, it, expect } from 'vitest';
import { importReasonOf } from '@/lib/ingest/data-service';

describe('importReasonOf — import 结果四态（local/lake 同口径）', () => {
  it('imported + query → imported', () => {
    expect(importReasonOf(true, '第一轮提问')).toBe('imported');
  });

  it('imported + no query → imported-empty（空捕获占位行）', () => {
    expect(importReasonOf(true, null)).toBe('imported-empty');
  });

  it('not imported + query → already-exists（已存在，合并）', () => {
    expect(importReasonOf(false, '存量会话的第一轮')).toBe('already-exists');
  });

  it('not imported + no query → no-interactions（空或不可读）', () => {
    expect(importReasonOf(false, null)).toBe('no-interactions');
  });
});