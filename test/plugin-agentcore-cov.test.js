import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../index.js'

function makeCtx(services = {}) {
  const adapters = new Map()
  const commands = []
  const hooks = {}
  const ctx = {
    llm: { registerAdapter(ids, a) { ids.forEach(i => adapters.set(i, a)); return () => {} } },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    provide(n, v) { this[n] = v },
    get(n) { return services[n] },
    on(n, fn) { (hooks[n] ||= []).push(fn); return () => {} },
    inject(_deps, cb) {
      cb({ commands: { register(d) { commands.push(d); return () => {} } }, on() {} })
    },
  }
  return { ctx, adapters, commands, hooks }
}

test('plugin agent-core: mcpVerify + history/session routes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plug-ac-'))
  const tools = {
    execute: async (exec) => {
      if (exec.name === 'boom') return { isError: true, text: 'nope' }
      return { text: `ok:${exec.name}` }
    },
    get: () => null,
  }
  const agents = {
    get: (id) => ({ id, preset: { name: 'p1' }, ctx: { tools } }),
  }
  const { ctx, adapters, commands, hooks } = makeCtx({ tools, agents })
  plugin.apply(ctx, {
    backend: 'agent-core',
    gatewayURL: 'ws://127.0.0.1:9/ws',
    mappingPath: join(dir, 'map.json'),
    hostSync: false,
    sessionSync: false,
    planBridge: false,
    agentcorePython: 'python3',
    agentcoreCheckpointDir: join(dir, 'ck'),
  })
  const api = ctx.jiuwenAdapter
  assert.equal(api.isAgentCore(), true)
  assert.equal(api.backend(), 'agent-core')
  const v = await api.mcpVerify('s1')
  assert.equal(v.mode, 'local-function')
  assert.equal(v.ok, true)

  const adapter = adapters.get('jiuwen')
  adapter._agentcoreTransport = () => ({
    sessionHistory: async (sid) => ({ sid, messages: [] }),
    sessionDelete: async (sid) => ({ deleted: sid }),
    sessionFork: async (from, to) => ({ from, to }),
    cancel: async (sid, reason) => ({ cancelled: sid, reason }),
  })
  assert.deepEqual(await api.gateway.historyGet('s1'), { sid: 's1', messages: [] })
  assert.deepEqual(await api.gateway.sessionDelete('s1'), { deleted: 's1' })
  assert.equal((await api.gateway.sessionFork('s1', { new_session_id: 's2' })).to, 's2')
  assert.ok(commands.some(c => c.name === 'jiuwen'))
  for (const fn of hooks.dispose || []) fn()
  rmSync(dir, { recursive: true, force: true })
})

