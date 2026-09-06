// preflight.js — E3 启动前体检：peer 版本合规预检（2026-09-06 事件第二幕）
//
// 背景：9-06 第二幕「export 缺失」实为 peer 版本漂移——@morlay/session-rdb@0.0.11
// 声明 peer dsh-settings ^0.1.1-rc.2，实际解析到 0.1.2-alpha.3（旧 API 被移除）。
// 本模块把「启动即崩」前移到「启动前报告」：核对每个 bundle 声明的
// peerDependencies 区间与实际解析版本，越界即告警并给出钉版本命令。
//
// 分层：
//   satisfies(version, range)          —— 零依赖 semver 子集（纯函数，单测重点）
//   compareVersions(a, b)              —— 数值段比较（pre-1.0 生态常见 rc/alpha/beta）
//   preflightBundles(profileDir, list) —— 编排（FS/resolve 可注入，便于单测）
//
// 能力边界（诚实声明）：支持 ^ ~ > >= < <= =、空格/逗号 AND、|| OR、空/* 通配；
// 不支持 hyphen 区间、x-range 通配（1.x）、build metadata 排序等冷门形态——按
// npm 语义，候选带 prerelease 时仅当区间含同 [major,minor,patch] 元组的
// prerelease 比较器才可能命中（这正是 0.1.2-alpha.3 不满足 ^0.1.1-rc.2 的规则）。

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

/** 拆 3 段数字 + prerelease 尾巴。输入 '1.2.3-rc.1' → {nums:[1,2,3], pre:'rc.1'} */
export function parseVersion(raw) {
  if (typeof raw !== 'string') return null
  const v = raw.trim()
  if (!v) return null
  const m = v.match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/)
  if (!m) return null
  return {
    nums: [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)],
    pre: m[4] ?? '',
  }
}

function preTuple(v) {
  return v ? `${v.nums[0]}.${v.nums[1]}.${v.nums[2]}` : null
}

