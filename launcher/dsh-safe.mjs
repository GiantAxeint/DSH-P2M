// dsh-safe.mjs v2 — crash-safe launcher for DSH (upgraded by DSH-P2M)
//
// Why this file exists / what changed vs v1 (DESIGN §6.4, user decision):
//   v1 (pre-DSH-P2M) decided AND wrote the guard itself on every boot crash.
//   v2 is a PURE BOOT SUPERVISOR: the canonical plugin-guard.yml now lives at
//   <DSH_HOME>/p2m/plugin-guard.yml and is the SINGLE decision surface shared
//   with the p2m (A-plugin) runtime. Rules:
//     1. p2m is the single writer during runtime; this launcher only performs
//        EMERGENCY isolation while booting (p2m cannot run yet — plugins load
//        after the loader, and a crashing plugin can stop the boot entirely).
//     2. Boot crashes are attributed to an entry id, appended to the SAME
//        incidents file p2m reads, and isolated via the same lock+backup
//        protocol used by lib/guard.js (this file re-implements a minimal
//        subset inline so the launcher stays a single distributable file).
//     3. Protected ids (default: p2m itself) are NEVER isolated: if the boot
//        crash names a protected id we give up loudly instead of shooting
//        ourselves in the foot.
//     4. E3 preflight (inlined minimal subset; canonical logic in lib/preflight.js)
//        checks every profile bundle's peerDependencies against the actually
//        resolved versions BEFORE spawning, prints violations with pin commands;
//        set DSH_P2M_PREFLIGHT=block to abort the boot on any violation.
//
// Migration: on first run an old v1 guard next to this file
// (plugin-guard.yml in the same directory) is merged into the canonical file.
//
// Usage:  node dsh-safe.mjs   (or double-click DSH-safe.cmd)

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HOME = os.homedir()
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh')
const STATE_ROOT = path.join(DSH_HOME, 'p2m')
const GUARD_FILE = process.env.DSH_P2M_GUARD_FILE || path.join(STATE_ROOT, 'plugin-guard.yml')
const INCIDENT_FILE = path.join(STATE_ROOT, 'incidents.jsonl')
const LEGACY_GUARD = path.join(__dirname, 'plugin-guard.yml') // v1 file next to launcher
const PROFILE_DIR = path.join(DSH_HOME, 'profiles', process.env.DSH_PROFILE || 'web')
// 日志分级与显示（与 p2m 一致，见 README「日志显示规则」）：[WARNING] 黄 / [ERROR] 红
// NO_COLOR 或非 TTY 时自动退化为无色文本，避免日志文件/管道残留 ANSI 转义码。
const ANSI_OK = process.env.NO_COLOR === undefined && Boolean(process.stderr && process.stderr.isTTY)
const Y = ANSI_OK ? '\x1b[33m' : ''
const R = ANSI_OK ? '\x1b[31m' : ''
const Z = ANSI_OK ? '\x1b[0m' : ''

const BOOT_WAIT_MS = 12000 // 判定 "boot OK" vs "crashed" 的窗口
const MAX_ATTEMPTS = 5
const PROTECTED = new Set((process.env.DSH_P2M_PROTECTED || 'p2m').split(',').map((s) => s.trim()).filter(Boolean))

// ---------- 最小 guard 读写（与 lib/guard.js 同协议；锁+备份，防与 p2m 抢写） ----------
const GUARD_HEADER = [
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

function readGuardIds(file) {
  if (!fs.existsSync(file)) return []
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  const ids = []
  let candidate = null
  for (const line of lines) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const idMatch = t.match(/-?\s*id:\s*([^\s]+)/)
    if (idMatch) { candidate = idMatch[1].trim(); continue }
    if (/disabled:\s*true/.test(t) && candidate) { ids.push(candidate); candidate = null }
  }
  return ids
}

function writeGuard(file, ids) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const body = ids.length ? ids.map((id) => `- id: ${id}\n  disabled: true`).join('\n') : '[]'
  const tmp = path.join(path.dirname(file), `.guard.tmp-${process.pid}`)
  fs.writeFileSync(tmp, GUARD_HEADER + body + '\n', 'utf8')
  fs.renameSync(tmp, file)
}

