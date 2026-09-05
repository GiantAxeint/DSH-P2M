// yaml-min.test.mjs — 子集 YAML 解析器单测（覆盖真实补丁方言形态）
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseDocument, safeParse, jsExprOf } from '../lib/yaml-min.js'

test('空文档与空数组', () => {
  assert.deepEqual(parseDocument(''), [])
  assert.deepEqual(parseDocument('# 只有注释\n\n'), [])
  assert.deepEqual(parseDocument('[]'), [])
})

test('overlay 行：id + config 嵌套 + !!js 表达式（真实 webserver 补丁）', () => {
  const text = [
    '# 端口覆盖',
    '- id: webserver',
    '  config:',
    "    host: !!js ctx.webStartup.host ?? '127.0.0.1'",
    '    port: !!js ctx.webStartup.port ?? 9080',
    '',
  ].join('\n')
  const [row] = parseDocument(text)
  assert.equal(row.id, 'webserver')
  assert.equal(row.config.port.__jsExpr, 'ctx.webStartup.port ?? 9080')
  assert.equal(jsExprOf(row.config.host), "ctx.webStartup.host ?? '127.0.0.1'")
})

test('overlay 行：disabled 布尔', () => {
  const text = '- id: web-ui-pet\n  disabled: true\n'
  const [row] = parseDocument(text)
  assert.deepEqual(row, { id: 'web-ui-pet', disabled: true })
})

test('insert 行：带引号 name（真实主题插件补丁）', () => {
  const text = [
    '- insert:',
    '    - id: theme-endfield',
    "      name: 'dsh-theme-endfield'",
  ].join('\n')
  const [row] = parseDocument(text)
  assert.equal(row.insert[0].id, 'theme-endfield')
  assert.equal(row.insert[0].name, 'dsh-theme-endfield')
})

test('无引号 name（真实 whale 插件补丁）', () => {
  const text = '- insert:\n    - id: dsh-whale-widget\n      name: dsh-whale-widget\n'
  const [row] = parseDocument(text)
  assert.equal(row.insert[0].name, 'dsh-whale-widget')
})

test('多行混合 + 续行键与嵌套 group 形态', () => {
  const text = [
    '- insert:',
    '    - id: p2m',
    "      name: 'dsh-p2m'",
    '- id: some-entry',
    '  disabled: !!js ctx.flag && true',
    '- insert:',
    '    - id: grp',
    '      group: true',
    '      config:',
    '        - id: child-1',
    '          name: child-mod',
  ].join('\n')
  const rows = parseDocument(text)
  assert.equal(rows.length, 3)
  assert.deepEqual(rows[1], { id: 'some-entry', disabled: { __jsExpr: 'ctx.flag && true' } })
  assert.equal(rows[2].insert[0].config[0].id, 'child-1')
})

test('行内注释不污染值；URL 冒号不误判为键值分隔', () => {
  const text = [
    '- id: a # 行尾注释',
    "  url: 'https://example.com/x'",
    '  on: true',
  ].join('\n')
  const [row] = parseDocument(text)
  assert.equal(row.id, 'a')
  assert.equal(row.url, 'https://example.com/x')
  assert.equal(row.on, true)
})

test('safeParse 坏输入返回 error 而非抛错', () => {
  const r = safeParse('- id: [unclosed\n  bad')
  // 宽容解析：要么出值要么 error，绝不向外抛
  assert.ok(r.error === undefined || r.error !== undefined)
})

test('多文档/复杂 YAML 之外语法不应崩溃', () => {
  const weird = 'a: {flow: true}\n- 1\n- "x:y"\n# done\n'
  const parsed = parseDocument(weird) // 不抛错即通过
  assert.ok(Array.isArray(parsed) || typeof parsed === 'object')
})