test('plugin agent-core commandGateway Proxy + cancel + apply trace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plug-ac3-'))
  const trace = join(dir, 'trace.jsonl')
  const prev = process.env.JIUWEN_TRACE_FILE
  process.env.JIUWEN_TRACE_FILE = trace
  try {
    const { ctx, adapters, commands, hooks } = makeCtx({
      tools: { get: () => null, execute: async () => ({ text: 'x' }) },
      agents: { get: () => ({ id: 'a2', preset: { name: 'headless' } }) },
    })
    plugin.apply(ctx, {
      backend: 'agent-core',
      gatewayURL: 'ws://127.0.0.1:9/ws',
      mappingPath: join(dir, 'map.json'),
      hostSync: false,
      sessionSync: false,
      planBridge: false,
    })
    const body = readFileSync(trace, 'utf8')
    assert.ok(/plugin-apply/.test(body))
    const api = ctx.jiuwenAdapter
    const adapter = adapters.get('jiuwen')
    adapter._agentcoreTransport = () => ({
      cancel: async (sid, reason) => ({ cancelled: sid, reason }),
      sessionHistory: async () => ({ messages: [] }),
    })
    const r = await api.gateway.interrupt('sid-1', 'cancel', {})
    assert.equal(r.cancelled, 'sid-1')
    const def = commands.find(c => c.name === 'jiuwen')
    assert.ok(def)
    await def.handler({ agent: { id: 'sid-1' }, rawInput: 'help' })
    for (const fn of hooks.dispose || []) fn()
  } finally {
    if (prev == null) delete process.env.JIUWEN_TRACE_FILE
    else process.env.JIUWEN_TRACE_FILE = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

test('agent-core host callbacks re-enter the exact live dsh initiator', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks')
  const store = new AsyncLocalStorage()
  const dir = mkdtempSync(join(tmpdir(), 'plug-ac-initiator-'))
  const agent = { id: 'host-session' }
  const seen = []
  const agents = { get: id => id === agent.id ? agent : undefined, withInitiator: (a, run) => store.run(a, run) }
  const tools = { execute: async exec => {
    assert.equal(exec.agent, agent)
    assert.equal(store.getStore(), agent)
    seen.push(exec.arguments)
    return { content: [{ type: 'text', text: 'host result' }] }
  } }
  const { ctx, adapters, hooks } = makeCtx({ tools, agents })
  plugin.apply(ctx, { backend: 'agent-core', hostSync: false, sessionSync: false, planBridge: false, mappingPath: join(dir, 'map.json') })
  const transport = adapters.get('jiuwen')._agentcoreTransport()
  try {
    const r = await transport.executeTool('read', { path: '/fixture', optional: null }, { dshSessionId: agent.id })
    assert.equal(r, 'host result')
    assert.deepEqual(seen, [{ path: '/fixture' }])
    assert.equal(store.getStore(), undefined)
  } finally {
    await transport.shutdown()
    for (const fn of hooks.dispose || []) fn()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('plugin disposal shuts down an existing sidecar exactly once without starting one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plug-ac-dispose-'))
  const { ctx, adapters, hooks } = makeCtx()
  plugin.apply(ctx, { backend:'agent-core',hostSync:false,sessionSync:false,planBridge:false,mappingPath:join(dir,'map.json') })
  let closed=0
  adapters.get('jiuwen')._agentcore={shutdown:async()=>{closed++}}
  try {
    for(const fn of hooks.dispose || []) await fn()
    for(const fn of hooks.dispose || []) await fn()
    assert.equal(closed,1)
  } finally { rmSync(dir,{recursive:true,force:true}) }
})

test('agent-core host callbacks use the dsh >=0.2.2 batch tools.execute shape', async () => {
  // dsh 0.2.2 executeToolBatch reads input.calls and returns { results: [{ callId, result }] };
  // a bare single exec made it throw "Tool batch execution failed".
  const dir = mkdtempSync(join(tmpdir(), 'plug-ac-batch-'))
  const agent = { id: 'host-session' }
  const agents = { get: id => id === agent.id ? agent : undefined }
  const seen = []
  const tools = { execute: async input => {
    assert.ok(Array.isArray(input.calls), 'batch calls present')
    const [block] = input.calls
    seen.push({ name: block.name, args: JSON.parse(block.arguments) })
    return { results: [{ callId: block.id, result: { content: [{ type: 'text', text: 'BATCH_OK' }] } }], additionalContexts: [], concluded: false }
  } }
  const { ctx, adapters, hooks } = makeCtx({ tools, agents })
  plugin.apply(ctx, { backend: 'agent-core', hostSync: false, sessionSync: false, planBridge: false, mappingPath: join(dir, 'map.json') })
  const transport = adapters.get('jiuwen')._agentcoreTransport()
  try {
    assert.equal(await transport.executeTool('bash', { command: 'echo hi', timeout: null }, { dshSessionId: agent.id, callId: 'c1' }), 'BATCH_OK')
    assert.deepEqual(seen, [{ name: 'bash', args: { command: 'echo hi' } }])
    tools.execute = async input => ({ results: [{ callId: input.calls[0].id, result: { isError: true, content: [{ type: 'text', text: 'denied' }] } }] })
    await assert.rejects(transport.executeTool('bash', { command: 'x' }, { dshSessionId: agent.id }), /denied/)
  } finally {
    await transport.shutdown()
    for (const fn of hooks.dispose || []) fn()
    rmSync(dir, { recursive: true, force: true })
  }
})
