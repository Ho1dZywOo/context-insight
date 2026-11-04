// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// BigInt → JSON 边界序列化垫片（roll-up 列升 BigInt 的配套，单一安装点）。
//
// 背景：Session/Execution/InteractionBridge 的 token 与时延 roll-up 列是无界
// 域量（实测 Execution.tokens 1.26B、长活会话 execution 跨度 3.8B ms、外部
// 报告 Session.totalTokens 2.23B——均破 Int32 的 2.147B 上限，SQLite 64 位照
// 存、Prisma 读出即抛 Inconsistent column data），schema 已升 BigInt，Prisma
// 查询结果里这些字段由此变为 bigint。
//
// 问题：JSON.stringify 原生不支持 bigint（直接 TypeError）。API 路由、lake
// 导出、分析器等几十处序列化点若各自手动 Number()，漏一处就是一条查不出
// 的运行时 500（tsc 对「对象里藏 bigint 再 stringify」零感知）。与其散点
// 防守，不如在序列化边界装一次全局垫片：bigint.toJSON = Number()。
//
// 精度依据：token 计数与时延毫秒的真实域远小于 2^53（≈9e15，JS number 的
// 精确整数上界；3.8B ms ≈ 44 天会话跨度也才 3.8e9），Number() 无损。超出
// 2^53 的值只可能是脏数据（如起点塌成 epoch 0 的整段时间戳），显示层四舍
// 五入无害——列本身的 64 位精度不受影响。
//
// 安装点：Next 服务端 instrumentation.register（src/instrumentation.ts）、
// 测试 setup（tests/setup.ts）、db 单例（src/lib/db.ts，覆盖绕过 Next 的
// 独立入口：脚本 / CLI / 直连 prisma 的测试）。模块幂等，多次 import 无副作用。

export {};

const bigintProto = BigInt.prototype as unknown as { toJSON?: () => number };
if (typeof bigintProto.toJSON !== 'function') {
  Object.defineProperty(bigintProto, 'toJSON', {
    value: function (this: bigint): number {
      return Number(this);
    },
    writable: true,
    configurable: true,
    enumerable: false,
  });
}
