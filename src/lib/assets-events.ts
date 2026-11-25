// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 资产集合变更事件（客户端跨组件软同步）：AssetList 与 RecycleBin 各自持有
// 客户端态的资产副本（列表 items / 回收站 entries），而二者互不为父子、无共
// 同 store——任一侧完成服务端结算（删除/撤销/恢复）后广播本事件，持有方各
// 自重取对齐。替代旧范式的整页 location.reload「全局快照」同步：items 是客
// 户端 state，router.refresh() 只换 RSC props 不重置 state，跨组件必须显式
// 通知。事件载荷为空（无派发方与监听方的 schema 耦合），监听方按自己的口
// 径全量重取——服务端是唯一真相源，客户端只做缓存失效。

export const ASSETS_CHANGED_EVENT = 'insight:assets-changed'

export function notifyAssetsChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(ASSETS_CHANGED_EVENT))
}

export function onAssetsChanged(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(ASSETS_CHANGED_EVENT, handler)
  return () => window.removeEventListener(ASSETS_CHANGED_EVENT, handler)
}
