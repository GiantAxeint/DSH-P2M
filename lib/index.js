// index.js — DSH-P2M（A 插件）Cordis 插件入口
//
// 职责（DESIGN 7/8）：
//   1. bootstrap：确保状态目录；自杀免疫自愈（guard 中出现自身/核心条目 → 移除）；
//   2. 采样：按 sampleIntervalMs 收集“运行中 entry” → 累计使用时长台账；
//   3. 观察：定时对账 loader 树 vs guard，把 loader 自动禁用（C2）交给裁决引擎，
//      autoIsolate 时固化进 guard（guard 唯一写者），core/p2m 命中则只告警+尽力恢复；
//   4. 暴露 ctx.p2m API（list/enable/disable/status/usage/incidents/guard/scanConflicts）。
//
// 稳定性：模块自身任何异常都被吞掉记日志——p2m 只是普通 entry，绝不能拖垮 DSH。
// 零运行时依赖（不用 cordis import），所有 loader 能力通过 ctx 动态调用并 try/catch。

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

import { defaultGuardFile, readGuard, disableEntry, enableEntry, mutateGuard, migrateLegacy } from './guard.js'
import { readLedger, tick, writeLedger, usageMsOf } from './ledger.js'
import { readState, writeState, appendIncident, readIncidents } from './state.js'
import { orderEntries, tierOf, TIER, isProtected } from './priority.js'
import { scanRuntime, scanStatic, KIND } from './conflicts.js'
import { decide } from './policy.js'
import { errText, now } from './util.js'

export const name = 'dsh-p2m'

