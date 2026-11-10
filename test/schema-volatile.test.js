// Regression: dsh's schemastery only accepts volatile fields on a fixed
// top-level object path. Wrapping them in intersect([...]) made the real dsh
// loader reject the plugin config, so llm-jiuwen never activated.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { createSettingsConfig } from '../src/schema.js'

function realSchemastery() {
  const roots = [process.env.DSH_NM].filter(Boolean)
  for (const root of roots) {
    try {
      const mod = createRequire(join(root, 'noop.js'))('@deepseek-ai/schemastery')
      return mod?.default || mod?.Schema || mod
    } catch { /* try next */ }
  }
  return undefined
}

test('settings schema keeps volatile fields on a top-level object', () => {
  const calls = []
  const node = (type, extra = {}) => {
    const s = { type, ...extra, meta: {} }
    s.volatile = () => { s.meta.volatile = true; return s }
    s.required = () => s
    s.default = () => s
    s.role = () => s
    return s
  }
  const fake = {
    string: () => node('string'),
    number: () => node('number'),
    array: inner => node('array', { inner }),
    object: dict => { calls.push('object'); return node('object', { dict }) },
    intersect: list => { calls.push('intersect'); return node('intersect', { list }) },
  }
  const schema = createSettingsConfig(fake)
  assert.equal(schema.type, 'object')
  assert.ok(!calls.includes('intersect'))
  for (const key of ['displayName', 'baseURL', 'apiKeyEnv', 'defaultModel', 'models']) {
    assert.equal(schema.dict[key].meta.volatile, true, key)
  }
})

test('settings schema validates under dsh schemastery and keeps extra keys', { skip: !realSchemastery() && 'dsh schemastery not available' }, () => {
  const Schema = realSchemastery()
  const schema = createSettingsConfig(Schema)
  const out = schema({ backend: 'agent-core', gatewayFallback: false, baseURL: 'https://api.example.com/v1', models: [{ id: 'm1' }] })
  assert.equal(out.backend, 'agent-core')
  assert.equal(out.gatewayFallback, false)
})
