// ledger.test.mjs — 使用时长台账单测：结算口径 / 崩溃丢失边界 / 排序依据
import test from 'node:test'
import assert from 'node:assert/strict'
import { tick, usageMsOf } from '../lib/ledger.js'

test('tick 基本累积：连续运行按间隔累加', () => {
  const t0 = 1000
  let entries = {}
  entries = tick(entries, ['a'], t0) // a 从 t0 开账
  entries = tick(entries, ['a'], t0 + 5000) // 结算 5s 再开账
  entries = tick(entries, [], t0 + 7000) // a 停了，再结算 2s
  assert.equal(usageMsOf(entries, 'a'), 7000)
  assert.equal(entries.a.runningSince, null)
})

test('运行中断断续续不重复计', () => {
  let entries = tick({}, ['b'], 0)
  entries = tick(entries, [], 1000) // 停
  entries = tick(entries, ['b'], 2000) // 再启
  entries = tick(entries, [], 4000) // 停
  assert.equal(usageMsOf(entries, 'b'), 1000 + 2000)
})

test('从未停机的崩溃最多丢失一个采样间隔（口径）', () => {
  // 进程崩溃前最后一次落盘是上一个 tick；本 tick 未及结算即崩 → 丢 ≤ interval
  let entries = tick({}, ['c'], 0)
  entries = tick(entries, ['c'], 30_000)
  assert.equal(usageMsOf(entries, 'c'), 30_000) // 已落盘 30s
  // 崩溃瞬间（35s 时）未跑 tick —— 丢失 5s，符合 DESIGN 5.3 口径
})

test('tick 保留历史 id（不主动删除，保证排序稳定）', () => {
  let entries = tick({}, ['old'], 0)
  entries = tick(entries, [], 1000)
  entries = tick(entries, ['new'], 2000)
  assert.ok('old' in entries && 'new' in entries)
})

test('usageMsOf 不存在返回 0', () => {
  assert.equal(usageMsOf({}, 'nope'), 0)
})

test('真实业务场景：B 用时超过 C → 排序变化', () => {
  // 模拟：B 持续运行、C 停用 —— 由 priority 测试验证排序结果，
  // 这里验证台账数据能区分两者。
  let entries = tick({}, ['B', 'C'], 0)
  // B 继续跑 12 小时，C 中途停止
  for (let t = 30_000; t <= 30_000 * 1440; t += 30_000) {
    entries = tick(entries, ['B'], t)
  }
  entries = tick(entries, ['B'], 30_000 * 1440 + 1)
  // 结算：B ≈ 12h，C ≈ 0
  assert.ok(usageMsOf(entries, 'B') > usageMsOf(entries, 'C'))
  assert.ok(Math.abs(usageMsOf(entries, 'B') - 12 * 3600 * 1000) <= 30_000)
})
