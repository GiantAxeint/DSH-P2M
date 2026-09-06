// conflicts.js — 冲突检测：静态扫描（patch 层） + 运行期归一化
//
// 冲突分类见 DESIGN 6.1：C1 启动崩溃（启动器归因）、C2 运行期 apply 失败/
// 自动禁用、C3 同 id 跨层配置互踩、C4 同层重复 id、C5 重复 name、C6 自杀/越权、
// C7 同名服务注册（2026-09-06 事件第三幕新增，见 docs/incident-2026-09-06.html）。
// 本模块负责把“可观测事实”归一化成统一的 Conflict 记录；裁决在 policy.js。
//
// C7 能力边界（诚实声明，依据 cordis 源码实证）：
//   cordis 里服务注册只有两个入口——Service 子类构造 super(ctx, name) 与
//   ctx.provide(name, value)（@deepseek-ai/cordis lib/index.js Service#constructor
//   与 RegistryService#provide，重复注册即抛 "service X has been registered at"）。
//   但 name 字面量常写在【一跳依赖的基类包】里（如 sessionPersistence 实际写在
//   @deepseek-ai/dsh-session-persistence，而非 morlay RDB 插件自己的源码），因此
//   C7 扫描器除入口包源码外，还默认扫一跳 dependencies/peerDependencies 包。
//   仍扫不到的形态：动态拼接名、符号键 static provide、跨多跳依赖——记为局限。

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { safeParse, jsExprOf } from './yaml-min.js'
import { isPlainObject, stableJson } from './util.js'

export const KIND = Object.freeze({
  BOOT_CRASH: 'C1', // 启动崩溃（由启动器写入 incidents，本模块不产生）
  AUTO_DISABLED: 'C2', // 运行期 loader 自动 disabled（未持久化到 guard）
  CONFIG_CLASH: 'C3', // 同 id 跨层配置不同
  DUP_ID: 'C4', // 同层重复 id
  DUP_NAME: 'C5', // 不同 id 指向同一模块名
  SELF_GUARD: 'C6', // guard 中出现 p2m/core 自己的行
  SERVICE_CLASH: 'C7', // 同名服务注册（不同 entry 会向 cordis 注册同一 service）
})

const SEVERITY = Object.freeze({ ERROR: 'error', WARN: 'warn', INFO: 'info' })

/** 从解析后的 patch 值里提取“entry 定义/覆盖”列表（扁平，一层 insert）。 */
function collectDefs(value) {
  const defs = []
  if (!Array.isArray(value)) return defs
  const visitRow = (row) => {
    if (!isPlainObject(row)) return
    if (Array.isArray(row.insert)) {
      for (const child of row.insert) {
        if (!isPlainObject(child) || typeof child.id !== 'string') continue
        defs.push({
          kind: 'insert',
          id: child.id,
          name: typeof child.name === 'string' ? child.name : null,
          disabled: child.disabled,
          config: child.config,
        })
      }
      return
    }
    if (typeof row.id === 'string') {
      defs.push({
        kind: 'overlay',
        id: row.id,
        name: typeof row.name === 'string' ? row.name : null,
        disabled: row.disabled,
        config: row.config,
        group: row.group,
      })
    }
  }
  for (const row of value) visitRow(row)
  return defs
}

/**
 * 静态扫描一组补丁层。
 * @param {{name:string, text:string}[]} layers 补丁层（如用户 cordis.patch.yml、
 *       各插件 cordis.patch.yml），name 用于 evidence。
 * @returns Conflict[]（确定性顺序、去重）
 */
