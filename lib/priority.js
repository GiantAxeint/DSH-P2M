// priority.js — 分层优先级模型（核心要求 3 + 4）
//
// 模型固定为三层（DESIGN 5.1）：
//   tier 0  DSH 本体   —— 永不参与任何“禁用/隔离”决策
//   tier 1  A 插件自身 —— 同上（自杀免疫）
//   tier 2  其他插件   —— 按累计使用时长降序排“维护优先级”
// 全部纯函数，便于单测与在启动器侧复用同一套裁决口径。

import { usageMsOf } from './ledger.js'

export const TIER = Object.freeze({
  CORE: 0,
  SELF: 1,
  OTHER: 2,
})

export const TIER_LABEL = Object.freeze({
  0: 'dsh-core',
  1: 'p2m-self',
  2: 'third-party',
})

/**
 * 判定 entry 的层级。
 * @param {{id:string, name:string|null|undefined}} entry
 * @param {{entryId:string, packageName:string}} self  A 插件自识别信息
 * @param {{namePrefixes:string[], entryIds:string[]}} core  识别 DSH 本体的规则
 */
export function tierOf(entry, self, core) {
  const id = entry.id
  const name = entry.name ?? ''
  if (id === self.entryId || name === self.packageName) return TIER.SELF
  if (core.entryIds.includes(id)) return TIER.CORE
  for (const prefix of core.namePrefixes) {
    if (name.startsWith(prefix)) return TIER.CORE
  }
  return TIER.OTHER
}

export function isProtected(tier) {
  return tier === TIER.CORE || tier === TIER.SELF
}

/**
 * 输出带优先级的排序列表：DSH 本体(保原序) > A 插件 > 其他(按 usageMs 降序)。
 * 同 usage 的第三方用 id 升序破平，保证输出确定（便于测试与展示稳定）。
 * @param {{id:string, name?:string|null}[]} entries
 * @param {object} ledgerEntries usage.json 的 entries
 * @param {{entryId:string, packageName:string}} self
 * @param {{namePrefixes:string[], entryIds:string[]}} core
 */
export function orderEntries(entries, ledgerEntries, self, core) {
  const buckets = { 0: [], 1: [], 2: [] }
  for (const entry of entries) {
    const tier = tierOf(entry, self, core)
    buckets[tier].push({ ...entry, tier, usageMs: usageMsOf(ledgerEntries, entry.id) })
  }
  // tier0 保持传入顺序（= loader 启动顺序）；tier1 天然一个；tier2 按 usage 降序
  buckets[2].sort((a, b) => b.usageMs - a.usageMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return [...buckets[0], ...buckets[1], ...buckets[2]]
}

/**
 * 在“必须牺牲一个”时选出出局者（理论上不会被调用到 protected 集合，
 * 调用方需先过滤；此处仍做防御：若只有 protected 则返回 null）。
 * 规则：tier 大者出局；同 tier 比 usage，用时短者出局（DESIGN 5.2）。
 */
export function pickLoser(ranked, self, core) {
  let loser = null
  for (const entry of ranked) {
    const tier = tierOf(entry, self, core)
    if (isProtected(tier)) continue
    if (!loser || entry.usageMs < loser.usageMs) loser = entry
  }
  return loser
}
