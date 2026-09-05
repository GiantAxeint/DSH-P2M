// conflicts.test.mjs — 静态/运行期冲突检测 + 崩溃归因单测
import test from 'node:test'
import assert from 'node:assert/strict'
import { scanStatic, scanRuntime, entryIdFromError, KIND } from '../lib/conflicts.js'

const layers = (map) => Object.entries(map).map(([name, text]) => ({ name, text }))

test('C3：跨层同 id 配置互踩（双 overlay 不同意）', () => {
  const found = scanStatic(layers({
    'user-patch': '- id: webserver\n  config:\n    port: 9080\n',
    'plugin-x': '- id: webserver\n  config:\n    port: 9999\n',
  }))
  assert.ok(found.some((c) => c.kind === KIND.CONFIG_CLASH && c.entryId === 'webserver'))
})

test('C3 不误报：同 id 相同配置 → 无冲突', () => {
  const found = scanStatic(layers({
    a: '- id: webserver\n  config:\n    port: 9080\n',
    b: '- id: webserver\n  config:\n    port: 9080\n',
  }))
  assert.equal(found.some((c) => c.kind === KIND.CONFIG_CLASH), false)
})

test('C3：insert 定义被 overlay 改配置 → 提示', () => {
  const found = scanStatic(layers({
    'plugin-a': '- insert:\n    - id: pet\n      name: pet-mod\n',
    'user-patch': '- id: pet\n  disabled: true\n',
  }))
  // disabled 不同属于合法“禁用”意图还是冲突？——定义为提示类 CONFIG_CLASH（warn）
  assert.ok(found.some((c) => c.kind === KIND.CONFIG_CLASH && c.entryId === 'pet'))
})

test('C4：同层重复 id', () => {
  const found = scanStatic(layers({
    bad: '- insert:\n    - id: pet\n      name: a\n    - id: pet\n      name: b\n',
  }))
  assert.ok(found.some((c) => c.kind === KIND.DUP_ID && c.entryId === 'pet'))
})

test('C4 不误报：insert 行本身带 id 不是 overlay 重复', () => {
  // 真实素材：profile patch 的 overlay 行 + theme/whale 各自 insert 行 → 各层独立
  const found = scanStatic(layers({
    'theme': '- insert:\n    - id: theme-endfield\n      name: dsh-theme-endfield\n',
    'whale': '- insert:\n    - id: dsh-whale-widget\n      name: dsh-whale-widget\n',
    'user': '- id: web-ui-pet\n  disabled: true\n',
  }))
  assert.equal(found.length, 0)
})

test('C5：同层不同 id 同名模块', () => {
  const found = scanStatic(layers({
    bad: '- insert:\n    - id: a\n      name: same-mod\n    - id: b\n      name: same-mod\n',
  }))
  assert.ok(found.some((c) => c.kind === KIND.DUP_NAME))
})

test('scanRuntime：C2 自动禁用未持久化 / C6 stale guard / C5 运行期重名', () => {
  const entries = [
    { id: 'good', name: 'good-mod', disabled: false, running: true },
    { id: 'failed', name: 'failed-mod', disabled: true, running: false }, // loader 自动禁用
    { id: 'ghost', name: 'ghost-mod', disabled: false, running: true }, // guard 却禁了它
    { id: 'a', name: 'dup', disabled: false, running: true },
    { id: 'b', name: 'dup', disabled: false, running: true },
  ]
  const found = scanRuntime(entries, ['ghost'])
  assert.ok(found.some((c) => c.kind === KIND.AUTO_DISABLED && c.entryId === 'failed'))
  assert.ok(found.some((c) => c.kind === KIND.SELF_GUARD && c.entryId === 'ghost'))
  assert.ok(found.some((c) => c.kind === KIND.DUP_NAME && c.entryId === 'a/b'))
})

test('scanRuntime：guard 与树一致 → 无冲突', () => {
  const entries = [
    { id: 'off', name: 'off-mod', disabled: true, running: false },
    { id: 'on', name: 'on-mod', disabled: false, running: true },
  ]
  assert.equal(scanRuntime(entries, ['off']).length, 0)
})

test('entryIdFromError：崩溃文本归因（dsh-safe 同协议）', () => {
  assert.equal(
    entryIdFromError('failed to import loader entry web-ui-pet (@linxin666/dsh-web-all): boom'),
    'web-ui-pet'
  )
  assert.equal(entryIdFromError('failed to apply loader entry theme-endfield (dsh-theme-endfield): x'), 'theme-endfield')
  assert.equal(entryIdFromError('something else entirely'), null)
})

test('静态扫描解析失败的层被标记不崩溃', () => {
  const found = scanStatic(layers({
    good: '[]',
    broken: '\t- id: x\n\t  broken',
  }))
  assert.ok(Array.isArray(found))
})