export function scanStatic(layers) {
  const parsed = layers.map((layer) => {
    const r = safeParse(layer.text)
    return {
      name: layer.name,
      defs: r.error ? [] : collectDefs(r.value),
      error: r.error ? String(r.error?.message ?? r.error) : null,
    }
  })

  const conflicts = []
  const seen = new Set()
  const push = (conflict) => {
    const key = `${conflict.kind}|${conflict.entryId ?? ''}|${conflict.detail}`
    if (seen.has(key)) return
    seen.add(key)
    conflicts.push(conflict)
  }

  // C4：同一层内重复 id —— 只对“同形态”重复报错：
  //   多个 insert 定义同一 id（真重复挂载）或 多个 overlay 同一 id（双层覆盖打架）。
  //   insert + overlay 同现是 cordis 补丁的合法习语（web-all 全家桶即如此：
  //   insert 挂载 + 顶层 disabled:true 出厂禁用），不算重复。
  for (const layer of parsed) {
    const byKind = { insert: new Map(), overlay: new Map() }
    for (const def of layer.defs) {
      const bucket = byKind[def.kind] ?? byKind.overlay
      if (!bucket.has(def.id)) bucket.set(def.id, [])
      bucket.get(def.id).push(def)
    }
    for (const kind of ['insert', 'overlay']) {
      for (const [id, list] of byKind[kind]) {
        if (list.length > 1) {
          push({
            kind: KIND.DUP_ID,
            severity: SEVERITY.ERROR,
            layers: [layer.name],
            entryId: id,
            detail: `layer "${layer.name}" declares ${kind} id "${id}" ${list.length} times`,
          })
        }
      }
    }
  }

  // C3：跨层同 id 的 insert 定义 vs overlay 覆盖、或双 overlay 互踩
  const byIdAcross = new Map()
  for (const layer of parsed) {
    for (const def of layer.defs) {
      if (!byIdAcross.has(def.id)) byIdAcross.set(def.id, [])
      byIdAcross.get(def.id).push({ layer: layer.name, ...def })
    }
  }
  const comparable = (def) => {
    const part = {}
    if ('disabled' in def) part.disabled = def.disabled
    if ('config' in def) part.config = def.config
    if (def.group !== undefined) part.group = def.group
    return part
  }
  for (const [id, list] of byIdAcross) {
    if (list.length < 2) continue
    const inserts = list.filter((d) => d.kind === 'insert')
    const overlays = list.filter((d) => d.kind === 'overlay')
    if (inserts.length > 1) {
      push({
        kind: KIND.CONFIG_CLASH,
        severity: SEVERITY.ERROR,
        layers: inserts.map((d) => d.layer),
        entryId: id,
        detail: `id "${id}" mounted by ${inserts.length} layers (${inserts.map((d) => d.layer).join(', ')})`,
      })
      continue
    }
    // 有唯一的 insert 定义：overlay 若给了不同 config/disabled 才算 C3
    if (inserts.length === 1) {
      const baseRaw = inserts[0]
      const base = comparable(baseRaw)
      for (const ov of overlays) {
        const cmp = comparable(ov)
        if (stableJson(cmp) !== stableJson(base)) {
          // E4：出厂默认 disabled 的条目被上层（通常 profile patch）覆盖为启用 ——
          // 事件第三幕形态（morlay 三件套出厂禁用，被 profile 整批 disabled:false 唤醒）。
          const factoryDefaultOverridden = baseRaw.disabled === true && ov.disabled === false
          const detail = factoryDefaultOverridden
            ? `id "${id}" 出厂默认 disabled（由 "${inserts[0].layer}" 挂载），但 overlay "${ov.layer}" 把它覆盖为启用——若它与另一默认后端/服务提供方同注册面，会直接启动崩溃（service already registered）`
            : `overlay in "${ov.layer}" changes config/disabled of id "${id}" mounted by "${inserts[0].layer}"`
          const advice = factoryDefaultOverridden
            ? `二选一：① 在 "${ov.layer}" 把 "${id}" 改回 disabled: true（保留出厂默认）；② 确认要启用时，同时把冲突的另一方（如官方默认后端对应条目）也 disabled: true——勿两个都开。`
            : null
          push({
            kind: KIND.CONFIG_CLASH,
            severity: factoryDefaultOverridden ? SEVERITY.WARN : SEVERITY.WARN,
            layers: [inserts[0].layer, ov.layer],
            entryId: id,
            detail,
            advice,
          })
        }
      }
      continue
    }
    // 双 overlay（如两个插件都改同一个系统服务的端口）
    if (overlays.length >= 2) {
      const sigs = new Set(overlays.map((d) => stableJson(comparable(d))))
      if (sigs.size > 1) {
        push({
          kind: KIND.CONFIG_CLASH,
          severity: SEVERITY.WARN,
          layers: overlays.map((d) => d.layer),
          entryId: id,
          detail: `overlays ${overlays.map((d) => `"${d.layer}"`).join(' vs ')} disagree on id "${id}"`,
          advice: `二选一：在 profile 顶层 patch 里把 "${id}" 显式覆盖成一致值（config 取其一），或把其中一个提供方的该条目 disabled: true。`,
        })
      }
    }
  }

  // C5：同一层内不同 id 指向同名模块
  for (const layer of parsed) {
    const byName = new Map()
    for (const def of layer.defs) {
      if (!def.name) continue
      if (!byName.has(def.name)) byName.set(def.name, [])
      byName.get(def.name).push(def.id)
    }
    for (const [name, ids] of byName) {
      if (ids.length > 1) {
        push({
          kind: KIND.DUP_NAME,
          severity: SEVERITY.WARN,
          layers: [layer.name],
          entryId: ids.join('/'),
          detail: `module "${name}" referenced by ids ${ids.join(', ')} in "${layer.name}"`,
        })
      }
    }
  }

  for (const layer of parsed) {
    if (layer.error && parsed.length > 1) {
      push({
        kind: KIND.CONFIG_CLASH,
        severity: SEVERITY.INFO,
        layers: [layer.name],
        entryId: null,
        detail: `layer "${layer.name}" unreadable: ${layer.error}`,
      })
    }
  }
  return conflicts
}

