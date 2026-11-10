import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createMcpBridge, matchesAllowlist, proxyRegistration, isProxyConnected, sessionMcpName, schemasRev, PROXY_PATH, mcpCallTimeoutMs } from '../src/mcp-bridge.js'

const tmp = mkdtempSync(join(tmpdir(), 'jw-mcp-test-'))
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }))

const base = { toolAllowlist: ['read', 'web_*', 'orchestrator_report'], toolApproval: 'dsh', approvalTimeoutMs: 200, toolCallTimeoutMs: 1000, mcpServerName: 'dsh-tools', mcpStateDir: join(tmp, 'state'), jiuwenMcpStateFile: join(tmp, 'jiuwen-state.json'), mcpGcOnStart: false }
function bridge(services, cfg = {}) {
  const calls = []
  const b = createMcpBridge({ config: () => ({ ...base, ...cfg }), services: () => services, rpc: async (m, p) => { calls.push([m, p]); return {} } })
  return { b, calls }
}
const schemas = [{ name: 'read', description: 'r', parameters: { type: 'object' } }, { name: 'web_fetch', description: 'w' }, { name: 'bash', description: 'b' }, { name: 'orchestrator_report', description: 'rep' }]

test('allowlist: exact, prefix*, *', () => {
  assert.ok(matchesAllowlist('web_fetch', ['web_*']))
  assert.ok(!matchesAllowlist('bash', ['read']))
  assert.ok(matchesAllowlist('bash', ['*']))
  assert.ok(!matchesAllowlist('bash', []))
})

test('sessionMcpName is stable and distinct per session', () => {
  const a = sessionMcpName('dsh-tools', 'worker-aaa')
  const b = sessionMcpName('dsh-tools', 'worker-bbb')
  assert.equal(a, sessionMcpName('dsh-tools', 'worker-aaa'))
  assert.notEqual(a, b)
  assert.match(a, /^dsh-tools-[a-f0-9]{16}$/)
})

test('registers a per-session stdio proxy; dispose never disconnects; reconnect on schema growth', async () => {
  rmSync(join(tmp, 'jiuwen-state.json'), { force: true })
  const { b, calls } = bridge({})
  const r0 = await b.prepare(schemas, 's1')
  const name = sessionMcpName('dsh-tools', 's1')
  assert.equal(r0.mcpServerName, name)
  const r = await b._handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 's1')
  assert.deepEqual(r.result.tools.map(t => t.name), ['read', 'web_fetch', 'orchestrator_report'])
  assert.deepEqual(calls.map(c => c[0]), ['mcp.register_custom', 'mcp.connect'])
  assert.equal(calls[0][1].name, name)
  assert.equal(calls[0][1].transport, 'stdio')
  const stateDir = join(tmp, 'state', 's', name.slice('dsh-tools-'.length))
  const union = () => JSON.parse(readFileSync(join(stateDir, 'schemas.json'), 'utf8'))
  assert.deepEqual(calls[0][1].args, [PROXY_PATH, stateDir, `--rev=${schemasRev(union())}`])
  const ep = join(stateDir, `ep-${process.pid}.json`)
  assert.ok(existsSync(ep))
  assert.deepEqual(union().map(t => t.name), ['read', 'web_fetch', 'orchestrator_report'])
  await b.prepare(schemas, 's1')
  assert.equal(calls.length, 2)
  await b.dispose()
  assert.equal(calls.length, 2, 'no mcp.disconnect / delete_custom on dispose')
  assert.ok(!existsSync(ep))
  // Next prepare with connected record at the same revision → reuse
  const reg = proxyRegistration(name, stateDir, mcpCallTimeoutMs(base), schemasRev(union()))
  writeFileSync(join(tmp, 'jiuwen-state.json'), JSON.stringify({ mcp: { [name]: { ...reg, state: 'connected' } } }))
  assert.ok(isProxyConnected({ ...reg, state: 'connected' }, reg))
  const next = bridge({})
  const r2 = await next.b.prepare(schemas, 's1')
  assert.equal(r2.reused, true)
  assert.equal(next.calls.length, 0)
  // New tool name → re-register at the new revision (a plain reconnect reuses Jiuwen's cached server)
  const more = bridge({}, { toolAllowlist: ['*'] })
  const r3 = await more.b.prepare(schemas, 's1')
  assert.deepEqual(more.calls.map(c => c[0]), ['mcp.disconnect', 'mcp.register_custom', 'mcp.connect'])
  assert.equal(r3.reconnected, true)
  assert.deepEqual(more.calls[1][1].args, [PROXY_PATH, stateDir, `--rev=${schemasRev(union())}`])
  await next.b.dispose(); await more.b.dispose()
  const u = await more.b.unregister()
  assert.ok(u.disconnect && u.delete)
})

