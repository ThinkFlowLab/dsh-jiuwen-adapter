import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isAgentCoreBackend,
  agentcoreUnsupportedError,
  wrapGatewayApiForBackend,
  AGENTCORE_API_METHODS,
  AGENTCORE_RPC_METHODS,
} from '../src/agentcore-api.js'
import { buildModelSpec } from '../src/agentcore-transport.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHostSync } from '../src/host-sync.js'
import { SessionStore } from '../src/session-store.js'

test('isAgentCoreBackend detects agent-core only', () => {
  assert.equal(isAgentCoreBackend({ backend: 'agent-core' }), true)
  assert.equal(isAgentCoreBackend({ backend: 'gateway' }), false)
  assert.equal(isAgentCoreBackend({}), false)
})

test('agentcoreUnsupportedError shape matches Gateway UNSUPPORTED', () => {
  const e = agentcoreUnsupportedError('skills.list')
  assert.equal(e.code, 'UNSUPPORTED')
  assert.equal(e.backend, 'agent-core')
  assert.equal(e.method, 'skills.list')
  assert.match(e.message, /agent-core/)
})

test('wrapGatewayApiForBackend: supported methods pass; others throw on agent-core', async () => {
  const calls = []
  const base = {
    historyGet: async (sid) => ({ sid, ok: true }),
    sessionDelete: async (sid) => ({ deleted: sid }),
    sessionFork: async (sid) => ({ session_id: `fork_${sid}` }),
    skillsList: async () => ({ skills: [] }),
    modelsList: async () => ({ models: ['gw'] }),
    rpc: async (m, p) => { calls.push([m, p]); return { ok: true } },
    supports: async () => true,
    unsupported: () => [],
    interrupt: async (sid) => ({ interrupted: sid }),
    chatCancel: async (sid) => ({ cancelled: sid }),
  }
  const ac = {
    sessionHistory: async (sid) => ({ history: sid }),
    sessionDelete: async (sid) => ({ deleted: sid }),
    sessionFork: async (from, to) => ({ session_id: to, from }),
    cancel: async (sid) => ({ cancelled: sid }),
  }
  let backend = 'agent-core'
  const api = wrapGatewayApiForBackend(base, {
    getConfig: () => ({ backend }),
    getAgentcore: () => ac,
    modelsFromConfig: () => ({ models: [{ model_name: 'm1' }], active_model: 'm1' }),
  })

  // AGENTCORE_API_METHODS pass through to base (plugin wires agent-core inside those methods).
  assert.deepEqual(await api.historyGet('s1'), { sid: 's1', ok: true })
  assert.deepEqual(await api.modelsList(), { models: [{ model_name: 'm1' }], active_model: 'm1' })
  assert.equal(await api.supports('history.get'), true)
  assert.equal(await api.supports('skills.list'), false)
  await assert.rejects(() => api.skillsList(), (e) => e.code === 'UNSUPPORTED' && e.backend === 'agent-core')
  assert.deepEqual(await api.rpc('session.delete', { session_id: 'x' }), { deleted: 'x' })
  await assert.rejects(() => api.rpc('skills.list', {}), (e) => e.code === 'UNSUPPORTED')
  assert.deepEqual(await api.interrupt('s1'), { cancelled: 's1' })

  backend = 'gateway'
  assert.deepEqual(await api.skillsList(), { skills: [] })
  assert.deepEqual(await api.modelsList(), { models: ['gw'] })
})

test('buildModelSpec forwards temperature / max_tokens / top_p', () => {
  const prev = process.env.AGENTCORE_FAKE_MODEL
  delete process.env.AGENTCORE_FAKE_MODEL
  const s = buildModelSpec(
    { model: 'gpt', temperature: 0.2, maxTokens: 100, topP: 0.9 },
    {},
  )
  assert.equal(s.temperature, 0.2)
  assert.equal(s.max_tokens, 100)
  assert.equal(s.top_p, 0.9)
  if (prev !== undefined) process.env.AGENTCORE_FAKE_MODEL = prev
})

