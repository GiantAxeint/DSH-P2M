// util.js — 无依赖通用小工具（原子写文件 / 锁 / JSON 序列化 / 时间）
//
// 为什么独立成模块：guard.js 与 state.js 都要"写文件绝不写一半"，且 p2m 与
// 启动器双进程都要抢同一把锁；把原子写与锁放这里，避免两处各写一遍造成行为漂移。

import fs from 'node:fs'
import path from 'node:path'

export const now = () => Date.now()

/** 排序键后的 JSON 序列化：state/usage 落盘内容稳定，便于人读与 diff。 */
export function stableJson(value, space = 2) {
  return JSON.stringify(sortDeep(value), null, space)
}

export function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key])
    return out
  }
  return value
}

/**
 * 原子写文件：先写同目录临时文件再 rename。
 * 为什么必须原子：若直接写目标文件，写入中途崩溃会留下半截 guard/state，
 * 下次启动解析失败可能误伤 DSH 本体。
 */
export function atomicWriteFile(file, data, { mode } = {}) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${now()}`)
  try {
    fs.writeFileSync(tmp, data, 'utf8')
    if (mode) fs.chmodSync(tmp, mode)
    fs.renameSync(tmp, file)
  } catch (error) {
    try { fs.unlinkSync(tmp) } catch { /* 清理失败可忽略 */ }
    throw error
  }
}

/** JSON 原子写（配套 stableJson）。 */
export function atomicWriteJson(file, value, { mode } = {}) {
  atomicWriteFile(file, stableJson(value), { mode })
}

/**
 * 排它锁：`<file>.lock` 用 'wx' 创建；创建失败说明别人持有。
 * staleMs 后视为死锁可夺锁（进程崩溃会留下孤儿锁，不能永远卡死启动）。
 * fn 在持锁期间执行，最后总是释放。
 */
export async function withLock(lockFile, fn, { staleMs = 60_000, pollMs = 250, timeoutMs = 15_000 } = {}) {
  const deadline = now() + timeoutMs
  for (;;) {
    try {
      const fd = fs.openSync(lockFile, 'wx')
      fs.writeFileSync(fd, String(now()))
      fs.closeSync(fd)
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let stale = false
      try {
        const born = Number(fs.readFileSync(lockFile, 'utf8'))
        stale = Number.isFinite(born) && now() - born > staleMs
      } catch {
        stale = true // 锁文件不可读/已被删 → 直接尝试接管
      }
      if (stale) {
        try { fs.unlinkSync(lockFile) } catch { /* 夺锁失败则继续等 */ }
      }
      if (now() > deadline) throw new Error(`lock timeout: ${lockFile}`)
      await sleep(pollMs)
    }
  }
  try {
    return await fn()
  } finally {
    try { fs.unlinkSync(lockFile) } catch { /* 释放失败可忽略，stale 兜底 */ }
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 错误文本归一化：catch 到的东西未必是 Error。 */
export function errText(error) {
  if (!error) return String(error)
  if (error instanceof Error) return error.message
  return String(error)
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