test('Bug 5: concurrent sessions attribute tools/call to their own agent (no ownerOf cross-talk)', async () => {
  const ran = []
  const agents = {
    get: (sid) => ({ id: sid, ctx: { tools: { get: () => null } } }),
  }
  const tools = {
    get: (n, agent) => ({
      execute: async (args) => {
        ran.push({ tool: n, agent: agent?.id, args })
        return `ok ${n} for ${agent?.id}`
      },
    }),
  }
  const { b, calls } = bridge({ tools, agents, approval: { request: async () => 'allowed-once' } }, { toolApproval: 'none', toolAllowlist: ['*'] })
  const ra = await b.prepare(schemas, 'worker-A')
  const rb = await b.prepare(schemas, 'worker-B')
  assert.notEqual(ra.mcpServerName, rb.mcpServerName)
  assert.equal(calls.filter(c => c[0] === 'mcp.register_custom').length, 2)

  let r = await b._handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'orchestrator_report', arguments: { ticket: 'A' } } }, 'worker-A')
  assert.equal(r.result.isError, false)
  assert.match(r.result.content[0].text, /worker-A/)
  r = await b._handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'orchestrator_report', arguments: { ticket: 'B' } } }, 'worker-B')
  assert.equal(r.result.isError, false)
  assert.match(r.result.content[0].text, /worker-B/)
  assert.deepEqual(ran.map(x => x.agent), ['worker-A', 'worker-B'])

  // Proxy forwards via per-session URL path
  const keyA = ra.mcpServerName.slice('dsh-tools-'.length)
  const stateA = join(tmp, 'state', 's', keyA)
  const p = spawn(process.execPath, [PROXY_PATH, stateA], { stdio: ['pipe', 'pipe', 'inherit'] })
  const pending = new Map(); let buf = ''
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); pending.get(m.id)?.(m) } })
  const call = (id, method, params) => new Promise((res) => { pending.set(id, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') })
  r = await call(3, 'tools/call', { name: 'orchestrator_report', arguments: { via: 'proxy' } })
  assert.equal(r.result.isError, false)
  assert.match(r.result.content[0].text, /worker-A/)
  p.stdin.end()
  await b.releaseSession('worker-A')
  assert.ok(calls.some(c => c[0] === 'mcp.delete_custom' && c[1].name === ra.mcpServerName))
  await b.dispose()
})

test('proxy (stdio): lists session schemas, forwards tools/call, errors when dsh is gone', async () => {
  rmSync(join(tmp, 'jiuwen-state.json'), { force: true })
  const tools = { get: (n) => ({ execute: async () => `ran ${n}` }) }
  const { b } = bridge({ tools }, { toolApproval: 'none' })
  const prep = await b.prepare(schemas, 's1')
  const stateDir = join(tmp, 'state', 's', prep.mcpServerName.slice('dsh-tools-'.length))
  const p = spawn(process.execPath, [PROXY_PATH, stateDir], { stdio: ['pipe', 'pipe', 'inherit'] })
  const pending = new Map(); let buf = ''
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); pending.get(m.id)?.(m) } })
  const call = (id, method, params) => new Promise((res) => { pending.set(id, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') })
  assert.equal((await call(1, 'initialize', {})).result.serverInfo.name, 'dsh-jiuwen-proxy')
  assert.ok((await call(2, 'tools/list', {})).result.tools.some(t => t.name === 'read'))
  let r = await call(3, 'tools/call', { name: 'read', arguments: {} })
  assert.equal(r.result.isError, false); assert.equal(r.result.content[0].text, 'ran read')
  await b.dispose()
  r = await call(4, 'tools/call', { name: 'read', arguments: {} })
  assert.equal(r.result.isError, true); assert.match(r.result.content[0].text, /not running/)
  p.stdin.end()
})

test('tools/call: approval allowed-once executes; denied without UI; non-allowlisted errors', async () => {
  const agent = { id: 's1' }
  const tools = { get: (n) => ({ execute: async (args) => ({ content: [{ type: 'text', text: `ran ${n} ${JSON.stringify(args)}` }] }) }) }
  const ok = bridge({ tools, agents: { get: () => agent }, approval: { request: async (r) => (r.agent === agent ? 'allowed-once' : 'rejected') } })
  await ok.b.prepare(schemas, 's1')
  let r = await ok.b._handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read', arguments: { path: 'x' } } }, 's1')
  assert.equal(r.result.isError, false)
  assert.equal(r.result.content[0].text, 'ran read {"path":"x"}')
  r = await ok.b._handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bash', arguments: {} } }, 's1')
  assert.equal(r.result.isError, true)
  await ok.b.dispose()
  const deny = bridge({ tools, agents: { get: () => agent } })
  await deny.b.prepare(schemas, 's1')
  r = await deny.b._handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'read', arguments: {} } }, 's1')
  assert.equal(r.result.isError, true)
  assert.match(r.result.content[0].text, /denied/)
  await deny.b.dispose()
  const none = bridge({ tools }, { toolApproval: 'none' })
  await none.b.prepare(schemas, 's1')
  r = await none.b._handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'web_fetch', arguments: {} } }, 's1')
  assert.equal(r.result.isError, false)
  await none.b.dispose()
})

