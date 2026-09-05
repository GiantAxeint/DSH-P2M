// trial.test.mjs — 试用门禁子进程试跑单测（需求 R5）
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runTrial } from '../lib/trial.js'
import { askCrashRisk } from '../lib/dialog.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fx = (name) => path.join(here, 'fixtures', name, 'index.mjs')

test('ok 插件：verdict=ok', async () => {
  const r = await runTrial(fx('ok-plugin'))
  assert.equal(r.verdict, 'ok')
})

test('apply 抛错插件：verdict=crash，且带详情', async () => {
  const r = await runTrial(fx('crash-plugin'))
  assert.equal(r.verdict, 'crash')
  assert.match(r.detail, /simulated crash/)
})

test('永不结束插件：verdict=timeout', async () => {
  const r = await runTrial(fx('hang-plugin'), { timeoutMs: 1500 })
  assert.equal(r.verdict, 'timeout')
})

test('无 apply 模块：verdict=unsupported（无法判定，非 crash）', async () => {
  const r = await runTrial(fx('noapply-plugin'))
  assert.equal(r.verdict, 'unsupported')
})

test('不存在的模块：verdict=crash（视为会崩）', async () => {
  const r = await runTrial(path.join(here, 'fixtures', 'does-not-exist', 'index.mjs'))
  assert.equal(r.verdict, 'crash')
})

test('askCrashRisk：ui=none 或异常时安全默认 cancel（不弹窗）', async () => {
  assert.equal(await askCrashRisk('x', 'detail', { ui: 'none' }), 'cancel')
})
