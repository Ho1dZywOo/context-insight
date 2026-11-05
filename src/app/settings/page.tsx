"use client"
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { useState, useEffect, type ReactNode } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ArrowLeftIcon, SparklesIcon, DatabaseIcon, ScrollTextIcon, type LucideIcon } from "lucide-react"
import { BRAND_NAME, BAY_NAME } from "@/lib/branding"
import { VERSION_DISPLAY } from "@/lib/version"
import { AIProviderConfigPanel } from "@/components/observe/AIProviderConfigPanel"
import { AppShell } from "@/components/layout/AppShell"
import { AppHeader } from "@/components/layout/AppHeader"
import { HEADER_PILL_TINTED } from "@/components/layout/header-actions"
import { cn } from "@/lib/utils"
import {
  loadLakeConfig,
  clearLakeConfig,
  planCredentialAction,
  type LakeConfig,
  type LakeAuthMode,
} from "@/lib/lake-config"

export default function SettingsPage() {
  const [address, setAddress] = useState("")
  const [authMode, setAuthMode] = useState<LakeAuthMode>("none")
  const [account, setAccount] = useState("")
  const [password, setPassword] = useState("")
  const [token, setToken] = useState("")
  const [branch, setBranch] = useState("")
  const [directory, setDirectory] = useState("")
  // LFS 模式（服务端 lake-config.json 的 lfs 字段回显，缺省 true）：平台不
  // 向普通代码仓开放 LFS 时（上传报 project lfs not enabled）关掉即走普通 git
  const [lfs, setLfs] = useState(true)
  const [savedFlag, setSavedFlag] = useState(false)
  const [hydrated, setHydrated] = useState(false)
  const [authStatus, setAuthStatus] = useState<{ username: string; tokenMasked: string; verifiedAt?: string } | null>(null)
  const [authHint, setAuthHint] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [browseOpen, setBrowseOpen] = useState(false)
  const [browsePrefix, setBrowsePrefix] = useState("")
  const [browseDirs, setBrowseDirs] = useState<string[]>([])
  const [browseLoading, setBrowseLoading] = useState(false)
  const [browseError, setBrowseError] = useState<string | null>(null)
  const [branchOpen, setBranchOpen] = useState(false)
  const [branchList, setBranchList] = useState<string[]>([])
  const [branchLoading, setBranchLoading] = useState(false)
  const [branchError, setBranchError] = useState<string | null>(null)

  // 运行日志配置块（logger-config.json 的 UI 面）：client 组件绝不 import
  // logger（node:fs 依赖），一律走 /api/settings/logger-config
  const [logEnabled, setLogEnabled] = useState(true)
  const [logLevel, setLogLevel] = useState<"debug" | "info" | "warn" | "error">("info")
  const [logFile, setLogFile] = useState(true)
  const [logStdout, setLogStdout] = useState(true)
  const [logSavedFlag, setLogSavedFlag] = useState(false)
  const [logHydrated, setLogHydrated] = useState(false)
  const [logEnvOverrides, setLogEnvOverrides] = useState<string[]>([])
  const [logDir, setLogDir] = useState<string | null>(null)
  const [logHint, setLogHint] = useState<string | null>(null)

  useEffect(() => {
    // 渲染期零读 localStorage（hydration 契约，同 v1.84 AIProviderConfigPanel）。
    // 单源架构：服务端 lake-config.json 为准（全机生效）；未配置时用 legacy
    // localStorage 值预填表单（存量用户保存一次即完成迁移）。凭据形态字段
    // （authMode/账号/令牌）不落服务端配置文件，从 legacy 预填或空
    void (async () => {
      const legacy = loadLakeConfig()
      try {
        const res = await fetch("/api/settings/lake-config")
        const data = await res.json() as { configured?: boolean; address?: string; branch?: string; directory?: string; lfs?: boolean }
        if (data.configured && data.address) {
          setAddress(data.address)
          setBranch(data.branch?.trim() || "main")
          setDirectory(data.directory ?? "")
          setLfs(data.lfs ?? true)
          setSavedFlag(true)
        } else if (legacy) {
          setAddress(legacy.address)
          setBranch(legacy.branch)
          setDirectory(legacy.directory)
        } else {
          setBranch("main")
        }
      } catch {
        if (legacy) {
          setAddress(legacy.address)
          setBranch(legacy.branch)
          setDirectory(legacy.directory)
        } else {
          setBranch("main")
        }
      }
      if (legacy) {
        setAuthMode(legacy.authMode)
        setAccount(legacy.account)
        setPassword(legacy.password)
        setToken(legacy.token)
      }
      setHydrated(true)
    })()
  }, [])

  // 运行日志配置回填（缺省 = 全默认：开 / info / 双开）
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/settings/logger-config")
        const data = await res.json() as { enabled?: boolean; level?: string; file?: boolean; stdout?: boolean; logDir?: string; envOverrides?: string[] }
        if (typeof data.enabled === "boolean") setLogEnabled(data.enabled)
        if (data.level === "debug" || data.level === "info" || data.level === "warn" || data.level === "error") setLogLevel(data.level)
        if (typeof data.file === "boolean") setLogFile(data.file)
        if (typeof data.stdout === "boolean") setLogStdout(data.stdout)
        if (typeof data.logDir === "string" && data.logDir) setLogDir(data.logDir)
        if (Array.isArray(data.envOverrides)) setLogEnvOverrides(data.envOverrides)
      } catch { /* 读取失败按默认渲染，不阻塞页面 */ }
      setLogHydrated(true)
    })()
  }, [])

  // 服务端凭据状态（lake-auth.json）：按当前地址展示已配置的令牌脱敏信息
  useEffect(() => {
    if (!hydrated) return
    let active = true
    fetch("/api/settings/lake-auth")
      .then(r => r.json())
      .then((data: { remotes?: Array<{ url: string; username: string; tokenMasked: string; verifiedAt?: string }> }) => {
        if (!active) return
        const key = address.trim().replace(/\/+$/, "")
        const hit = data.remotes?.find(r => r.url === key || r.url === `${key}.git` || r.url.replace(/\.git$/, "") === key.replace(/\.git$/, ""))
        setAuthStatus(hit ?? null)
      })
      .catch(() => { /* 状态读取失败不阻塞页面 */ })
    return () => { active = false }
  }, [hydrated, address])

  const config: LakeConfig = {
    address: address.trim(),
    authMode,
    account,
    password,
    token,
    branch,
    directory,
  }

  function dirty() {
    setSavedFlag(false)
    setTestResult(null)
    setAuthHint(null)
  }

  // 保存（单源架构）：远端偏好（地址/分支/目录）落服务端 lake-config.json
  // ——全机生效（导入/上传/Viewer/CLI 共读同一份）；legacy localStorage 同步
  // 清除（防旧值在服务端配置清空后复活）。凭据（用户名+令牌/密码）落服务端
  // lake-auth.json（与 cpx 同机共享）。凭据操作走 planCredentialAction 决策：
  // 匿名模式清除该地址凭据；token/password 模式输入留空 = 保留现有
  async function handleSave() {
    setSavedFlag(true)
    const remoteUrl = address.trim().replace(/\/+$/, "")
    try {
      const cfgRes = await fetch("/api/settings/lake-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: remoteUrl, branch: branch.trim() || "main", directory: directory.trim(), lfs }),
      })
      if (!cfgRes.ok) throw new Error(String((await cfgRes.json()).error ?? "远端偏好保存失败"))
      clearLakeConfig()
      const action = planCredentialAction(config)
      if (action === "save-token") {
        const res = await fetch("/api/settings/lake-auth", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: remoteUrl, username: account.trim() || "oauth2", token: token.trim() }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(String(data.error ?? "凭据保存失败"))
        setAuthStatus({ username: account.trim() || "oauth2", tokenMasked: String(data.tokenMasked ?? "****"), verifiedAt: data.verifiedAt ?? undefined })
        setAuthHint(data.reachable === false ? "已保存，但地址探测未通过（私有仓/网络问题可忽略，令牌有效性由首次上传确认）" : "凭据已保存到本机服务端（cpx 与 insight 共用）")
      } else if (action === "save-password") {
        const res = await fetch("/api/settings/lake-auth", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: remoteUrl, username: account.trim(), token: password.trim() }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(String(data.error ?? "凭据保存失败"))
        setAuthStatus({ username: account.trim(), tokenMasked: String(data.tokenMasked ?? "****"), verifiedAt: data.verifiedAt ?? undefined })
        setAuthHint(data.reachable === false ? "已保存，但地址探测未通过（私有仓/网络问题可忽略，令牌有效性由首次上传确认）" : "凭据已保存到本机服务端（cpx 与 insight 共用）")
      } else if (action === "clear") {
        await fetch("/api/settings/lake-auth", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: remoteUrl }),
        })
        setAuthStatus(null)
        setAuthHint("匿名模式：已清除该地址的服务端凭据")
      } else {
        setAuthHint("令牌/密码留空：已保留该地址的服务端凭据（输入新值可更换；切到匿名模式可清除）")
      }
    } catch (e) {
      setAuthHint(`凭据保存失败：${e instanceof Error ? e.message : "网络错误"}`)
    }
  }

  async function handleClear() {
    clearLakeConfig()
    const remoteUrl = address.trim().replace(/\/+$/, "")
    fetch("/api/settings/lake-config", { method: "DELETE" }).catch(() => { /* best-effort */ })
    fetch("/api/settings/lake-auth", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: remoteUrl }),
    }).catch(() => { /* best-effort */ })
    setAddress("")
    setAuthMode("none")
    setAccount("")
    setPassword("")
    setToken("")
    setBranch("main")
    setDirectory("")
    setSavedFlag(false)
    setTestResult(null)
    setAuthStatus(null)
    setAuthHint(null)
  }

  async function handleTest() {
    setTesting(true)
    setTestResult(null)
    try {
      // 测试的是用户正在输入的值（编辑态探测——含表单凭据即时验证；
      // 表单凭据空则测服务端已存凭据）
      const res = await fetch("/api/ingest/lake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "test",
          config: {
            address: address.trim(),
            authMode,
            account: account.trim(),
            password,
            token,
            branch: branch.trim() || "main",
            directory: directory.trim(),
          },
        }),
      })
      const data = await res.json()
      setTestResult({
        success: Boolean(data.success),
        message: String(data.message ?? data.error ?? "测试失败"),
      })
    } catch (e) {
      setTestResult({ success: false, message: e instanceof Error ? e.message : "网络错误" })
    } finally {
      setTesting(false)
    }
  }

  async function fetchDirs(prefix: string) {
    setBrowseLoading(true)
    setBrowseError(null)
    try {
      const res = await fetch("/api/ingest/lake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "dirs",
          prefix,
          config: { address: address.trim(), branch: branch.trim() || "main", directory: directory.trim() },
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(String(data.error ?? "获取目录失败"))
      setBrowseDirs(Array.isArray(data.dirs) ? data.dirs : [])
      setBrowsePrefix(prefix)
    } catch (e) {
      setBrowseError(e instanceof Error ? e.message : "网络错误")
    } finally {
      setBrowseLoading(false)
    }
  }

  function handleBrowse() {
    setBrowseOpen(true)
    fetchDirs("")
  }

  function closeBrowse() {
    setBrowseOpen(false)
    setBrowseDirs([])
    setBrowsePrefix("")
    setBrowseError(null)
  }

  async function handlePickBranch() {
    setBranchOpen(true)
    setBranchLoading(true)
    setBranchError(null)
    try {
      const res = await fetch("/api/ingest/lake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "branches",
          config: { address: address.trim(), branch: branch.trim() || "main", directory: directory.trim() },
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(String(data.error ?? "获取分支失败"))
      setBranchList(Array.isArray(data.branches) ? data.branches : [])
    } catch (e) {
      setBranchError(e instanceof Error ? e.message : "网络错误")
    } finally {
      setBranchLoading(false)
    }
  }

  function closeBranch() {
    setBranchOpen(false)
    setBranchList([])
    setBranchError(null)
  }

  function logDirty() {
    setLogSavedFlag(false)
  }

  async function handleLogSave() {
    setLogHint(null)
    try {
      const res = await fetch("/api/settings/logger-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: logEnabled, level: logLevel, file: logFile, stdout: logStdout }),
      })
      if (res.ok) {
        setLogSavedFlag(true)
      } else {
        const data = await res.json().catch(() => ({})) as { error?: string }
        setLogHint(`保存失败：${data.error ?? res.status}`)
      }
    } catch (e) {
      setLogHint(`保存失败：${e instanceof Error ? e.message : "网络错误"}`)
    }
  }

  async function handleLogClear() {
    setLogHint(null)
    try {
      const res = await fetch("/api/settings/logger-config", { method: "DELETE" })
      if (!res.ok) throw new Error(String((await res.json().catch(() => ({}))).error ?? res.status))
      setLogEnabled(true)
      setLogLevel("info")
      setLogFile(true)
      setLogStdout(true)
      setLogSavedFlag(false)
    } catch (e) {
      // DELETE 失败不重置本地态——UI 显示默认而服务端仍是旧值会造成脱节
      setLogHint(`恢复默认失败：${e instanceof Error ? e.message : "网络错误"}`)
    }
  }

  return (
    <AppShell
      active="settings"
      toolbar={
        <AppHeader
          title="设置"
          actions={
            <Link href="/" className={`${HEADER_PILL_TINTED} lg:hidden`}>
              <ArrowLeftIcon className="size-4 text-muted-foreground" />
              返回
            </Link>
          }
        />
      }
      statusBar={
        <footer className="flex h-7 shrink-0 items-center justify-between gap-4 border-t border-border/40 bg-card/30 px-4 text-[11px] text-muted-foreground">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex items-center gap-1.5 whitespace-nowrap">
              <span className="size-1.5 rounded-full bg-emerald-500" />
              设置 · Local
            </span>
            <span className="hidden text-muted-foreground/60 sm:inline">{BRAND_NAME}</span>
          </div>
          <span className="whitespace-nowrap text-muted-foreground/60">{VERSION_DISPLAY}</span>
        </footer>
      }
    >
      <main className="mx-auto w-full max-w-4xl px-6 py-12 lg:px-8">
        <div className="space-y-10">
          <section className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
            <SectionHeader
              icon={SparklesIcon}
              title="LLM API 配置"
              desc="用于 Audit 一键审计报告与 AI workflow 阶段划分。仅支持 OpenAI 兼容端点（如 /compatible-mode/v1）。配置存于浏览器本地，两 tab 共享。"
            />
            <SectionCard className="p-6">
              <AIProviderConfigPanel compact />
            </SectionCard>
          </section>

          <section className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300 delay-75">
            <SectionHeader
              icon={DatabaseIcon}
              title={`${BAY_NAME} 数据之湖`}
              desc="会话归档仓的连接配置：地址、认证（推送凭据）、分支与目录。留空使用默认值；配置后列表 / 导入 / 上传均按此远端执行。上传需要推送凭据（保存后 cpx 命令行同机可用）。"
            />
            <SectionCard className="space-y-5 p-6">
              <Field label="地址">
                <Input
                  value={address}
                  onChange={(e) => {
                    setAddress(e.target.value)
                    dirty()
                    if (browseOpen) closeBrowse()
                    if (branchOpen) closeBranch()
                  }}
                  className="h-9 text-xs"
                  placeholder="https://example.com/your-lake.git"
                />
              </Field>
              <Field label="认证方式">
                <Segmented
                  value={authMode}
                  onChange={(v) => { setAuthMode(v); dirty() }}
                  disabled={!hydrated}
                  options={[
                    { value: "token", label: "令牌" },
                    { value: "password", label: "账户密码" },
                    { value: "none", label: "匿名" },
                  ]}
                />
              </Field>
              {authMode === "password" ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="账户">
                    <Input value={account} onChange={(e) => { setAccount(e.target.value); dirty() }} className="h-9 text-xs" placeholder="用户名" />
                  </Field>
                  <Field label="密码" hint="gitcode 已移除 git 密码认证（仅支持私人访问令牌），密码方式仅适用于仍支持密码认证的远端。">
                    <Input type="password" value={password} onChange={(e) => { setPassword(e.target.value); dirty() }} className="h-9 text-xs" placeholder="••••••" />
                  </Field>
                </div>
              ) : (
                <Field label="令牌">
                  <Input type="password" value={token} onChange={(e) => { setToken(e.target.value); dirty() }} className="h-9 text-xs" placeholder={authStatus ? `已配置 ${authStatus.tokenMasked}（输入新值可更换）` : "推送凭据（作为 git 凭据，账户可留空）"} />
                </Field>
              )}
              {authStatus && (
                <p className="text-xs text-emerald-700 dark:text-emerald-400">
                  ✓ 服务端已配置：{authStatus.username} / {authStatus.tokenMasked}{authStatus.verifiedAt ? `（连接验证于 ${new Date(authStatus.verifiedAt).toLocaleString()}）` : ""}
                </p>
              )}
              {authHint && <p className="text-xs text-muted-foreground">{authHint}</p>}
              <Field label="连接">
                <div className="flex flex-wrap items-center gap-3">
                  <Button size="sm" variant="outline" className="h-9 px-4 text-xs" onClick={handleTest} disabled={testing || !hydrated}>
                    {testing ? "测试中…" : "测试连接"}
                  </Button>
                  {testResult && (
                    <span className={`min-w-0 text-xs break-all ${testResult.success ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
                      {testResult.success ? "✓ " : "✗ "}{testResult.message}
                    </span>
                  )}
                </div>
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="分支">
                  <div className="flex gap-2">
                    <Input value={branch} onChange={(e) => { setBranch(e.target.value); dirty(); if (browseOpen) closeBrowse() }} className="h-9 text-xs flex-1" placeholder="main（默认）" />
                    <Button size="sm" variant="outline" className="h-9 text-xs shrink-0" onClick={handlePickBranch} disabled={!hydrated}>选择</Button>
                  </div>
                </Field>
                <Field label="目录" hint="上传缺省目录：留空 = 仓库根（<sid>/ 根级），可点「浏览」从仓库中选择。">
                  <div className="flex gap-2">
                    <Input value={directory} onChange={(e) => { setDirectory(e.target.value); dirty() }} className="h-9 text-xs flex-1" placeholder="留空 = 根目录" />
                    <Button size="sm" variant="outline" className="h-9 text-xs shrink-0" onClick={handleBrowse} disabled={!hydrated}>浏览</Button>
                  </div>
                </Field>
              </div>
              {branchOpen && (
                <div className="rounded-xl border border-border/50 bg-foreground/[0.02] p-4 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-xs font-medium">选择分支</span>
                    <Button size="sm" variant="ghost" className="h-6 px-2 text-xs shrink-0" onClick={closeBranch}>关闭</Button>
                  </div>
                  {branchLoading && <p className="text-xs text-muted-foreground">加载中…</p>}
                  {branchError && <p className="text-xs text-red-600 break-all">{branchError}</p>}
                  {!branchLoading && !branchError && branchList.length === 0 && <p className="text-xs text-muted-foreground">远端没有可列出的分支</p>}
                  <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" variant="secondary" className="h-6 px-2.5 text-xs" onClick={() => { setBranch("main"); dirty(); closeBranch() }}>main（默认）</Button>
                    {branchList.map(b => (
                      <Button
                        key={b}
                        size="sm"
                        variant={b === branch.trim() ? "default" : "secondary"}
                        className="h-6 px-2.5 text-xs"
                        onClick={() => { setBranch(b); dirty(); closeBranch(); if (browseOpen) closeBrowse() }}
                      >
                        {b}
                      </Button>
                    ))}
                  </div>
                  <p className="text-[11px] text-muted-foreground/70">仅列出受支持的分支名（不含 <code>/</code>）。</p>
                </div>
              )}
              {browseOpen && (
                <div className="rounded-xl border border-border/50 bg-foreground/[0.02] p-4 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-xs font-medium">选择目录 <span className="text-muted-foreground">@{branch.trim() || "main"} /{browsePrefix}</span></span>
                    <Button size="sm" variant="ghost" className="h-6 px-2 text-xs shrink-0" onClick={closeBrowse}>关闭</Button>
                  </div>
                  {browsePrefix && (
                    <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => fetchDirs(browsePrefix.split("/").slice(0, -1).join("/"))}>← 上一级</Button>
                  )}
                  {browseLoading && <p className="text-xs text-muted-foreground">加载中…（首次浏览需拉取仓库元数据）</p>}
                  {browseError && <p className="text-xs text-red-600 break-all">{browseError}</p>}
                  {!browseLoading && !browseError && browseDirs.length === 0 && <p className="text-xs text-muted-foreground">该目录下没有子目录</p>}
                  <div className="flex flex-wrap gap-1.5">
                    {browseDirs.map(d => (
                      <Button key={d} size="sm" variant="secondary" className="h-6 px-2.5 text-xs" onClick={() => fetchDirs(d)}>
                        {d.slice(browsePrefix ? browsePrefix.length + 1 : 0)}/
                      </Button>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      className="h-6 px-2.5 text-xs"
                      onClick={() => { setDirectory(browsePrefix); dirty(); closeBrowse() }}
                    >
                      选定 /{browsePrefix || ""}
                    </Button>
                    {browsePrefix && (
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => { setDirectory(""); dirty(); closeBrowse() }}>
                        选定根目录
                      </Button>
                    )}
                  </div>
                </div>
              )}
              <div className="flex items-center justify-between gap-6 border-t border-border/40 pt-5">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-foreground/80">启用 LFS 存储</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/70">
                    <code>*.jsonl.7z</code> / <code>*.jsonl.gz</code> 走 LFS 指针出仓。部分平台（如 GitCode / AtomGit）不向普通代码仓提供 LFS——上传报「project lfs not enabled」时关闭本开关，改走普通 git 存储（会话文件压缩后仅数十 KB 级）。
                  </p>
                </div>
                <Switch checked={lfs} onChange={(v) => { setLfs(v); dirty() }} />
              </div>
              <div className="flex items-center gap-2 border-t border-border/40 pt-5">
                <Button size="sm" className="h-9 px-4 text-xs" onClick={handleSave} disabled={!hydrated || !address.trim()}>
                  保存配置
                </Button>
                <Button size="sm" variant="ghost" className="h-9 text-xs" onClick={handleClear} disabled={!hydrated}>
                  恢复默认值
                </Button>
                {savedFlag && <span className="text-xs text-emerald-600 dark:text-emerald-400">✓ 已保存</span>}
              </div>
              <p className="border-t border-border/40 pt-4 text-[11px] leading-relaxed text-muted-foreground/70">
                凭据保存在本机服务端（~/.context-insight/lake-auth.json，权限 0600），cpx 与 insight 上传/下载共用同一份；地址/分支/目录偏好同时存浏览器本地与服务端（~/.context-insight/lake-config.json）——viewer 与跨浏览器共享同一配置。数据仓默认需凭据推送（需仓主将你的账号加为协作者）。
              </p>
            </SectionCard>
          </section>

          <section className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300 delay-150">
            <SectionHeader
              icon={ScrollTextIcon}
              title="运行日志"
              desc="服务端运行过程日志（导入管线 / 数据之湖同步 / API 错误），按天滚动落盘于 ~/.context-insight/logs/ 并同时输出到启动终端。保存后即时生效，无需重启；环境变量（CONTEXT_LOG*）优先于此处设置。"
            />
            <SectionCard className="space-y-4 p-6">
              <div className="divide-y divide-border/40">
                <div className="flex items-center justify-between gap-6 py-3.5">
                  <span className="text-xs font-medium text-foreground/80">启用日志</span>
                  <Switch checked={logEnabled} onChange={(v) => { setLogEnabled(v); logDirty() }} disabled={!logHydrated} />
                </div>
                <div className="flex items-center justify-between gap-6 py-3.5">
                  <span className="text-xs font-medium text-foreground/80">日志级别</span>
                  <Segmented
                    value={logLevel}
                    onChange={(v) => { setLogLevel(v); logDirty() }}
                    disabled={!logHydrated}
                    options={[
                      { value: "debug", label: "Debug" },
                      { value: "info", label: "Info" },
                      { value: "warn", label: "Warn" },
                      { value: "error", label: "Error" },
                    ]}
                  />
                </div>
                <div className="flex items-center justify-between gap-6 py-3.5">
                  <span className="text-xs font-medium text-foreground/80">写入文件</span>
                  <Switch checked={logFile} onChange={(v) => { setLogFile(v); logDirty() }} disabled={!logHydrated} />
                </div>
                <div className="flex items-center justify-between gap-6 py-3.5">
                  <span className="text-xs font-medium text-foreground/80">输出到屏幕</span>
                  <Switch checked={logStdout} onChange={(v) => { setLogStdout(v); logDirty() }} disabled={!logHydrated} />
                </div>
              </div>
              {logDir && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground shrink-0">日志位置</span>
                  <code className="min-w-0 text-xs text-muted-foreground break-all select-text">{logDir}/insight-&lt;日期&gt;.log</code>
                </div>
              )}
              {logEnvOverrides.length > 0 && (
                <p className="text-xs text-red-600">环境变量 {logEnvOverrides.join("、")} 正在覆盖此处设置（改动部署环境变量后本页设置才会生效）。</p>
              )}
              <div className="flex flex-wrap items-center gap-2 border-t border-border/40 pt-5">
                <Button size="sm" className="h-9 px-4 text-xs" onClick={handleLogSave} disabled={!logHydrated}>
                  保存配置
                </Button>
                <Button size="sm" variant="ghost" className="h-9 text-xs" onClick={handleLogClear} disabled={!logHydrated}>
                  恢复默认值
                </Button>
                {logSavedFlag && <span className="text-xs text-emerald-600 dark:text-emerald-400">✓ 已保存</span>}
                {logHint && <span className="min-w-0 text-xs text-red-600 break-all">{logHint}</span>}
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground/70">
                也可用环境变量配置（优先于此页）：<code>CONTEXT_LOG</code> 总开关（0/off 关）、<code>CONTEXT_LOG_LEVEL</code> 级别、<code>CONTEXT_LOG_FILE</code> 写文件、<code>CONTEXT_LOG_STDOUT</code> 输出到屏幕、<code>CONTEXT_LOG_DIR</code> 日志目录——置 0/off 即关对应通道。配置存于本机服务端（~/.context-insight/logger-config.json）；默认开（Info 级、文件与终端双输出）。
              </p>
            </SectionCard>
          </section>
        </div>
      </main>
    </AppShell>
  )
}

function SectionHeader({ icon: Icon, title, desc }: { icon: LucideIcon; title: string; desc: string }) {
  return (
    <div className="flex items-start gap-3 px-1">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-emerald-500/20 bg-emerald-500/[0.07] text-emerald-600 dark:text-emerald-400">
        <Icon className="size-4.5" />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <h2 className="text-sm font-semibold tracking-tight text-foreground">{title}</h2>
        <p className="text-xs leading-relaxed text-muted-foreground">{desc}</p>
      </div>
    </div>
  )
}

function SectionCard({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("rounded-2xl border border-border/50 bg-card/60 shadow-[0_1px_2px_rgba(0,0,0,0.03),0_20px_48px_-24px_rgba(0,0,0,0.25)] backdrop-blur-2xl backdrop-saturate-150", className)}>
      {children}
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <span className="text-xs font-medium text-foreground/80">{label}</span>
      {children}
      {hint && <p className="text-[11px] leading-relaxed text-muted-foreground/70">{hint}</p>}
    </div>
  )
}

function Segmented<T extends string>({ value, onChange, options, disabled }: {
  value: T
  onChange: (v: T) => void
  options: Array<{ value: T; label: string }>
  disabled?: boolean
}) {
  return (
    <div className="inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-lg bg-foreground/[0.05] p-1">
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={cn(
            "h-7 rounded-md px-3.5 text-xs transition-all duration-200 disabled:opacity-50",
            value === o.value
              ? "bg-background font-medium text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Switch({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200 disabled:opacity-50",
        checked ? "bg-emerald-500" : "bg-foreground/[0.15]",
      )}
    >
      <span className={cn("absolute left-0.5 top-0.5 size-5 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.25)] transition-transform duration-200", checked && "translate-x-5")} />
    </button>
  )
}
