import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveAgentCoreModel, agentcoreChildEnv } from '../src/jiuwen-env.js'
import {
  unwrapConfig, resolveHostApiKey, childEnvFromKey, fingerprintSecret,
  installHostModelSettings, SETTINGS_NS,
} from '../src/host-model-settings.js'
import { resolveConfig } from '../src/config.js'
import * as plugin from '../index.js'

test('unwrapConfig reads Volatile .get() fields', () => {
  const raw = { baseURL: { get: () => 'https://ui.example/v1' }, keep: 'plain', models: [{ id: 'm' }] }
  const plain = unwrapConfig(raw)
  assert.equal(plain.baseURL, 'https://ui.example/v1')
  assert.equal(plain.keep, 'plain')
  assert.equal(plain.models[0].id, 'm')
})

test('resolveConfig prefers plugin/UI baseURL over JIUWEN_BASE_URL', () => {
  const prev = process.env.JIUWEN_BASE_URL
  process.env.JIUWEN_BASE_URL = 'https://env.example/v1'
  try {
    const cfg = resolveConfig({ baseURL: 'https://ui.example/v1' })
    assert.equal(cfg.baseURL, 'https://ui.example/v1')
  } finally {
    if (prev == null) delete process.env.JIUWEN_BASE_URL
    else process.env.JIUWEN_BASE_URL = prev
  }
})

test('UI-selected model beats AGENTCORE_MODEL', () => {
  const prevAc = process.env.AGENTCORE_MODEL
  const prevHome = process.env.JIUWEN_HOME
  const dir = mkdtempSync(join(tmpdir(), 'jw-ui-model-'))
  mkdirSync(join(dir, 'config'), { recursive: true })
  writeFileSync(join(dir, 'config/.env'), 'MODEL_NAME=from-dotenv\nAPI_BASE=https://dotenv.example/v1\n')
  process.env.JIUWEN_HOME = dir
  process.env.AGENTCORE_MODEL = 'from-env'
  try {
    const m = resolveAgentCoreModel(
      { defaultModel: 'jiuwen-default', baseURL: 'http://127.0.0.1:18080/v1' },
      { model: 'ui-picked-model' },
      {},
    )
    assert.equal(m.model, 'ui-picked-model')
    // Placeholder cfg baseURL still falls back to dotenv.
    assert.equal(m.api_base, 'https://dotenv.example/v1')
  } finally {
    if (prevAc == null) delete process.env.AGENTCORE_MODEL
    else process.env.AGENTCORE_MODEL = prevAc
    if (prevHome == null) delete process.env.JIUWEN_HOME
    else process.env.JIUWEN_HOME = prevHome
    rmSync(dir, { recursive: true, force: true })
  }
})

test('catalog modelName on an alias beats AGENTCORE_MODEL', () => {
  const prevAc = process.env.AGENTCORE_MODEL
  process.env.AGENTCORE_MODEL = 'from-env'
  try {
    const m = resolveAgentCoreModel(
      {
        defaultModel: 'jiuwen-default',
        baseURL: 'https://ui.example/v1',
        models: [{ id: 'jiuwen-default', name: 'Default', modelName: 'doubao-from-ui' }],
      },
      { model: 'jiuwen-default' },
      {},
    )
    assert.equal(m.model, 'doubao-from-ui')
    assert.equal(m.api_base, 'https://ui.example/v1')
  } finally {
    if (prevAc == null) delete process.env.AGENTCORE_MODEL
    else process.env.AGENTCORE_MODEL = prevAc
  }
})

