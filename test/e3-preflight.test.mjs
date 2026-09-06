// e3-preflight.test.mjs — E3 peer 版本合规预检单测
//
// 覆盖：satisfies/compareVersions（^ ~ 区间、AND/OR、prerelease 同元组规则——
// 事件第二幕 0.1.2-alpha.3 ∉ ^0.1.1-rc.2 的判定依据）；preflightBundles 编排
// （ok / 越界 error+fix / 不可解析 error / git 区间 warn / 不可读 bundle warn）。
// 编排用注入式假 FS，零真实磁盘依赖。

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  satisfies,
  compareVersions,
  parseVersion,
  preflightBundles,
} from '../lib/preflight.js'

test('parseVersion：常规 / 缺段 / prerelease / v 前缀', () => {
  assert.deepEqual(parseVersion('1.2.3').nums, [1, 2, 3])
  assert.deepEqual(parseVersion('0.1').nums, [0, 1, 0])
  assert.deepEqual(parseVersion('2').nums, [2, 0, 0])
  assert.equal(parseVersion('0.1.1-rc.2').pre, 'rc.2')
  assert.equal(parseVersion('v0.1.1-rc.2').pre, 'rc.2')
  assert.equal(parseVersion('not-a-version'), null)
})

test('compareVersions：数值段优先、稳定版 > 同元组 prerelease', () => {
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
  assert.equal(compareVersions('0.1.2-alpha.3', '0.1.1-rc.2'), 1)
  assert.equal(compareVersions('0.1.1', '0.1.1-rc.2'), 1, '稳定版大于同元组 prerelease')
  assert.equal(compareVersions('0.1.1-rc.3', '0.1.1-rc.2'), 1)
  assert.equal(compareVersions('0.1.1-alpha.10', '0.1.1-alpha.2'), 1, '数字段按数值比较')
})

test('satisfies：^ / ~ / AND / OR / 通配', () => {
  assert.equal(satisfies('1.2.0', '^1.2.0'), true)
  assert.equal(satisfies('1.9.9', '^1.2.0'), true)
  assert.equal(satisfies('2.0.0', '^1.2.0'), false)
  assert.equal(satisfies('0.2.3', '^0.2.3'), true)
  assert.equal(satisfies('0.3.0', '^0.2.3'), false)
  assert.equal(satisfies('0.0.3', '^0.0.3'), true)
  assert.equal(satisfies('0.0.4', '^0.0.3'), false)
  assert.equal(satisfies('1.3.0', '~1.2.0'), false)
  assert.equal(satisfies('1.2.5', '~1.2.0'), true)
  assert.equal(satisfies('1.9.0', '>=1.0.0 <2.0.0'), true)
  assert.equal(satisfies('2.1.0', '>=1.0.0 <2.0.0'), false)
  assert.equal(satisfies('1.5.0', '1.5.0'), true)
  assert.equal(satisfies('1.5.1', '1.5.0'), false)
  assert.equal(satisfies('1.5.0', '>=1.0.0 || >=3.0.0'), true)
  assert.equal(satisfies('3.2.0', '>=1.0.0 || >=3.0.0'), true)
  assert.equal(satisfies('2.0.0', '>=3.0.0 || >=5.0.0'), false)
  assert.equal(satisfies('9.9.9', '*'), true)
  assert.equal(satisfies('9.9.9', ''), true)
})

test('satisfies：prerelease 同元组规则（事件第二幕判定）', () => {
  // 0.1.2-alpha.3（元组 0.1.2）不该满足 ^0.1.1-rc.2（元组 0.1.1）——npm 语义
  assert.equal(satisfies('0.1.2-alpha.3', '^0.1.1-rc.2'), false, '爬升版本不满足钉住区间')
  assert.equal(satisfies('0.1.1-rc.2', '^0.1.1-rc.2'), true, '钉住的版本自身满足')
  assert.equal(satisfies('0.1.1-rc.5', '^0.1.1-rc.2'), true, '同元组更高 prerelease 满足')
  assert.equal(satisfies('0.1.2-alpha.3', '^0.1.2-alpha.1'), true, '同元组 prerelease 区间内')
  // 稳定候选满足带 prerelease 下界的区间
  assert.equal(satisfies('0.1.1', '>=0.1.1-rc.2'), true)
  assert.equal(satisfies('1.2.0-beta.1', '>=1.0.0'), false, '无 prerelease 的区间不放行 prerelease 候选')
})

// ---------- 编排测试：注入式假环境 ----------
const makeEnv = (bundles, peerVersions) => {
  const roots = {}
  for (const [spec, pkg] of Object.entries(bundles)) roots[spec] = `/v/${spec}`
  return {
    profileDir: '/v/prof',
    bundleSpecs: Object.keys(bundles),
    opts: {
      resolveBundleRoot: (spec) => roots[spec] ?? null,
      readBundlePkg: (root) => {
        const spec = root.split('/').pop()
        return JSON.parse(JSON.stringify(bundles[spec]))
      },
      resolvePeerVersion: (peer) => peerVersions[peer] ?? null,
    },
    roots,
  }
}

test('preflightBundles：合规 → ok；越界 → error + 钉版本 fix', () => {
  const env = makeEnv(
    { 'pkg-a': { name: 'pkg-a', peerDependencies: { 'dep-x': '^1.0.0', 'dep-y': '~2.0.0' } } },
    { 'dep-x': '1.4.0', 'dep-y': '3.0.0' },
  )
  const { findings, summary } = preflightBundles(env.profileDir, env.bundleSpecs, env.opts)
  assert.equal(findings.find((f) => f.peer === 'dep-x').level, 'ok')
  const bad = findings.find((f) => f.peer === 'dep-y')
  assert.equal(bad.level, 'error')
  assert.ok(bad.fix.includes('pnpm') && bad.fix.includes('dep-y@~2.0.0'), 'fix 应给出钉版本命令')
  assert.equal(summary.error, 1)
  assert.equal(summary.ok, 1)
})

test('preflightBundles：peer 不可解析 → error + fix；git 区间 → warn；不可读 bundle → warn', () => {
  const env = makeEnv(
    {
      'pkg-b': { name: 'pkg-b', peerDependencies: { 'ghost-peer': '^0.1.1-rc.2', 'dep-git': 'github:user/repo#main' } },
      'pkg-broken': null, // 不可读
    },
    { 'ghost-peer': null },
  )
  const { findings, summary } = preflightBundles(env.profileDir, env.bundleSpecs, env.opts)
  const unres = findings.find((f) => f.peer === 'ghost-peer')
  assert.equal(unres.level, 'error')
  assert.ok(unres.fix.includes('ghost-peer@^0.1.1-rc.2'))
  assert.equal(findings.find((f) => f.peer === 'dep-git').level, 'warn')
  assert.ok(findings.some((f) => f.bundle === 'pkg-broken' && f.level === 'warn'))
  assert.equal(summary.warn, 2)
  assert.equal(summary.error, 1)
})

test('preflightBundles：无 peer 的 bundle 不计数不产生 finding', () => {
  const env = makeEnv({ 'pkg-nopeers': { name: 'pkg-nopeers' } }, {})
  const { findings, summary } = preflightBundles(env.profileDir, env.bundleSpecs, env.opts)
  assert.equal(findings.length, 0)
  assert.equal(summary.checked, 0)
})
