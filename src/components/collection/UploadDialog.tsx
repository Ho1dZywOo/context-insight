// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

'use client'

// 统一上传弹窗（design: docs/design/unified-workbench/design.md §4 刀3）。
// kind 参数化合并旧 UploadToLakeDialog（会话）与 UploadBundleDialog（run）；
// 刀3 后 run 上传表单与会话对齐——范式目录 / 提交人 / 内容描述 / 任务结果
// 结果同款必选项（共享表单件 UploadFormFields，双通路视觉与校验锁步）：
// - 会话体：预填首问/会话用户 + baseline 勾选，凭据预检 + 引导弹窗，成功即关
// - run 体：预填 run 名称 + 包内结果视图（unchanged/成员数/缺正文警告），
//   手动关闭；统一布局（目录即目录）——范式目录 = 物理落点 <范式>/<runId>/，
//   会话与 run 都可上传至任意顶层目录
// 上传 action 走 registry（kind 分发事实单点）。受控组件——open/onOpenChange
// 由调用方管理，上传开始与结果经 onUploadStart/onResult 回调交还调用方呈现
// （列表行状态图标 / 详情页 toast）。取代旧双弹窗（刀3 退役）。

import { useEffect, useState } from 'react'

import { BAY_NAME } from '@/lib/branding'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { LakeTokenDialog } from '@/components/LakeTokenDialog'
import {
  findStoredAuthEntry,
  isCredentialErrorCode,
  serverLakeConfigStatus,
  type LakeTokenReason,
  type StoredRemoteInfo,
} from '@/lib/lake-token-prompt'
import { ASSET_KINDS } from '@/lib/collection/registry'
import { LoaderIcon } from 'lucide-react'

export interface UploadSessionTarget {
  taskId: string
  query?: string | null
  framework?: string | null
  model?: string | null
  startTime?: string | null
  endTime?: string | null
  sourcePath?: string | null
  user?: string | null
}

export interface UploadRunTarget {
  runId: string
  runName: string | null
}

export type UploadTarget = UploadSessionTarget | UploadRunTarget

/** 统一上传结果（会话/run 双通路同款）：warnings = 上传成功但缺正文等软提示 */
export interface UploadOutcome {
  ok: boolean
  message?: string | null
  warnings?: string[]
}

interface UploadDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  kind: 'session' | 'run'
  target: UploadTarget | null
  onUploadStart?: () => void
  onResult?: (outcome: UploadOutcome) => void
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    const hour = String(d.getHours()).padStart(2, '0')
    const minute = String(d.getMinutes()).padStart(2, '0')
    return `${month}/${day} ${hour}:${minute}`
  } catch {
    return String(iso)
  }
}

// 提交信息组装：提交人（独立输入框唯一事实源）+ 内容描述（选填，空则省略
// 该行）+ 溯源上下文（日志路径/备注，自动附加）。后端网关从首行「提交人:」提取。
function buildUploadDescription(target: UploadSessionTarget, submitter: string, contentDesc: string): string {
  const model = target.model ?? ''
  const timeRange = `${formatTime(target.startTime)} → ${formatTime(target.endTime)}`
  const framework = target.framework ?? ''
  const sourcePath = target.sourcePath ?? ''
  const context = `日志路径:${sourcePath ? ' ' + sourcePath : ' taskId ' + target.taskId + ', 框架 ' + framework}
备注: 模型 ${model}, 时间 ${timeRange}`
  const descLine = contentDesc.trim() ? `内容描述: ${contentDesc.trim()}\n` : ''
  return `提交人: ${submitter.trim()}
${descLine}${context}`
}

// ── 共享表单件（会话/run 双通路同款：范式目录 + 提交人 + 内容描述 + 任务结果）──

interface ParadigmDirsState {
  dirs: string[]
  loading: boolean
  error: string | null
}

/** 范式目录下拉数据源（打开即拉，双通路共享单源）：全仓顶层目录即范式
 *  注册表；根级会话目录（缺省上传位，<sid>/ 形态）不进下拉——统一布局下
 *  会话与 bundle 都可上传至任意顶层目录（目录即目录，不按资产类型分区）。 */
