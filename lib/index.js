// index.js — DSH-P2M（A 插件）Cordis 插件入口
//
// 职责（DESIGN 7/8 + §13 R5）：
//   1. bootstrap：确保状态目录；自杀免疫自愈（guard 中出现自身/核心条目 → 移除）；
//   2. 采样：按 sampleIntervalMs 收集“运行中 entry” → 累计使用时长台账；
//   3. 观察：定时对账 loader 树 vs guard，把 loader 自动禁用（C2）交给裁决引擎，
//      autoIsolate 时固化进 guard（guard 唯一写者），core/p2m 命中则只告警+尽力恢复；
//   4. 试用门禁（R5）：真实开启前先子进程试跑；失败弹「取消开启/无视风险继续使用」；
//   5. 暴露 ctx.p2m API（list/enable/disable/trial/status/usage/incidents/guard/scanConflicts）。
//
// 稳定性：模块自身任何异常都被吞掉记日志——p2m 只是普通 entry，绝不能拖垮 DSH。
// 零运行时依赖（不用 cordis import），所有 loader 能力通过 ctx 动态调用并 try/catch。

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

import { defaultGuardFile, readGuard, disableEntry, enableEntry, mutateGuard, migrateLegacy } from './guard.js'
import { readLedger, tick, writeLedger, usageMsOf } from './ledger.js'
import { readState, writeState, appendIncident, readIncidents, buildResolveSnapshot, driftReport } from './state.js'
import { orderEntries, tierOf, TIER, isProtected } from './priority.js'
import { scanRuntime, scanStatic, scanServiceClashes, KIND } from './conflicts.js'
import { preflightBundles } from './preflight.js'
import { decide } from './policy.js'
import { runTrial } from './trial.js'
import { askCrashRisk } from './dialog.js'
import { errText, now } from './util.js'

export const name = 'dsh-p2m'

