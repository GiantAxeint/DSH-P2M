// c7-service-clash.test.mjs — E1 同名服务注册预检（C7）单测
//
// 覆盖：serviceNamesFromSource 三形态识别；scanServiceClashes 双 entry 撞名、
// 一跳依赖包溯源、known-core 告警（含 advice）、disabled 过滤。
// 全部用注入式假 FS（内存 map），零真实磁盘依赖；真实 resolve 行为在
// 真机冒烟时验证（DESIGN §10）。

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  serviceNamesFromSource,
  scanServiceClashes,
  KIND,
} from '../lib/conflicts.js'

test('serviceNamesFromSource：识别 super(ctx) / provide / 静态字面量三形态', () => {
  const src = `
    var A = class extends Service {
      constructor(ctx) {
        super(ctx, 'sessionPersistence');
      }
    };
    ctx.provide('settings', impl);
    this.provide("pet", impl);
    someObj.provide('ignored-dynamic-ok-not-name', impl); // 仅计数无意义，但仍是字面量
    static provide = 'theme';
    const x = super( ctx ,  "dupQuote" );
  `
  const names = serviceNamesFromSource(src)
  assert.ok(names.includes('sessionPersistence'), 'super(ctx, ...) 形态')
  assert.ok(names.includes('settings'), 'ctx.provide 形态')
  assert.ok(names.includes('pet'), 'this.provide 形态')
  assert.ok(names.includes('theme'), '静态字面量形态')
  assert.ok(names.includes('dupQuote'), '带空白的 super( ctx , "…") 形态')
})

test('serviceNamesFromSource：去重、排序、空输入安全', () => {
  assert.deepEqual(serviceNamesFromSource('super(ctx, \'a\'); super(ctx, "a")'), ['a'])
  assert.deepEqual(serviceNamesFromSource(null), [])
  assert.deepEqual(serviceNamesFromSource(''), [])
  assert.deepEqual(serviceNamesFromSource('var n = dynamicName'), [])
})

// ---------- 假 FS ----------
const makeFs = (files, roots) => ({
  files,
  roots,
  opts: {
    baseDir: '/v',
    resolveRoot: (spec) => roots[spec] ?? null,
    listFiles: (root) => Object.keys(files).filter((f) => f.startsWith(root + '/')).sort(),
    readFile: (f) => files[f] ?? '',
  },
})

const clashSourceA = `var A = class extends Service {
  constructor(ctx) { super(ctx, 'sessionPersistence') }
}
`
const clashSourceB = `var B = class extends Service {
  constructor(ctx) { super(ctx, "sessionPersistence") }
}
`

test('C7：两个将启用 entry 注册同名服务 → error 冲突', () => {
  const { files, roots, opts } = makeFs({
    '/v/pkg-a/index.mjs': clashSourceA,
    '/v/pkg-a/package.json': '{"name":"pkg-a","dependencies":{}}',
    '/v/pkg-b/index.mjs': clashSourceB,
    '/v/pkg-b/package.json': '{"name":"pkg-b","dependencies":{}}',
  }, { 'pkg-a': '/v/pkg-a', 'pkg-b': '/v/pkg-b' })
  const found = scanServiceClashes([
    { id: 'entry-a', spec: 'pkg-a' },
    { id: 'entry-b', spec: 'pkg-b' },
  ], opts)
  const hit = found.find((c) => c.kind === KIND.SERVICE_CLASH && c.entryId === 'entry-a/entry-b')
  assert.ok(hit, '应命中双注册冲突')
  assert.equal(hit.severity, 'error')
  assert.ok(hit.detail.includes('sessionPersistence'))
  assert.ok(hit.evidence?.service === 'sessionPersistence')
})