/**
 * 运行期归一化：把 loader 树状态 vs guard 的差异变成 Conflict。
 * @param {{id:string, name:string|null, disabled:boolean, running:boolean}[]} storeEntries
 * @param {string[]} guardIds
 */
export function scanRuntime(storeEntries, guardIds) {
  const conflicts = []
  const guard = new Set(guardIds)
  const byName = new Map()
  for (const entry of storeEntries) {
    // C2：树里 disabled 但 guard 没有 → loader 自动禁用未持久化
    if (entry.disabled && !guard.has(entry.id)) {
      conflicts.push({
        kind: KIND.AUTO_DISABLED,
        severity: SEVERITY.WARN,
        layers: ['runtime'],
        entryId: entry.id,
        detail: `entry "${entry.id}" auto-disabled at runtime but not persisted in guard`,
      })
    }
    // C6：guard 里禁了但树里其实没有这个 entry
    if (!entry.disabled && guard.has(entry.id)) {
      conflicts.push({
        kind: KIND.SELF_GUARD,
        severity: SEVERITY.INFO,
        layers: ['runtime'],
        entryId: entry.id,
        detail: `guard disables "${entry.id}" but it is running — stale or conflicting decision`,
      })
    }
    if (entry.name) {
      if (!byName.has(entry.name)) byName.set(entry.name, [])
      byName.get(entry.name).push(entry.id)
    }
  }
  for (const [name, ids] of byName) {
    if (ids.length > 1) {
      conflicts.push({
        kind: KIND.DUP_NAME,
        severity: SEVERITY.WARN,
        layers: ['runtime'],
        entryId: ids.join('/'),
        detail: `module "${name}" loaded by ids ${ids.join(', ')}`,
      })
    }
  }
  return conflicts
}