function withGuardLock(fn) {
  const lock = GUARD_FILE + '.lock'
  const deadline = Date.now() + 15000
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx')
      fs.writeFileSync(fd, String(Date.now()))
      fs.closeSync(fd)
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let stale = false
      try { stale = Date.now() - Number(fs.readFileSync(lock, 'utf8')) > 60_000 } catch { stale = true }
      if (stale) { try { fs.unlinkSync(lock) } catch { /* 等下一次 */ } }
      if (Date.now() > deadline) throw new Error(`guard lock timeout: ${lock}`)
      const pause = new Promise((r) => setTimeout(r, 250))
      // 同步实现里没法 await；用 Atomics.wait 极小概率自旋也够用（250ms 轮询）
      const end = Date.now() + 250
      while (Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
  }
  try { return fn() } finally {
    try { fs.unlinkSync(lock) } catch { /* stale 兜底 */ }
  }
}

function isolate(file, id) {
  return withGuardLock(() => {
    const ids = readGuardIds(file)
    if (ids.includes(id)) return false
    if (fs.existsSync(file)) {
      const bak = `${file}.bak-${Date.now()}`
      fs.copyFileSync(file, bak)
      console.log(`[dsh-safe] guard backup -> ${bak}`)
    }
    writeGuard(file, [...ids, id])
    return true
  })
}

function appendIncident(entry) {
  fs.mkdirSync(path.dirname(INCIDENT_FILE), { recursive: true })
  fs.appendFileSync(INCIDENT_FILE, JSON.stringify({ ts: Date.now(), source: 'launcher', ...entry }) + '\n', 'utf8')
}

// ============ E3 启动前 peer 体检（最小实现，内嵌以保持单文件分发） ============
// 能力对齐 lib/preflight.js 的 satisfies 子集（^ ~ >= <= > < =、AND/OR、prerelease
// 同元组规则）。改动本函数时请同步 lib/preflight.js，避免两处语义漂移。

function pvParse(raw) {
  const m = String(raw ?? '').trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/)
  return m ? { n: [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)], pre: m[4] ?? '' } : null
}
function pvCompare(a, b) {
  const va = pvParse(a); const vb = pvParse(b)
  if (!va || !vb) return NaN
  for (let i = 0; i < 3; i++) if (va.n[i] !== vb.n[i]) return va.n[i] < vb.n[i] ? -1 : 1
  if (va.pre === vb.pre) return 0
  if (!va.pre) return 1
  if (!vb.pre) return -1
  const as = va.pre.split('.'); const bs = vb.pre.split('.')
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    if (as[i] === undefined) return -1
    if (bs[i] === undefined) return 1
    const an = /^\d+$/.test(as[i]); const bn = /^\d+$/.test(bs[i])
    if (an && bn) { const d = Number(as[i]) - Number(bs[i]); if (d) return d < 0 ? -1 : 1 }
    else if (an !== bn) return an ? -1 : 1
    else if (as[i] !== bs[i]) return as[i] < bs[i] ? -1 : 1
  }
  return 0
}
function evCmp(version, op, target) {
  const c = pvCompare(version, target)
  if (Number.isNaN(c)) return false
  if (op === '>') return c > 0
  if (op === '>=') return c >= 0
  if (op === '<') return c < 0
  if (op === '<=') return c <= 0
  return c === 0
}
function satisfiesMini(version, range) {
  const r = String(range ?? '').trim()
  if (!r || r === '*') return true
  const cand = pvParse(version)
  if (!cand) return false
  const evalGroup = (group) => {
    const parts = group.split(/[\s,]+/).filter(Boolean)
    if (!parts.length) return true
    const comparators = []
    let rangeHasPre = false
    for (const part of parts) {
      const m = part.match(/^(>=|<=|>|<|=|\^|~)?\s*(.+)$/)
      if (!m) return false
      let op = m[1] || '='; let t = m[2]
      if (op === '^' || op === '~') {
        const tv = pvParse(t)
        if (!tv) return false
        const [mj, mn, pt] = tv.n
        const upper = op === '^'
          ? (mj > 0 ? `${mj + 1}.0.0` : mn > 0 ? `0.${mn + 1}.0` : `0.0.${pt + 1}`)
          : `${mj}.${mn + 1}.0`
        if (tv.pre) rangeHasPre = true
        comparators.push({ op: '>=', target: t }, { op: '<', target: upper })
        continue
      }
      if (t.startsWith('=')) { op = '='; t = t.slice(1) }
      const tv = pvParse(t)
      if (!tv) return false
      if (tv.pre) rangeHasPre = true
      comparators.push({ op, target: t })
    }
    if (cand.pre && !rangeHasPre) return false
    if (cand.pre && rangeHasPre) {
      const tuple = `${cand.n[0]}.${cand.n[1]}.${cand.n[2]}`
      const same = comparators.some((c) => {
        const t = pvParse(c.target)
        return !!t?.pre && `${t.n[0]}.${t.n[1]}.${t.n[2]}` === tuple
      })
      if (!same) return false
    }
    return comparators.every((c) => evCmp(version, c.op, c.target))
  }
  return String(range).split('||').some((g) => evalGroup(g))
}