const DEFAULTS = {
  sampleIntervalMs: 30_000, // 使用时长采样间隔（口径见 DESIGN 5.3）
  reconcileIntervalMs: 30_000, // 树 vs guard 对账间隔
  autoIsolate: true, // 运行期 C2 是否自动固化隔离；false = 只报告
  autoGateRisk: true, // R5：真实开启前是否走“试跑 + 风险弹窗”
  popupCooldownMs: 120_000, // 同一插件连续弹窗冷却（防风暴）
  trialTimeoutMs: 15_000, // 试跑子进程超时
  ui: 'auto', // 'auto'=优先桌面弹窗；'none'=不弹，默认取消开启
  ledgerWriteThrottleMs: 5000,
  coreNamePrefixes: ['@deepseek-ai/'],
  coreEntryIds: [], // 额外视为 DSH 本体的 entry id（一般不配）
  // C7 引擎核心默认服务名单快照（2026-09-06 第三幕实证）：core 内置后端默认注册、
  // 第三方入口撞名即启动崩溃。按引擎演进可增删，置 [] 关闭该告警。
  knownCoreServices: ['sessionPersistence'],
  c7ScanIntervalMs: 300_000, // C7 静态文件扫描的节流间隔（5 分钟）
  preflightOnBoot: true, // E3：boot 时对 profile 全部 bundle 做 peer 版本体检（只报告不阻塞）
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
  const rec = { state: null, ledgerEntries: {}, lastLedgerWrite: 0, guardIds: [], forceUntil: {}, c7: { at: 0, sig: '', conflicts: [] }, reportedKeys: new Set(), resolvePrev: null, lastResolveWriteAt: 0 }
  const canGate = () => cfg.autoIsolate && cfg.autoGateRisk

  // ---------- E2 解析路径留痕（DESIGN E2；resolve 快照 + 漂移 incident） ----------
  const specEntries = (entries) => entries
    .filter((e) => e.name && e.name !== e.id)
    .map((e) => ({ id: e.id, spec: e.name }))
  const captureResolve = (entries) => safe(
    () => buildResolveSnapshot(specEntries(entries), { baseDir, profileDir: baseDir }),
    null,
  )
  // 记录解析漂移：只对“内容有变化”的新现象记 incident（防 30s 对账刷屏）
  const recordResolveDrift = (next, entries) => {
    if (!rec.resolvePrev || !next) { rec.resolvePrev = next; return }
    const drift = driftReport(rec.resolvePrev, next)
    if (drift.length) {
      const first = drift[0]
      const summary = drift.map((d) => `${d.entryId}(${d.spec}): ${d.changes.map((c) => `${c.field} ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`).join('; ')}`).join(' | ')
      if (logOnce('resolve-drift', drift.map((d) => d.entryId).join(','), summary)) {
        const drifted = drift.filter((d) => d.changes.some((c) => c.field === 'local' && c.to === false))
        incident({
          kind: 'resolve-drift', entryId: drift.map((d) => d.entryId).join(','),
          detail: summary.slice(0, 800),
          advice: drifted.length
            ? `以下 spec 的解析落点不在 profile 内（Node 向上爬升，多半命中全局 CLI）：${drifted.map((d) => d.spec).join(', ')}。修复：在该 profile 里显式钉回兼容版本（pnpm add ${drifted[0]?.spec}@<期望版本>），再用 p2m 的 scanConflicts/trial 复核。`
            : null,
        })
        warn(`resolve drift: ${drift.length} entry(s) changed resolution — see incident`)
      }
    }
    rec.resolvePrev = next
    const stale = now() - rec.lastResolveWriteAt > 60_000
    if (drift.length || stale) {
      rec.state.lastResolve = next
      writeState(stateFile, rec.state)
      rec.lastResolveWriteAt = now()
    }
  }

  const refreshGuardIds = () => {
    rec.guardIds = readGuard(guardFile).ids
    return rec.guardIds
  }

  // ---------- E3 启动前体检（peer 版本合规；只报告，绝不阻塞 loader） ----------
  const runPreflight = () => {
    let bundleSpecs = []
    try {
      const profilePkg = JSON.parse(fs.readFileSync(path.join(baseDir, 'package.json'), 'utf8'))
      bundleSpecs = Object.keys(profilePkg.dependencies ?? {})
    } catch { /* profile package.json 不可读 → 无 bundle 可检 */ }
    const result = preflightBundles(baseDir, bundleSpecs)
    rec.state.preflight = {
      at: now(), checked: result.summary.checked,
      ok: result.summary.ok, error: result.summary.error, warn: result.summary.warn,
    }
    const errors = result.findings.filter((f) => f.level === 'error')
    if (errors.length) {
      warn(`preflight: ${errors.length} peer violation(s) — 建议先钉版本再重启 DSH`)
      for (const e of errors.slice(0, 5)) warn(`  ${e.bundle} peer ${e.peer}: declared ${e.declared}, resolved ${e.resolved ?? '(none)'} | fix: ${e.fix}`)
      if (logOnce('preflight-failed', errors[0]?.bundle ?? 'preflight', errors.map((e) => `${e.bundle}:${e.peer}`).join(','))) {
        incident({
          kind: 'preflight-failed',
          entryId: errors.map((e) => e.bundle).join(','),
          detail: errors.slice(0, 8).map((e) => `${e.bundle} peer ${e.peer}: declared ${e.declared} vs resolved ${e.resolved ?? '(none)'} (${e.detail})`).join('; ').slice(0, 800),
          advice: `修复：在 profile 显式钉版本 — ${[...new Set(errors.map((e) => e.fix))].slice(0, 5).join('；')}`,
        })
      }
    }
    rec.preflightResult = result
    return result
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

  // ---------- C7 同名服务预检（DESIGN 6.1 C7；静态文件扫描，节流 + 签名失效） ----------
  const c7Entries = (entries) => entries
    .filter((e) => !e.disabled && !rec.guardIds.includes(e.id) && e.name && e.name !== e.id)
    .map((e) => ({ id: e.id, spec: e.name, layer: 'runtime', disabled: false }))
  const scanC7 = (entries, { force = false } = {}) => {
    const list = c7Entries(entries)
    const sig = list.map((e) => `${e.id}:${e.spec}`).join('|')
    if (!force && sig === rec.c7.sig && now() - rec.c7.at < cfg.c7ScanIntervalMs) return rec.c7.conflicts
    rec.c7 = {
      at: now(),
      sig,
      conflicts: scanServiceClashes(list, {
        baseDir,
        knownCoreServices: cfg.knownCoreServices,
      }),
    }
    return rec.c7.conflicts
  }
  // 同类静态冲突只记一次 incident（防止每 30s 对账刷屏）；Set 上限防内存膨胀
  const logOnce = (kind, entryId, detail) => {
    const key = `${kind}|${entryId ?? ''}|${String(detail).slice(0, 120)}`
    if (rec.reportedKeys.has(key)) return false
    if (rec.reportedKeys.size > 128) rec.reportedKeys.clear()
    rec.reportedKeys.add(key)
    return true
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

  // ---------- R5 试用门禁：解析模块路径 → 子进程试跑 → 弹窗二选一 ----------
  const baseUrl = loader?.ctx?.baseUrl || process.cwd()
  const baseDir = (() => {
    try {
      const u = new URL(baseUrl)
      if (u.protocol === 'file:') return fileURLToPath(u)
    } catch { /* 非 URL → 当路径 */ }
    return baseUrl
  })()
  const resolveModule = (spec) => {
    if (!spec || typeof spec !== 'string') return null
    try {
      if (spec.startsWith('file:')) return fileURLToPath(new URL(spec))
      if (spec.startsWith('.') || path.isAbsolute(spec)) return path.resolve(baseDir, spec)
      const req = createRequire(path.join(baseDir, '__p2m_require__.cjs'))
      return req.resolve(spec)
    } catch {
      return null // 解析失败 = 无法试跑（可能 entry 已被移除）
    }
  }
  const trialOf = async (id) => {
    const entry = snapshotEntries().find((e) => e.id === id)
    if (!entry) return null
    const modPath = resolveModule(entry.name)
    if (!modPath) return null
    return runTrial(modPath, { timeoutMs: cfg.trialTimeoutMs })
  }
  // 用户选“无视风险继续使用”后，若该插件再次崩溃：冷却期内不再弹窗，静默隔离
  const markForced = (id) => { rec.forceUntil[id] = now() + cfg.popupCooldownMs }
  const isForcedRecently = (id) => (rec.forceUntil[id] ?? 0) > now()

  /** 手动开启前的门禁：返回 'pass'(放行) | 'cancel'(取消) | 'force'(无视风险)。 */
  const decideEnableGate = async (id, evidence) => {
    if (!canGate()) return 'pass'
    const tr = await trialOf(id)
    if (!tr || tr.verdict === 'ok') return 'pass' // 试跑通过/无法试跑 → 放行
    const choice = await askCrashRisk(id, tr.detail || evidence, { ui: cfg.ui })
    if (choice === 'force') {
      markForced(id)
      incident({ kind: 'user-forced-enable', entryId: id, detail: tr.detail.slice(0, 300) })
      return 'force'
    }
    incident({ kind: 'user-cancelled-enable', entryId: id, detail: tr.detail.slice(0, 300) })
    return 'cancel'
  }

  /** C2 隔离前的门禁：返回 'isolate'(隔离/维持禁用) | 'force'(无视风险，热开启)。 */
  const decideIsolateGate = async (id, evidence) => {
    if (!canGate()) return 'isolate' // 未开 R5 门禁 → 维持原裁决（隔离）
    if (isForcedRecently(id)) {
      incident({ kind: 'force-failed', entryId: id, detail: 'user forced enable but entry crashed again; isolating silently' })
      return 'isolate'
    }
    const tr = await trialOf(id)
    if (tr && tr.verdict === 'ok') {
      // 隔离态下试跑通过 → 不是“自崩”而是冲突 → 按策略隔离冲突方
      return 'isolate'
    }
    const choice = await askCrashRisk(id, tr?.detail || evidence, { ui: cfg.ui })
    if (choice === 'force') {
      markForced(id)
      incident({ kind: 'user-forced-enable', entryId: id, detail: tr?.detail.slice(0, 300) || evidence })
      await hotSetDisabled(id, false)
      return 'force'
    }
    incident({ kind: 'user-cancelled-isolate', entryId: id, detail: tr?.detail.slice(0, 300) || evidence })
    return 'isolate'
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
    const conflicts = [...scanRuntime(entries, refreshGuardIds()), ...scanC7(entries)]
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
        // R5 门禁：能判定为“冲突”（隔离态试跑通过）→ 静默隔离；
        // 试跑失败/超时 → 弹窗「取消开启 / 无视风险继续使用」。
        const gate = await decideIsolateGate(decision.loserId, conflict.detail)
        if (gate === 'isolate') {
          await isolateEntry(decision.loserId, conflict)
        } else {
          log(`entry "${decision.loserId}" force-enabled by user decision (crash risk ignored)`)
        }
      } else {
        if (logOnce(conflict.kind, conflict.entryId, conflict.detail)) {
          incident({
            kind: 'conflict-reported', entryId: conflict.entryId ?? null,
            conflictKind: conflict.kind, reason: decision.reason, detail: conflict.detail,
            advice: decision.advice ?? conflict.advice ?? null,
          })
        }
        log(`conflict ${conflict.kind} ${conflict.entryId ?? ''}: ${decision.reason}${decision.advice ? ` | 建议: ${decision.advice}` : ''}`)
      }
    }
    // E2：每次对账后比对解析快照（漂移才 incident / 写 state）
    recordResolveDrift(captureResolve(entries), entries)
  }

  // ---------- ctx.p2m 公开 API ----------
  const api = {
    name: 'p2m',
    status: () => safe(() => ({
      ok: Boolean(loader), stateRoot, guardFile,
      guardIds: readGuard(guardFile).ids,
      autoIsolate: cfg.autoIsolate,
      autoGateRisk: cfg.autoGateRisk,
      ui: cfg.ui,
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
      const entries = snapshotEntries()
      refreshGuardIds()
      return [
        ...scanStatic(layers),
        ...scanRuntime(entries, rec.guardIds),
        ...scanC7(entries, { force: true }),
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
      // R5：若该插件正在 guard 隔离中，恢复开启前先试跑；失败则弹窗二选一
      if (rec.guardIds.includes(id)) {
        const gate = await decideEnableGate(id, 'manual enable of guard-isolated entry')
        if (gate === 'cancel') {
          incident({ kind: 'manual-enable-cancelled', entryId: id })
          return { ok: false, gated: true, reason: 'user cancelled (crash risk)' }
        }
      }
      const res = await enableEntry(guardFile, id)
      incident({ kind: 'manual-enable', entryId: id, backup: res.backup })
      await hotSetDisabled(id, false)
      return { ok: true, changed: res.changed, backup: res.backup }
    },
    trial: async (id) => {
      // 手动试跑：直接返回子进程试跑结论，不写 guard、不弹窗
      return safe(() => trialOf(id), null)
    },
    reconcile: () => reconcile(),
    sample: () => sampleTick(),
    preflight: () => safe(() => rec.preflightResult ?? runPreflight()),
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
    // E2：boot 时记一版解析快照（此后每次对账比对，漂移才写 incident）
    const bootSnap = captureResolve(snapshotEntries())
    if (bootSnap) { rec.state.lastResolve = bootSnap; rec.resolvePrev = bootSnap }
    // E3：boot 时跑一次 peer 体检（只报告）
    if (cfg.preflightOnBoot) safe(runPreflight)
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
