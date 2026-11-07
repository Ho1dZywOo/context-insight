#!/usr/bin/env bash
# Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
# This program is free software; you can redistribute it and/or modify it under the terms and conditions of
# CANN Open Software License Agreement Version 2.0 (the "License").
# You may refer to the License for details. Please do not use this file except in compliance with the License.
# THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
# INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
# See LICENSE in the root of the software repository for the full text of the License.
#
# Insight E2E 后端引导（playwright.config.ts 的 webServer.command）。
#
# 刻意不复用 ./start.sh：它是用户日常启动器，会杀掉本仓所有自家 next 实例
# （cwd 锚定——会把用户正在用的 21025 实例一并 SIGTERM）、写端口登记、装
# 代理、拉 smart-agent、开浏览器。E2E 要的是一个安静的、环境隔离的、可
# 重复的被测服务，这里走 next start 的最小集：
#
#   1. prisma/e2e.db 每次重建（migrations 重放）——run-to-run 确定性基线，
#      与 dev.db（用户生产库）/test.db（vitest 库）物理隔离
#   2. .next 构建按 BUILD_ID 新鲜度复用（与 start.sh 同款判定，排除
#      export-view.js——它是每次启动重写的构建产物）：首跑全量构建，之后
#      源码未变秒过
#   3. public/export-view.js 重建（离线 HTML 导出的运行时依赖）
#   4. exec next start 绑 127.0.0.1:E2E_PORT（默认 21100，避开 dev 21025）
#
# 环境隔离三件套：DATABASE_URL=prisma/e2e.db（绝不碰用户库）、
# CONTEXT_INSIGHT_HOME=仓内 tmp/insight-e2e-home（run-store/回收站/数据仓
# 配置与真实 ~/.context-insight 物理断开）、CONTEXT_LOG=0（不写用户日志目录）。
#
# 注意 .next 与用户实例共享（Turbopack 禁止 distDir 外置，见
# next.config.ts）：E2E 与 ./start.sh 并行跑会互相打架（重建会抽掉运行中
# 实例的产物）——串行使用；端口已错开，仅构建产物是共享面。
set -euo pipefail

# tests/e2e/boot → 仓库根
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${INSIGHT_E2E_PORT:-21100}"
DB="$SCRIPT_DIR/prisma/e2e.db"
E2E_HOME="$SCRIPT_DIR/tmp/insight-e2e-home"

cd "$SCRIPT_DIR"

# 隔离环境先于一切（构建期也可能触库/触 lake 配置——统一指到 e2e 侧）
rm -rf "$E2E_HOME"
mkdir -p "$E2E_HOME"
export DATABASE_URL="file:$DB"
export CONTEXT_INSIGHT_HOME="$E2E_HOME"
export CONTEXT_LOG=0
export CONTEXT_LOG_FILE=0

# --- 1) e2e.db：migrations 重放（同一基线；夹具会话从物理上不可能泄进用户库） ---
rm -f "$DB" "$DB-wal" "$DB-shm" "$DB-journal"
npx prisma migrate deploy

# --- 2) 构建：BUILD_ID 新鲜度复用（源码/配置比 BUILD_ID 新才重建） ---
NEED_BUILD=true
if [ -f ".next/BUILD_ID" ]; then
  STALE="$(find src prisma public package.json next.config.ts tsconfig.json -newer .next/BUILD_ID ! -path 'public/export-view.js' -print -quit 2>/dev/null || true)"
  if [ -z "$STALE" ]; then
    NEED_BUILD=false
    echo "[e2e-boot] build cached — skip"
  fi
fi
if [ "$NEED_BUILD" = true ]; then
  echo "[e2e-boot] building (first run or stale sources)..."
  npm run build
fi

# --- 3) export-view（离线 HTML 导出用例的运行时依赖；gitignore 构建产物） ---
npm run build:export-view >/dev/null 2>&1 \
  || echo "[e2e-boot] export-view build failed — HTML export specs may fail" >&2

# --- 4) 起服：exec 让 webServer 的 SIGTERM 直接落在 next 进程上 ---
# （不 exec 的话 SIGTERM 打在 bash 壳上，next 子进程会漏成孤儿——
#   global-teardown 的端口断言兜底，但正常路径就该干净退场）
echo "[e2e-boot] next start on 127.0.0.1:$PORT (db=$DB, home=$E2E_HOME)"
exec node node_modules/next/dist/bin/next start -H 127.0.0.1 --port "$PORT"