function preflightProfile() {
  const profilePkgFile = path.join(PROFILE_DIR, 'package.json')
  if (!fs.existsSync(profilePkgFile)) return { findings: [], summary: { checked: 0, ok: 0, error: 0, warn: 0 } }
  let deps = {}
  try { deps = JSON.parse(fs.readFileSync(profilePkgFile, 'utf8')).dependencies ?? {} } catch { return { findings: [], summary: { checked: 0, ok: 0, error: 0, warn: 0 } } }
  const req = createRequire(path.join(PROFILE_DIR, '__p2m_resolve__.cjs'))
  const findings = []
  const summary = { checked: 0, ok: 0, error: 0, warn: 0 }
  // 解析 spec → {dir, pkg}；不可解析返回 null
  const locatePkg = (spec) => {
    try {
      let file = req.resolve(spec)
      let dir = file
      for (;;) {
        const pf = path.join(dir, 'package.json')
        if (fs.existsSync(pf)) return { dir, pkg: JSON.parse(fs.readFileSync(pf, 'utf8')) }
        const parent = path.dirname(dir)
        if (parent === dir) return null
        dir = parent
      }
    } catch { return null }
  }
  for (const [spec] of Object.entries(deps)) {
    const bundle = locatePkg(spec)
    if (!bundle?.pkg?.peerDependencies) continue
    for (const [peer, declared] of Object.entries(bundle.pkg.peerDependencies)) {
      const d = String(declared)
      if (/^(github|git|file:|link:|workspace:|http)/.test(d) || !/\d/.test(d)) continue
      const actual = locatePkg(peer)
      summary.checked++
      const resolved = actual?.pkg?.version ?? null
      if (!resolved) {
        findings.push({ level: 'error', bundle: spec, peer, declared: d, resolved: null, fix: `pnpm --dir "${PROFILE_DIR}" add ${peer}@${d}` })
        summary.error++
      } else if (satisfiesMini(resolved, d)) {
        summary.ok++
      } else {
        findings.push({ level: 'error', bundle: spec, peer, declared: d, resolved, fix: `pnpm --dir "${PROFILE_DIR}" add ${peer}@${d}` })
        summary.error++
      }
    }
  }
  return { findings, summary }
}

function migrateLegacyIfNeeded() {
  if (!fs.existsSync(LEGACY_GUARD)) return
  const legacy = readGuardIds(LEGACY_GUARD)
  if (!legacy.length) return
  const canonical = fs.existsSync(GUARD_FILE) ? readGuardIds(GUARD_FILE) : []
  if (canonical.length) return
  writeGuard(GUARD_FILE, legacy)
  console.log(`[dsh-safe] migrated legacy guard (${legacy.length} disabled) -> ${GUARD_FILE}`)
}

