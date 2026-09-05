// conflicts.js — 冲突检测：静态扫描（patch 层） + 运行期归一化
//
// 冲突分类见 DESIGN 6.1：C1 启动崩溃（启动器归因）、C2 运行期 apply 失败/
// 自动禁用、C3 同 id 跨层配置互踩、C4 同层重复 id、C5 重复 name、C6 自杀/越权。
// 本模块负责把“可观测事实”归一化成统一的 Conflict 记录；裁决在 policy.js。

import { safeParse, jsExprOf } from './yaml-min.js'
import { isPlainObject, stableJson } from './util.js'

export const KIND = Object.freeze({
  BOOT_CRASH: 'C1', // 启动崩溃（由启动器写入 incidents，本模块不产生）
  AUTO_DISABLED: 'C2', // 运行期 loader 自动 disabled（未持久化到 guard）
  CONFIG_CLASH: 'C3', // 同 id 跨层配置不同
  DUP_ID: 'C4', // 同层重复 id
  DUP_NAME: 'C5', // 不同 id 指向同一模块名
  SELF_GUARD: 'C6', // guard 中出现 p2m/core 自己的行
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

  // C4：同一层内重复 id
  for (const layer of parsed) {
    const byId = new Map()
    for (const def of layer.defs) {
      if (!byId.has(def.id)) byId.set(def.id, [])
      byId.get(def.id).push(def)
    }
    for (const [id, list] of byId) {
      if (list.length > 1) {
        push({
          kind: KIND.DUP_ID,
          severity: SEVERITY.ERROR,
          layers: [layer.name],
          entryId: id,
          detail: `layer "${layer.name}" declares id "${id}" ${list.length} times`,
        })
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
      const base = comparable(inserts[0])
      for (const ov of overlays) {
        const cmp = comparable(ov)
        if (stableJson(cmp) !== stableJson(base)) {
          push({
            kind: KIND.CONFIG_CLASH,
            severity: SEVERITY.WARN,
            layers: [inserts[0].layer, ov.layer],
            entryId: id,
            detail: `overlay in "${ov.layer}" changes config/disabled of id "${id}" mounted by "${inserts[0].layer}"`,
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

export { SEVERITY }
