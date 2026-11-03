// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recoverAgentMdFromSystem } from '@/lib/agent-md-session-recover';

/**
 * system 注入恢复测试。fixture = ses_fc73d17d7ffer（cannbot proxy 正常会话，88/88
 * system 注入实测覆盖）的真实子代理样本——19 个 agentType 各一个（gzip 原样，
 * system 保留完整正文 + available_skills 运行时尾部）。
 */
const FIXTURE_DIR = path.resolve(__dirname, './data/agent-md-system-recover');
const FIXTURE_MAIN = path.join(FIXTURE_DIR, 'ses_norm_fixture.jsonl.gz');
const FIXTURE_SID = 'ses_norm_fixture';

describe('recoverAgentMdFromSystem（system 注入恢复——正常会话主路径）', () => {
  it('19 个 agentType 全部恢复成功（真实会话样本，meta 定位 + 标题守卫 + 剥尾部）', () => {
    const agentTypes = new Set<string>();
    for (const f of fs.readdirSync(path.join(FIXTURE_DIR, 'ses_norm_fixture', 'subagents'))) {
      if (!f.endsWith('.meta.json')) continue;
      const meta = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'ses_norm_fixture', 'subagents', f), 'utf-8'));
      const at = (meta.x_lake)?.data?.agentType ?? meta.agentType;
      if (at) agentTypes.add(at);
    }
    expect(agentTypes.size).toBe(19);

    let recovered = 0;
    for (const at of agentTypes) {
      const r = recoverAgentMdFromSystem(
        FIXTURE_MAIN,
        FIXTURE_SID,
        at
      );
      if (!r) continue;
      recovered++;
      // 声明形态：首行标题 = agent 名；尾部运行时块已剥
      expect(r.content.startsWith(`# ${at}`)).toBe(true);
      expect(r.content).not.toContain('<available_skills>');
      expect(r.source).toMatch(/^subagent:ses_/);
    }
    expect(recovered).toBe(19); // 正常会话：全部经 system 注入恢复（不依赖 Read）
  });

  it('子代理 meta fixture 走规范 x_lake 信封（读侧单轨：机械改名回 legacy 键 x_cannbay 会被挡）', () => {
    // 回归锁：这些 cc-subagent-meta fixture 必须携带规范键 x_lake（真实捕获形态），
    // 不得回退到已退役的 legacy 键 x_cannbay——readEnvelope（只读 x_lake）的 lake
    // 列表路径对 x_cannbay 单键会失明。负向验证：把任一 fixture 的 x_lake 改回
    // x_cannbay，本用例必红。
    const dir = path.join(FIXTURE_DIR, 'ses_norm_fixture', 'subagents');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.meta.json'));
    expect(files.length).toBe(19);
    for (const f of files) {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      const env = meta.x_lake;
      expect(env?.schema).toBe('cc-subagent-meta');
      expect(env?.data?.agentType).toBe(meta.agentType);
      expect(meta.x_cannbay).toBeUndefined();
    }
  });

  it('恢复的正文是远端运行时版本（designer 8,606 字 ≠ 磁盘 demo 4,771 / glacier 6,793）', () => {
    const r = recoverAgentMdFromSystem(
      FIXTURE_MAIN,
      FIXTURE_SID,
      'designer'
    );
    expect(r).not.toBeNull();
    expect(r!.content.length).toBeGreaterThan(8000); // 实际 8,606 字
    expect(r!.content).toContain('## 你的角色');
  });

  it('x_lake.data.system 优先于 legacy 顶层 system（双轨契约）', () => {
    // fixture 的 assistant 行同时带两个字段且值一致（x_lake 是权威源）——
    // 构造一个 x_lake 与 legacy 不一致的用例验证优先级
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sys-recover-'));
    const subDir = path.join(tmp, 'ses_x', 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(
      path.join(subDir, 'sub-1.jsonl'),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        system: '# legacy-should-lose\n\nlegacy 正文。',
        x_lake: { schema: 'cc-wire-round', version: 1, data: { system: '# winner\n\n权威正文。' } },
      }) + '\n'
    );
    fs.writeFileSync(
      path.join(subDir, 'sub-1.meta.json'),
      JSON.stringify({ agentType: 'winner' })
    );
    fs.writeFileSync(path.join(tmp, 'ses_x.jsonl'), '');
    const r = recoverAgentMdFromSystem(path.join(tmp, 'ses_x.jsonl'), 'ses_x', 'winner');
    expect(r?.content).toBe('# winner\n\n权威正文。');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('opencode 通用 system prompt（"You are opencode…"）→ null（该形态无声明，降级）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sys-recover-'));
    const subDir = path.join(tmp, 'ses_g', 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(
      path.join(subDir, 'sub-g.jsonl'),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        system: 'You are opencode, an interactive CLI tool that helps users with software engineering tasks.',
      }) + '\n'
    );
    fs.writeFileSync(
      path.join(subDir, 'sub-g.meta.json'),
      JSON.stringify({ agentType: 'designer' })
    );
    fs.writeFileSync(path.join(tmp, 'ses_g.jsonl'), '');
    expect(recoverAgentMdFromSystem(path.join(tmp, 'ses_g.jsonl'), 'ses_g', 'designer')).toBeNull();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('标题 ≠ 请求的 agent 名 → null（防 meta 与正文错位）', () => {
    expect(
      recoverAgentMdFromSystem(
        FIXTURE_MAIN,
        FIXTURE_SID,
        'nonexistent-agent'
      )
    ).toBeNull();
  });

  it('无子代理目录 / 文件缺失 → null 不抛错', () => {
    expect(recoverAgentMdFromSystem('/tmp/definitely-missing.jsonl', 'whatever', 'x')).toBeNull();
  });

  // ===== opencode 派发形态（ses_f391f2af 实测回归锁：94 子代理 0 精确标题）=====
  // 事故：旧守卫要求正文首行标题 === agentName，对带饰标题/自然语言标题/无标题
  // 三形态全军覆没 → 恢复 0/15。身份模型改为 meta 权威 + H1 小写 id 词元强证据。

  /** 搭一个子代理捕获 fixture，返回 (sourcePath, sessionId)。 */
  const buildOpencodeFixture = (
    subs: Array<{ meta: string | null; system: string }>
  ): { src: string; sid: string } => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sys-recover-oc-'));
    const sid = 'ses_oc_form';
    const subDir = path.join(tmp, sid, 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    subs.forEach((s, i) => {
      fs.writeFileSync(
        path.join(subDir, `sub-${i}.jsonl`),
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
          x_lake: { schema: 'cc-wire-round', version: 1, data: { system: s.system } },
        }) + '\n'
      );
      if (s.meta != null) {
        fs.writeFileSync(path.join(subDir, `sub-${i}.meta.json`), JSON.stringify({ agentType: s.meta }));
      }
    });
    fs.writeFileSync(path.join(tmp, `${sid}.jsonl`), '');
    return { src: path.join(tmp, `${sid}.jsonl`), sid };
  };

  it('带饰标题 `# slug（角色）`（design-step-reviewer 实测形态）→ meta 命中即恢复', () => {
    const { src, sid } = buildOpencodeFixture([
      { meta: 'design-step-reviewer', system: '# design-step-reviewer（R 对抗审核 / 门控）\n\n## 职责\n\n正文。' },
    ]);
    const r = recoverAgentMdFromSystem(src, sid, 'design-step-reviewer');
    expect(r?.content.startsWith('# design-step-reviewer（R 对抗审核 / 门控）')).toBe(true);
    fs.rmSync(path.dirname(src), { recursive: true, force: true });
  });

  it('自然语言 H1 标题 `# Operator Architect Agent`（acme-ops-architect 实测形态）→ 恢复', () => {
    const { src, sid } = buildOpencodeFixture([
      { meta: 'acme-ops-architect', system: '# Operator Architect Agent\n\n大写开头的自然语言标题不构成 id 证据。' },
    ]);
    const r = recoverAgentMdFromSystem(src, sid, 'acme-ops-architect');
    expect(r?.content).toContain('# Operator Architect Agent');
    fs.rmSync(path.dirname(src), { recursive: true, force: true });
  });

  it('正文无 H1（首行 `## 约束`，design-scheduler 实测形态）→ meta 命中即恢复', () => {
    const { src, sid } = buildOpencodeFixture([
      { meta: 'design-scheduler', system: '## 约束\n\n章节标题不是文档标题。' },
    ]);
    const r = recoverAgentMdFromSystem(src, sid, 'design-scheduler');
    expect(r?.content).toContain('## 约束');
    fs.rmSync(path.dirname(src), { recursive: true, force: true });
  });

  it('正文直起无标题（64/94 实测形态）→ meta 命中即恢复', () => {
    const { src, sid } = buildOpencodeFixture([
      { meta: 'design-merger', system: '在所有 kernel 泳道完成后执行合并。' },
    ]);
    const r = recoverAgentMdFromSystem(src, sid, 'design-merger');
    expect(r?.content).toContain('合并');
    fs.rmSync(path.dirname(src), { recursive: true, force: true });
  });

  it('H1 小写 id 词元异名（meta 命中但标题是别的 agent）→ null（防捕获错位）', () => {
    const { src, sid } = buildOpencodeFixture([
      { meta: 'agent-a', system: '# agent-b\n\n标题 id 证据与 meta 冲突，视为错位。' },
    ]);
    expect(recoverAgentMdFromSystem(src, sid, 'agent-a')).toBeNull();
    fs.rmSync(path.dirname(src), { recursive: true, force: true });
  });

  it('无 meta 兜底：H1 id 词元命中 → 恢复；无标题正文 → 不误收', () => {
    const { src, sid } = buildOpencodeFixture([
      { meta: null, system: '# orphan-agent\n\n无 meta，靠标题 id 证据兜底。' },
      { meta: null, system: '无标题正文，不应被张冠李戴。' },
    ]);
    const hit = recoverAgentMdFromSystem(src, sid, 'orphan-agent');
    expect(hit?.content).toContain('兜底');
    // 请求一个不存在于任何标题/ meta 的名字：无 meta + 无标题正文不得被误收
    expect(recoverAgentMdFromSystem(src, sid, 'whoever')).toBeNull();
    fs.rmSync(path.dirname(src), { recursive: true, force: true });
  });
});
