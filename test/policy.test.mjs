// policy.test.mjs — 裁决引擎单测：protected 免疫 / autoIsolate 开关 / 裁决矩阵
import test from 'node:test'
import assert from 'node:assert/strict'
import { decide } from '../lib/policy.js'
import { KIND } from '../lib/conflicts.js'
import { TIER, tierOf } from '../lib/priority.js'

const self = { entryId: 'p2m', packageName: 'dsh-p2m' }
const core = { namePrefixes: ['@deepseek-ai/'], entryIds: [] }

// 构造排序上下文：core(0) > p2m(1) > others(usage 降序)
function ctx(others, { autoIsolate = true } = {}) {
  const order = [
    { id: 'core-x', name: '@deepseek-ai/base', tier: TIER.CORE },
    { id: 'p2m', name: 'dsh-p2m', tier: TIER.SELF },
    ...others.map((o, i) => ({
      id: o.id, name: o.name, tier: TIER.OTHER,
      usageMs: o.usageMs ?? 100 - i,
    })),
  ]
  return { order, self, core, cfg: { autoIsolate } }
}

test('C2：第三方被自动禁用 → autoIsolate=true 时隔离进 guard', () => {
  const decision = decide(
    { kind: KIND.AUTO_DISABLED, entryId: 'offender', layers: ['runtime'] },
    ctx([{ id: 'offender', name: 'off-mod', usageMs: 1 }, { id: 'hot', name: 'hot-mod', usageMs: 99 }])
  )
  assert.equal(decision.action, 'isolate')
  assert.equal(decision.loserId, 'offender')
})

test('C2：autoIsolate=false → 只报告', () => {
  const decision = decide(
    { kind: KIND.AUTO_DISABLED, entryId: 'offender', layers: ['runtime'] },
    ctx([{ id: 'offender', name: 'off-mod' }], { autoIsolate: false })
  )
  assert.equal(decision.action, 'report')
  assert.equal(decision.reason.includes('autoIsolate disabled'), true)
})

test('保护铁律：冲突涉及 core 或 p2m → 永不 isolate（C2 也不例外）', () => {
  for (const entryId of ['core-x', 'p2m']) {
    const decision = decide(
      { kind: KIND.AUTO_DISABLED, entryId, layers: ['runtime'] },
      ctx([{ id: 'other', name: 'other-mod' }])
    )
    assert.equal(decision.action, 'report', `id=${entryId} 不应被 isolate`)
    assert.equal(decision.loserId, null)
    assert.equal(decision.reason.includes('protected'), true)
  }
})

test('结构性冲突（C3/C4/C5）永远只报告', () => {
  for (const kind of [KIND.CONFIG_CLASH, KIND.DUP_ID, KIND.DUP_NAME]) {
    const decision = decide(
      { kind, entryId: 'webserver', layers: ['a', 'b'] },
      ctx([{ id: 'webserver', name: 'x-mod' }])
    )
    assert.equal(decision.action, 'report', `kind=${kind} 不应自动隔离`)
    assert.equal(decision.reason.includes('structural'), true)
  }
})

test('offender 已不在树中 → ignore', () => {
  const decision = decide(
    { kind: KIND.AUTO_DISABLED, entryId: 'gone', layers: ['runtime'] },
    ctx([{ id: 'other', name: 'other-mod' }])
  )
  assert.equal(decision.action, 'ignore')
})

test('C1 启动崩溃（启动器写入）同 C2 处理：可 isolate 第三方', () => {
  const decision = decide(
    { kind: KIND.BOOT_CRASH, entryId: 'crashy', layers: ['boot'] },
    ctx([{ id: 'crashy', name: 'crash-mod', usageMs: 0 }, { id: 'used', name: 'used-mod', usageMs: 5 }])
  )
  assert.equal(decision.action, 'isolate')
  assert.equal(decision.loserId, 'crashy')
})

test('tierOf 与 policy 协同：related 为空时保守 report', () => {
  const decision = decide(
    { kind: KIND.SELF_GUARD, entryId: 'mystery', layers: ['runtime'] },
    ctx([{ id: 'other', name: 'other-mod' }])
  )
  assert.equal(decision.action, 'report')
})
