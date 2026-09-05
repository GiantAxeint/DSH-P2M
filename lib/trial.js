// trial.js — 试用门禁：子进程“试运行”一个插件模块（需求 R5）
//
// 为什么放子进程（DESIGN 13.2）：试跑的目的是“看它会不会崩”，而崩的代价必须
// 只由试跑者承担。子进程里 import + apply，抛错/崩溃/超时都只杀子进程，
// 绝不影响 DSH 主进程。verdict 三态 + unsupported（探针不足，无法判定）。

import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const PROBE_SOURCE = `
// --- p2m trial probe (generated) ---
// 探针 ctx：只提供“不崩”的最小桩。插件若强依赖真服务（ctx.loader 等），
// apply 里拿不到就会抛“缺服务”——probe 捕获后标记为 unsupported 而非 crash。
const noop = () => {}
const logger = () => ({ info: noop, warn: noop, error: noop, debug: noop })
const ctx = {
  logger,
  on: noop, once: noop, before: noop, emit: noop, plugin: noop,
  provide: noop, service: noop,
  root: { logger },
  model: undefined, loader: undefined, registry: undefined,
}
const spec = process.env.P2M_TRIAL_SPEC
const config = process.env.P2M_TRIAL_CONFIG ? JSON.parse(process.env.P2M_TRIAL_CONFIG) : undefined
let mod
try {
  mod = await import(spec)
} catch (e) {
  console.error('[trial] import-failed: ' + (e && e.stack ? e.stack : String(e)))
  process.exit(3) // 3 = import 失败
}
const plugin = mod && (mod.default ?? mod)
const apply = typeof plugin === 'function' ? plugin : plugin && (plugin.apply || plugin.callback)
if (typeof apply !== 'function') {
  console.error('[trial] unsupported: module has no callable apply')
  process.exit(4) // 4 = 无法判定
}
// keep-alive：Node 22 对“悬空 top-level await”会在事件循环空转时强制退出(exit 13)；
// 挂一个定时器句柄才能让“慢但活着”的 apply 真正跑到超时，而不是被误判成 crash。
const keep = setInterval(() => {}, 1000)
try {
  const ret = await apply(ctx, config)
  clearInterval(keep)
  // 插件可能返回 disposer；子进程马上退出即可，无需清理
  void ret
  process.stdout.write('TRIAL_OK\\n')
  process.exit(0)
} catch (e) {
  clearInterval(keep)
  console.error('[trial] apply-failed: ' + (e && e.stack ? e.stack : String(e)))
  process.exit(2) // 2 = apply 抛错（判 crash）
}
`

/**
 * 子进程试跑一个插件模块（绝对路径或 file: URL）。
 * @param {string} modulePath  插件模块绝对路径（.js/.mjs）或 file: URL
 * @param {object} [opts]
 * @param {object} [opts.config]  apply 收到的 config
 * @param {number} [opts.timeoutMs]  超时（默认 15s）
 * @param {string} [opts.nodeBin]    用于试跑的子进程 node（默认 process.execPath）
 * @returns {Promise<{verdict:'ok'|'crash'|'timeout'|'unsupported'|'error', detail:string, exitCode:number|null}>}
 */
export function runTrial(modulePath, { config, timeoutMs = 15_000, nodeBin } = {}) {
  return new Promise((resolve) => {
    const spec = modulePath.startsWith('file:') ? modulePath : pathToFileURL(modulePath).href
    const node = nodeBin || process.execPath
    const child = spawn(node, ['--input-type=module', '-e', PROBE_SOURCE], {
      env: {
        ...process.env,
        P2M_TRIAL_SPEC: spec,
        P2M_TRIAL_CONFIG: config !== undefined ? JSON.stringify(config ?? {}) : '',
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    let settled = false
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { err += d.toString() })
    const done = (verdict, exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        verdict,
        detail: (err || out).trim().slice(0, 1200),
        exitCode,
      })
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已退出 */ }
      done('timeout', null)
    }, timeoutMs)
    child.on('error', () => done('error', null))
    child.on('exit', (code) => {
      if (out.includes('TRIAL_OK')) return done('ok', code)
      if (code === 2 || code === 3) return done('crash', code) // apply/import 抛错 → 视为会崩
      if (code === 4 || code === 0) return done('unsupported', code) // 无法判定
      return done('crash', code)
    })
  })
}
