// priority.test.mjs — 分层与动态排序单测（核心要求 3/4）
import test from 'node:test'
import assert from 'node:assert/strict'
import { tierOf, orderEntries, pickLoser, TIER, isProtected } from '../lib/priority.js'

const self = { entryId: 'p2m', packageName: 'dsh-p2m' }
const core = { namePrefixes: ['@deepseek-ai/'], entryIds: ['webserver'] }

test('tierOf 分层：core / self / other', () => {
  assert.equal(tierOf({ id: 'webserver', name: '@deepseek-ai/dsh-base' }, self, core), TIER.CORE)
  assert.equal(tierOf({ id: 'web-ui-pet', name: '@linxin666/dsh-web-all' }, self, core), TIER.OTHER)
  assert.equal(tierOf({ id: 'p2m', name: 'dsh-p2m' }, self, core), TIER.SELF)
  assert.equal(tierOf({ id: 'x', name: '@deepseek-ai/dsh-web-app' }, self, core), TIER.CORE)
  assert.equal(isProtected(TIER.CORE), true)
  assert.equal(isProtected(TIER.SELF), true)
  assert.equal(isProtected(TIER.OTHER), false)
})

test('orderEntries：DSH > A 插件 > 其他(按 usage 降序)，tier0 保序', () => {
  const entries = [
    { id: 'theme-endfield', name: 'dsh-theme-endfield' },
    { id: 'web-ui-pet', name: '@linxin666/dsh-web-all' },
    { id: 'core-b', name: '@deepseek-ai/dsh-web-app' },
    { id: 'p2m', name: 'dsh-p2m' },
    { id: 'core-a', name: '@deepseek-ai/dsh-base' },
  ]
  const ledger = {
    'theme-endfield': { cumulativeMs: 5_000 },
    'web-ui-pet': { cumulativeMs: 20_000 },
    'p2m': { cumulativeMs: 0 },
    'core-a': { cumulativeMs: 9_999_999 },
  }
  const ranked = orderEntries(entries, ledger, self, core)
  assert.deepEqual(ranked.map((e) => e.id), [
    'core-b', // tier0 保序：输入里 core-b 先于 core-a
    'core-a',
    'p2m', // tier1
    'web-ui-pet', // tier2 usage 20s
    'theme-endfield', // tier2 usage 5s
  ])
  assert.equal(ranked[0].tier, TIER.CORE)
  assert.equal(ranked[2].tier, TIER.SELF)
})

test('orderEntries 动态性：B 时长超 C → B 排到 C 前', () => {
  const entries = [
    { id: 'B', name: 'plugin-b' },
    { id: 'C', name: 'plugin-c' },
  ]
  let ranked = orderEntries(entries, { B: { cumulativeMs: 10 }, C: { cumulativeMs: 50 } }, self, core)
  assert.deepEqual(ranked.map((e) => e.id), ['C', 'B']) // C 更久 → 在前
  ranked = orderEntries(entries, { B: { cumulativeMs: 80 }, C: { cumulativeMs: 50 } }, self, core)
  assert.deepEqual(ranked.map((e) => e.id), ['B', 'C']) // B 反超 → 在前
})

test('orderEntries 同 usage 破平确定（按 id 升序）', () => {
  const entries = [
    { id: 'z', name: 'm' },
    { id: 'a', name: 'm' },
    { id: 'p2m', name: 'dsh-p2m' },
    { id: 'core', name: '@deepseek-ai/x' },
  ]
  const ranked = orderEntries(entries, {}, self, core)
  assert.deepEqual(ranked.map((e) => e.id), ['core', 'p2m', 'a', 'z'])
})

test('pickLoser 永不选 protected，选 usage 最低者', () => {
  const ranked = [
    { id: 'core', name: '@deepseek-ai/x', usageMs: 0 },
    { id: 'p2m', name: 'dsh-p2m', usageMs: 0 },
    { id: 'hot', name: 'hot-plugin', usageMs: 999 },
    { id: 'cold', name: 'cold-plugin', usageMs: 1 },
  ]
  assert.equal(pickLoser(ranked, self, core).id, 'cold')
  // 全 protected → 无人可牺牲
  const onlyProtected = ranked.slice(0, 2)
  assert.equal(pickLoser(onlyProtected, self, core), null)
})