test('C7：同名服务只在一跳依赖包里 → 仍能溯源（事件第三幕形态）', () => {
  const { files, roots, opts } = makeFs({
    // pkg-c 自己源码不含注册字面量，靠依赖 dep-x（基类包）注册 sessionPersistence
    '/v/pkg-c/index.mjs': `var C = class extends Service {
      constructor(ctx) { super(ctx) }
    }
`,
    '/v/pkg-c/package.json': '{"name":"pkg-c","dependencies":{"dep-x":"1.0.0"}}',
    '/v/dep-x/lib/base.mjs': `var Base = class extends Service {
      constructor(ctx) { super(ctx, "sessionPersistence") }
    }
`,
    '/v/dep-x/package.json': '{"name":"dep-x","dependencies":{}}',
    '/v/pkg-b/index.mjs': clashSourceB,
    '/v/pkg-b/package.json': '{"name":"pkg-b","dependencies":{}}',
  }, { 'pkg-c': '/v/pkg-c', 'pkg-b': '/v/pkg-b', 'dep-x': '/v/dep-x' })
  const found = scanServiceClashes([
    { id: 'entry-c', spec: 'pkg-c' },
    { id: 'entry-b', spec: 'pkg-b' },
  ], opts)
  const hit = found.find((c) => c.kind === KIND.SERVICE_CLASH && c.entryId === 'entry-c/entry-b')
  assert.ok(hit, '依赖包溯源应命中')
  assert.equal(hit.evidence.a.source, 'dep:dep-x', '应标注出处为依赖包')
})

test('C7：服务不同 → 不误报', () => {
  const { files, roots, opts } = makeFs({
    '/v/pkg-a/index.mjs': "var A = class extends Service { constructor(ctx){ super(ctx,'pet') } }\n",
    '/v/pkg-a/package.json': '{"name":"pkg-a","dependencies":{}}',
    '/v/pkg-b/index.mjs': "var B = class extends Service { constructor(ctx){ super(ctx,'settings') } }\n",
    '/v/pkg-b/package.json': '{"name":"pkg-b","dependencies":{}}',
  }, { 'pkg-a': '/v/pkg-a', 'pkg-b': '/v/pkg-b' })
  const found = scanServiceClashes([
    { id: 'entry-a', spec: 'pkg-a' },
    { id: 'entry-b', spec: 'pkg-b' },
  ], opts)
  assert.equal(found.filter((c) => c.kind === KIND.SERVICE_CLASH).length, 0)
})

test('C7：known-core 告警（单 entry 也扫）→ warn + 二选一 advice', () => {
  const { files, roots, opts } = makeFs({
    '/v/pkg-rdb/index.mjs': clashSourceA,
    '/v/pkg-rdb/package.json': '{"name":"pkg-rdb","dependencies":{}}',
  }, { 'pkg-rdb': '/v/pkg-rdb' })
  const found = scanServiceClashes(
    [{ id: 'web-ui-session-rdb', spec: 'pkg-rdb' }],
    { ...opts, knownCoreServices: ['sessionPersistence'] },
  )
  const hit = found.find((c) => c.kind === KIND.SERVICE_CLASH && c.entryId === 'web-ui-session-rdb')
  assert.ok(hit, '应命中 known-core 告警')
  assert.equal(hit.severity, 'warn')
  assert.ok(hit.advice.includes('二选一'), 'advice 应含二选一修复建议')
  assert.ok(hit.detail.includes('DSH engine core'))
})

test('C7：默认跳过 disabled entry；includeDisabled 可纳入', () => {
  const mk = () => makeFs({
    '/v/pkg-a/index.mjs': clashSourceA,
    '/v/pkg-a/package.json': '{"name":"pkg-a","dependencies":{}}',
    '/v/pkg-b/index.mjs': clashSourceB,
    '/v/pkg-b/package.json': '{"name":"pkg-b","dependencies":{}}',
  }, { 'pkg-a': '/v/pkg-a', 'pkg-b': '/v/pkg-b' })
  const entries = [
    { id: 'entry-a', spec: 'pkg-a', disabled: true },
    { id: 'entry-b', spec: 'pkg-b', disabled: false },
  ]
  const skipped = scanServiceClashes(entries, mk().opts)
  assert.equal(skipped.filter((c) => c.kind === KIND.SERVICE_CLASH).length, 0, 'disabled 默认不参与')
  const included = scanServiceClashes(entries, { ...mk().opts, includeDisabled: true })
  assert.ok(included.some((c) => c.kind === KIND.SERVICE_CLASH), 'includeDisabled 后应命中')
})
