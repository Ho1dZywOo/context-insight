// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 品牌图标瓦片（run 详情页 BrandLockup 与主页大标题共用）：对角渐变 + 白色
// Activity glyph + 内高光/投影。sm 档与详情页逐类一致；lg 档供主页大标题
// 旁挂（同梯度视觉、等比放大）。

import { ActivityIcon } from 'lucide-react';

export function BrandMark({ size = 'sm' }: { size?: 'sm' | 'lg' }) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center bg-gradient-to-br from-sky-400 via-blue-500 to-indigo-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.25),0_1px_4px_rgba(59,113,224,0.45)] ${
        size === 'sm' ? 'size-7 rounded-[8px]' : 'size-10 rounded-[12px]'
      }`}
    >
      <ActivityIcon className={`${size === 'sm' ? 'size-4' : 'size-[19px]'} text-white`} strokeWidth={2.5} />
    </span>
  );
}
