// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// bigint-json 垫片精度守卫生回归锁（审查意见：全局 BigInt.prototype.toJSON = Number()
// 对超出 2^53 的真 64 位值会「静默丢精度、零报错」——垫片加 Number.isSafeInteger
// 越界抛错，把静默吞精度变成响亮失败）。垫片在 tests/setup.ts 已全局安装，本
// 用例直接对 JSON.stringify 断言边界行为。

import { describe, expect, it } from 'vitest';

describe('bigint-json 垫片：安全整数界内的序列化无损、越界响亮失败', () => {
  it('安全整数界内 bigint 序列化为 number 且无损（roll-up 真实域 < 2^53）', () => {
    expect(JSON.stringify({ n: BigInt('123') })).toBe('{"n":123}');
    // Number.MAX_SAFE_INTEGER = 2^53 - 1，仍可精确表示
    expect(JSON.stringify({ n: BigInt('9007199254740991') })).toBe('{"n":9007199254740991}');
    // roll-up 真实峰值（2.4B tokens / 3.8B ms）远小于界，序列化安全
    expect(JSON.stringify({ tokens: BigInt('2400000000') })).toBe('{"tokens":2400000000}');
  });

  it('超出安全整数界（真 64 位值）抛错而非静默丢精度', () => {
    // 2^53 + 1 经 Number() 会四舍五入丢精度——垫片应抛错阻止
    expect(() => JSON.stringify({ id: BigInt('9007199254740993') })).toThrow(TypeError);
    expect(() => JSON.stringify(BigInt('9007199254740992'))).toThrow(TypeError); // 2^53 本身已非安全
  });
});