test('mcp-reset: unregister then next prepare restores registration', async () => {
  rmSync(join(tmp, 'jiuwen-state.json'), { force: true })
  const { b, calls } = bridge({})
  await b.prepare(schemas, 's1')
  const first = calls.find(c => c[0] === 'mcp.register_custom')[1]
  await b.unregister()
  calls.length = 0
  await b.prepare(schemas, 's1')
  assert.deepEqual(calls.map(c => c[0]), ['mcp.register_custom', 'mcp.connect'])
  assert.equal(calls[0][1].name, first.name)
  calls.length = 0
  await b.prepare(schemas, 's1')
  assert.equal(calls.length, 0, 'only once after a reset')
  await b.dispose()
})

test('releaseSession removes registration and state dir', async () => {
  const { b, calls } = bridge({})
  const r = await b.prepare(schemas, 'gone')
  const dir = join(tmp, 'state', 's', r.mcpServerName.slice('dsh-tools-'.length))
  assert.ok(existsSync(dir))
  await b.releaseSession('gone')
  assert.ok(calls.some(c => c[0] === 'mcp.disconnect' && c[1].name === r.mcpServerName))
  assert.ok(calls.some(c => c[0] === 'mcp.delete_custom' && c[1].name === r.mcpServerName))
  assert.ok(!existsSync(dir))
  await b.dispose()
})

test('/jiuwen mcp-reset requires a trailing confirm', async () => {
  const { createJiuwenCommand } = await import('../src/commands.js')
  let n = 0
  const cmd = createJiuwenCommand({ sessions: { ensure: () => ({ jiuwenSessionId: 'j' }) }, gateway: () => ({}), config: () => ({ mcpServerName: 'dsh-tools' }), mcpBridge: { unregister: async () => { n++; return { disconnect: {}, delete: {} } } } })
  assert.match(await cmd.run('s', 'mcp-reset'), /Refusing .*mcp-reset confirm/)
  assert.equal(n, 0)
  assert.match(await cmd.run('s', 'mcp-reset confirm'), /Removed Jiuwen MCP registration/)
  assert.equal(n, 1)
})

test('compat: prepare/dispose cycles leave no process exit listener behind', async () => {
  const n0 = process.listenerCount('exit')
  for (let i = 0; i < 3; i++) {
    const { b } = bridge({})
    await b.prepare(schemas, `leak-${i}`)
    assert.ok(process.listenerCount('exit') <= n0 + 1)
    await b.dispose()
  }
  assert.equal(process.listenerCount('exit'), n0)
})

