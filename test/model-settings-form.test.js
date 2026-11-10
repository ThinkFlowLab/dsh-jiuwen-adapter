import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  modelsFromValue, validateModels, pathOpsForDraft, namespaceValue, DEFAULT_MODELS, SETTINGS_NS,
} from '../client/form-logic.js'

test('modelsFromValue falls back to the default catalog', () => {
  const models = modelsFromValue({})
  assert.deepEqual(models.map(m => m.id), DEFAULT_MODELS.map(m => m.id))
})

test('validateModels rejects a blank or duplicate id', () => {
  assert.equal(validateModels([{ id: 'a' }, { id: 'b' }]), undefined)
  assert.equal(validateModels([{ id: '' }]).index, 0)
  assert.ok(/twice/.test(validateModels([{ id: 'a' }, { id: 'a' }]).message))
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
