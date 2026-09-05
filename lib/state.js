// state.js — p2m 状态文件的读写（JSON，原子写）
//
// 与 guard（YAML，外部要读）分开：state.json 是 p2m 私有的自描述状态，
// 里面放 core 名单快照、自检时间、schema 版本等“解释性”信息；
// usage 台账独立成 ledger.js，incidents 独立成 incidents 模块（JSONL 追加）。

import fs from 'node:fs'
import path from 'node:path'
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