test('verify: mcp.show resolves the custom passthrough server', async () => {
  const name = sessionMcpName('dsh-tools', 's1')
  const b = createMcpBridge({ config: () => ({ mcpServerName: 'dsh-tools' }), services: () => ({}), logger: {}, rpc: async (m, p) => {
    if (m === 'mcp.show' && p.name === name) return { type: 'detail', item: { name, category: 'custom', connection_state: 'connected', tools: [{ name: 'bash' }] } }
    throw new Error('SkillHub asset not found: x')
  } })
  // seed session entry via prepare with empty tools → null; use sessionServerName path
  const v = await b.verify('s1')
  assert.equal(v.name, name)
  assert.equal(v.registered, true)
})

test('memory plugins: read-only session-query tools skip the per-call approval gate (dsh never asks for them); others still gated', async () => {
  const { resolveConfig } = await import('../src/config.js')
  const def = resolveConfig({}, { env: {} }).toolApprovalExempt
  assert.deepEqual(def, ['session_search', 'session_event_search', 'session_event_read', 'session_trace', 'session_event_trace', 'get_goal', 'update_goal', 'create_goal'])
  assert.deepEqual(resolveConfig({}, { env: { JIUWEN_TOOL_APPROVAL_EXEMPT: '' } }).toolApprovalExempt, [])
  const agent = { id: 's1' }; let asked = 0
  const tools = { get: (n) => ({ execute: async (args, exec) => ({ content: [{ type: 'text', text: `ran ${n} agent=${exec.agent?.id}` }] }) }) }
  const mem = [...schemas, { name: 'session_search', description: 's', parameters: { type: 'object' } }, { name: 'get_goal', description: 'g', parameters: { type: 'object' } }, { name: 'update_goal', description: 'u', parameters: { type: 'object' } }, { name: 'create_goal', description: 'c', parameters: { type: 'object' } }]
  const b1 = bridge({ tools, agents: { get: () => agent }, approval: { request: async () => { asked++; return 'rejected' } } }, { toolAllowlist: ['*'], toolApprovalExempt: def })
  await b1.b.prepare(mem, 's1')
  let r = await b1.b._handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'session_search', arguments: { query: 'zebra' } } })
  assert.equal(r.result.isError, false); assert.equal(r.result.content[0].text, 'ran session_search agent=s1'); assert.equal(asked, 0)
  for (const goalTool of ['get_goal', 'update_goal', 'create_goal']) {
    r = await b1.b._handle({ jsonrpc: '2.0', id: goalTool, method: 'tools/call', params: { name: goalTool, arguments: {} } })
    assert.equal(r.result.isError, false, `${goalTool} should skip approval`); assert.equal(r.result.content[0].text, `ran ${goalTool} agent=s1`); assert.equal(asked, 0)
  }
  r = await b1.b._handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bash', arguments: {} } })
  assert.equal(r.result.isError, true); assert.equal(asked, 1, 'non-exempt tool still asks')
  await b1.b.dispose()
  const b2 = bridge({ tools, agents: { get: () => agent } }, { toolAllowlist: ['*'], toolApprovalExempt: [] })
  await b2.b.prepare(mem, 's1')
  r = await b2.b._handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'session_search', arguments: {} } })
  assert.equal(r.result.isError, true, 'empty exempt list restores the old gate')
  r = await b2.b._handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_goal', arguments: {} } })
  assert.equal(r.result.isError, true, 'empty exempt list still gates get_goal')
  await b2.b.dispose()
})

test('hostSkillInject:index force-includes skillLoaderTool even when allowlist excludes it', async () => {
  const tools = [...schemas, { name: 'skill', description: 'load skill body' }]
  const { b } = bridge({}, { toolAllowlist: ['read'], hostSkillInject: 'index', skillLoaderTool: 'skill' })
  await b.prepare(tools, 'idx')
  assert.deepEqual(b.exposed('idx').sort(), ['read', 'skill'])
  await b.dispose()
  const body = bridge({}, { toolAllowlist: ['read'], hostSkillInject: 'body', skillLoaderTool: 'skill' })
  await body.b.prepare(tools, 'body')
  assert.deepEqual(body.b.exposed('body'), ['read'], 'body mode does not force-include loader')
  await body.b.dispose()
})

