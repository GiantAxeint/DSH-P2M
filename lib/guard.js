// guard.js — canonical guard 持久层（“唯一写者”封装）
//
// 为什么是独立模块：guard（plugin-guard.yml）是 p2m 运行期与 DSH-safe 启动器
// 共享的唯一“禁用决策面”。所有写入必须经过这里：加锁 → 读现状 → 备份 → 原子写。
// 这样双进程即使抢写，也不会出现半截文件或互相覆盖丢失记录（DESIGN 4/6.4）。

import fs from 'node:fs'
import path from 'node:path'
import { safeParse, jsExprOf } from './yaml-min.js'
import { atomicWriteFile, now, withLock, errText, isPlainObject } from './util.js'

export const GUARD_HEADER = [
  '# ============================================================',
  '#  dsh plugin guard file (plugin-guard.yml)',
  '#  Managed by DSH-P2M (A-plugin). Do not edit manually unless',
  '#  you know what you are doing.',
  '#',
  '#  Top-level YAML array of loader patch entries, one per disabled plugin:',
  '#    - id: <entry-id>',
  '#      disabled: true',
  '#  The empty array below means: nothing is disabled right now.',
  '# ============================================================',
  '',
].join('\n')

/** 读取 guard 文本 → 已禁用 id 列表（字面 disabled:true 才算，!!js 不算）。 */
export function readGuard(file) {
  if (!fs.existsSync(file)) return { ids: [], rows: [], error: null }
  const text = fs.readFileSync(file, 'utf8')
  return parseGuard(text)
}

/** 解析 guard 内容（也用于旧启动器/手写文件的兼容读取）。 */
export function parseGuard(text) {
  const parsed = safeParse(text)
  if (parsed.error) return { ids: [], rows: [], error: parsed.error }
  const rows = Array.isArray(parsed.value) ? parsed.value : []
  const ids = []
  const exprs = []
  for (const row of rows) {
    if (!isPlainObject(row) || typeof row.id !== 'string' || !('disabled' in row)) continue
    if (row.disabled === true) ids.push(row.id)
    else if (jsExprOf(row.disabled) !== null) exprs.push(row.id)
  }
  return { ids, rows, exprs, error: null }
}

/** 生成 guard 文件内容（与 dsh-safe 旧格式逐字节兼容的方言）。 */
export function stringifyGuard(ids) {
  if (!ids.length) return GUARD_HEADER + '[]\n'
  const rows = ids
    .map((id) => `- id: ${id}\n  disabled: true`)
    .join('\n')
  return GUARD_HEADER + rows + '\n'
}

/** 默认 canonical guard 路径：<DSH_HOME>/p2m/plugin-guard.yml。 */
export function defaultGuardFile(stateRoot) {
  return path.join(stateRoot, 'plugin-guard.yml')
}

/**
 * 在锁内“读现状 → 应用变更函数 → 备份 → 原子写”。
 * change(oldIds) 返回新 id 数组（可能原样 → 不写）。
 * 返回 { changed, ids, backup }。
 */
export async function mutateGuard(file, change, { backup = true } = {}) {
  const lockFile = file + '.lock'
  return withLock(lockFile, () => {
    const current = readGuard(file)
    if (current.error) throw new Error(`guard unreadable: ${file}: ${errText(current.error)}`)
    const nextIds = change(current.ids)
    const changed = JSON.stringify(nextIds) !== JSON.stringify(current.ids)
    if (!changed) return { changed: false, ids: current.ids, backup: null }
    let backupName = null
    if (backup && fs.existsSync(file)) {
      backupName = `${file}.bak-${now()}`
      fs.copyFileSync(file, backupName)
    }
    atomicWriteFile(file, stringifyGuard(nextIds))
    return { changed: true, ids: nextIds, backup: backupName }
  })
}

/** 便捷：禁用一个 id（已存在则 no-op）。 */
export function disableEntry(file, id) {
  return mutateGuard(file, (ids) => (ids.includes(id) ? ids : [...ids, id]))
}

/** 便捷：恢复一个 id（不存在则 no-op）。 */
export function enableEntry(file, id) {
  return mutateGuard(file, (ids) => ids.filter((x) => x !== id))
}

/**
 * 首跑迁移：把旧启动器同目录的 plugin-guard.yml 内容并入 canonical，
 * 仅当 canonical 不存在/为空且 legacy 有内容时执行。
 */
export function migrateLegacy(legacyFile, canonicalFile) {
  if (!legacyFile || !fs.existsSync(legacyFile)) return { migrated: false, reason: 'no-legacy' }
  const legacy = readGuard(legacyFile)
  if (!legacy.ids.length) return { migrated: false, reason: 'legacy-empty' }
  if (fs.existsSync(canonicalFile) && readGuard(canonicalFile).ids.length) {
    return { migrated: false, reason: 'canonical-exists' }
  }
  fs.mkdirSync(path.dirname(canonicalFile), { recursive: true })
  atomicWriteFile(canonicalFile, stringifyGuard(legacy.ids))
  return { migrated: true, ids: legacy.ids }
}
