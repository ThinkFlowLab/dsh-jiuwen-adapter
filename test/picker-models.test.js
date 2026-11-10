import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJiuwenAdapter } from '../src/adapter.js'
import { resolveConfig } from '../src/config.js'
import { pickerModels, resolveAliasModel, findCatalogModel, isModelAlias } from '../src/picker-models.js'
import { resolveAgentCoreModel } from '../src/jiuwen-env.js'

/** Isolate env model sources (AGENTCORE_MODEL / MODEL_NAME / Jiuwen dotenv). */
function withEnv(vars, fn) {
  const keys = ['AGENTCORE_MODEL', 'MODEL_NAME', 'JIUWEN_HOME', 'AGENTCORE_FAKE_MODEL']
  const prev = Object.fromEntries(keys.map(k => [k, process.env[k]]))
  const home = mkdtempSync(join(tmpdir(), 'jw-picker-'))
  for (const k of keys) delete process.env[k]
  process.env.JIUWEN_HOME = home // no config/.env inside
  Object.assign(process.env, vars)
  const done = () => {
    for (const k of keys) { if (prev[k] == null) delete process.env[k]; else process.env[k] = prev[k] }
    rmSync(home, { recursive: true, force: true })
  }
  let out
  try { out = fn() } catch (e) { done(); throw e }
  if (out && typeof out.then === 'function') return out.finally(done)
  done()
  return out
}

function acConfig(raw = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jw-picker-map-'))
  return resolveConfig({ mode: 'gateway', backend: 'agent-core', mappingPath: join(dir, 'map.json'), ...raw }, { env: {} })
}

function rig(cfgRef, extra = {}) {
  const sent = []
  const Adapter = createJiuwenAdapter(null, {
    config: () => cfgRef.cfg,
    sessions: {
      ensure: (id) => ({ dshSessionId: id, jiuwenSessionId: id, updatedAt: '', backendOrigin: 'agent-core', turns: 1 }),
      update: () => {},
      recordTurn: () => {},
    },
    logger: { warn() {}, error() {}, info() {}, debug() {} },
    ...extra,
  })
  const a = new Adapter()
  a._agentcoreTransport = () => ({
    async *stream(_request, _mapping, turn) {
      sent.push(turn.model)
      yield { type: 'finish', finishReason: 'stop' }
    },
  })
  return { adapter: a, sent }
}

async function drain(it) { for await (const _ of it) { /* consume */ } }

const turn = (model, sessionId = 's1') => ({ sessionId, model, messages: [{ role: 'user', content: 'hi' }] })

test('picker lists the configured real model names, not jiuwen aliases', () => withEnv({}, async () => {
  const ref = { cfg: acConfig({ models: [{ id: 'doubao-seed-2.0-mini' }, { id: 'deepseek-v3', name: 'DeepSeek V3' }] }) }
  const { adapter } = rig(ref)
  const models = await adapter.listModels('jiuwen')
  assert.deepEqual(models.map(m => m.id), ['doubao-seed-2.0-mini', 'deepseek-v3'])
  assert.deepEqual(models.map(m => m.name), ['doubao-seed-2.0-mini', 'DeepSeek V3'])
  assert.ok(models.every(m => !isModelAlias(m.id)))
  assert.equal(adapter.providerInfo('jiuwen').name, 'JiuwenSwarm')
}))

test('legacy alias rows with modelName are listed under the real name', () => withEnv({}, async () => {
  const ref = { cfg: acConfig({ models: [
    { id: 'jiuwen-default', name: 'Jiuwen Default', modelName: 'doubao-seed-2.0-mini' },
    { id: 'jiuwen-swarm', name: 'Jiuwen Swarm' },
    { id: 'fast', name: 'Fast', modelName: 'doubao-seed-2.0-lite' },
  ] }) }
  const models = await rig(ref).adapter.listModels('jiuwen')
  assert.deepEqual(models.map(m => [m.id, m.name]), [
    ['doubao-seed-2.0-mini', 'doubao-seed-2.0-mini'],
    ['doubao-seed-2.0-lite', 'Fast'],
  ])
}))

test('changing the Settings model list changes the picker on the next listModels', () => withEnv({}, async () => {
  const ref = { cfg: acConfig({ models: [{ id: 'model-a' }] }) }
  const { adapter } = rig(ref)
  assert.deepEqual((await adapter.listModels('jiuwen')).map(m => m.id), ['model-a'])
  ref.cfg = acConfig({ models: [{ id: 'model-a' }, { id: 'model-b' }] })
  assert.deepEqual((await adapter.listModels('jiuwen')).map(m => m.id), ['model-a', 'model-b'])
}))