// ── toolApproval: 'host' (default) — passthrough runs through dsh's own tool pipeline ──
const hostRuntime = (impl) => {
  const seen = []
  return { seen, get: (n) => ({ name: n, execute: async () => { throw new Error('def.execute must not be called directly in host mode') } }),
    execute: async (exec) => { seen.push(exec); return impl(exec) } }
}

test('host (default): passthrough goes through tools.execute; no adapter approval gate (policy never still runs allowed tools)', async () => {
  const { resolveConfig } = await import('../src/config.js')
  assert.equal(resolveConfig({}, { env: {} }).toolApproval, 'host')
  assert.equal(resolveConfig({}, { env: { JIUWEN_TOOL_APPROVAL: 'dsh' } }).toolApproval, 'dsh')
  assert.equal(resolveConfig({ toolApproval: 'none' }, { env: {} }).toolApproval, 'none')
  const agent = { id: 's1' }; let asked = 0
  const rt = hostRuntime((exec) => ({ isError: false, content: [{ type: 'text', text: `ran ${exec.name} ${JSON.stringify(exec.arguments)}` }] }))
  const { b } = bridge({ tools: rt, agents: { get: () => agent }, approval: { request: async () => { asked++; return 'rejected' } } }, { toolApproval: undefined, toolAllowlist: ['*'] })
  await b.prepare([...schemas, { name: 'write', description: 'w' }], 's1')
  const r = await b._handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write', arguments: { path: 'a.txt' } } }, 's1')
  assert.equal(r.result.isError, false, r.result.content[0].text)
  assert.equal(r.result.content[0].text, 'ran write {"path":"a.txt"}')
  assert.equal(asked, 0, 'adapter never asks itself under host mode')
  const ex = rt.seen[0]
  assert.equal(ex.name, 'write'); assert.equal(ex.agent, agent); assert.deepEqual(ex.arguments, { path: 'a.txt' })
  assert.match(ex.callId, /^jiuwen-[0-9a-f-]{36}$/)
  assert.ok(ex.signal instanceof AbortSignal && !ex.signal.aborted)
  assert.ok(Array.isArray(ex.calls) && ex.calls.length === 1, 'batch calls present for dsh 0.2.2')
  assert.equal(ex.calls[0].id, ex.callId)
  assert.equal(ex.calls[0].name, 'write')
  assert.deepEqual(JSON.parse(ex.calls[0].arguments), { path: 'a.txt' })
  await b.dispose()
})

test('host (contract, not live): dsh 0.2.2 batch-only tools.execute unwraps; bare single exec is not required', async () => {
  // Isolated contract test: a 0.2.2-shaped runtime that only reads input.calls
  // and returns { results: [{ callId, result }] }. This is not a live Gateway run.
  const agent = { id: 's1' }
  const rt = hostRuntime((exec) => {
    if (!Array.isArray(exec.calls) || !exec.calls[0]) throw new Error('Tool batch execution failed')
    const block = exec.calls[0]
    return {
      results: [{ callId: block.id, result: { content: [{ type: 'text', text: `batch ${block.name} ${block.arguments}` }] } }],
      additionalContexts: [],
      concluded: false,
    }
  })
  const { b } = bridge({ tools: rt, agents: { get: () => agent } }, { toolApproval: 'host', toolAllowlist: ['*'] })
  await b.prepare([...schemas, { name: 'write', description: 'w' }], 's1')
  const r = await b._handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write', arguments: { path: 'a.txt' } } }, 's1')
  assert.equal(r.result.isError, false, r.result.content?.[0]?.text)
  assert.equal(r.result.content[0].text, 'batch write {"path":"a.txt"}')
  await b.dispose()
})