const DEFAULTS = {
  sampleIntervalMs: 30_000, // 使用时长采样间隔（口径见 DESIGN 5.3）
  reconcileIntervalMs: 30_000, // 树 vs guard 对账间隔
  autoIsolate: true, // 运行期 C2 是否自动固化隔离；false = 只报告
  ledgerWriteThrottleMs: 5000,
  coreNamePrefixes: ['@deepseek-ai/'],
  coreEntryIds: [], // 额外视为 DSH 本体的 entry id（一般不配）
  patchLayers: [], // 供 scanConflicts() 读取的补丁文件路径（可选）
  legacyGuardFile: null, // 旧启动器 guard（如 E:/DeepseekHome/plugin-guard.yml），首跑迁移
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config }
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const stateRoot = cfg.stateRoot || path.join(dshHome, 'p2m')
  const guardFile = cfg.guardFile || defaultGuardFile(stateRoot)
  const usageFile = cfg.usageFile || path.join(stateRoot, 'usage.json')
  const stateFile = cfg.stateFile || path.join(stateRoot, 'state.json')
  const incidentFile = cfg.incidentFile || path.join(stateRoot, 'incidents.jsonl')

  const self = { entryId: cfg.selfEntryId || 'p2m', packageName: cfg.selfPackageName || 'dsh-p2m' }
  const core = { namePrefixes: cfg.coreNamePrefixes, entryIds: cfg.coreEntryIds }
  const loader = typeof ctx?.loader === 'object' ? ctx.loader : null

  const log = (...args) => console.log(`[p2m] ${args.join(' ')}`)
  const warn = (...args) => console.warn(`[p2m] ${args.join(' ')}`)
  // safe 需同时接住同步抛错与异步 rejection（p2m 自身错误绝不能外溢拖垮 DSH）
  const safe = (fn, fallback = null) => {
    try {
      const result = fn()
      if (result && typeof result.then === 'function') {
        return result.catch((error) => { warn('internal error:', errText(error)); return fallback })
      }
      return result
    } catch (error) {
      warn('internal error:', errText(error))
      return fallback
    }
  }
  const incident = (entry) => safe(() => appendIncident(incidentFile, entry))
  const rec = { state: null, ledgerEntries: {}, lastLedgerWrite: 0, guardIds: [] }

  const refreshGuardIds = () => {
    rec.guardIds = readGuard(guardFile).ids
    return rec.guardIds
  }

  // ---------- loader 树快照 ----------
  const snapshotEntries = () => {
    if (!loader || !loader.store) return []
    const out = []
    for (const entry of Object.values(loader.store)) {
      const options = entry?.options
      if (!options || options.group) continue // 组容器不计入使用时长与排序
      const running = Boolean(entry.fiber && !entry.disabled)
      out.push({
        id: options.id,
        name: typeof options.name === 'string' ? options.name : options.id,
        disabled: entry.disabled === true || options.disabled === true,
        running,
        entry,
      })
    }
    return out
  }

  const ranked = (entries) => {
    const list = entries.map(({ id, name, disabled, running }) => ({
      id, name, disabled, running,
      tier: tierOf({ id, name }, self, core),
      usageMs: usageMsOf(rec.ledgerEntries, id),
    }))
    return orderEntries(list, rec.ledgerEntries, self, core)
  }

  // ---------- 热调度（尽力而为；持久化靠 guard） ----------
  const hotSetDisabled = async (id, disabled) => {
    if (!loader) return false
    return safe(async () => {
      const entry = (loader.resolve && loader.resolve(id)) || loader.store?.[id]
      if (!entry?.update) return false
      await entry.update({ disabled }, false, false)
      return true
    }, false)
  }

  // ---------- 采样：累计使用时长 ----------
  const sampleTick = () => {
    if (!loader) return
    const running = snapshotEntries().filter((e) => e.running && !e.disabled).map((e) => e.id)
    rec.ledgerEntries = tick(rec.ledgerEntries, running)
    const res = writeLedger(usageFile, rec.ledgerEntries, {
      throttleMs: cfg.ledgerWriteThrottleMs,
      lastWriteAt: rec.lastLedgerWrite,
    })
    if (res.wrote) rec.lastLedgerWrite = res.at
  }

  // ---------- 对账：C2/C6 归一化 + 裁决 ----------
  const isolateEntry = async (id, conflict) => {
    const res = await disableEntry(guardFile, id)
    incident({
      kind: 'isolate', entryId: id, conflictKind: conflict?.kind ?? null,
      changed: res.changed, backup: res.backup,
      reason: conflict?.detail ?? 'policy isolate',
    })
    await hotSetDisabled(id, true)
    log(`isolated "${id}" -> guard (backup ${res.backup ?? 'n/a'})`)
    return res
  }

  const reconcile = async () => {
    if (!loader) return
    const entries = snapshotEntries()
    const conflicts = scanRuntime(entries, refreshGuardIds())
    for (const conflict of conflicts) {
      const relatedIds = [conflict.entryId].filter(Boolean)
      const relatedEntries = entries.filter((e) => relatedIds.includes(e.id))
      const protectedHit = relatedEntries.some((e) => isProtected(tierOf({ id: e.id, name: e.name }, self, core)))
      if (protectedHit) {
        // 保护对象被运行时自动禁用：绝不写 guard；尽力热恢复，冷却重试
        const cooldown = rec.protectRetryAt?.[conflict.entryId] ?? 0
        if (now() > cooldown) {
          rec.protectRetryAt = { ...(rec.protectRetryAt ?? {}), [conflict.entryId]: now() + 5 * 60_000 }
          incident({ kind: 'protected-auto-disabled', entryId: conflict.entryId, severity: 'error', detail: conflict.detail })
          warn(`protected entry "${conflict.entryId}" was auto-disabled — attempting hot restore`)
          await hotSetDisabled(conflict.entryId, false)
        }
        continue
      }
      const decision = decide(conflict, {
        order: ranked(entries),
        self, core,
        cfg: { autoIsolate: cfg.autoIsolate },
      })
      if (decision.action === 'isolate' && decision.loserId) {
        await isolateEntry(decision.loserId, conflict)
      } else {
        incident({
          kind: 'conflict-reported', entryId: conflict.entryId ?? null,
          conflictKind: conflict.kind, reason: decision.reason, detail: conflict.detail,
        })
        log(`conflict ${conflict.kind} ${conflict.entryId ?? ''}: ${decision.reason}`)
      }
    }
  }

  // ---------- ctx.p2m 公开 API ----------
  const api = {
    name: 'p2m',
    status: () => safe(() => ({
      ok: Boolean(loader), stateRoot, guardFile,
      guardIds: readGuard(guardFile).ids,
      autoIsolate: cfg.autoIsolate,
      sampleIntervalMs: cfg.sampleIntervalMs,
      bootCount: rec.state?.bootCount ?? 0,
      updatedAt: rec.state?.updatedAt ?? null,
    })),
    list: () => safe(() => {
      const entries = snapshotEntries()
      return ranked(entries).map((e) => ({
        id: e.id, name: e.name, tier: e.tier, tierLabel: ['dsh-core', 'p2m-self', 'third-party'][e.tier],
        usageMs: e.usageMs, running: e.running, disabled: e.disabled,
        guardDisabled: rec.guardIds.includes(e.id),
      }))
    }),
    usage: () => safe(() => ({ entries: rec.ledgerEntries, updatedAt: rec.state?.updatedAt })),
    incidents: (limit) => safe(() => readIncidents(incidentFile, { limit: limit ?? 50 })),
    guard: () => safe(() => ({ file: guardFile, ids: readGuard(guardFile).ids })),
    scanConflicts: () => safe(() => {
      const layers = (cfg.patchLayers || [])
        .filter((f) => fs.existsSync(f))
        .map((f) => ({ name: f, text: fs.readFileSync(f, 'utf8') }))
      return [
        ...scanStatic(layers),
        ...scanRuntime(snapshotEntries(), refreshGuardIds()),
      ]
    }),
    disable: async (id) => {
      const entry = snapshotEntries().find((e) => e.id === id)
      const tier = tierOf({ id, name: entry?.name ?? id }, self, core)
      if (isProtected(tier)) return { ok: false, reason: `"${id}" is protected (tier ${tier})` }
      const res = await disableEntry(guardFile, id)
      incident({ kind: 'manual-disable', entryId: id, backup: res.backup })
      await hotSetDisabled(id, true)
      return { ok: true, changed: res.changed, backup: res.backup }
    },
    enable: async (id) => {
      const res = await enableEntry(guardFile, id)
      incident({ kind: 'manual-enable', entryId: id, backup: res.backup })
      await hotSetDisabled(id, false)
      return { ok: true, changed: res.changed, backup: res.backup }
    },
    reconcile: () => reconcile(),
    sample: () => sampleTick(),
  }

  // 尝试把 p2m 挂到 ctx 上供其他插件/调试读取（尽力而为）
  try { if (typeof ctx.provide === 'function') ctx.provide('p2m', api) } catch { /* ignore */ }
  try {
    Object.defineProperty(ctx, 'p2m', { value: api, writable: true, configurable: true })
  } catch { /* ignore */ }

  // ---------- bootstrap ----------
  const boot = safe(() => {
    fs.mkdirSync(stateRoot, { recursive: true })
    rec.state = readState(stateFile)
    rec.state.bootCount = (rec.state.bootCount ?? 0) + 1
    rec.ledgerEntries = readLedger(usageFile).entries
    if (cfg.legacyGuardFile) {
      const m = migrateLegacy(cfg.legacyGuardFile, guardFile)
      if (m.migrated) log(`migrated legacy guard (${m.ids.length} disabled) -> ${guardFile}`)
    }
    // 自杀免疫：guard 中若有 p2m 自身/核心条目 → 移除（DESIGN 5.1 规则 1）
    const current = readGuard(guardFile)
    const poisoned = current.ids.filter((id) => {
      if (id === self.entryId) return true
      const name = snapshotEntries().find((e) => e.id === id)?.name ?? id
      return isProtected(tierOf({ id, name }, self, core))
    })
    if (poisoned.length) {
      mutateGuard(guardFile, (ids) => ids.filter((id) => !poisoned.includes(id)))
      incident({ kind: 'self-heal', entryId: poisoned.join(','), detail: 'removed protected entries from guard' })
      warn(`self-heal: removed protected guard rows: ${poisoned.join(', ')}`)
    }
    refreshGuardIds()
    writeState(stateFile, rec.state)
    log(`boot #${rec.state.bootCount} | guard=${guardFile} | autoIsolate=${cfg.autoIsolate}`)
  })
  boot?.()

  if (!loader) {
    warn('loader service unavailable — manager runs in reporting-only mode')
  }

  // ---------- 定时器 ----------
  const timers = []
  timers.push(setInterval(() => safe(sampleTick), cfg.sampleIntervalMs))
  timers.push(setInterval(() => safe(reconcile), cfg.reconcileIntervalMs))
  safe(sampleTick)
  safe(reconcile)

  try {
    ctx.on?.('dispose', () => {
      for (const t of timers) clearInterval(t)
      sampleTick() // 退出前最后结算一次
      log('disposed')
    })
  } catch { /* ignore */ }

  return api
}