test('UI baseURL beats AGENTCORE_API_BASE and dotenv', () => {
  const prevAc = process.env.AGENTCORE_API_BASE
  const prevHome = process.env.JIUWEN_HOME
  const dir = mkdtempSync(join(tmpdir(), 'jw-ui-base-'))
  mkdirSync(join(dir, 'config'), { recursive: true })
  writeFileSync(join(dir, 'config/.env'), 'API_BASE=https://dotenv.example/v1\n')
  process.env.JIUWEN_HOME = dir
  process.env.AGENTCORE_API_BASE = 'https://env.example/v1'
  try {
    const m = resolveAgentCoreModel(
      { defaultModel: 'm', baseURL: 'https://ui.example/v1' },
      { model: 'm' },
      {},
    )
    assert.equal(m.api_base, 'https://ui.example/v1')
  } finally {
    if (prevAc == null) delete process.env.AGENTCORE_API_BASE
    else process.env.AGENTCORE_API_BASE = prevAc
    if (prevHome == null) delete process.env.JIUWEN_HOME
    else process.env.JIUWEN_HOME = prevHome
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveHostApiKey prefers credentials.resolve over cfg.apiKey', async () => {
  const ctx = { get: (n) => (n === 'credentials' ? { resolve: async () => ({ value: 'from-store' }) } : undefined) }
  const key = await resolveHostApiKey(ctx, { apiKeyEnv: 'JIUWEN_API_KEY', apiKey: 'from-cfg' })
  assert.equal(key, 'from-store')
  const fallback = await resolveHostApiKey({ get: () => undefined }, { apiKey: 'from-cfg' })
  assert.equal(fallback, 'from-cfg')
})

test('childEnvFromKey writes JIUWEN_API_KEY and custom ref, never used as a log helper', () => {
  const env = childEnvFromKey('secret-value', 'MY_KEY')
  assert.equal(env.JIUWEN_API_KEY, 'secret-value')
  assert.equal(env.API_KEY, 'secret-value')
  assert.equal(env.MY_KEY, 'secret-value')
  const fp = fingerprintSecret('secret-value')
  assert.equal(fp.length, 16)
  assert.notEqual(fp, 'secret-value')
})

test('installHostModelSettings registers a configurable provider and configures settings', () => {
  const entries = []
  const configured = []
  const ctx = {
    fiber: { entry: { options: { id: SETTINGS_NS } } },
    llm: {
      registerConfigurableProviders(list) {
        entries.push(...list)
        return () => { entries.length = 0 }
      },
    },
    inject(deps, cb) {
      assert.deepEqual(deps, ['settings'])
      cb({
        settings: { configure: (opts, fiber) => { configured.push({ opts, fiber }); return () => {} } },
        effect: (fn) => { const off = fn(); if (typeof off === 'function') configured.push({ effectOff: true }) },
      })
    },
    get() {},
  }
  const inst = installHostModelSettings({
    ctx,
    readConfig: () => ({ provider: 'jiuwen', displayName: 'JiuwenSwarm', apiKeyEnv: 'JIUWEN_API_KEY' }),
    logger: { debug() {} },
  })
  assert.equal(inst.settingsNs, SETTINGS_NS)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].provider, 'jiuwen')
  assert.equal(entries[0].settingsNs, SETTINGS_NS)
  assert.deepEqual(entries[0].settingsPath, [])
  assert.equal(entries[0].nativeAuth.oauth, false)
  assert.ok(entries[0].nativeAuth.env.includes('JIUWEN_API_KEY'))
  assert.ok(configured.length >= 1)
  assert.equal(configured[0].opts.auto, false)
  inst.dispose()
  assert.equal(entries.length, 0)
})

test('plugin apply still works when settings/configurable-providers are absent (compat)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jw-ui-plugin-'))
  const adapters = new Map()
  const ctx = {
    llm: { registerAdapter(ids, a) { ids.forEach(i => adapters.set(i, a)); return () => {} } },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    provide(n, v) { this[n] = v },
    get() {},
    on() { return () => {} },
    inject(_deps, cb) { cb({ commands: { register() { return () => {} } }, on() {} }) },
  }
  assert.doesNotThrow(() => plugin.apply(ctx, {
    backend: 'agent-core',
    hostSync: false,
    sessionSync: false,
    planBridge: false,
    mappingPath: join(dir, 'map.json'),
  }))
  assert.ok(adapters.has('jiuwen'))
  rmSync(dir, { recursive: true, force: true })
})

test('resolveChildEnv injects a credential into the sidecar env bag', async () => {
  const ctx = {
    llm: { registerConfigurableProviders() { return () => {} } },
    inject() {},
    get: (n) => (n === 'credentials' ? { resolve: async () => ({ value: 'ui-stored-key' }) } : undefined),
  }
  const inst = installHostModelSettings({
    ctx,
    readConfig: () => ({ apiKeyEnv: 'JIUWEN_API_KEY' }),
    logger: { debug() {} },
  })
  const extra = await inst.resolveChildEnv()
  assert.equal(extra.JIUWEN_API_KEY, 'ui-stored-key')
  assert.equal(extra.API_KEY, 'ui-stored-key')
  // agentcoreChildEnv must forward the injected key
  const prev = process.env.JIUWEN_API_KEY
  process.env.JIUWEN_API_KEY = 'from-process-env'
  try {
    const child = agentcoreChildEnv(extra)
    assert.equal(child.JIUWEN_API_KEY, 'ui-stored-key')
  } finally {
    if (prev == null) delete process.env.JIUWEN_API_KEY
    else process.env.JIUWEN_API_KEY = prev
  }
  inst.dispose()
})
