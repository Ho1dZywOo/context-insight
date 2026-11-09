// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and
// conditions of the CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 零内置凭据防回潮锁（跨包扫描，自 cpx 侧迁移而来）：cpx 与 insight 全量
// 源码不得出现密文常量或内嵌凭据 URL——凭据一律走服务端存储与解析链。
// 嵌入凭据正则为 host 无关形态（不绑定任何托管平台域名）。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// 布局自适应：本包根在 monorepo 布局下是 packages/insight，拆仓后是仓库根。
// cpx 姊妹包仅 monorepo 布局存在（拆仓后 cpx 是独立仓库）——兄弟目录缺失时
// 跳过该侧扫描（cpx 仓由其自身的哨兵把守），不误伤拆仓布局。
const INSIGHT_ROOT = path.resolve(__dirname, '../..');
const CPX_ROOT = path.resolve(__dirname, '../../../cpx/src');
const ROOTS = [fs.existsSync(CPX_ROOT) ? CPX_ROOT : null, path.resolve(INSIGHT_ROOT, 'src')]
  .filter((x): x is string => x != null);

describe('跨包源码零内置凭据（防回潮锁）', () => {
  it('cpx/insight 源码不得出现密文常量或内嵌凭据 URL', () => {
    const encodedConst = /LAKE_PUSH_URL_ENCODED|LAKE_PUSH_URL\s*=/;
    const base64Blob = /=\s*['"][A-Za-z0-9+/]{60,}={0,2}['"]/;
    // Host-agnostic: any user:pass@ URL on any host is forbidden.
    const embeddedCreds = /https?:\/\/[^/'"\s]+:[^'"\s@]+@[a-z0-9.-]+\.[a-z]{2,}/i;
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx|mjs|js)$/.test(e.name)) continue;
        const src = fs.readFileSync(full, 'utf8');
        for (const [name, re] of [['encoded-const', encodedConst], ['base64-blob', base64Blob], ['embedded-creds', embeddedCreds]] as const) {
          if (re.test(src)) offenders.push(`${rel(full)}: ${name}`);
        }
      }
    };
    for (const r of ROOTS) walk(r);
    expect(offenders, `检出内置凭据残留（凭据必须走服务端存储与解析链，绝不回源码）:\n${offenders.join('\n')}`).toEqual([]);
  });
});

describe('平台中性哨兵（平台化 P1-P3 防回潮锁，词表源 sensitive-info-audit）', () => {
  // 私仓/组织/用户名/预设名/env 旧前缀——src 零容忍（任何命中都是回潮）。
  // contextBay 是主品牌 Bay 显示名（branding.ts BAY_NAME 常量字面量），
  // CANNbay/CANNBay 仅存在于 cannbot 变体打包面（pack-cannbot 翻转）——
  // src 其他文件出现品牌字面量（应经 BAY_NAME 常量引用）即回潮。
  // x_cannbay 是已退役的旧信封键（v0.2.41 起单轨 x_lake）——任何出现都是
  // 退役轨回潮。
  const FORBIDDEN_ANYWHERE = [
    'atomgit', 'TTELab', 'guanxinghua', 'cann_corpus', 'trace_corpus',
    'CANNBAY2_', 'cannbay-lake', 'cannbay2', 'x_cannbay',
  ];
  // 路径键统一按「本包根相对 + 正斜杠」规范化（两种布局同键）；cpx 侧键
  // 由 rel() 归一为 cpx/ 前缀。
  const BRAND_NAME_FILES = new Set([
    'src/lib/branding.ts',
    'scripts/pack-cannbot.mjs',
    'tests/pipeline/cannbot-pack.test.ts',
  ]);
  const LEGACY_ENVELOPE_HOME = new Set(['src/lib/shared/envelope.ts', 'cpx/src/envelope.ts']);
  // 品牌名白名单文件内 CANNbay/CANNBay 合法（branding 字面量/翻转规则/探针）
  const BRAND_FORMS = /CANNBay|CANNbay/;

  it('双包 src 词表扫描归零（私址/组织/用户名/预设名/env 旧前缀/品牌变体/旧信封键）', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx|mjs|js)$/.test(e.name)) continue;
        const lines = fs.readFileSync(full, 'utf8').split('\n');
        const relPath = rel(full);
        const isBrandFile = BRAND_NAME_FILES.has(relPath.replace(/\\/g, '/'));
        lines.forEach((line, i) => {
          for (const word of FORBIDDEN_ANYWHERE) {
            if (word === 'x_cannbay' && LEGACY_ENVELOPE_HOME.has(relPath.replace(/\\/g, '/'))) continue;
            if (line.includes(word)) offenders.push(`${relPath}:${i + 1} [${word}] ${line.trim().slice(0, 80)}`);
          }
          // 品牌名白名单文件内 CANNbay/CANNBay 合法；其他文件出现品牌字面量即回潮
          // （应经 BAY_NAME/BAY_VIEWER_NAME 常量引用）
          if (!isBrandFile && BRAND_FORMS.test(line)) {
            offenders.push(`${relPath}:${i + 1} [brand-literal-outside-allowed] ${line.trim().slice(0, 80)}`);
          }
          // 裸 cannbay（旧品牌词根，任何上下文都是回潮）
          if (/(^|[^_\w-])cannbay([^_\w-]|$)/.test(line)) {
            offenders.push(`${relPath}:${i + 1} [bare-cannbay] ${line.trim().slice(0, 80)}`);
          }
        });
      }
    };
    for (const r of ROOTS) walk(r);
    expect(offenders, `平台化词表回潮（敏感词治理见 sensitive-info-audit；白名单外命中即红）:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('cpx 信封写点单轨（x_cannbay 写点 = 旧键退役轨回潮，v0.2.41 起只写 x_lake）', () => {
    if (!fs.existsSync(CPX_ROOT)) return; // 拆仓布局：cpx 在独立仓，本项由 cpx 仓自守
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!/\.ts$/.test(e.name)) continue;
        const lines = fs.readFileSync(full, 'utf8').split('\n');
        lines.forEach((line, i) => {
          if (/x_cannbay\s*:/.test(line)) offenders.push(`${rel(full)}:${i + 1}`);
        });
      }
    };
    walk(CPX_ROOT);
    expect(offenders, `cpx 信封写点回潮旧键（信封一律走 x_lake，旧键已退役）:\n${offenders.join('\n')}`).toEqual([]);
  });
});

function rel(full: string): string {
  // 规范化为相对本包根的正斜杠路径（monorepo/拆仓两种布局产出同一键）；
  // cpx 侧路径归一掉 ../cpx/ 前导，保持 cpx/src/... 形态
  const r = path.relative(INSIGHT_ROOT, full).replace(/\\/g, '/');
  return r.startsWith('../cpx/') ? r.slice(3) : r;
}