/** 解析 loader 崩溃文本 → 疑似出问题的 entry id（协议见 DESIGN F6）。 */
export function entryIdFromError(text) {
  if (!text) return null
  const m = String(text).match(/failed to (?:import|apply|dispose) loader entry ([^\s(]+)/)
  return m ? m[1] : null
}

// ============ C7 同名服务注册预检（2026-09-06 事件第三幕） ============

/**
 * 从源码文本提取 cordis 服务注册名（纯函数）。
 * 覆盖三种真实形态（依据 @deepseek-ai/cordis 源码与 @morlay/@deepseek-ai 实际包）：
 *   1. Service 子类构造：super(ctx, 'name') / super(ctx, "name")
 *   2. ctx.provide('name', …)（含 this./xx. 前缀）
 *   3. 静态字面量 provide = 'name'（兜底，符号键形态不可静态识别）
 * @returns string[]（去重、排序）
 */
export function serviceNamesFromSource(source) {
  if (typeof source !== 'string' || !source) return []
  const names = new Set()
  const patterns = [
    /super\(\s*(?:this\.)?ctx\s*,\s*(['"])([A-Za-z_$][\w$]*)\1/g,
    /\b(?:ctx|this|[A-Za-z_$][\w$]*)\.provide\(\s*(['"])([A-Za-z_$][\w$]*)\1/g,
    /(?:static\s+)?provide\s*=\s*(['"])([A-Za-z_$][\w$]*)\1/g,
  ]
  for (const re of patterns) {
    let m
    while ((m = re.exec(source))) names.add(m[2])
  }
  return [...names].sort()
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'test', 'tests', 'dist', 'coverage', '.cache'])
const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs'])

/** 收集包目录下的源码文件（默认实现；上限防失控）。 */
export function collectSourceFiles(pkgRoot, { maxDepth = 6, maxFiles = 500 } = {}) {
  const out = []
  const walk = (dir, depth) => {
    if (depth > maxDepth || out.length >= maxFiles) return
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      if (out.length >= maxFiles) return
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name) || ent.name.endsWith('.map')) continue
        walk(path.join(dir, ent.name), depth + 1)
      } else if (ent.isFile() && SOURCE_EXT.has(path.extname(ent.name))) {
        out.push(path.join(dir, ent.name))
      }
    }
  }
  walk(pkgRoot, 0)
  return out.sort()
}

/**
 * 把 spec（包名/路径）解析到包根目录（含 package.json 的那一层）。
 * 解析失败返回 null（github/link spec 或已卸载时常见，静默跳过）。
 */
export function resolvePkgRoot(spec, baseDir) {
  if (!spec || typeof spec !== 'string') return null
  try {
    const req = createRequire(path.join(baseDir, '__p2m_resolve__.cjs'))
    const candidates = [spec, `${spec}/package.json`]
    for (const cand of candidates) {
      try {
        const resolved = req.resolve(cand)
        let dir = resolved
        if (!dir.endsWith('.json') && !dir.endsWith('.js') && !dir.endsWith('.mjs') && !dir.endsWith('.cjs')) {
          dir = path.join(resolved, 'package.json') // 目录解析（仅兜底）
        }
        for (;;) {
          if (fs.existsSync(path.join(dir, 'package.json'))) return dir
          const parent = path.dirname(dir)
          if (parent === dir) break
          dir = parent
        }
      } catch { /* 换候选 */ }
    }
  } catch { /* 解析器不可用 */ }
  return null
}

/** 单包服务名索引：入口包源码 + 一跳依赖包源码（去重，保留首个出处）。 */
export function scanPackageServiceNames(pkgRoot, {
  baseDir,
  scanDepPackages = true,
  listFiles = collectSourceFiles,
  readFile = (f) => fs.readFileSync(f, 'utf8'),
  resolveRoot = resolvePkgRoot,
} = {}) {
  if (!pkgRoot) return []
  const index = new Map() // name -> { file }
  const absorb = (root, sourceLabel) => {
    let files = []
    try { files = listFiles(root) } catch { return }
    for (const file of files) {
      let text = ''
      try { text = readFile(file) } catch { continue }
      for (const name of serviceNamesFromSource(text)) {
        if (!index.has(name)) index.set(name, { file, source: sourceLabel })
      }
    }
  }
  absorb(pkgRoot, 'own')
  if (scanDepPackages) {
    let pkg = null
    // 用 `${root}/package.json` 而非 path.join：Windows 下两者混用时避免分隔符不一致
    try { pkg = JSON.parse(readFile(`${pkgRoot}/package.json`)) } catch { /* 读不到按无依赖处理 */ }
    const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.peerDependencies ?? {}) }
    for (const depSpec of Object.keys(deps)) {
      const depRoot = resolveRoot(depSpec, baseDir || pkgRoot)
      if (depRoot && depRoot !== pkgRoot) absorb(depRoot, `dep:${depSpec}`)
    }
  }
  return [...index.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([name, meta]) => ({ name, ...meta }))
}

/**
 * C7 静态预检：一组“将启用”的 entry（含各自包名）→ 同名服务注册冲突。
 * @param {{id:string, spec:string, layer?:string, disabled?:boolean}[]} entries
 * @param {object} opts
 * @param {string} opts.baseDir  解析基准（profile 目录；resolve 会向上爬升到全局 CLI）
 * @param {boolean} opts.includeDisabled  是否把 disabled entry 也纳入扫描
 * @param {boolean} opts.scanDepPackages  是否扫一跳依赖包（默认 true，命中事件第三幕形态）
 * @param {string[]} opts.knownCoreServices  DSH 引擎核心默认服务名单快照
 * @returns Conflict[]
 */
export function scanServiceClashes(entries, opts = {}) {
  const {
    baseDir,
    includeDisabled = false,
    scanDepPackages = true,
    knownCoreServices = [],
    listFiles,
    readFile,
    resolveRoot = resolvePkgRoot,
  } = opts
  if (!Array.isArray(entries)) return []
  const enabled = entries.filter((e) => includeDisabled || !e.disabled)
  if (enabled.length === 0) return []
  if (enabled.length < 2 && !(knownCoreServices && knownCoreServices.length)) return []

  const perEntry = enabled.map((e) => {
    const root = resolveRoot(e.spec, baseDir)
    const svcs = root
      ? scanPackageServiceNames(root, { baseDir: baseDir || root, scanDepPackages, listFiles, readFile, resolveRoot })
      : []
    return { entry: e, root, svcs }
  })

  const conflicts = []
  const seen = new Set()
  const push = (c) => {
    const key = `${c.kind}|${c.entryId ?? ''}|${c.detail}`
    if (seen.has(key)) return
    seen.add(key)
    conflicts.push(c)
  }

  // 1) 两个不同 entry 提供同名服务 → 真实注册冲突（error）
  for (let i = 0; i < perEntry.length; i++) {
    for (let j = i + 1; j < perEntry.length; j++) {
      const a = perEntry[i]
      const b = perEntry[j]
      if (a.entry.id === b.entry.id) continue
      if (!a.svcs.length || !b.svcs.length) continue
      const aNames = new Map(a.svcs.map((s) => [s.name, s]))
      for (const sb of b.svcs) {
        const sa = aNames.get(sb.name)
        if (!sa) continue
        push({
          kind: KIND.SERVICE_CLASH,
          severity: SEVERITY.ERROR,
          layers: [a.entry.layer ?? 'runtime', b.entry.layer ?? 'runtime'],
          entryId: `${a.entry.id}/${b.entry.id}`,
          detail: `entries "${a.entry.id}" (${a.entry.spec}) and "${b.entry.id}" (${b.entry.spec}) both register cordis service "${sb.name}" — boot will throw "has been registered at"`,
          advice: `二选一：在 profile 顶层 cordis.patch.yml 把 "${a.entry.id}" 或 "${b.entry.id}" 其中一方置 disabled: true（保留更常用/更重要的那个）；若两者均需保留，则让其中一方改用不同服务名或换成不重复注册的替代包。`,
          evidence: { service: sb.name, a: { entry: a.entry.id, file: sa.file, source: sa.source }, b: { entry: b.entry.id, file: sb.file, source: sb.source } },
        })
      }
    }
  }

  // 2) 单个 entry 注册了 DSH 引擎核心默认服务（如内置 JSONL 的 sessionPersistence）→ 警告 + 二选一建议
  if (knownCoreServices.length) {
    for (const item of perEntry) {
      if (!item.root || !item.svcs.length) continue
      for (const svc of item.svcs) {
        if (!knownCoreServices.includes(svc.name)) continue
        push({
          kind: KIND.SERVICE_CLASH,
          severity: SEVERITY.WARN,
          layers: [item.entry.layer ?? 'runtime'],
          entryId: item.entry.id,
          detail: `entry "${item.entry.id}" (${item.entry.spec}) registers "${svc.name}", which the DSH engine core also registers by default`,
          advice: `二选一：① 在 profile 顶层 cordis.patch.yml 把 "${item.entry.id}" 置 disabled: true（保留引擎默认）；② 确认要替换引擎默认后端时，同时把官方默认后端对应 entry 一并 disabled: true，勿两个都开。`,
          evidence: { service: svc.name, entry: item.entry.id, file: svc.file, source: svc.source },
        })
      }
    }
  }
  return conflicts
}

export { SEVERITY }