test('host: dsh pipeline denial / error results pass through as isError (dsh decides, never fails open)', async () => {
  const agent = { id: 's1' }
  const rt = hostRuntime((exec) => exec.name === 'bash'
    ? { isError: true, content: [{ type: 'text', text: 'Error: the user rejected tool "bash"' }], error: { message: 'the user rejected tool "bash"' } }
    : Promise.reject(new Error('boom')))
  const { b } = bridge({ tools: rt, agents: { get: () => agent } }, { toolApproval: 'host', toolAllowlist: ['*'] })
  await b.prepare(schemas, 's1')
  let r = await b._handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bash', arguments: { command: 'ls' } } }, 's1')
  assert.equal(r.result.isError, true); assert.match(r.result.content[0].text, /user rejected tool "bash"/)
  r = await b._handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read', arguments: {} } }, 's1')
  assert.equal(r.result.isError, true); assert.match(r.result.content[0].text, /dsh tool read failed: boom/)
  r = await b._handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'not_admitted', arguments: {} } }, 's1')
  assert.equal(r.result.isError, true); assert.match(r.result.content[0].text, /not exposed/)
  assert.equal(rt.seen.length, 2, 'non-admitted tool never reaches dsh')
  await b.dispose()
})

test('host: falls back to the legacy per-call gate without a runtime execute() or a live agent; toolApprovalExempt still applies there', async () => {
  const agent = { id: 's1' }; const asked = []
  const legacy = { get: (n) => ({ execute: async () => `direct ${n}` }) }
  const fb = bridge({ tools: legacy, agents: { get: () => agent }, approval: { request: async (r) => { asked.push(r.toolName); return 'allowed-once' } } }, { toolApproval: 'host', toolAllowlist: ['*'], toolApprovalExempt: ['read'] })
  await fb.b.prepare(schemas, 's1')
  let r = await fb.b._handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bash', arguments: {} } }, 's1')
  assert.equal(r.result.content[0].text, 'direct bash'); assert.deepEqual(asked, ['bash'])
  r = await fb.b._handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read', arguments: {} } }, 's1')
  assert.equal(r.result.content[0].text, 'direct read'); assert.deepEqual(asked, ['bash'], 'exempt tool skips the fallback gate')
  await fb.b.dispose()
  // runtime present but no agent → fallback gate denies (no approval channel for an agent-less call)
  const rt = hostRuntime(() => ({ content: [{ type: 'text', text: 'host' }] }))
  const na = bridge({ tools: rt, agents: { get: () => undefined }, approval: { request: async () => 'allowed-once' } }, { toolApproval: 'host', toolAllowlist: ['*'] })
  await na.b.prepare(schemas, 's2')
  r = await na.b._handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bash', arguments: {} } }, 's2')
  assert.equal(r.result.isError, true); assert.match(r.result.content[0].text, /denied bash \(unavailable\)/)
  assert.equal(rt.seen.length, 0)
  await na.b.dispose()
})

test("toolApproval 'dsh' keeps the legacy gate even when the runtime has execute(); 'none' runs the definition directly", async () => {
  const agent = { id: 's1' }; let asked = 0
  const direct = []
  const rt = { get: (n) => ({ execute: async () => { direct.push(n); return `direct ${n}` } }), execute: async () => { throw new Error('pipeline must not run') } }
  const d = bridge({ tools: rt, agents: { get: () => agent }, approval: { request: async () => { asked++; return 'rejected' } } }, { toolApproval: 'dsh', toolAllowlist: ['*'], toolApprovalExempt: [] })
  await d.b.prepare(schemas, 's1')
  let r = await d.b._handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bash', arguments: {} } }, 's1')
  assert.equal(r.result.isError, true); assert.match(r.result.content[0].text, /dsh denied bash \(rejected\)/); assert.equal(asked, 1)
  await d.b.dispose()
  const n = bridge({ tools: rt, agents: { get: () => agent }, approval: { request: async () => { asked++; return 'rejected' } } }, { toolApproval: 'none', toolAllowlist: ['*'] })
  await n.b.prepare(schemas, 's1')
  r = await n.b._handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bash', arguments: {} } }, 's1')
  assert.equal(r.result.content[0].text, 'direct bash'); assert.equal(asked, 1)
  await n.b.dispose()
})

