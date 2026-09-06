// e4-profile-override.test.mjs — E4 profile 层覆盖感知单测
//
// 覆盖：出厂默认 disabled 被用户层覆盖为启用（事件第三幕形态）→ 识别 + 二选一
// advice；合法禁用不误加 advice；双 overlay 分歧 advice；C7 双 entry 撞名 advice。

import test from 'node:test'
import assert from 'node:assert/strict'
import { scanStatic, scanServiceClashes, KIND } from '../lib/conflicts.js'

const layers = (map) => Object.entries(map).map(([name, text]) => ({ name, text }))

test('E4：出厂 disabled:true 被 profile 覆盖为启用 → 识别 + 二选一 advice（事件第三幕形态）', () => {
  const found = scanStatic(layers({
    'web-all(patch)': `
- insert:
    - id: web-ui-session-branch
      name: '@morlay/session-branch'
      disabled: true
    - id: web-ui-session-rdb
      name: '@morlay/session-rdb'
      disabled: true
`,
    'profile patch': `
- id: web-ui-session-branch
  disabled: false
- id: web-ui-session-rdb
  disabled: false
`,
  }))
  const hit = found.find((c) => c.kind === KIND.CONFIG_CLASH && c.entryId === 'web-ui-session-rdb')
  assert.ok(hit, '应命中 C3 覆盖冲突')
  assert.ok(hit.detail.includes('出厂默认 disabled'), 'detail 应点明出厂默认被覆盖')
  assert.ok(hit.advice.includes('二选一'), 'advice 应含二选一')
  assert.ok(hit.advice.includes('disabled: true'), 'advice 应给具体修复动作')
})

test('E4：把出厂条目改为 disabled:true（合法禁用意图）→ 不配 advice', () => {
  const found = scanStatic(layers({
    'bundle': '- insert:\n    - id: pet\n      name: pet-mod\n',
    'profile': '- id: pet\n  disabled: true\n',
  }))
  const hit = found.find((c) => c.kind === KIND.CONFIG_CLASH && c.entryId === 'pet')
  assert.ok(hit, '合法禁用仍按 C3 提示类报告（既有语义）')
  assert.equal(hit.advice, null, '禁用意图不应配二选一 advice')
})

test('E4：双 overlay 不同意 → 统一值/禁一方 advice', () => {
  const found = scanStatic(layers({
    'a': '- id: webserver\n  config:\n    port: 9080\n',
    'b': '- id: webserver\n  config:\n    port: 9999\n',
  }))
  const hit = found.find((c) => c.kind === KIND.CONFIG_CLASH && c.entryId === 'webserver')
  assert.ok(hit)
  assert.ok(hit.advice.includes('二选一'))
})

test('E4：C7 双 entry 撞名 → advice 含“二选一/禁一方”', () => {
  const files = {
    '/v/pkg-a/index.mjs': "var A = class extends Service { constructor(ctx){ super(ctx,'pet') } }\n",
    '/v/pkg-a/package.json': '{"name":"pkg-a","dependencies":{}}',
    '/v/pkg-b/index.mjs': "var B = class extends Service { constructor(ctx){ super(ctx,'pet') } }\n",
    '/v/pkg-b/package.json': '{"name":"pkg-b","dependencies":{}}',
  }
  const found = scanServiceClashes(
    [{ id: 'a', spec: 'pkg-a' }, { id: 'b', spec: 'pkg-b' }],
    {
      baseDir: '/v',
      resolveRoot: (s) => ({ 'pkg-a': '/v/pkg-a', 'pkg-b': '/v/pkg-b' })[s] ?? null,
      listFiles: (root) => Object.keys(files).filter((f) => f.startsWith(root + '/')).sort(),
      readFile: (f) => files[f] ?? '',
    },
  )
  const hit = found.find((c) => c.kind === KIND.SERVICE_CLASH)
  assert.ok(hit)
  assert.ok(hit.advice.includes('二选一'), 'C7 error 也应配修复建议')
})

test('E4：同文件 insert + overlay 同 id 是合法习语 → 不再误报 C4（web-all 形态）', () => {
  const found = scanStatic(layers({
    'web-all(patch)': `
- insert:
    - id: web-ui-session-rdb
      name: '@morlay/session-rdb'
      disabled: true
- id: web-ui-session-rdb
  disabled: true
`,
  }))
  assert.equal(found.filter((c) => c.kind === KIND.DUP_ID).length, 0, 'insert+overlay 同现不算重复 id')
  // 但同一文件两个 overlay 改同一 id → 仍是 C4
  const dupOverlay = scanStatic(layers({
    bad: '- id: x\n  config: { a: 1 }\n- id: x\n  config: { a: 2 }\n',
  }))
  assert.ok(dupOverlay.some((c) => c.kind === KIND.DUP_ID && c.entryId === 'x'))
})
