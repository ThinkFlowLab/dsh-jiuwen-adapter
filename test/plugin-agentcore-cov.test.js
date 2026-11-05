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
