import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  modelsFromValue, defaultFromValue, modelsForSave, validateModels, pathOpsForDraft, namespaceValue, SETTINGS_NS,
} from '../client/form-logic.js'

test('modelsFromValue starts empty when nothing is configured (no jiuwen aliases)', () => {
  assert.deepEqual(modelsFromValue({}), [])
})

test('modelsFromValue rewrites legacy alias rows to their real model name', () => {
  const value = {
    defaultModel: 'jiuwen-default',
    models: [
      { id: 'jiuwen-default', name: 'Jiuwen Default', modelName: 'doubao-seed-2.0-mini' },
      { id: 'jiuwen-swarm', name: 'Jiuwen Swarm' },
      { id: 'deepseek-v3', name: 'DeepSeek V3' },
    ],
  }
  const rows = modelsFromValue(value)
  assert.deepEqual(rows.map(r => [r.id, r.name]), [['doubao-seed-2.0-mini', ''], ['deepseek-v3', 'DeepSeek V3']])
  assert.equal(defaultFromValue(value, rows), 'doubao-seed-2.0-mini')
  assert.equal(defaultFromValue({ defaultModel: 'gone' }, rows), 'doubao-seed-2.0-mini')
})

test('modelsForSave drops blank rows and fills the display name', () => {
  assert.deepEqual(modelsForSave([{ id: ' m ', name: '' }, { id: '', name: 'x' }]), [{ id: 'm', name: 'm' }])
})

test('validateModels rejects aliases, duplicates, and an empty list', () => {
  assert.equal(validateModels([{ id: 'a' }, { id: 'b' }, { id: '' }]), undefined)
  assert.ok(/at least one/.test(validateModels([{ id: '' }]).message))
  assert.ok(/twice/.test(validateModels([{ id: 'a' }, { id: 'a' }]).message))
  assert.ok(/not a model name/.test(validateModels([{ id: 'jiuwen-default' }]).message))
})

test('pathOpsForDraft emits set/unset for changed fields only', () => {
  const ops = pathOpsForDraft(
    { baseURL: 'https://old.example/v1', defaultModel: 'jiuwen-default' },
    { baseURL: 'https://new.example/v1', defaultModel: 'jiuwen-default', apiKeyEnv: 'JIUWEN_API_KEY', models: [{ id: 'm', name: 'M' }] },
  )
  const keys = ops.map(o => o.path[0])
  assert.ok(keys.includes('baseURL'))
  assert.ok(keys.includes('models'))
  assert.ok(!keys.includes('defaultModel'))
  assert.equal(ops.find(o => o.path[0] === 'baseURL').op, 'set')
})

test('namespaceValue finds the llm-jiuwen section', () => {
  const ns = namespaceValue({ namespaces: [{ ns: 'llm-pi-ai' }, { ns: SETTINGS_NS, value: { baseURL: 'x' }, revision: 3 }] })
  assert.equal(ns.revision, 3)
  assert.equal(ns.value.baseURL, 'x')
})

test('shipped client bundle is a ModuleLoader factory for this package', () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  const src = readFileSync(join(root, 'lib/client.js'), 'utf8')
  assert.match(src, /window\.__ModuleLoader__\.load\(/)
  assert.match(src, /id:\s*"@dsh-jiuwen\/adapter"/)
  assert.match(src, /settings\.models\.provider-card/)
  assert.match(src, /exports\.apply|module\.exports/)
  assert.doesNotMatch(src, /sk-[A-Za-z0-9]{8,}/)
})

test('shipped client bundle renders the Models card (react import survives the build)', () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  const src = readFileSync(join(root, 'lib/client.js'), 'utf8')
  let factory
  const window = { __ModuleLoader__: { load: (m) => { factory = m.factory } } }
  new Function('window', src)(window)
  const calls = []
  const react = {
    createElement: (type, props, ...children) => { calls.push(type); return { type, props, children } },
    useState: (v) => [v, () => {}],
    useEffect: () => {},
  }
  const mod = factory((id) => { if (id === 'react') return react; throw new Error('unexpected require ' + id) })
  let card
  const ctx = {
    slots: {
      inject: (_name, fn) => { for (const v of fn()) void v },
      register: (_opts, component) => { card = component; return () => {} },
    },
    remote: {},
  }
  mod.apply(ctx)
  assert.equal(typeof card, 'function')
  const el = card({ provider: { settingsNs: 'llm-jiuwen' } })
  assert.equal(el.type, mod.JiuwenModelsCard)
  const tree = mod.JiuwenModelsCard({ ctx })
  assert.equal(tree.type, 'div')
  assert.ok(calls.includes('input'))
})
