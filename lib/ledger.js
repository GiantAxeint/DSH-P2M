// ledger.js — 累计使用时长台账（核心要求 4 的数据源）
//
// 口径（DESIGN 5.3）：插件处于“运行中”即计墙钟时间；采样循环每 tick 先
// 结算上一段、再为仍在运行的插件重新开账，因此任何时刻崩溃最多丢失
// 一个采样间隔，且不会重复计。
// 纯函数 tick() 方便单测；读写 JSON 复用 util 原子写。

import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteJson, now } from './util.js'

export const LEDGER_SCHEMA = 1

const emptyLedger = () => ({ schema: LEDGER_SCHEMA, updatedAt: now(), entries: {} })

export function defaultUsageFile(stateRoot) {
  return path.join(stateRoot, 'usage.json')
}

export function readLedger(file) {
  try {
    if (!fs.existsSync(file)) return emptyLedger()
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return {
      schema: LEDGER_SCHEMA,
      updatedAt: raw.updatedAt ?? now(),
      entries: raw.entries && typeof raw.entries === 'object' ? raw.entries : {},
    }
  } catch {
    return emptyLedger()
  }
}

/**
 * 一个采样 tick（纯函数）。
 * prev: { entries: { id: {cumulativeMs, firstSeen, lastSeen, runningSince} } }
 * runningIds: 当前正在运行的 entry id 集合
 * 返回新的 entries 对象（含之前所有 id 的历史，绝不主动删除）。
 */
export function tick(prevEntries, runningIds, at = now()) {
  const running = new Set(runningIds)
  const entries = {}
  // 1) 先全量结算：任何有 runningSince 的都把这段时间并入 cumulativeMs
  for (const [id, rec] of Object.entries(prevEntries)) {
    let cumulativeMs = rec.cumulativeMs || 0
    if (rec.runningSince != null) {
      cumulativeMs += Math.max(0, at - rec.runningSince)
    }
    entries[id] = {
      cumulativeMs,
      firstSeen: rec.firstSeen ?? at,
      lastSeen: running.has(id) ? at : rec.lastSeen ?? at,
      runningSince: null,
    }
  }
  // 2) 为仍在运行的重新开账
  for (const id of running) {
    const prev = entries[id]
    entries[id] = {
      cumulativeMs: prev ? prev.cumulativeMs : 0,
      firstSeen: prev ? prev.firstSeen : at,
      lastSeen: at,
      runningSince: at,
    }
  }
  return entries
}

/** 读取台账中某 id 的累计毫秒（不存在 → 0）。 */
export function usageMsOf(entries, id) {
  return entries[id]?.cumulativeMs ?? 0
}

/** 保存台账（原子写）。 */
export function writeLedger(file, entries, { throttleMs = 5000, lastWriteAt = 0 } = {}) {
  const at = now()
  if (at - lastWriteAt < throttleMs) return { wrote: false, at }
  const ledger = { schema: LEDGER_SCHEMA, updatedAt: at, entries }
  atomicWriteJson(file, ledger)
  return { wrote: true, at }
}

/** 清理辅助：确保状态目录存在。 */
export function ensureLedgerDir(stateRoot) {
  fs.mkdirSync(path.dirname(defaultUsageFile(stateRoot)), { recursive: true })
}