test('host: the call budget (toolCallTimeoutMs + approvalTimeoutMs) aborts exec.signal; Jiuwen registration timeout covers it', async () => {
  const agent = { id: 's1' }
  const rt = hostRuntime((exec) => new Promise((res) => exec.signal.addEventListener('abort', () => res({ isError: true, content: [{ type: 'text', text: 'Error: aborted' }] }))))
  const { b, calls } = bridge({ tools: rt, agents: { get: () => agent } }, { toolApproval: 'host', toolAllowlist: ['*'], toolCallTimeoutMs: 60, approvalTimeoutMs: 40 })
  await b.prepare(schemas, 's-budget')
  const reg = calls.find(c => c[0] === 'mcp.register_custom')[1]
  assert.equal(reg.timeout_s, Math.ceil((60 + 40 + 5000) / 1000))
  const t0 = Date.now()
  const r = await b._handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read', arguments: {} } }, 's-budget')
  assert.equal(r.result.isError, true)
  assert.ok(Date.now() - t0 >= 90, 'budget includes the approval window')
  assert.ok(rt.seen[0].signal.aborted)
  await b.dispose()
  const none = bridge({}, { toolApproval: 'none', toolCallTimeoutMs: 120_000, approvalTimeoutMs: 300_000 })
  await none.b.prepare(schemas, 's-none')
  assert.equal(none.calls.find(c => c[0] === 'mcp.register_custom')[1].timeout_s, 125)
  await none.b.dispose()
})

test('host: skill loader output is still redacted', async () => {
  const agent = { id: 's1' }
  const secret = 'sk-' + 'a'.repeat(40)
  const rt = hostRuntime(() => ({ content: [{ type: 'text', text: `body key=${secret}` }] }))
  const { b } = bridge({ tools: rt, agents: { get: () => agent } }, { toolApproval: 'host', toolAllowlist: ['*'], skillLoaderTool: 'skill' })
  await b.prepare([{ name: 'skill', description: 's' }], 's1')
  const r = await b._handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'skill', arguments: { name: 'x' } } }, 's1')
  assert.equal(r.result.isError, false)
  assert.ok(!r.result.content[0].text.includes(secret))
  await b.dispose()
})

test('prepare([]) (host-sync "ensure proxy") keeps the admitted schemas: tools/call still works afterwards', async () => {
  const agent = { id: 's1' }
  const rt = hostRuntime((exec) => ({ content: [{ type: 'text', text: `ran ${exec.name}` }] }))
  const { b } = bridge({ tools: rt, agents: { get: () => agent } }, { toolApproval: 'host' })
  await b.prepare(schemas, 's-keep')
  assert.deepEqual(b.exposed('s-keep'), ['read', 'web_fetch', 'orchestrator_report'])
  await b.prepare([], 's-keep')
  assert.deepEqual(b.exposed('s-keep'), ['read', 'web_fetch', 'orchestrator_report'])
  const r = await b._handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read', arguments: {} } }, 's-keep')
  assert.equal(r.result.isError, false)
  // a real (non-empty) tool list still replaces the set
  await b.prepare([{ name: 'read', description: 'r' }], 's-keep')
  assert.deepEqual(b.exposed('s-keep'), ['read'])
  assert.equal(await b.prepare([], 'fresh-empty'), null)
  await b.dispose()
})

test('mcp-client tools (mcp__server__tool) via passthrough: approval-gated; no answer → bounded "(timeout)" deny, not a hang', async () => {
  const tools = { get: () => ({ execute: async () => 'should-not-run' }) }
  const agents = { get: () => ({ id: 's', ctx: { tools: { get: () => null } } }) }
  const { b } = bridge({ tools, agents, approval: { request: async () => new Promise(() => {}) } }, { toolAllowlist: ['mcp__*'], approvalTimeoutMs: 80 })
  // Keep the event loop alive while approvalTimeoutMs fires (otherwise a hanging Promise starves the timer).
  const keep = setInterval(() => {}, 1000)
  try {
    await b.prepare([{ name: 'mcp__echo__echo', description: 'e', parameters: { type: 'object', properties: { text: { type: 'string' } } } }], 's-echo')
    const r = await b._handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'mcp__echo__echo', arguments: { text: 'hi' } } }, 's-echo')
    assert.equal(r.result.isError, true); assert.match(r.result.content[0].text, /dsh denied mcp__echo__echo \(timeout\)/)
  } finally { clearInterval(keep); await b.dispose() }
})