test('hostSync agent-core: delete/fork/pause use agentcore; skills/mcp soft-skip', async () => {
  const listeners = {}
  const ctx = {
    on(ev, fn) { (listeners[ev] ||= []).push(fn); return () => {} },
    get() { return undefined },
  }
  const sessions = new SessionStore(join(mkdtempSync(join(tmpdir(), 'ac-api-')), 'm.json'))
  const acCalls = []
  const gwCalls = []
  const agentcore = () => ({
    cancel: async (sid) => { acCalls.push(['cancel', sid]); return {} },
    sessionDelete: async (sid) => { acCalls.push(['delete', sid]); return {} },
    sessionFork: async (from, to) => { acCalls.push(['fork', from, to]); return { session_id: to } },
  })
  const gateway = () => ({
    rpc: async (m, p) => { gwCalls.push([m, p]); return {} },
    chatInterrupt: async (sid) => { gwCalls.push(['chat.interrupt', sid]); return {} },
    sessionDelete: async (sid) => { gwCalls.push(['session.delete', sid]); return {} },
    sessionFork: async (sid) => { gwCalls.push(['session.fork', sid]); return { session_id: `fork_${sid}` } },
    sessionRename: async () => { gwCalls.push(['session.rename']); return {} },
    features: { isUnsupported: () => false },
  })
  const dispose = installHostSync({
    ctx,
    config: () => ({ provider: 'jiuwen', backend: 'agent-core', hostSync: true, models: [{ id: 'jiuwen-default' }] }),
    sessions,
    gateway,
    agentcore,
    logger: { debug() {}, info() {} },
    services: () => ({}),
  })

  const id = 'ac-sess'
  sessions.ensure(id, { preferredJiuwenId: 'jw-ac' })
  sessions.update(id, { turns: 2 })
  const session = { id, header: { config: { provider: 'jiuwen' } } }

  // model → session map
  for (const fn of listeners['session/event'] || []) {
    fn(session, { type: 'model/selection', data: { config: { provider: 'jiuwen', model: 'my-model' } } })
    fn(session, { type: 'working-directory/change', data: { cwd: '/tmp/ac' } })
    fn(session, { type: 'plan/mode', data: { active: true } })
  }
  assert.equal(sessions.get(id).modelName, 'my-model')
  assert.equal(sessions.get(id).projectDir, '/tmp/ac')
  assert.equal(sessions.get(id).chatMode, 'agent.plan')

  // pause → agentcore.cancel
  for (const fn of listeners['workspace/session-stop'] || []) {
    fn({ sessionId: id })
  }
  await new Promise((r) => setTimeout(r, 30))
  assert.ok(acCalls.some((c) => c[0] === 'cancel'))
  assert.equal(gwCalls.length, 0)

  // fork → agentcore.sessionFork
  const kid = { id: id + '-kid', header: { config: { provider: 'jiuwen' }, parentSession: id } }
  for (const fn of listeners['session/created'] || []) fn(kid)
  await new Promise((r) => setTimeout(r, 50))
  assert.ok(acCalls.some((c) => c[0] === 'fork'))

  // title → mapping only, no gateway rename
  for (const fn of listeners['session/event'] || []) {
    fn(session, { type: 'session/title', data: { title: 'AC Title' } })
  }
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(sessions.get(id).title, 'AC Title')
  assert.ok(!gwCalls.some((c) => c[0] === 'session.rename'))

  // skills/change → no gateway
  for (const fn of listeners['skills/change'] || []) fn()
  await new Promise((r) => setTimeout(r, 30))
  assert.ok(!gwCalls.some((c) => String(c[0]).includes('skills')))

  dispose()
  assert.ok(AGENTCORE_API_METHODS.has('historyGet'))
  assert.ok(AGENTCORE_RPC_METHODS.has('session.delete'))
})

test('wrapGatewayApiForBackend covers all acRpc methods and gateway passthrough', async () => {
  const ac = {
    sessionHistory: async (sid) => ({ h: sid }),
    sessionDelete: async (sid) => ({ d: sid }),
    sessionFork: async (from, to) => ({ session_id: to, from }),
    cancel: async (sid) => ({ c: sid }),
  }
  const base = {
    historyGet: async () => ({}),
    sessionDelete: async () => ({}),
    sessionFork: async () => ({}),
    skillsList: async () => ({ skills: ['gw'] }),
    modelsList: async () => ({ models: ['gw'] }),
    rpc: async (m, p) => ({ via: 'gw', m, p }),
    supports: async (m) => m === 'skills.list',
    unsupported: () => ['old'],
    interrupt: async (sid) => ({ i: sid }),
    chatCancel: async (sid) => ({ x: sid }),
    foo: 'bar',
  }
  let backend = 'agent-core'
  const api = wrapGatewayApiForBackend(base, {
    getConfig: () => ({ backend }),
    getAgentcore: () => ac,
    modelsFromConfig: () => ({ models: [{ model_name: 'm' }], active_model: 'm' }),
  })
  assert.deepEqual(await api.rpc('history.get', { session_id: 'a' }), { h: 'a' })
  assert.deepEqual(await api.rpc('session.fork', { session_id: 'p', new_session_id: 'c' }), { session_id: 'c', from: 'p' })
  assert.deepEqual(await api.rpc('session.fork', { source_session_id: 'p2' }), { session_id: (await api.rpc('session.fork', { source_session_id: 'p2' })).session_id, from: 'p2' })
  // fork without to generates fork-*
  const fr = await api.rpc('session.fork', { session_id: 'p3' })
  assert.match(fr.session_id, /^fork-/)
  assert.deepEqual(await api.rpc('chat.interrupt', { sid: 'z' }), { c: 'z' })
  assert.deepEqual(await api.rpc('models.list', {}), { models: [{ model_name: 'm' }], active_model: 'm' })
  assert.deepEqual(await api.chatCancel('z'), { c: 'z' })
  assert.match(api.unsupported()[0], /Gateway-only/)
  assert.equal(api.foo, 'bar')

  // no agentcore → unsupported
  const api2 = wrapGatewayApiForBackend(base, {
    getConfig: () => ({ backend: 'agent-core' }),
    getAgentcore: () => null,
  })
  await assert.rejects(() => api2.rpc('history.get', { sid: 'x' }), (e) => e.code === 'UNSUPPORTED')
  await assert.rejects(() => api2.interrupt('x'), (e) => e.code === 'UNSUPPORTED')
  // modelsList without modelsFromConfig
  const api3 = wrapGatewayApiForBackend(base, {
    getConfig: () => ({ backend: 'agent-core' }),
    getAgentcore: () => ac,
  })
  assert.deepEqual(await api3.modelsList(), { models: [], active_model: null })

  backend = 'gateway'
  assert.equal(await api.supports('skills.list'), true)
  assert.deepEqual(api.unsupported(), ['old'])
  assert.deepEqual(await api.rpc('skills.list', { a: 1 }), { via: 'gw', m: 'skills.list', p: { a: 1 } })
  assert.deepEqual(await api.modelsList(), { models: ['gw'] })
  assert.deepEqual(await api.interrupt('s'), { i: 's' })
  assert.deepEqual(await api.chatCancel('s'), { x: 's' })
})
