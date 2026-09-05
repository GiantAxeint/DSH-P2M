// guard.test.mjs — guard 模块单测：读写往返 / 原子写 / 锁互斥 / 迁移
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseGuard, stringifyGuard, mutateGuard, disableEntry, enableEntry, migrateLegacy, readGuard } from '../lib/guard.js'
import { parseDocument } from '../lib/yaml-min.js'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p2m-guard-'))

test('stringifyGuard/parseGuard 往返（空与多行）', () => {
  const empty = stringifyGuard([])
  assert.ok(empty.includes('[]'))
  assert.deepEqual(parseGuard(empty).ids, [])

  const text = stringifyGuard(['a', 'b-c', 'd'])
  assert.deepEqual(parseGuard(text).ids, ['a', 'b-c', 'd'])
  // 且输出可被 yaml-min 按补丁方言再次解析
  const value = parseDocument(text)
  assert.ok(Array.isArray(value))
})

test('parseGuard 兼容真实旧启动器格式（含注释头）', () => {
  const legacy = [
    '# ============================================================',
    '#  Auto-managed by DSH-safe.cmd. Do not edit manually.',
    '# ============================================================',
    '- id: bad-plugin',
    '  disabled: true',
    '',
  ].join('\n')
  assert.deepEqual(parseGuard(legacy).ids, ['bad-plugin'])
})

test('parseGuard 忽略 !!js 表达式（与 dsh-safe 口径一致，不误判为禁用）', () => {
  const text = [
    '- id: web-ui-pet',
    '  disabled: !!js ctx.petOff',
    '- id: plain',
    '  disabled: true',
  ].join('\n')
  const parsed = parseGuard(text)
  assert.deepEqual(parsed.ids, ['plain'])
  assert.deepEqual(parsed.exprs, ['web-ui-pet'])
})

test('mutateGuard 变更才写盘并生成备份；未变更不写', async () => {
  const file = path.join(tmpRoot, 'g1.yml')
  const r1 = await mutateGuard(file, (ids) => [...ids, 'x'])
  assert.equal(r1.changed, true)
  assert.equal(r1.backup, null) // 首次无旧文件
  assert.deepEqual(readGuard(file).ids, ['x'])
  assert.ok(fs.existsSync(file + '.lock') === false)

  const r2 = await mutateGuard(file, (ids) => [...ids]) // 内容不变 → 不写盘
  assert.equal(r2.changed, false)
  assert.equal(r2.backup, null)

  const r3 = await mutateGuard(file, (ids) => [...ids, 'y'])
  assert.equal(r3.changed, true)
  assert.ok(r3.backup && fs.existsSync(r3.backup))
  assert.deepEqual(readGuard(file).ids, ['x', 'y'])
})

test('disableEntry/enableEntry 幂等', async () => {
  const file = path.join(tmpRoot, 'g2.yml')
  await disableEntry(file, 'k1')
  const again = await disableEntry(file, 'k1') // 已存在 → 不写
  assert.equal(again.changed, false)
  assert.deepEqual(readGuard(file).ids, ['k1'])
  await enableEntry(file, 'k1')
  assert.deepEqual(readGuard(file).ids, [])
})

test('并发互斥：锁保证串行且不损坏', async () => {
  const file = path.join(tmpRoot, 'g3.yml')
  await Promise.all(['a', 'b', 'c', 'd'].map((id) => disableEntry(file, id)))
  assert.deepEqual(readGuard(file).ids.sort(), ['a', 'b', 'c', 'd'])
})

test('migrateLegacy：仅 canonical 不存在时迁移', () => {
  const legacy = path.join(tmpRoot, 'legacy-guard.yml')
  fs.writeFileSync(legacy, stringifyGuard(['old1', 'old2']))
  const canonical = path.join(tmpRoot, 'canonical', 'plugin-guard.yml')

  const m1 = migrateLegacy(legacy, canonical)
  assert.equal(m1.migrated, true)
  assert.deepEqual(readGuard(canonical).ids.sort(), ['old1', 'old2'])

  const m2 = migrateLegacy(legacy, canonical) // canonical 已有 → 不再迁移
  assert.equal(m2.migrated, false)
})