test('selecting a picker model sends exactly that model to agent-core, and switching mid-session follows', () => withEnv({ AGENTCORE_MODEL: 'env-model' }, async () => {
  const ref = { cfg: acConfig({ models: [{ id: 'doubao-seed-2.0-mini' }, { id: 'deepseek-v3' }], defaultModel: 'doubao-seed-2.0-mini' }) }
  const { adapter, sent } = rig(ref)
  await drain(adapter.stream(turn('deepseek-v3')))
  await drain(adapter.stream(turn('doubao-seed-2.0-mini')))
  assert.deepEqual(sent.map(m => m.model), ['deepseek-v3', 'doubao-seed-2.0-mini'])
}))

test('a picker id that came from a legacy row modelName routes to that model', () => withEnv({ AGENTCORE_MODEL: 'env-model' }, async () => {
  const ref = { cfg: acConfig({ models: [{ id: 'jiuwen-default', modelName: 'doubao-seed-2.0-mini' }] }) }
  const { adapter, sent } = rig(ref)
  await drain(adapter.stream(turn('doubao-seed-2.0-mini')))
  assert.equal(sent[0].model, 'doubao-seed-2.0-mini')
}))

test('legacy jiuwen-default still resolves: configured model first, then env', () => {
  withEnv({ AGENTCORE_MODEL: 'env-model' }, () => {
    const cfg = acConfig({ models: [{ id: 'doubao-seed-2.0-mini' }], defaultModel: 'jiuwen-default' })
    assert.equal(resolveAgentCoreModel(cfg, { model: 'jiuwen-default' }).model, 'doubao-seed-2.0-mini')
    assert.equal(resolveAgentCoreModel(cfg, { model: 'jiuwen-swarm' }).model, 'doubao-seed-2.0-mini')
    const cfg2 = acConfig({ models: [{ id: 'a' }, { id: 'b' }], defaultModel: 'b' })
    assert.equal(resolveAliasModel(cfg2, 'jiuwen-default'), 'b')
    // Nothing configured → env fallback (headless).
    assert.equal(resolveAgentCoreModel(acConfig(), { model: 'jiuwen-default' }).model, 'env-model')
  })
})

test('a legacy agent-default-model selection stays routable in the picker, labeled with its real model', () => withEnv({}, async () => {
  const ref = { cfg: acConfig({ models: [{ id: 'doubao-seed-2.0-mini' }] }) }
  const { adapter, sent } = rig(ref, { hostDefaultModel: () => ({ provider: 'jiuwen', model: 'jiuwen-default' }) })
  const models = await adapter.listModels('jiuwen')
  assert.deepEqual(models.map(m => m.id), ['doubao-seed-2.0-mini', 'jiuwen-default'])
  assert.equal(models[1].name, 'doubao-seed-2.0-mini (default)')
  assert.equal((await adapter.resolveModel('jiuwen', 'jiuwen-default')).name, 'doubao-seed-2.0-mini')
  await drain(adapter.stream(turn('jiuwen-default')))
  assert.equal(sent[0].model, 'doubao-seed-2.0-mini')
  // Once the default points at a real model the alias entry disappears.
  const { adapter: b } = rig(ref, { hostDefaultModel: () => ({ provider: 'jiuwen', model: 'doubao-seed-2.0-mini' }) })
  assert.deepEqual((await b.listModels('jiuwen')).map(m => m.id), ['doubao-seed-2.0-mini'])
}))

test('headless / nothing configured: picker shows the env model; no env → one placeholder', () => {
  withEnv({ AGENTCORE_MODEL: 'env-model' }, () => {
    assert.deepEqual(pickerModels(acConfig()).map(m => m.id), ['env-model'])
  })
  withEnv({}, () => {
    const list = pickerModels(acConfig())
    assert.equal(list.length, 1)
    assert.equal(list[0].id, 'jiuwen-default')
    assert.equal(resolveAgentCoreModel(acConfig(), { model: 'jiuwen-default' }).model, 'jiuwen-default')
  })
})

test('gateway backend keeps its Jiuwen catalog ids unchanged', () => withEnv({}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jw-picker-gw-'))
  const ref = { cfg: resolveConfig({ mode: 'gateway', backend: 'gateway', mappingPath: join(dir, 'm.json') }, { env: {} }) }
  const models = await rig(ref).adapter.listModels('jiuwen')
  assert.deepEqual(models.map(m => m.id), ['jiuwen-default', 'jiuwen-swarm'])
}))

test('findCatalogModel matches by id, then by modelName', () => {
  const cfg = { models: [{ id: 'jiuwen-default', modelName: 'x' }, { id: 'y' }] }
  assert.equal(findCatalogModel(cfg, 'x').id, 'jiuwen-default')
  assert.equal(findCatalogModel(cfg, 'y').id, 'y')
  assert.equal(findCatalogModel(cfg, 'z'), undefined)
})
