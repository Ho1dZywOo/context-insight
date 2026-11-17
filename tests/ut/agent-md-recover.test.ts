// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { describe, it, expect, vi } from 'vitest';
import { selectRecoveredAgentMd, recoverAgentMdFromSession, type RecoverToolCallRow } from '@/lib/agent-md-recover';
import type { PrismaClient } from '@prisma/client';

/**
 * agent-md-recover（Read + shell 双通道会话内恢复）纯函数与 DB 层测试。
 *
 * audit agent 对账的声明三级降级之一（system 注入 > **本模块会话内读取** >
 * 磁盘扫描）：codex 原生导入的子 rollout 无 system 注入字段（agent-md-session-recover
 * 天然无数据）、agent 定义在仓库里由子代理运行时 cat/sed 读取——本模块经
 * shell-restore 引擎归因恢复运行时生效原文（读的是哪份就是哪份）。
 * 数据流：Read ToolCall（opencode `N: ` 信封 / claude `N\t`）+ shell 隐式读
 * （codex exec_command 的 cat/sed）→ selectRecoveredAgentMd（按文件分组 +
 * 分段拼合 + 最新读取消歧）。
 */

function opencodeReadResult(filePath: string, lines: string[]): string {
  const numbered = lines.map((l, i) => `${i + 1}: ${l}`).join('\n');
  return `<path>${filePath}</path>\n<type>file</type>\n<content>\n${numbered}\n</content>`;
}

function claudeReadResult(lines: string[]): string {
  return lines.map((l, i) => `${i + 1}\t${l}`).join('\n');
}

function tc(toolName: string, filePath: string | null, resultJson: string | null, startedAt: Date): RecoverToolCallRow {
  return {
    toolName,
    argsJson: filePath ? JSON.stringify({ filePath }) : null,
    resultJson,
    startedAt,
  };
}

describe('selectRecoveredAgentMd（Read 结果拼合/消歧）', () => {
  it('opencode read（N: + 信封）→ 信封剥离、行号剥离、原文还原', () => {
    const fp = '/ws/plugins-official/plugin-a/agents/dev-agent.md';
    const md = ['---', 'name: dev-agent', 'description: 开发者', '---', '', '# dev-agent', '', '正文内容'].join('\n');
    const r = selectRecoveredAgentMd([tc('read', fp, opencodeReadResult(fp, md.split('\n')), new Date('2026-01-01'))], 'dev-agent');
    expect(r).not.toBeNull();
    expect(r!.content).toBe(md);
    expect(r!.source).toBe(fp);
    expect(r!.fullRead).toBe(true);
  });

  it('claude read（N\\t 格式）→ 同样恢复', () => {
    const md = '---\nname: reviewer\n---\nreview body';
    const r = selectRecoveredAgentMd([tc('Read', '/ws/.claude/agents/reviewer.md', claudeReadResult(md.split('\n')), new Date('2026-01-01'))], 'reviewer');
    expect(r?.content).toBe(md);
  });

  it('同文件多次分段读（连续 offset 续读拼合 / 跳行 gap 标记）', () => {
    const fp = '/ws/agents/dev-agent.md';
    // 连续续读：1-7 + 8-9 → 拼合无 gap
    const r = selectRecoveredAgentMd([
      tc('read', fp, `<path>${fp}</path>\n<type>file</type>\n<content>\n1: ---\n2: name: dev-agent\n3: ---\n4: \n5: # dev-agent\n6: \n7: 前半正文\n</content>`, new Date('2026-01-01')),
      tc('read', fp, `<path>${fp}</path>\n<type>file</type>\n<content>\n8: 后半正文\n9: 收尾\n</content>`, new Date('2026-01-02')),
    ], 'dev-agent');
    expect(r!.content).toContain('前半正文');
    expect(r!.content).toContain('后半正文');
    // 跳行：1-3 + 8-9 → gap 标记 + 非全文
    const r2 = selectRecoveredAgentMd([
      tc('read', fp, `<path>${fp}</path>\n<type>file</type>\n<content>\n1: 头\n2: 行\n3: 一\n</content>`, new Date('2026-01-01')),
      tc('read', fp, `<path>${fp}</path>\n<type>file</type>\n<content>\n8: 尾\n9: 行\n</content>`, new Date('2026-01-02')),
    ], 'dev-agent');
    expect(r2!.content).toContain('--line');
    expect(r2!.fullRead).toBe(false);
  });

  it('多插件同名（demo 先读、glacier 后读）→ 取最新读取的文件', () => {
    const demoFp = '/ws/plugins-official/demo/agents/spec-verifier.md';
    const glacierFp = '/ws/plugins-official/glacier/agents/spec-verifier.md';
    const r = selectRecoveredAgentMd([
      tc('read', demoFp, opencodeReadResult(demoFp, ['# demo 版'].concat(Array(20).fill('x'))), new Date('2026-01-01')),
      tc('read', glacierFp, opencodeReadResult(glacierFp, ['# glacier 版'].concat(Array(20).fill('y'))), new Date('2026-01-02')),
    ], 'spec-verifier');
    expect(r!.source).toBe(glacierFp);
    expect(r!.content).toContain('glacier 版');
  });

  it('失败探测 read（空 result）跳过；同名它路径不误配（agents-ish/ 子目录排除）', () => {
    const goodFp = '/ws/plugins-official/glacier/agents/design-verifier.md';
    const md = '# design-verifier\n\n' + 'z'.repeat(200);
    const r = selectRecoveredAgentMd([
      tc('read', '/ws/agents-ish/design-verifier.md', '<content></content>', new Date('2026-01-01')),
      tc('read', '/ws/docs/agents/design-verifier.md', null, new Date('2026-01-01')),
      tc('read', goodFp, opencodeReadResult(goodFp, md.split('\n')), new Date('2026-01-02')),
    ], 'design-verifier');
    expect(r!.source).toBe(goodFp);
    expect(r!.content).toContain('# design-verifier');
  });

  it('无匹配 read → null', () => {
    expect(selectRecoveredAgentMd([], 'nobody')).toBeNull();
    expect(
      selectRecoveredAgentMd([tc('read', '/ws/agents/other.md', '<content>...</content>', new Date())], 'nobody')
    ).toBeNull();
  });
});

