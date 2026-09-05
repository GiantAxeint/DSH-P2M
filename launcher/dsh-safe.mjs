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

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HOME = os.homedir()
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh')
const STATE_ROOT = path.join(DSH_HOME, 'p2m')
const GUARD_FILE = process.env.DSH_P2M_GUARD_FILE || path.join(STATE_ROOT, 'plugin-guard.yml')
const INCIDENT_FILE = path.join(STATE_ROOT, 'incidents.jsonl')
const LEGACY_GUARD = path.join(__dirname, 'plugin-guard.yml') // v1 file next to launcher

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

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      console.log(`[dsh-safe] reboot attempt ${attempt}...`)
      await new Promise((r) => setTimeout(r, 1500))
    }
    const result = await bootOnce()
    if (result.ok || result.err === '') continue
    const bad = extractEntryId(result.err)
    if (!bad) {
      console.log('[dsh-safe] boot failed but could not identify the plugin. Error output:')
      console.log(result.err.slice(0, 2000))
      break
    }
    if (PROTECTED.has(bad)) {
      // 铁律：永不隔离受保护条目（p2m 自身/用户指定核心）。宁可大声失败。
      console.error(`[dsh-safe] boot crash attributed to PROTECTED entry "${bad}" — refusing to isolate.`)
      console.error('[dsh-safe] error output:')
      console.error(result.err.slice(0, 2000))
      appendIncident({ kind: 'boot-crash-protected', entryId: bad, attempt, protected: true })
      break
    }
    if (readGuardIds(GUARD_FILE).includes(bad)) {
      console.log(`[dsh-safe] "${bad}" already disabled but boot still failed; giving up.`)
      console.log(result.err.slice(0, 2000))
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