// ---------- boot 监督 ----------
function extractEntryId(errText) {
  const m = errText.match(/failed to (?:import|apply) loader entry ([^\s(]+)/)
  return m ? m[1].trim() : null
}

function bootOnce() {
  return new Promise((resolve) => {
    const appdata = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming')
    const dshCmd = path.join(appdata, 'npm', 'dsh.cmd')
    // NOTE: `web` 子命令拒绝父级启动器选项，必须用 `--profile web` + `--patch`
    // 的 launcher 选项形式；web 自身 flag（--port）放在所有 launcher 选项之后。
    const args = ['/c', dshCmd, '--profile', 'web', '--patch', GUARD_FILE, '--port', '9080']
    const child = spawn('cmd', args, { stdio: ['inherit', 'inherit', 'pipe'], windowsHide: false })
    let errText = ''
    child.stderr.on('data', (d) => { errText += d.toString() })
    child.on('error', (e) => resolve({ ok: false, err: String(e) }))
    let settled = false
    child.on('exit', (code) => {
      if (!settled) { settled = true; resolve({ ok: false, err: errText, code }) }
    })
    setTimeout(() => {
      if (!settled && child.exitCode === null) {
        settled = true // 还在跑 = 启动成功
        console.log('[dsh-safe] boot OK, dsh is running. Close this window to stop.')
        child.on('exit', () => { console.log('[dsh-safe] dsh exited.'); process.exit(0) })
        child.unref()
      }
    }, BOOT_WAIT_MS)
  })
}

async function main() {
  console.log('[dsh-safe v2] DSH-P2M crash-safe launcher')
  console.log(`[dsh-safe] canonical guard: ${GUARD_FILE}`)
  fs.mkdirSync(STATE_ROOT, { recursive: true })
  migrateLegacyIfNeeded()
  console.log('[dsh-safe] currently disabled plugins:', readGuardIds(GUARD_FILE).length
    ? readGuardIds(GUARD_FILE).join(', ') : '(none)')

  // E3：启动前 peer 体检（默认只报告；DSH_P2M_PREFLIGHT=block 时存在 error 即拒绝启动）
  console.log('[dsh-safe] preflight: checking peerDependencies of profile bundles (E3)...')
  const pre = preflightProfile()
  console.log(`[dsh-safe] preflight: checked ${pre.summary.checked} peers | ok ${pre.summary.ok} | errors ${pre.summary.error}`)
  const preErrors = pre.findings.filter((f) => f.level === 'error')
  for (const f of preErrors) {
    console.warn(`${Y}[WARNING]${Z} [dsh-safe] preflight ✗ ${f.bundle} peer ${f.peer}: declared ${f.declared}, resolved ${f.resolved ?? '(none)'}`)
    console.warn(`    fix: ${f.fix}`)
  }
  if (preErrors.length) {
    console.warn(`${Y}[WARNING]${Z} [dsh-safe] hint: Check the peer ranges declared in ${path.join(PROFILE_DIR, 'package.json')} against the resolved versions above; run the fix command (pnpm --dir "${PROFILE_DIR}" add ...), then restart DSH.`)
  }
  if (process.env.DSH_P2M_PREFLIGHT === 'block' && preErrors.length) {
    appendIncident({
      kind: 'preflight-block',
      entryId: preErrors.map((f) => f.bundle).join(','),
      detail: preErrors.slice(0, 8).map((f) => `${f.bundle} peer ${f.peer}: declared ${f.declared} vs ${f.resolved ?? '(none)'}`).join('; '),
    })
    console.error(`${R}[ERROR]${Z} [dsh-safe] DSH_P2M_PREFLIGHT=block: refusing to start until peer violations are pinned.`)
    console.error(`${R}[ERROR]${Z} [dsh-safe] hint: See ${INCIDENT_FILE} (kind=preflight-block) and the fix commands above; resolve every violation, then restart.`)
    process.exit(1)
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      console.log(`[dsh-safe] reboot attempt ${attempt}...`)
      await new Promise((r) => setTimeout(r, 1500))
    }
    const result = await bootOnce()
    if (result.ok || result.err === '') continue
    const bad = extractEntryId(result.err)
    if (!bad) {
      console.warn(`${Y}[WARNING]${Z} [dsh-safe] boot failed but could not identify the plugin. Error output:`)
      console.warn(result.err.slice(0, 2000))
      console.warn(`${Y}[WARNING]${Z} [dsh-safe] hint: Inspect the error above and ${INCIDENT_FILE}; if it names a plugin, isolate it via p2m or add it to ${GUARD_FILE}.`)
      break
    }
    if (PROTECTED.has(bad)) {
      // 铁律：永不隔离受保护条目（p2m 自身/用户指定核心）。宁可大声失败。
      console.error(`${R}[ERROR]${Z} [dsh-safe] boot crash attributed to PROTECTED entry "${bad}" — refusing to isolate.`)
      console.error('[dsh-safe] error output:')
      console.error(result.err.slice(0, 2000))
      console.error(`${R}[ERROR]${Z} [dsh-safe] hint: A protected entry (DSH core / p2m) crashed DSH. Fix its dependencies inside ${PROFILE_DIR} (see the error above), then restart; it must never be added to ${GUARD_FILE}.`)
      appendIncident({ kind: 'boot-crash-protected', entryId: bad, attempt, protected: true })
      break
    }
    if (readGuardIds(GUARD_FILE).includes(bad)) {
      console.warn(`${Y}[WARNING]${Z} [dsh-safe] "${bad}" already disabled but boot still failed; giving up.`)
      console.warn(result.err.slice(0, 2000))
      console.warn(`${Y}[WARNING]${Z} [dsh-safe] hint: Check ${GUARD_FILE} for stale rows and ${INCIDENT_FILE}; the failure may come from another plugin — disable suspects and reboot.`)
      break
    }
    const isolated = isolate(GUARD_FILE, bad)
    appendIncident({
      kind: 'boot-crash', entryId: bad, attempt,
      isolated, detail: result.err.slice(0, 500),
    })
    console.log(`[dsh-safe] emergency-isolated failing plugin: ${bad} (guard + incident logged)`)
    console.log('[dsh-safe] p2m (A-plugin) will reconcile this decision at runtime; remove the row to re-enable.')
  }
}

main()