describe('selectRecoveredAgentMd（shell 通道——codex 现场形态）', () => {
  const fp = '/repo/.agents/skills/day0/agents/developer.md';
  const body = ['---', 'name: developer', '---', '', '# developer', '', '1. 检查图健康'];
  function shellTc(cmd: string, result: string, at: number): RecoverToolCallRow {
    return {
      toolName: 'exec_command',
      argsJson: JSON.stringify({ cmd, workdir: '/repo' }),
      resultJson: result,
      startedAt: new Date(at),
    };
  }

  it('codex exec_command cat agents/x.md → 归因恢复原文（此前 codex 子代理声明全灭）', () => {
    const r = selectRecoveredAgentMd([shellTc(`cat ${fp}`, `${body.join('\n')}\n`, 1)], 'developer');
    expect(r).not.toBeNull();
    expect(r!.source).toBe(fp);
    expect(r!.fullRead).toBe(true);
    expect(r!.content).toBe(body.join('\n'));
  });

  it('多段链（sed 区间 + 无关命令输出）只归因 .md 自己的行；混 dump 宁缺毋假', () => {
    const noisy = `pwd && printf '== md ==' && sed -n '1,7p' ${fp}`;
    const out = `/repo\n== md ==\n${body.join('\n')}\n`;
    const ok = selectRecoveredAgentMd([shellTc(noisy, out, 1)], 'developer');
    expect(ok!.content).toBe(body.join('\n'));
    // 多文件 dump（cat a.md b.md）：归因不可判定 → null（不拿拼接输出充数）
    const mixed = selectRecoveredAgentMd(
      [shellTc(`cat ${fp} /repo/agents/other.md`, 'developer\nother\n', 1)],
      'developer',
    );
    expect(mixed).toBeNull();
  });

  it('分段读跨调用拼合：sed 1,4p + sed 4,7p（重叠校准）→ 全文、截断缺口如实 gap', () => {
    const r = selectRecoveredAgentMd([
      shellTc(`sed -n '1,4p' ${fp}`, `${body.slice(0, 4).join('\n')}\n`, 1),
      shellTc(`sed -n '4,7p' ${fp}`, `${body.slice(3, 7).join('\n')}\n`, 2),
    ], 'developer');
    expect(r!.fullRead).toBe(true);
    expect(r!.content).toBe(body.join('\n'));
  });
});

describe('recoverAgentMdFromSession（DB 封装）', () => {
  it('查 read ToolCall 后走 selectRecoveredAgentMd（argsJson 过滤 agents/<name>.md）', async () => {
    const md = '# dev-agent\n\n' + 'a'.repeat(200);
    const prisma = {
      toolCall: {
        findMany: vi.fn().mockResolvedValue([
          { toolName: 'read', argsJson: JSON.stringify({ filePath: '/ws/agents/dev-agent.md' }), resultJson: opencodeReadResult('/ws/agents/dev-agent.md', md.split('\n')), startedAt: new Date('2026-01-01') },
        ]),
      },
    } as unknown as PrismaClient;
    const r = await recoverAgentMdFromSession(prisma, 'ses_1', 'dev-agent');
    expect(r?.content).toContain('# dev-agent');
    // 查询 where 含路径过滤（prisma findMany 收到 agents/dev-agent.md 条件）
    const arg = (prisma.toolCall.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(JSON.stringify(arg.where)).toContain('agents/dev-agent.md');
  });
});
