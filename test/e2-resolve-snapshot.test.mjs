// e2-resolve-snapshot.test.mjs — E2 解析路径留痕单测
//
// 覆盖：isInsideProfile 落点判定（profile 内/全局爬升/异盘）；buildResolveSnapshot
// 组装（注入 resolve/versionAt，unresolved 处理）；driftReport 前后漂移 diff。
// 全部纯函数 + 注入，无真实磁盘依赖。

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { isInsideProfile, buildResolveSnapshot, driftReport } from '../lib/state.js'

const sep = path.sep

test('isInsideProfile：profile 内 = true，全局爬升/异盘 = false', () => {
  const profile = path.join('C:', sep, 'Users', 'me', '.dsh', 'profiles', 'web')
  assert.equal(isInsideProfile(path.join(profile, 'node_modules', 'x', 'lib', 'index.js'), profile), true)
  assert.equal(isInsideProfile(path.join(profile, 'node_modules', 'dsh-p2m'), profile), true)
  assert.equal(isInsideProfile(profile, profile), true, 'profile 自身算内')
  // 全局 CLI 爬升落点（事件第二幕形态）
  assert.equal(isInsideProfile(path.join('C:', sep, 'Users', 'me', 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh-settings'), profile), false)
  // 异盘
  assert.equal(isInsideProfile(path.join('D:', sep, 'elsewhere', 'x.js'), profile), false)
  assert.equal(isInsideProfile(null, profile), false)
  assert.equal(isInsideProfile('/x', null), false)
})

test('buildResolveSnapshot：解析本地 → local=true 且带版本；unresolved → null', () => {
  const profile = path.join('C:', sep, 'prof', 'web')
  const snap = buildResolveSnapshot(
    [
      { id: 'p2m', spec: 'dsh-p2m' },
      { id: 'lost', spec: 'ghost-module' },
    ],
    {
      baseDir: profile,
      profileDir: profile,
      resolve: (spec) => spec === 'ghost-module' ? (() => { throw new Error('MODULE_NOT_FOUND') })() : path.join(profile, 'node_modules', spec, 'lib', 'index.js'),
      versionAt: (file) => (file.includes('ghost') ? null : '0.1.3'),
    },
  )
  const p2m = snap.entries.find((e) => e.entryId === 'p2m')
  const lost = snap.entries.find((e) => e.entryId === 'lost')
  assert.equal(p2m.local, true)
  assert.equal(p2m.version, '0.1.3')
  assert.ok(p2m.resolved.endsWith('index.js'))
  assert.equal(lost.resolved, null)
  assert.equal(lost.local, false, 'unresolved 一律视作漂移候选')
  assert.equal(lost.version, null)
})

test('buildResolveSnapshot：爬升到全局 → local=false（事件第二幕判别）', () => {
  const profile = path.join('C:', sep, 'prof', 'web')
  const globalPkg = path.join('C:', sep, 'Users', 'me', 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh-settings', 'lib', 'index.js')
  const snap = buildResolveSnapshot([{ id: 'x', spec: '@deepseek-ai/dsh-settings' }], {
    baseDir: profile,
    profileDir: profile,
    resolve: () => globalPkg,
    versionAt: () => '0.1.2-alpha.3',
  })
  assert.equal(snap.entries[0].local, false, '应识别“爬升到全局 CLI”')
  assert.equal(snap.entries[0].version, '0.1.2-alpha.3')
})

test('driftReport：解析落点从本地漂移到全局 → 检出 local 变化', () => {
  const profile = path.join('C:', sep, 'prof', 'web')
  const localFile = path.join(profile, 'node_modules', '@deepseek-ai', 'dsh-settings', 'lib', 'index.js')
  const globalFile = path.join('C:', sep, 'Users', 'me', 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh-settings', 'lib', 'index.js')
  const mk = (file, ver) => buildResolveSnapshot([{ id: 'x', spec: '@deepseek-ai/dsh-settings' }], {
    baseDir: profile, profileDir: profile,
    resolve: () => file, versionAt: () => ver,
  })
  const drift = driftReport(mk(localFile, '0.1.1-rc.2'), mk(globalFile, '0.1.2-alpha.3'))
  assert.equal(drift.length, 1)
  const changes = drift[0].changes.map((c) => c.field)
  assert.ok(changes.includes('local'), '应检出 local:true→false')
  assert.ok(changes.includes('resolved'))
  assert.ok(changes.includes('version'), '应检出版本变化')
})

test('driftReport：无变化 → 空；新出现 spec → appeared', () => {
  const profile = path.join('C:', sep, 'prof', 'web')
  const mk = (specs) => buildResolveSnapshot(specs, {
    baseDir: profile, profileDir: profile,
    resolve: (s) => path.join(profile, 'node_modules', s, 'index.js'), versionAt: () => '1.0.0',
  })
  assert.equal(driftReport(mk([{ id: 'a', spec: 'pkg-a' }]), mk([{ id: 'a', spec: 'pkg-a' }])).length, 0)
  const appeared = driftReport(mk([{ id: 'a', spec: 'pkg-a' }]), mk([{ id: 'a', spec: 'pkg-a' }, { id: 'b', spec: 'pkg-b' }]))
  assert.equal(appeared.length, 1)
  assert.equal(appeared[0].changes[0].field, 'appeared')
  assert.equal(driftReport(null, mk([])).length, 0)
})
