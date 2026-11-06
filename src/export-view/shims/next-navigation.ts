// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 嵌入式导出 bundle 的 next/navigation shim：用全局变量替代 Next 路由。
// searchParams 静态为空——离线档案与 live 工作台默认视图严格 parity（wire/
// replay 高级 tab 同样隐藏；wire-rounds 档案也不采集，导出文件不背冗余）
export function useSearchParams(): URLSearchParams {
  return new URLSearchParams("")
}
export function useRouter() {
  return { push: () => {}, replace: () => {}, back: () => {}, refresh: () => {} }
}
export function usePathname(): string {
  return "/run/export"
}
export function redirect(): never {
  throw new Error("redirect not supported in export bundle")
}