function useParadigmDirs(open: boolean): ParadigmDirsState {
  const [state, setState] = useState<ParadigmDirsState>({ dirs: [], loading: false, error: null })
  // 打开即重置（render-phase prop 变化模式）：清目录 + 置 loading，拉取结果
  // 由 effect 异步落——避免 effect 体内同步 setState 的级联渲染
  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setState({ dirs: [], loading: true, error: null })
  }
  useEffect(() => {
    if (!open) return
    let active = true
    fetch('/api/ingest/lake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: ASSET_KINDS.session.lakeListAction }),
    })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok) throw new Error(data.error ?? 'Failed to list paradigm dirs')
        const rootFolders = new Set(((data.sessions ?? []) as Array<{ sid: string; paradigm: string | null; recording?: string }>).filter(s => !s.paradigm).map(s => s.sid + (s.recording === 'native' ? '.native' : '')))
        const dirs = ((data.dirs ?? []) as string[]).filter(d => !rootFolders.has(d))
        if (!active) return
        setState({ dirs, loading: false, error: dirs.length === 0 ? '数据仓暂无范式目录：请先在数据仓新建顶层目录' : null })
      })
      .catch(() => { if (active) setState({ dirs: [], loading: false, error: '范式目录列表加载失败，请重试' }) })
    return () => { active = false }
  }, [open])
  return state
}

/** 凭据预检（双通路共享）：打开即检服务端配置远端——已配置但缺凭据直接弹
 *  引导（免填完表单才在提交时撞 no-credentials）；未配置静默（提交时拦）。 */
function useCredentialPrecheck(open: boolean) {
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false)
  const [tokenReason, setTokenReason] = useState<LakeTokenReason>('no-credentials')
  useEffect(() => {
    if (!open) return
    let active = true
    void (async () => {
      try {
        const st = await serverLakeConfigStatus()
        if (!active) return
        if (!st.configured) return
        const res = await fetch('/api/settings/lake-auth')
        const data = await res.json() as { remotes?: StoredRemoteInfo[] }
        if (!active) return
        if (!findStoredAuthEntry(data.remotes ?? [], st.address)) {
          setTokenReason('no-credentials')
          setTokenDialogOpen(true)
        }
      } catch { /* 状态读取失败不阻塞上传弹窗 */ }
    })()
    return () => { active = false }
  }, [open])
  return { tokenDialogOpen, setTokenDialogOpen, tokenReason, setTokenReason }
}

/** 上传表单状态（双通路共享）：打开即重置 + 预填——render-phase prop 变化
 *  模式（https://react.dev/learn/you-might-not-need-an-effect），替代在
 *  effect 里同步 setState（react-hooks 规则禁止，会触发级联渲染） */
function useUploadForm(open: boolean, prefill: { desc?: string; submitter?: string } | null) {
  const [contentDesc, setContentDesc] = useState('')
  const [submitter, setSubmitter] = useState('')
  const [submitterTouched, setSubmitterTouched] = useState(false)
  const [category, setCategory] = useState('')
  const [baseline, setBaseline] = useState(false)
  // 任务结果标注（随 meta 入仓，数据仓列表"任务结果"列展示）：
  // Web UI 必选（成功/失败，未选禁用上传）；'' 仅作初始未选态。数据层仍允许
  // 缺省（CLI 上传/历史数据 → 列表显示 —）
  const [opGen, setOpGen] = useState<'' | 'success' | 'failure'>('')
  const paradigm = useParadigmDirs(open)

  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setContentDesc(prefill?.desc ?? '')
      setSubmitter(prefill?.submitter ?? '')
      setSubmitterTouched(false)
      setCategory('')
      setBaseline(false)
      setOpGen('')
    }
  }
  return {
    contentDesc, setContentDesc,
    submitter, setSubmitter, submitterTouched, setSubmitterTouched,
    category, setCategory,
    baseline, setBaseline,
    opGen, setOpGen,
    paradigm,
  }
}

type UploadForm = ReturnType<typeof useUploadForm>