test('stale tool index: a connected proxy at an older schema revision is re-registered (new args → new Jiuwen server_id), same revision is reused', async () => {
  const sid = 'rev-s1'
  const name = sessionMcpName('dsh-tools', sid)
  const stateDir = join(tmp, 'state', 's', name.slice('dsh-tools-'.length))
  const st = join(tmp, 'rev-jw.json')
  const cfg = { jiuwenMcpStateFile: st, toolAllowlist: ['*'] }
  // Jiuwen started while schemas.json held another (stale) tool set; record has the pre-revision args.
  writeFileSync(st, JSON.stringify({ mcp: { [name]: { ...proxyRegistration(name, stateDir, 1000), state: 'connected' } } }))
  const a = bridge({}, cfg)
  const r = await a.b.prepare([{ name: 'deep_echo', description: 'e' }], sid)
  assert.deepEqual(a.calls.map(c => c[0]), ['mcp.disconnect', 'mcp.register_custom', 'mcp.connect'])
  assert.equal(r.reconnected, true)
  const rev = schemasRev(JSON.parse(readFileSync(join(stateDir, 'schemas.json'), 'utf8')))
  assert.equal(r.rev, rev); assert.deepEqual(a.calls[1][1].args.slice(2), [`--rev=${rev}`])
  // Gateway now holds the new revision → a second process with the same tools makes no RPC.
  writeFileSync(st, JSON.stringify({ mcp: { [name]: { ...a.calls[1][1], state: 'connected' } } }))
  const b = bridge({}, cfg)
  assert.equal((await b.b.prepare([{ name: 'deep_echo', description: 'e' }], sid)).reused, true)
  assert.equal(b.calls.length, 0)
  // Same names but a changed schema also gets a new revision.
  const c = bridge({}, cfg)
  await c.b.prepare([{ name: 'deep_echo', description: 'e2' }], sid)
  assert.deepEqual(c.calls.map(x => x[0]), ['mcp.disconnect', 'mcp.register_custom', 'mcp.connect'])
  // Another server's record with the same name is not disconnected (only re-registered).
  writeFileSync(st, JSON.stringify({ mcp: { [name]: { name, transport: 'stdio', command: 'other', args: [], state: 'connected' } } }))
  const d = bridge({}, cfg)
  await d.b.prepare([{ name: 'deep_echo', description: 'e3' }], sid)
  assert.deepEqual(d.calls.map(x => x[0]), ['mcp.register_custom', 'mcp.connect'])
  for (const x of [a, b, c, d]) await x.b.dispose()
})

test('proxy ignores the --rev arg', async () => {
  const dir = join(tmp, 'rev-proxy')
  const { mkdirSync } = await import('node:fs'); mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'schemas.json'), JSON.stringify([{ name: 'x', description: 'x', inputSchema: { type: 'object' } }]))
  const p = spawn(process.execPath, [PROXY_PATH, dir, '--rev=abc'], { stdio: ['pipe', 'pipe', 'inherit'] })
  const line = await new Promise((res) => { let buf = ''; p.stdout.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) res(JSON.parse(buf.slice(0, i))) }); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n') })
  assert.deepEqual(line.result.tools.map(t => t.name), ['x'])
  p.stdin.end()
})

test('/jiuwen mcp reports this session\'s per-session passthrough server (was: base name, always "not registered")', async () => {
  const { createJiuwenCommand } = await import('../src/commands.js')
  const name = sessionMcpName('dsh-tools', 'sess-a')
  const b = createMcpBridge({ config: () => ({ mcpServerName: 'dsh-tools' }), services: () => ({}), logger: {}, rpc: async (m, p) => {
    if (m === 'mcp.show' && p.name === name) return { type: 'detail', item: { name, category: 'custom', connection_state: 'connected', tools: [{ name: 'bash' }, { name: 'read' }] } }
    throw new Error(`SkillHub asset not found: ${p?.name}`)
  } })
  const cmd = createJiuwenCommand({ sessions: { ensure: () => ({ jiuwenSessionId: 'j' }) }, gateway: () => ({ mcpList: async () => ({ items: [{ name: 'github', connection_state: 'disconnected' }] }) }), config: () => ({ mcpServerName: 'dsh-tools' }), mcpBridge: b })
  const out = await cmd.run('sess-a', 'mcp')
  assert.match(out, new RegExp(`dsh tool passthrough: ${name} \\(custom, connected, 2 tools\\)`), out)
  assert.equal((await b.verify('sess-a')).registered, true)
})
