// Smoke test against the real @deepseek-ai/dsh-tools ToolRuntime (+ dsh-user-approval, timeout policy):
// Jiuwen passthrough under toolApproval 'host' must behave like a native dsh call.
// Set DSH_PKG_DIR to a directory holding the @deepseek-ai/* packages; skipped when absent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createMcpBridge } from '../src/mcp-bridge.js'

const D = process.env.DSH_PKG_DIR || (process.env.DSH_NM ? join(process.env.DSH_NM, '@deepseek-ai') : '/tmp/dshpre/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
const has = ['cordis', 'dsh-tools', 'dsh-user-approval', 'dsh-system-prompt', 'dsh-tool-call-timeout-policy'].every(p => existsSync(join(D, p, 'lib', 'index.js')))
const load = (p) => import(pathToFileURL(join(D, p, 'lib', 'index.js')).href)

async function host(policy) {
  const cordis = await load('cordis')
  const ctx = new cordis.Context()
  await ctx.plugin((await load('dsh-system-prompt')).default)
  const tools = await load('dsh-tools')
  await ctx.plugin(tools.ToolRuntime, {})
  await ctx.plugin((await load('dsh-user-approval')).ApprovalService, { policy })
  await ctx.plugin(await load('dsh-tool-call-timeout-policy'))
  const T = ctx.get('tools')
  const ran = []; const post = []; const results = []
  const out = { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] }
  T.register(tools.defineTool({ name: 'write', description: 'write a file', parameters: { path: { type: 'string', required: true } }, output: out,
    execute: async (a) => { ran.push(a.path); return `wrote ${a.path}` } }))
  T.register(tools.defineTool({ name: 'slow', description: 'slow', timeoutMs: 50, parameters: {}, output: out,
    execute: (_a, exec) => new Promise((res) => exec.signal.addEventListener('abort', () => res('stopped'))) }))
  // A native-style pre-execute policy: `ask` for one path, allow otherwise (like danger-full-access).
  ctx.on('tools/pre-execute', async (exec, next) => (exec.arguments?.path === 'needs-ask' ? { kind: 'ask', reason: 'outside sandbox' } : next()))
  ctx.on('tools/post-execute', async (exec, result, next) => { post.push(exec.name); return next() })
  ctx.on('tools/result', (exec, r) => { results.push([exec.name, r.isError]) })
  const events = []
  const session = { get seq() { return events.length }, eventAt: (s) => events[s], append: (type, data) => { events.push({ type, data }) } }
  session.append('turn/start', {})
  const agent = { id: 'jw-1', session, inject() {} }
  return { ctx, T, agent, ran, post, results, events, approval: ctx.get('approval') }
}

function bridgeFor(h, cfg = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jw-host-'))
  const b = createMcpBridge({
    config: () => ({ toolAllowlist: ['*'], approvalTimeoutMs: 1000, toolCallTimeoutMs: 2000, mcpServerName: 'dsh-tools', mcpStateDir: join(dir, 's'), jiuwenMcpStateFile: join(dir, 'jw.json'), mcpGcOnStart: false, ...cfg }),
    services: () => ({ tools: h.T, approval: h.approval, agents: { get: () => h.agent } }),
    rpc: async () => ({}),
  })
  return { b, cleanup: async () => { await b.dispose(); rmSync(dir, { recursive: true, force: true }) } }
}
const call = (b, name, args) => b._handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, 'jw-1')
const schemas = [{ name: 'write', description: 'w' }, { name: 'slow', description: 's' }]

test('real dsh-tools: policy never + allow → host runs write (legacy gate denied it); post-execute + tools/result fire', { skip: !has && 'dsh packages not installed' }, async () => {
  const h = await host('never')
  const { b, cleanup } = bridgeFor(h)
  await b.prepare(schemas, 'jw-1')
  const r = await call(b, 'write', { path: 'a.txt' })
  assert.equal(r.result.isError, false, r.result.content[0].text)
  assert.equal(r.result.content[0].text, 'wrote a.txt')
  assert.deepEqual(h.ran, ['a.txt'])
  assert.deepEqual(h.post, ['write']); assert.deepEqual(h.results, [['write', false]])
  assert.ok(!h.events.some(e => e.type === 'approval/asked'), 'no approval asked for an allowed call')
  await cleanup()
  // Same host, legacy gate: approval policy never rejects every call (the reported bug).
  const legacy = bridgeFor(h, { toolApproval: 'dsh', toolApprovalExempt: [] })
  await legacy.b.prepare(schemas, 'jw-1')
  const d = await call(legacy.b, 'write', { path: 'b.txt' })
  assert.equal(d.result.isError, true); assert.match(d.result.content[0].text, /dsh denied write \(rejected\)/)
  assert.deepEqual(h.ran, ['a.txt'])
  await legacy.cleanup()
})

test('real dsh-tools: a real ask under policy never is rejected by dsh (never fails open); under ask it routes to approval/request', { skip: !has && 'dsh packages not installed' }, async () => {
  const h = await host('never')
  const { b, cleanup } = bridgeFor(h)
  await b.prepare(schemas, 'jw-1')
  const r = await call(b, 'write', { path: 'needs-ask' })
  assert.equal(r.result.isError, true); assert.match(r.result.content[0].text, /rejected tool "write"/)
  assert.deepEqual(h.ran, [])
  const asked = h.events.find(e => e.type === 'approval/asked')
  assert.equal(asked.data.toolName, 'write'); assert.match(String(asked.data.callId), /^jiuwen-/)
  assert.deepEqual(h.post, ['write'], 'post-execute still sees the denial, as natively')
  await cleanup()
  const h2 = await host('ask')
  h2.ctx.on('approval/request', async () => 'allowed-once')
  const two = bridgeFor(h2)
  await two.b.prepare(schemas, 'jw-1')
  const ok = await call(two.b, 'write', { path: 'needs-ask' })
  assert.equal(ok.result.isError, false, ok.result.content[0].text); assert.deepEqual(h2.ran, ['needs-ask'])
  await two.cleanup()
})

test("real dsh-tools: dsh's own per-tool timeout policy applies (TOOL_TIMEOUT)", { skip: !has && 'dsh packages not installed' }, async () => {
  const h = await host('never')
  const { b, cleanup } = bridgeFor(h)
  await b.prepare(schemas, 'jw-1')
  const r = await call(b, 'slow', {})
  assert.equal(r.result.isError, true); assert.match(r.result.content[0].text, /timed out after 50ms/)
  await cleanup()
})
