// state.js — p2m 状态文件的读写（JSON，原子写）
//
// 与 guard（YAML，外部要读）分开：state.json 是 p2m 私有的自描述状态，
// 里面放 core 名单快照、自检时间、schema 版本、解析路径快照（E2）等
// “解释性”信息；usage 台账独立成 ledger.js，incidents 独立成 incidents
// 模块（JSONL 追加）。

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { atomicWriteJson, now } from './util.js'

export const STATE_SCHEMA = 1

const EMPTY = () => ({
  schema: STATE_SCHEMA,
  updatedAt: now(),
  coreSnapshot: { namePrefixes: ['@deepseek-ai/'], entryIds: [] },
  self: { entryId: 'p2m', packageName: 'dsh-p2m' },
  bootCount: 0,
})

/** 读 state.json；不存在或损坏 → 返回空态（绝不 crash）。 */
export function readState(file) {
  try {
    if (!fs.existsSync(file)) return EMPTY()
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { ...EMPTY(), ...raw, updatedAt: raw.updatedAt ?? now() }
  } catch {
    return EMPTY()
  }
}

/** 原子写 state.json。 */
export function writeState(file, state) {
  atomicWriteJson(file, { ...state, schema: STATE_SCHEMA, updatedAt: now() })
}

/** incidents：JSONL 追加写（append-only，永不 rewrite）。 */
export function appendIncident(file, entry) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const line = JSON.stringify({ ts: now(), ...entry })
  fs.appendFileSync(file, line + '\n', 'utf8')
}

export function readIncidents(file, { limit = 50 } = {}) {
  if (!fs.existsSync(file)) return []
  const out = []
  try {
    const text = fs.readFileSync(file, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      try { out.push(JSON.parse(line)) } catch { /* 坏行跳过 */ }
    }
  } catch { /* 读失败返回已有 */ }
  return out.slice(-limit)
}

// ============ E2 解析路径留痕（resolve 快照，2026-09-06 事件第二幕） ============
//
// 背景：9-06 第二幕的崩因是 profile 本地实体丢失后，Node 沿目录向上爬升，
// 命中全局 CLI 内置的 dsh-settings@0.1.2-alpha.3（旧 API），而非声明兼容的
// 0.1.1-rc.2 —— 报错是 “does not provide an export”，表象像“缺包”，实为
// “解析目标漂移”。本快照把每次对账时各 entry 的 require.resolve 实际落点
// 记进 state.json，漂移发生时直接写 incident，事后不必逐级排查。

/** 判定解析落点是否在 profile 目录内（local）；否则视为发生了向上爬升/漂移。 */
export function isInsideProfile(resolvedPath, profileDir) {
  if (!resolvedPath || !profileDir) return false
  const rel = path.relative(profileDir, resolvedPath)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** 从已解析文件路径向上找最近的 package.json，返回 {dir, version}；找不到返回 null。 */
export function pkgMetaAt(resolvedFile) {
  let dir = resolvedFile
  if (fs.existsSync(dir) && fs.statSync(dir).isFile()) dir = path.dirname(dir)
  for (;;) {
    const pkgFile = path.join(dir, 'package.json')
    if (fs.existsSync(pkgFile)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
        return { dir, version: pkg.version ?? null }
      } catch { return { dir, version: null } }
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * 构建解析路径快照（纯逻辑；FS/resolve 均可注入以便单测）。
 * @param {{id:string, spec:string}[]} entries
 * @param {object} opts
 * @param {string} opts.baseDir     解析基准目录（通常是 profile 根）
 * @param {string} opts.profileDir  判定 local/漂移 用的 profile 目录（默认 = baseDir）
 * @param {(spec:string)=>string} [opts.resolve]   注入 resolve；默认 createRequire
 * @param {(file:string)=>string|null} [opts.versionAt]  注入版本读取；默认 pkgMetaAt
 * @returns {{at:number, entries:{entryId,spec,resolved,version,local}[]}}
 */
export function buildResolveSnapshot(entries, {
  baseDir,
  profileDir = baseDir,
  resolve,
  versionAt,
} = {}) {
  const resolver = resolve || ((spec) => createRequire(path.join(baseDir, '__p2m_resolve__.cjs')).resolve(spec))
  const reader = versionAt || ((file) => pkgMetaAt(file)?.version ?? null)
  const out = []
  for (const e of entries ?? []) {
    if (!e || typeof e.spec !== 'string' || !e.spec) continue
    let resolved = null
    let version = null
    try { resolved = resolver(e.spec) } catch { /* unresolved（本地缺失/爬升不可达） */ }
    if (resolved) { try { version = reader(resolved) } catch { /* 版本读不到不致命 */ } }
    out.push({
      entryId: e.id ?? e.spec,
      spec: e.spec,
      resolved,
      version,
      local: resolved ? isInsideProfile(resolved, profileDir) : false,
    })
  }
  out.sort((a, b) => (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0))
  return { at: now(), entries: out }
}

/**
 * 前后两次快照的漂移报告（纯函数）。逐 spec 比较，返回有变化/新增/消失的条目。
 * @returns {{entryId:string, spec:string, changes:{field:string, from:*, to:*}[]}[]}
 */
export function driftReport(prevSnapshot, nextSnapshot) {
  if (!prevSnapshot || !nextSnapshot) return []
  const prev = new Map((prevSnapshot.entries ?? []).map((e) => [e.spec, e]))
  const out = []
  for (const next of nextSnapshot.entries ?? []) {
    const before = prev.get(next.spec)
    if (!before) {
      out.push({ entryId: next.entryId, spec: next.spec, changes: [{ field: 'appeared', from: null, to: next.resolved }] })
      continue
    }
    const changes = []
    if (before.local !== next.local) changes.push({ field: 'local', from: before.local, to: next.local })
    if (before.resolved !== next.resolved) changes.push({ field: 'resolved', from: before.resolved, to: next.resolved })
    if (before.version !== next.version) changes.push({ field: 'version', from: before.version, to: next.version })
    if (changes.length) out.push({ entryId: next.entryId, spec: next.spec, changes })
  }
  return out
}
