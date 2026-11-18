// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const packagePath = path.join(root, 'package.json')
const versionPath = path.join(root, 'src/lib/version.ts')

function readArg(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function usage() {
  console.error('Usage: node scripts/release/prepare-dev-version.mjs [--version X.Y.Z-dev.yyyyMMdd.run] [--print]')
}

if (process.argv.includes('--help')) {
  usage()
  process.exit(0)
}

const explicitVersion = readArg('--version')
const printOnly = process.argv.includes('--print')
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'))

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version)
  if (!match) throw new Error(`invalid package version: ${version}`)
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ?? '',
  }
}

function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1
  }
  if (!a.prerelease && b.prerelease) return 1
  if (a.prerelease && !b.prerelease) return -1
  return a.prerelease.localeCompare(b.prerelease)
}

function npmLatest(name) {
  const result = spawnSync('npm', ['view', name, 'dist-tags.latest', '--json', '--registry', 'https://registry.npmjs.org/'], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`cannot resolve npm latest for ${name}: ${result.error?.message ?? result.stderr ?? result.stdout}`)
  }
  return JSON.parse(result.stdout)
}

function nextDevVersion(version) {
  const candidates = [version, npmLatest('context-insight'), npmLatest('cannbot-insight')]
  const highest = candidates.sort(compareVersions).at(-1)
  const parsed = parseVersion(highest)
  if (!parsed.prerelease) parsed.core[2] += 1
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '')
  const run = process.env.GITHUB_RUN_NUMBER || String(Date.now())
  const attempt = process.env.GITHUB_RUN_ATTEMPT || '1'
  return `${parsed.core.join('.')}-dev.${date}.${run}.${attempt}`
}

const version = explicitVersion ?? nextDevVersion(pkg.version)
const parsed = parseVersion(version)
if (!parsed.prerelease.includes('dev')) {
  throw new Error(`dev version must contain a dev prerelease suffix: ${version}`)
}

if (!printOnly) {
  pkg.version = version
  fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`)
  const source = fs.readFileSync(versionPath, 'utf8')
  const updated = source.replace(/export const VERSION = "[^"]+"/, `export const VERSION = "${version}"`)
  if (updated === source) throw new Error('could not update VERSION in src/lib/version.ts')
  fs.writeFileSync(versionPath, updated)
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`)
  }
}

console.log(version)
