// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const EXPORT_SERVICE_PATH = path.resolve(__dirname, '../../src/lib/ingest/export-service.ts');

function extractDDL(source: string): string {
  const match = source.match(/const DDL = `([\s\S]*?)`;/);
  if (!match) throw new Error('DDL not found in export-service.ts');
  return match[1];
}

function extractInsertStatements(source: string): Array<{ table: string; columns: string[]; placeholders: number }> {
  const regex = /db\.prepare\(`\s*INSERT INTO "(\w+)" \(\s*([\s\S]*?)\s*\) VALUES \(([\s\S]*?)\)\s*`\)/g;
  const results: Array<{ table: string; columns: string[]; placeholders: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    const table = match[1];
    const colsRaw = match[2];
    const valsRaw = match[3];
    const columns = colsRaw
      .split(',')
      .map(c => c.trim().replace(/"/g, '').replace(/\n/g, ''))
      .filter(c => c.length > 0);
    const placeholders = valsRaw
      .split(',')
      .map(v => v.trim())
      .filter(v => v === '?')
      .length;
    results.push({ table, columns, placeholders });
  }
  return results;
}

function extractRunArgCounts(source: string): Record<string, number> {
  const result: Record<string, number> = {};
  // 从源码静态解析每个 insertXxx.run(...) 的实参个数。不可以用「截到首个
  // ");"」的正则——分块插入把 run(...) 作为闭包实参嵌在 insertChunked(...)
  // 里，收尾是 "…),\n    );"，非贪婪匹配会多吃一个 run 自身的闭括号（+1
  // 假差异）。改为括号配平扫描：从 ".run(" 起深度计数取实参区，直呼与闭包
  // 两种书写形态一致成立（实参均为标识符/字面量/三元/普通函数调用，字符串
  // 字面量不含括号或逗号，配平与逗号切分安全）
  const regex = /(\w+)\.run\(/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    const varName = match[1];
    if (!varName.startsWith('insert')) continue;
    const open = match.index + match[0].length; // 已越过实参区开括号
    let depth = 1;
    let close = open;
    for (; close < source.length; close++) {
      const ch = source[close];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    const inner = source.slice(open, close);
    const args = inner
      .split(',')
      .map(a => a.trim())
      .filter(a => a.length > 0 && !a.startsWith('//'));
    result[varName] = args.length;
  }
  return result;
}

describe('export-service INSERT column/placeholder parity', () => {
  const source = fs.readFileSync(EXPORT_SERVICE_PATH, 'utf-8');
  const ddl = extractDDL(source);
  const inserts = extractInsertStatements(source);

  it('DDL should be extractable from source', () => {
    expect(ddl.length).toBeGreaterThan(0);
  });

  it('all INSERT prepared statements should have equal column count and placeholder count', () => {
    expect(inserts.length).toBe(9);
    for (const { table, columns, placeholders } of inserts) {
      expect(columns.length, `${table}: column count (${columns.length}) must match ? count (${placeholders})`).toBe(placeholders);
    }
  });

  it('DDL should parse correctly with better-sqlite3 (all tables and indexes created)', () => {
    const db = new Database(':memory:');
    db.exec(ddl);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => (r as { name: string }).name);
    const expectedTables = ['Execution', 'ExecutionSkill', 'ExportMeta', 'InteractionBridge', 'Session', 'SessionSkill', 'SkillEvent', 'ToolCall', 'Turn'];
    expect(tables).toEqual(expectedTables);

    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => (r as { name: string }).name);
    expect(indexes.length).toBeGreaterThan(0);

    db.close();
  });

  it('each INSERT prepared statement should bind without column mismatch error', () => {
    const db = new Database(':memory:');
    db.exec(ddl);

    for (const { table, columns, placeholders } of inserts) {
      const placeholdersStr = Array.from({ length: placeholders }, () => '?').join(', ');
      const colsStr = columns.map(c => `"${c}"`).join(', ');
      const sql = `INSERT INTO "${table}" (${colsStr}) VALUES (${placeholdersStr})`;
      const stmt = db.prepare(sql);
      expect(stmt, `${table}: prepared statement should compile without error`).toBeDefined();
    }

    db.close();
  });
});

describe('export-service run() arg count matches VALUES placeholder count', () => {
  const source = fs.readFileSync(EXPORT_SERVICE_PATH, 'utf-8');
  const inserts = extractInsertStatements(source);
  const runArgs = extractRunArgCounts(source);

  it('insertSession.run() args should match VALUES placeholder count', () => {
    const sessionInsert = inserts.find(i => i.table === 'Session');
    expect(sessionInsert).toBeDefined();
    expect(runArgs['insertSession'], `insertSession.run() has ${runArgs['insertSession']} args, VALUES has ${sessionInsert!.placeholders} ?`).toBe(sessionInsert!.placeholders);
  });

  it('insertTurn.run() args should match VALUES placeholder count', () => {
    const turnInsert = inserts.find(i => i.table === 'Turn');
    expect(turnInsert).toBeDefined();
    expect(runArgs['insertTurn']).toBe(turnInsert!.placeholders);
  });

  it('insertToolCall.run() args should match VALUES placeholder count', () => {
    const tcInsert = inserts.find(i => i.table === 'ToolCall');
    expect(tcInsert).toBeDefined();
    expect(runArgs['insertToolCall']).toBe(tcInsert!.placeholders);
  });

  it('insertExecution.run() args should match VALUES placeholder count', () => {
    const exInsert = inserts.find(i => i.table === 'Execution');
    expect(exInsert).toBeDefined();
    expect(runArgs['insertExecution']).toBe(exInsert!.placeholders);
  });

  it('insertBridge.run() args should match VALUES placeholder count', () => {
    const brInsert = inserts.find(i => i.table === 'InteractionBridge');
    expect(brInsert).toBeDefined();
    expect(runArgs['insertBridge']).toBe(brInsert!.placeholders);
  });
});

describe('regression guard: Session 30-vs-31 bug', () => {
  const source = fs.readFileSync(EXPORT_SERVICE_PATH, 'utf-8');
  const inserts = extractInsertStatements(source);
  const runArgs = extractRunArgCounts(source);

  it('Session INSERT must have 31 columns, 31 placeholders, and 31 run() args', () => {
    const sessionInsert = inserts.find(i => i.table === 'Session');
    expect(sessionInsert).toBeDefined();
    expect(sessionInsert!.columns.length).toBe(31);
    expect(sessionInsert!.placeholders).toBe(31);
    expect(runArgs['insertSession']).toBe(31);
  });
});

describe('regression guard: rename 前先清已存在目标（Windows 覆盖归档）', () => {
  const source = fs.readFileSync(EXPORT_SERVICE_PATH, 'utf-8');

  it('outPath 已存在时须在 renameSync 前 unlink（rename 覆盖已存在目标在 Windows 下会 EPERM）', () => {
    const unlink = source.indexOf('fs.existsSync(outPath)) fs.unlinkSync(outPath)');
    const rename = source.indexOf('fs.renameSync(tmpPath, outPath)');
    expect(rename).toBeGreaterThanOrEqual(0);
    expect(unlink).toBeGreaterThanOrEqual(0);
    expect(unlink).toBeLessThan(rename);
  });
});