/** 共享表单（会话/run 双通路同款字段与校验）：范式目录* / 提交人* / 内容描述 /
 *  任务结果*；baseline 勾选为会话专有（范式基准会话，位置即身份）。 */
function UploadFormFields({ form, withBaseline, descPlaceholder, disabled }: {
  form: UploadForm
  withBaseline?: boolean
  descPlaceholder?: string
  disabled?: boolean
}) {
  return (
    <>
      <div className="space-y-1.5">
        <label className="text-sm font-medium">
          范式目录 <span className="text-red-500">*</span>
        </label>
        <select
          className="w-full text-sm px-3 py-2 border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring/30"
          value={form.category}
          onChange={(e) => form.setCategory(e.target.value)}
          disabled={form.paradigm.loading || disabled}
        >
          <option value="" disabled>
            {form.paradigm.loading ? '加载范式目录中…' : '请选择范式目录'}
          </option>
          {form.paradigm.dirs.map(d => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
        {form.paradigm.error && <p className="text-xs text-red-500">{form.paradigm.error}</p>}
        {withBaseline && (
          <label
            className={
              form.category
                ? 'flex items-center gap-2 pt-0.5 cursor-pointer select-none transition-opacity'
                : 'flex items-center gap-2 pt-0.5 select-none opacity-60'
            }
          >
            <Checkbox
              checked={form.baseline}
              onCheckedChange={(v) => form.setBaseline(v === true)}
              disabled={!form.category}
              className="cursor-pointer"
            />
            <span className="text-xs text-muted-foreground">
              设为该范式 baseline 会话（<code>{form.category}/baseline/</code>，原 baseline 移回普通目录）
            </span>
          </label>
        )}
      </div>
      <div className="space-y-1.5">
        <label className="text-sm font-medium">
          提交人 <span className="text-red-500">*</span>
        </label>
        <input
          className="w-full text-sm px-3 py-2 border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring/30"
          placeholder="必填：真实姓名或账号"
          value={form.submitter}
          onChange={(e) => { form.setSubmitter(e.target.value); form.setSubmitterTouched(true); }}
          disabled={disabled}
        />
        {form.submitterTouched && !form.submitter.trim() && (
          <p className="text-xs text-red-500">提交人不能为空</p>
        )}
      </div>
      <div className="space-y-1.5">
        <label className="text-sm font-medium">内容描述</label>
        <textarea
          className="w-full min-h-[120px] max-h-64 text-sm px-3 py-2 border rounded-md bg-background resize-y overflow-y-auto focus:outline-none focus:ring-2 focus:ring-ring/30"
          placeholder={descPlaceholder}
          value={form.contentDesc}
          onChange={(e) => form.setContentDesc(e.target.value)}
          disabled={disabled}
        />
      </div>
      <div className="flex items-center justify-between gap-3">
        <label className="text-sm font-medium shrink-0">
          任务结果 <span className="text-red-500">*</span>
        </label>
        <div className="flex gap-1 rounded-lg border bg-muted/40 p-1">
          {([
            { v: 'success' as const, label: '成功' },
            { v: 'failure' as const, label: '失败' },
          ]).map(o => {
            const active = form.opGen === o.v
            return (
              <Button
                key={o.v}
                variant="ghost"
                size="sm"
                className={
                  o.v === 'success'
                    ? 'h-6 px-3 text-xs' + (active ? ' bg-emerald-600 hover:bg-emerald-600 text-white' : ' text-muted-foreground')
                    : 'h-6 px-3 text-xs' + (active ? ' bg-red-600 hover:bg-red-600 text-white' : ' text-muted-foreground')
                }
                onClick={() => form.setOpGen(active ? '' : o.v)}
                disabled={disabled}
              >
                {o.label}
              </Button>
            )
          })}
        </div>
      </div>
    </>
  )
}

// 上传按钮统一必选门：提交人 + 范式目录 + 任务结果（会话/run 同款）
function uploadGate(form: UploadForm, uploading: boolean): boolean {
  return uploading || !form.submitter.trim() || form.opGen === '' || (!form.category || form.paradigm.dirs.length === 0)
}

function SessionUploadBody({ open, onOpenChange, target, onUploadStart, onResult }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  target: UploadSessionTarget | null
  onUploadStart?: () => void
  onResult?: (outcome: UploadOutcome) => void
}) {
  const form = useUploadForm(open, target ? { desc: (target.query ?? '').trim(), submitter: (target.user ?? '').trim() } : null)
  const [uploading, setUploading] = useState(false)
  const cred = useCredentialPrecheck(open)

  // 同步上传原生会话（仅捕获行显示）：勾选即预检（native-preview 只读探测），
  // 上传时随捕获行一起落 <sid>.native/（codex 原生 sid 不同，以响应为准）
  const [withNative, setWithNative] = useState(false)
  const [nativePreview, setNativePreview] = useState<{ loading: boolean; found?: boolean; origin?: 'db' | 'disk'; reason?: string } | null>(null)
  const [nativeWasOpen, setNativeWasOpen] = useState(false)
  if (open !== nativeWasOpen) {
    setNativeWasOpen(open)
    if (open) {
      setWithNative(false)
      setNativePreview(null)
    }
  }

  // 勾选「同步上传原生会话」→ 只读预检（DB 直查 + 本机磁盘发现），结果即时
  // 呈现：找到（已导入/本机文件）或未找到（白话原因），用户上传前心里有数
  function handleToggleNative(checked: boolean) {
    setWithNative(checked)
    setNativePreview(null)
    if (!checked || !target) return
    setNativePreview({ loading: true })
    fetch('/api/ingest/lake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'native-preview', taskId: target.taskId, framework: target.framework ?? undefined }),
    })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        const r = (data as { resolution?: { status?: string; origin?: 'db' | 'disk'; reason?: string } })?.resolution
        if (!ok || !r || r.status !== 'found') {
          setNativePreview({ loading: false, found: false, reason: r?.reason ?? (ok ? '未找到原生会话' : String((data as { error?: string }).error ?? '预检失败')) })
          return
        }
        setNativePreview({ loading: false, found: true, origin: r.origin })
      })
      .catch(() => setNativePreview({ loading: false, found: false, reason: '预检失败：网络错误' }))
  }

  async function handleUpload() {
    if (!target) return
    // 未配置预检（与 ImportDialog 同款）：服务端 lake-config.json 未配 →
    // 弹引导；已配则请求不带 config（服务端单源解析）
    const server = await serverLakeConfigStatus()
    if (!server.configured) {
      cred.setTokenReason('unconfigured')
      cred.setTokenDialogOpen(true)
      return
    }
    setUploading(true)
    onUploadStart?.()
    try {
      const res = await fetch('/api/ingest/lake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: ASSET_KINDS.session.lakeUploadAction,
          taskId: target.taskId,
          // 同 sid 双行（方案一）消歧：不带 framework 裸 taskId 会上传另一行
          framework: target.framework ?? undefined,
          description: buildUploadDescription(target, form.submitter, form.contentDesc),
          ...(form.category ? { category: form.category, ...(form.baseline ? { baseline: true } : {}) } : {}),
          ...(form.opGen ? { opGen: form.opGen } : {}),
          ...(withNative ? { withNative: true } : {}),
        }),
      })
      const data = await res.json()
      // 凭据类错误（无凭据/鉴权失败/无权限）：弹引导配置弹窗（免绕道设置页），
      // 文案仍随结果回调给调用方展示
      let message = res.ok ? undefined : String(data.error ?? 'Upload failed')
      if (!res.ok && isCredentialErrorCode(data.code)) {
        message = `${message} —— 请在弹窗中配置凭据后重试`
        cred.setTokenReason(data.code)
        cred.setTokenDialogOpen(true)
      }
      // 原生会话同步结果独立呈现（捕获行已上传成功，原生结果不影响 ok）
      if (res.ok && withNative) {
        const native = (data as { native?: { status?: string; reason?: string } })?.native
        if (native?.status === 'uploaded') message = '原生会话已同步上传'
        else if (native?.status === 'not-found') message = `捕获已上传；原生会话未找到：${native.reason ?? '未知原因'}`
        else if (native?.status === 'failed') message = `捕获已上传；原生会话上传失败：${native.reason ?? '未知原因'}`
      }
      onResult?.({ ok: res.ok, message })
      if (res.ok) onOpenChange(false)
    } catch {
      onResult?.({ ok: false, message: 'Upload failed: network error' })
    } finally {
      setUploading(false)
    }
  }

  const isProxyTarget = (target?.framework ?? '').endsWith('-proxy')

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v || !uploading) onOpenChange(v) }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>上传到 {BAY_NAME}</DialogTitle>
          <DialogDescription>会话经数据治理后上传至数据仓，可随时重新导入</DialogDescription>
        </DialogHeader>
        <UploadFormFields form={form} withBaseline descPlaceholder="选填，预填会话首问，可修改" disabled={uploading} />
        {isProxyTarget && (
          <div className="space-y-1.5">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <Checkbox
                checked={withNative}
                onCheckedChange={(v) => handleToggleNative(v === true)}
                disabled={uploading}
                className="cursor-pointer"
              />
              <span className="text-xs text-muted-foreground">
                同步上传本机原生会话（同一场对话的原生记录，一并入仓便于对照）
              </span>
            </label>
            {nativePreview && (
              <p className={'text-xs ' + (nativePreview.loading ? 'text-muted-foreground' : nativePreview.found ? 'text-emerald-600' : 'text-amber-600')}>
                {nativePreview.loading
                  ? '正在查找本机原生会话…'
                  : nativePreview.found
                    ? `已找到原生会话${nativePreview.origin === 'disk' ? '（本机文件，上传时自动导入）' : '（已导入）'}`
                    : `未找到原生会话：${nativePreview.reason ?? '本机没有对应记录'}`}
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={uploading}>取消</Button>
          <Button
            variant="default"
            className="bg-blue-600 hover:bg-blue-700 text-white"
            onClick={handleUpload}
            disabled={uploadGate(form, uploading)}
          >
            {uploading ? '上传中...' : '确认上传'}
          </Button>
        </DialogFooter>
      </DialogContent>
      {/* 令牌引导弹窗（叠加在上传弹窗之上；保存成功自动收起，表单保留可重试） */}
      <LakeTokenDialog open={cred.tokenDialogOpen} onOpenChange={cred.setTokenDialogOpen} reason={cred.tokenReason} onSaved={() => { if (cred.tokenReason === 'unconfigured') { cred.setTokenDialogOpen(false); handleUpload() } }} />
    </Dialog>
  )
}

function RunUploadBody({ open, onOpenChange, target, onUploadStart, onResult }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  target: UploadRunTarget | null
  onUploadStart?: () => void
  onResult?: (outcome: UploadOutcome) => void
}) {
  const runId = target?.runId ?? ''
  const runName = target?.runName ?? null
  const form = useUploadForm(open, target ? { desc: runName ?? '' } : null)
  const [uploading, setUploading] = useState(false)
  const [result, setResult] = useState<{ unchanged: boolean; sessionCount: number; missingSessions: string[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const cred = useCredentialPrecheck(open)

  async function startUpload() {
    if (!target) return
    // 未配置预检（与会话体同款）
    const server = await serverLakeConfigStatus()
    if (!server.configured) {
      cred.setTokenReason('unconfigured')
      cred.setTokenDialogOpen(true)
      return
    }
    setUploading(true)
    setResult(null)
    setError(null)
    onUploadStart?.()
    try {
      const desc = `提交人: ${form.submitter.trim()}` + (form.contentDesc.trim() ? `\n内容描述: ${form.contentDesc.trim()}` : '')
      const res = await fetch('/api/ingest/lake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: ASSET_KINDS.run.lakeUploadAction,
          runId,
          description: desc,
          // 范式目录 = 物理落点 <范式>/<runId>/（位置即身份）；任务结果
          // 落 bundle.meta.json（列表"任务结果"列）
          category: form.category,
          ...(form.opGen ? { opGen: form.opGen } : {}),
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        let message = String(data.error ?? `上传失败 (${res.status})`)
        if (isCredentialErrorCode(data.code)) {
          message = `${message} —— 请在弹窗中配置凭据后重试`
          cred.setTokenReason(data.code)
          cred.setTokenDialogOpen(true)
        }
        setError(message)
        onResult?.({ ok: false, message })
        return
      }
      setResult({
        unchanged: data.unchanged === true,
        sessionCount: typeof data.sessionCount === 'number' ? data.sessionCount : 0,
        missingSessions: Array.isArray(data.missingSessions) ? data.missingSessions : [],
      })
      onResult?.({ ok: true, message: null, warnings: Array.isArray(data.warnings) ? data.warnings : [] })
    } catch (e) {
      const message = e instanceof Error ? e.message : '网络错误'
      setError(message)
      onResult?.({ ok: false, message })
    } finally {
      setUploading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v || !uploading) onOpenChange(v) }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>上传 Run 到 {BAY_NAME}</DialogTitle>
          <DialogDescription>
            整个 run 作为一个包上传到所选范式目录（含 manifest、体检报告与成员会话）；同名包再次上传会整体替换，换目录上传会自动迁移旧位置
          </DialogDescription>
        </DialogHeader>
        <div className="text-sm bg-muted/50 px-3 py-2 rounded-md truncate" title={runId}>
          {runName || runId}
        </div>
        <UploadFormFields form={form} descPlaceholder="选填，预填 run 名称，可修改" disabled={uploading} />
        <div className="text-xs text-muted-foreground space-y-1">
          <p>包里的对话记录会先做敏感信息清洗，洗不干净的会拒绝上传</p>
        </div>
        {uploading && (
          <div className="flex items-center gap-2 py-2 justify-center">
            <LoaderIcon className="size-4 animate-spin" />
            <span className="text-sm text-muted-foreground">上传中（大包清洗耗时较长）...</span>
          </div>
        )}
        {result && (
          <div className="text-sm space-y-1">
            <p className="text-emerald-600 dark:text-emerald-400 break-words">
              {result.unchanged
                ? '包内容与数据仓一致，无需重新上传'
                : `已上传 ${result.sessionCount} 个成员会话到 ${BAY_NAME}`}
            </p>
            {result.missingSessions.length > 0 && (
              <p className="text-xs text-amber-600 dark:text-amber-400 break-words">
                ⚠ {result.missingSessions.length} 个成员会话不在 insight，包内缺其正文：{result.missingSessions.join(', ')}
              </p>
            )}
          </div>
        )}
        {error && (
          <p className="text-sm text-red-600 dark:text-red-400 break-words whitespace-pre-wrap">{error}</p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={uploading}>
            关闭
          </Button>
          <Button onClick={() => startUpload()} disabled={uploadGate(form, uploading)}>
            {uploading ? (
              <span className="flex items-center gap-1.5">
                <LoaderIcon className="size-4 animate-spin" />
                上传中...
              </span>
            ) : (
              '确认上传'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
      {/* 令牌引导弹窗（与会话体同款；保存成功自动收起，表单保留可重试） */}
      <LakeTokenDialog open={cred.tokenDialogOpen} onOpenChange={cred.setTokenDialogOpen} reason={cred.tokenReason} onSaved={() => { if (cred.tokenReason === 'unconfigured') { cred.setTokenDialogOpen(false); startUpload() } }} />
    </Dialog>
  )
}

export function UploadDialog({ open, onOpenChange, kind, target, onUploadStart, onResult }: UploadDialogProps) {
  if (kind === 'run') {
    const runTarget = target != null && 'runId' in target ? target : null
    return (
      <RunUploadBody
        open={open}
        onOpenChange={onOpenChange}
        target={runTarget}
        onUploadStart={onUploadStart}
        onResult={onResult}
      />
    )
  }
  const sessionTarget = target != null && 'taskId' in target ? target : null
  return (
    <SessionUploadBody
      open={open}
      onOpenChange={onOpenChange}
      target={sessionTarget}
      onUploadStart={onUploadStart}
      onResult={onResult}
    />
  )
}