/** prerelease 标识段比较：数字段小于非数字段；同为数字比大小；同为字符串按字典序。 */
function comparePre(a, b) {
  const as = a.split('.')
  const bs = b.split('.')
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i]
    const y = bs[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      const d = Number(x) - Number(y)
      if (d) return d < 0 ? -1 : 1
    } else if (xn !== yn) {
      return xn ? -1 : 1 // 数字段 < 字母段
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/** 比较两个版本：返回 -1/0/1。无 prerelease > 同元组带 prerelease。 */
export function compareVersions(a, b) {
  const va = parseVersion(a)
  const vb = parseVersion(b)
  if (!va || !vb) return NaN
  for (let i = 0; i < 3; i++) {
    if (va.nums[i] !== vb.nums[i]) return va.nums[i] < vb.nums[i] ? -1 : 1
  }
  if (va.pre === vb.pre) return 0
  if (!va.pre) return 1 // a 稳定版更大
  if (!vb.pre) return -1
  return comparePre(va.pre, vb.pre)
}

/** 单个比较器求值（op + version）；返回 true/false。 */
function evalComparator(version, op, target) {
  const c = compareVersions(version, target)
  if (Number.isNaN(c)) return false
  switch (op) {
    case '>': return c > 0
    case '>=': return c >= 0
    case '<': return c < 0
    case '<=': return c <= 0
    case '=': return c === 0
    default: return false
  }
}

/** 展开 ^ / ~ 为边界比较器组。returns [{op,target}...] */
function expandCaretTilde(ver, kind) {
  const v = parseVersion(ver)
  if (!v) return null
  const [major, minor, patch] = v.nums
  const pre = v.pre
  if (kind === '^') {
    const upper = major > 0
      ? { nums: [major + 1, 0, 0], pre: '' }
      : minor > 0
        ? { nums: [0, minor + 1, 0], pre: '' }
        : { nums: [0, 0, patch + 1], pre: '' }
    const lo = { op: '>=', target: ver }
    const hi = { op: '<', target: fmtUpper(upper) }
    return pre ? [lo, hi] : [lo, hi]
  }
  // '~'
  const upperMinor = { nums: [major, minor + 1, 0], pre: '' }
  return [
    { op: '>=', target: ver },
    { op: '<', target: fmtUpper(upperMinor) },
  ]
}

function fmtUpper(u) {
  return `${u.nums[0]}.${u.nums[1]}.${u.nums[2]}`
}

const OP_RE = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/

/**
 * 判断 version 是否满足 range（npm 语义子集）。
 * 候选带 prerelease 时：仅当 range 内存在同元组且带 prerelease 的比较器才放行。
 */
export function satisfies(version, range) {
  if (version == null || version === '') return false
  if (range == null) return true
  const r = String(range).trim()
  if (!r || r === '*' || r === 'x' || r === 'X') return true

  const candidate = parseVersion(version)
  if (!candidate) return false
  const candTuple = preTuple(candidate)

  // 一个比较器组（空格/逗号分隔 = AND），整体为 true 才算组通过
  const evalGroup = (groupText) => {
    const parts = groupText.split(/[\s,]+/).filter(Boolean)
    if (!parts.length) return true
    const comparators = []
    let rangeHasPrerelease = false
    for (const part of parts) {
      const m = part.match(OP_RE)
      if (!m) return false // 无法解析的段 → 组不通过（宁可告警）
      let op = m[1] || '='
      let targetRaw = m[2]
      if (op === '^' || op === '~') {
        const expanded = expandCaretTilde(targetRaw, op)
        if (!expanded) return false
        for (const c of expanded) {
          const tv = parseVersion(c.target)
          if (tv?.pre) rangeHasPrerelease = true
          comparators.push(c)
        }
        continue
      }
      // 兼容 '=1.2.3' 写法：'=' + target；target 可能形如 '1.2.3-rc.1'
      if (targetRaw.startsWith('=')) {
        op = '='
        targetRaw = targetRaw.slice(1)
      }
      const tv = parseVersion(targetRaw)
      if (!tv) return false
      if (tv.pre) rangeHasPrerelease = true
      comparators.push({ op, target: targetRaw })
    }
    // npm prerelease 规则
    if (candidate.pre && !rangeHasPrerelease) return false
    if (candidate.pre && rangeHasPrerelease) {
      const sameTuple = comparators.some((c) => {
        const t = parseVersion(c.target)
        return !!t?.pre && preTuple(t) === candTuple
      })
      if (!sameTuple) return false
    }
    return comparators.every((c) => evalComparator(version, c.op, c.target))
  }

  return r.split('||').some((g) => evalGroup(g))
}

/** 生成可执行的钉版本建议命令。 */
export function pinFix(peer, declared, profileDir) {
  const scope = profileDir ? ` --dir "${profileDir}"` : ''
  return `pnpm${scope} add ${peer}@${declared}`
}

// ---------- 编排：bundle × peerDependencies ----------

/**
 * 启动前体检：核对一批 bundle 声明的 peerDependencies 与实际解析版本。
 * @param {string} profileDir
 * @param {string[]} bundleSpecs  包名列表（通常 = profile package.json dependencies）
 * @param {object} [opts] 注入项（单测用）
 * @returns {{findings:object[], summary:{checked:number,ok:number,error:number,warn:number}}}
 */
export function preflightBundles(profileDir, bundleSpecs, opts = {}) {
  const {
    resolveBundleRoot,
    readBundlePkg,
    resolvePeerVersion,
  } = opts
  const findings = []
  const add = (level, f) => findings.push({ level, ...f })
  const summary = { checked: 0, ok: 0, error: 0, warn: 0 }
  for (const spec of bundleSpecs ?? []) {
    let root = null
    if (resolveBundleRoot) root = resolveBundleRoot(spec)
    else root = resolvePkgRootSafe(spec, profileDir)
    if (!root) {
      add('warn', { bundle: spec, detail: 'bundle 不可解析（本地缺失或非目录包）——跳过' })
      summary.warn++
      continue
    }
    let pkg = null
    if (readBundlePkg) pkg = readBundlePkg(root)
    else {
      try { pkg = JSON.parse(fsRead(`${root}/package.json`)) } catch { pkg = null }
    }
    if (!pkg) { add('warn', { bundle: spec, detail: 'bundle package.json 不可读' }); summary.warn++; continue }
    const peers = pkg.peerDependencies
    if (!peers || !Object.keys(peers).length) continue
    for (const [peer, declared] of Object.entries(peers)) {
      summary.checked++
      const declaredStr = String(declared)
      if (/^(github|git|file:|link:|workspace:|http)/.test(declaredStr) || !/\d/.test(declaredStr)) {
        add('warn', { bundle: spec, peer, declared: declaredStr, resolved: null, detail: 'peer 区间非 semver（git/url/未带版本），跳过' })
        summary.warn++
        continue
      }
      let resolved = null
      if (resolvePeerVersion) resolved = resolvePeerVersion(peer)
      else resolved = peerVersionSafe(peer, profileDir)
      if (!resolved) {
        add('error', {
          bundle: spec, peer, declared: declaredStr, resolved: null,
          detail: `peer "${peer}" 无法在 profile 中解析到实体（本地缺失，Node 可能爬升到全局 CLI 或直接 MODULE_NOT_FOUND）`,
          fix: pinFix(peer, declaredStr, profileDir),
        })
        summary.error++
        continue
      }
      if (satisfies(resolved, declaredStr)) {
        add('ok', { bundle: spec, peer, declared: declaredStr, resolved })
        summary.ok++
      } else {
        add('error', {
          bundle: spec, peer, declared: declaredStr, resolved,
          detail: `peer 版本越界：期望 ${declaredStr}，实际解析 ${resolved}（API 漂移温床，启动期可能报 export 缺失）`,
          fix: pinFix(peer, declaredStr, profileDir),
        })
        summary.error++
      }
    }
  }
  return { findings, summary }
}

// ---- 默认（真实 FS）实现 ----
function fsRead(file) {
  try { return fs.readFileSync(file, 'utf8') } catch { return null }
}

function resolvePkgRootSafe(spec, baseDir) {
  if (!spec || !baseDir) return null
  try {
    const req = createRequire(path.join(baseDir, '__p2m_resolve__.cjs'))
    const resolved = req.resolve(spec)
    let dir = resolved
    for (;;) {
      if (fs.existsSync(path.join(dir, 'package.json'))) return dir
      const parent = path.dirname(dir)
      if (parent === dir) return null
      dir = parent
    }
  } catch { return null }
}

function peerVersionSafe(peer, profileDir) {
  try {
    const req = createRequire(path.join(profileDir, '__p2m_resolve__.cjs'))
    const resolved = req.resolve(peer)
    let dir = resolved
    for (;;) {
      const pkgFile = path.join(dir, 'package.json')
      if (fs.existsSync(pkgFile)) {
        try { return JSON.parse(fs.readFileSync(pkgFile, 'utf8')).version ?? null } catch { return null }
      }
      const parent = path.dirname(dir)
      if (parent === dir) return null
      dir = parent
    }
  } catch { return null }
}
