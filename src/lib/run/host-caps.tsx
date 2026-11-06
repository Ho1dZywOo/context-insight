// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 工作台宿主能力门控：同一组件树跑在 live 页面与离线导出 HTML 两种宿主里
// （run 工作台自身即离线查看器）。需要服务端协作或页面的能力——刷新/
// 自动同步/上传/导出/在线对账/评分重算——经本单点询问；缺省 live（Next
// 页面不包 provider 即全能力），离线 bundle 由入口包 offline provider。

"use client";

import { createContext, useContext, type ReactNode } from "react";

export interface RunHostCaps {
  /** 离线导出 HTML 宿主：无服务端、无页面导航，只消费内嵌档案 */
  offline: boolean;
}

const LIVE_CAPS: RunHostCaps = { offline: false };

const RunHostCapsContext = createContext<RunHostCaps>(LIVE_CAPS);

export function RunOfflineHostCapsProvider({ children }: { children: ReactNode }) {
  return <RunHostCapsContext.Provider value={{ offline: true }}>{children}</RunHostCapsContext.Provider>;
}

export function useRunHostCaps(): RunHostCaps {
  return useContext(RunHostCapsContext);
}
