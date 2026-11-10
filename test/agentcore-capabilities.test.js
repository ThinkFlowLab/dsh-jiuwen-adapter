/**
 * agentcore native capabilities: config → per-turn features, host tool hiding, host.request answers,
 * and an offline end-to-end turn against the real sidecar (fake model).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveAgentcoreFeatures, buildTurnFeatures, filterHostTools, anyAgentcoreFeature } from '../src/agentcore-features.js'
import { AgentCoreTransport, answerHostRequest } from '../src/agentcore-transport.js'
import { resolveConfig } from '../src/config.js'
import { validateConfig } from '../src/config-validate.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PY = join(ROOT, '.venv-sidecar', 'bin', 'python')
const hasSidecar = existsSync(PY)
const T = (name) => ({ name, description: name, parameters: { type: 'object', properties: {} } })

test('agentcore config: everything off by default; config + env merge; validator accepts the object', () => {
  const f = resolveAgentcoreFeatures(undefined, {})
  assert.equal(anyAgentcoreFeature(f), false)
  assert.equal(buildTurnFeatures(f, { tools: [T('skill')] }).features, undefined)
  assert.equal(anyAgentcoreFeature(resolveConfig({}, {}).agentcore), false)
  const g = resolveAgentcoreFeatures({ skills: true }, { AGENTCORE_FEATURES: '{"planning":{"enabled":true}}' })
  assert.ok(g.skills.enabled && g.planning.enabled)
  assert.ok(resolveAgentcoreFeatures({}, { AGENTCORE_FEATURES: 'not json' }))
  assert.equal(resolveAgentcoreFeatures({ interrupts: true }, {}).interrupts.enabled, false, 'interrupts need askUser or confirmTools')
  assert.equal(resolveAgentcoreFeatures({ memory: 'true', rag: 7 }, {}).memory.enabled, true)
  assert.deepEqual(validateConfig({ agentcore: { skills: true } }), [])
  assert.ok(validateConfig({ agentcore: [1] }).some(w => /"agentcore" should be an object/.test(w)))
})

test('buildTurnFeatures: native skills/planning/subagents/ask_user replace host tools; secrets never cross', () => {
  const f = resolveAgentcoreFeatures({
    skills: { mode: 'auto_list', maxSkills: 3 }, planning: { progressReminder: true, interval: 5 },
    memory: { scope: 'project', coding: true, embedding: { model: 'e', apiBase: 'http://x', apiKeyEnv: 'EMB_KEY', apiKey: 'inline' }, external: { provider: 'mem0', apiKeyEnv: 'M0', options: { host: 'h', api_key: 'inline', token: 't' }, userId: 'u' } },
    subagents: { async: true, taskLoop: true, agents: [{ name: 'rev', description: 'd', systemPrompt: 'p', maxIterations: 4 }, { bogus: 1 }] },
    interrupts: { askUser: true, confirmTools: ['bash'] }, security: true, anomaly: true, heartbeat: true,
    progressiveTools: { limit: 7 }, sysOperation: { readOnly: false, code: true }, mcp: { servers: [{ server_name: 'm' }], resources: true },
    kvCache: true, moa: { referenceModels: ['ref-a', { model: 'ref-b', apiKeyEnv: 'RB' }], mode: 'aggregator_on_demand' },
    rag: { paths: ['/docs'], maxFiles: 9 }, otel: { exporter: 'file', tracesDir: '/t', serviceName: 's', endpoint: 'e' },
  }, {})
  const tools = ['skill', 'todo_write', 'subagent', 'ask_user', 'bash'].map(T)
  const mapping = { skillBodies: [{ name: 'demo', content: 'BODY', description: 'desc' }] }
  const { features: x, hide, nativeSkills } = buildTurnFeatures(f, { tools, mapping })
  assert.ok(nativeSkills)
  assert.deepEqual([...hide].sort(), ['ask_user', 'skill', 'subagent', 'todo_write'])
  assert.deepEqual(filterHostTools(tools, hide).map(t => t.name), ['bash'])
  assert.equal(filterHostTools(tools, new Set()), tools)
  assert.deepEqual(x.skills, { enabled: true, mode: 'auto_list', items: [{ name: 'demo', content: 'BODY', description: 'desc' }], host_loader: 'skill', max_skills: 3 })
  assert.deepEqual(x.planning, { enabled: true, mirror_tool: 'todo_write', progress_reminder: true, interval: 5 })
  assert.deepEqual(x.memory.embedding, { model: 'e', api_base: 'http://x', api_key_env: 'EMB_KEY' })
  assert.deepEqual(x.memory.external, { provider: 'mem0', options: { host: 'h' }, api_key_env: 'M0', user_id: 'u' })
  assert.ok(!JSON.stringify(x).includes('inline'), 'no inline secrets on the wire')
  assert.equal(x.memory.scope, 'project')
  assert.deepEqual(x.subagents.agents, [{ name: 'rev', description: 'd', system_prompt: 'p', max_iterations: 4 }])
  assert.deepEqual(x.interrupts, { ask_user: true, confirm_tools: ['bash'] })
  assert.deepEqual(x.sys_operation, { enabled: true, read_only: false, code: true })
  assert.deepEqual(x.moa.reference_models, [{ model: 'ref-a' }, { model: 'ref-b', api_key_env: 'RB' }])
  assert.deepEqual(x.rag, { enabled: true, paths: ['/docs'], max_files: 9 })
  assert.deepEqual(x.otel, { enabled: true, exporter: 'file', endpoint: 'e', traces_dir: '/t', service_name: 's' })
  assert.ok(x.security && x.anomaly && x.heartbeat && x.kv_cache && x.progressive_tools.limit === 7 && x.mcp.resources)

  // No host loader / todo tool: skills still native (bodies), no mirror, nothing hidden.
  const y = buildTurnFeatures(resolveAgentcoreFeatures({ skills: true, planning: true, sysOperation: true }, {}), { tools: [T('bash')] })
  assert.equal(y.features.skills.host_loader, undefined)
  assert.equal(y.features.planning.mirror_tool, undefined)
  assert.equal(y.features.sys_operation.read_only, true, 'sys_operation defaults read-only')
  assert.equal(y.hide.size, 0)
})

test('answerHostRequest: permission/interaction through the dsh interactor, fail closed', async () => {
  assert.deepEqual(await answerHostRequest({ kind: 'permission', tool: 'bash' }), { allow: false, outcome: 'no-interactive-host' })
  const seen = []
  const interact = async (q) => { seen.push(q); return q.payload.source === 'agentcore_ask_user' ? { answers: [{ selected_options: ['A'] }, { custom_input: 'typed' }] } : { outcome: seen.length === 1 ? 'allowed-once' : 'rejected' } }
  assert.deepEqual(await answerHostRequest({ kind: 'permission', tool: 'bash', args: { command: 'ls' } }, interact), { allow: true, outcome: 'allowed-once' })
  assert.equal(seen[0].payload.source, 'permission_interrupt')
  assert.equal(seen[0].payload.tool_name, 'bash')
  const c = await answerHostRequest({ kind: 'interaction', request: { tool_name: 'bash', message: 'Run it?', tool_args: { command: 'rm' } } }, interact)
  assert.deepEqual(c, { answer: { approved: false, feedback: 'denied by dsh (rejected)' }, outcome: 'rejected' })
  assert.equal(seen[1].payload.source, 'confirm_interrupt')
  const a = await answerHostRequest({ kind: 'interaction', request: { questions: [{ question: 'Q1' }, { question: 'Q2' }] } }, interact)
  assert.deepEqual(a.answer, { answers: { Q1: 'A', Q2: 'typed' } })
  assert.equal(seen[2].told, true)
  const none = await answerHostRequest({ kind: 'interaction', request: { questions: [{ question: 'Q' }] } }, async () => null)
  assert.deepEqual(none.answer, { answers: {} })
  assert.equal((await answerHostRequest({ kind: 'interaction', request: {} })).answer.approved, false)
  assert.match((await answerHostRequest({ kind: 'weird' }, interact)).outcome, /unsupported/)
})

function wrapSpawn(wrapperPath, ckpt) {
  return (cmd, args, opts) => spawn(PY, [wrapperPath], {
    ...opts, cwd: ROOT,
    env: { ...process.env, ...opts.env, AGENTCORE_FAKE_MODEL: '1', LLM_SSL_VERIFY: 'false', DSH_JIUVEN_AC_DIR: ckpt, PYTHONPATH: ROOT, PYTHONUNBUFFERED: '1' },
  })
}

async function collect(gen) { const out = []; for await (const c of gen) out.push(c); return out }

test('real sidecar: native skills load via host skill tool, todos mirror to todo_write, native IO tools are dsh-gated', { skip: !hasSidecar, timeout: 240_000 }, async () => {
  const ckpt = mkdtempSync(join(tmpdir(), 'ac-caps-'))
  const wrapper = join(ckpt, 'wrap.py')
  writeFileSync(wrapper, `
import os, sys, json
os.environ["AGENTCORE_FAKE_MODEL"] = "1"
sys.path.insert(0, ${JSON.stringify(ROOT)})
from openjiuwen.core.foundation.llm import AssistantMessage, ToolCall
from sidecar import fake_model
fake_model.install_fake_model()
tc = lambda i, n, a: ToolCall(id=i, type="function", name=n, arguments=json.dumps(a))
fake_model.reset_script([
  AssistantMessage(content="", tool_calls=[tc("c1", "skill_tool", {"skill_name": "demo"})]),
  AssistantMessage(content="", tool_calls=[tc("c2", "todo_create", {"todos": [{"id": "1", "content": "Step A", "activeForm": "Doing A", "description": "a", "status": "in_progress"}]})]),
  AssistantMessage(content="done1"),
  AssistantMessage(content="", tool_calls=[tc("c3", "read_file", {"file_path": "/etc/hostname"})]),
  AssistantMessage(content="done2"),
])
from sidecar.__main__ import main
main()
`)
  const calls = []
  const asks = []
  const t = new AgentCoreTransport({
    pythonPath: PY, cwd: ROOT, checkpointDir: ckpt, spawnImpl: wrapSpawn(wrapper, ckpt), logger: { warn() {}, error() {} },
    executeTool: async (name, args) => { calls.push({ name, args }); return name === 'skill' ? 'SKILL BODY FROM DSH' : { ok: true } },
    readyTimeoutMs: 90_000, requestTimeoutMs: 180_000,
  })
  const model = { provider: 'fake', model: 'fake', api_base: 'http://127.0.0.1:9/v1', api_key_env: 'NO_KEY' }
  const f = resolveAgentcoreFeatures({ skills: true, planning: true, sysOperation: true }, {})
  const all = [T('skill'), T('todo_write'), T('dsh_echo')]
  try {
    const turn1 = buildTurnFeatures(f, { tools: all, mapping: { skillBodies: [{ name: 'demo', content: 'mirror body' }] } })
    const events = []
    const c1 = await collect(t.stream({ messages: [{ role: 'user', content: 'go' }] }, { jiuwenSessionId: 'cap1' }, {
      query: 'go', tools: filterHostTools(all, turn1.hide), features: turn1.features, model, onEvent: (e) => events.push(e),
      interact: async (q) => { asks.push(q); return { outcome: 'rejected' } },
    }))
    assert.equal(c1.at(-1).reason.kind, 'stop')
    assert.deepEqual(calls.map(c => c.name), ['skill', 'todo_write'], JSON.stringify(events.filter(e => e.type === 'chunk' && /tool/.test(e.chunkType)).map(e => e.payload)))
    assert.deepEqual(calls[0].args, { name: 'demo' })
    assert.deepEqual(calls[1].args, { todos: [{ content: 'Step A', status: 'in_progress' }] })
    assert.ok(events.some(e => e.type === 'tool_call' && e.name === 'todo_write' && e.mirror === true))
    assert.ok(events.some(e => e.type === 'native_tool_call' && e.name === 'skill_tool'))
    assert.ok(events.some(e => e.type === 'native_tool_call' && e.name === 'todo_create'))
    assert.ok(!events.some(e => e.type === 'native_tool_call' && e.name === 'todo_write'))
    assert.equal(asks.length, 0, 'host and internal tools are never re-asked')

    const c2 = await collect(t.stream({ messages: [{ role: 'user', content: 'read' }] }, { jiuwenSessionId: 'cap1' }, {
      query: 'read', tools: filterHostTools(all, turn1.hide), features: turn1.features, model, onEvent: (e) => events.push(e),
      interact: async (q) => { asks.push(q); return { outcome: 'rejected' } },
    }))
    assert.equal(c2.at(-1).reason.kind, 'stop')
    assert.equal(asks.length, 1)
    assert.equal(asks[0].payload.tool_name, 'read_file')
    assert.ok(events.some(e => e.type === 'host_request' && e.kind === 'permission' && e.outcome === 'rejected'))
    assert.equal(calls.length, 2, 'denied native tool did not reach dsh')

    const st = await t.capabilitiesStatus('cap1')
    assert.ok(st.active && st.info.skills && st.info.planning && st.gateAsked.includes('read_file'))
    assert.ok(st.tools.includes('skill_tool') && st.tools.includes('todo_create') && !st.tools.includes('todo_write'))
    const mem = await t.memoryOp({ op: 'list', sid: 'cap1' })
    assert.equal(mem.ok, true)
  } finally {
    await t.shutdown()
    rmSync(ckpt, { recursive: true, force: true })
  }
})

test('facade + /jiuwen commands: capabilities and native memory ops', async () => {
  const { createAgentCoreFacade } = await import('../src/agentcore-facade.js')
  const { EXT } = await import('../src/commands-ext.js')
  const ops = []
  const ac = {
    capabilitiesStatus: async (sid) => ({ ok: true, active: true, info: { memory: { root: '/x' } }, gateAsked: ['bash'], tools: ['memory_search'], sid }),
    memoryOp: async (p) => { ops.push(p); return p.op === 'list' ? { ok: true, files: [{ path: 'MEMORY.md', bytes: 3 }] } : p.op === 'show' ? { ok: true, path: p.path, content: 'hello' } : p.op === 'search' ? { ok: true, query: p.query, mode: 'keyword', hits: [{ path: 'MEMORY.md', line: 1, text: 'hello' }] } : { ok: true, removed: 1 } },
  }
  const sessions = { get: (id) => (id === 'd1' ? { dshSessionId: 'd1', jiuwenSessionId: 'j1', projectDir: '/proj' } : undefined), list: () => [], update() {} }
  const facade = createAgentCoreFacade({ sessions, getConfig: () => ({ models: [], agentcore: resolveAgentcoreFeatures({ memory: { scope: 'project' } }, {}) }), getAgentcore: () => ac, state: {} })
  const caps = await facade.rpc('agentcore.capabilities', { session_id: 'd1' })
  assert.deepEqual(caps.configured, ['memory'])
  assert.equal(caps.live.sid, 'j1')
  assert.deepEqual(await facade.rpc('agentcore.memory', { session_id: 'd1', op: 'clear' }), { ok: false, error: 'clear needs confirm' })
  const g = { rpc: (m, p) => facade.rpc(m, p) }
  assert.match(await EXT.memory.run({ g, rest: ['list'], sid: 'd1' }), /MEMORY\.md \(3 B\)/)
  assert.match(await EXT.memory.run({ g, rest: ['show'], sid: 'd1' }), /hello/)
  assert.match(await EXT.memory.run({ g, rest: ['search', 'hel'], sid: 'd1' }), /MEMORY\.md:1/)
  assert.match(await EXT.memory.run({ g, rest: ['search'], sid: 'd1' }), /Usage/)
  assert.match(await EXT.memory.run({ g, rest: ['clear'], sid: 'd1' }), /clear confirm/)
  assert.match(await EXT.memory.run({ g, rest: ['clear', 'confirm'], sid: 'd1' }), /cleared \(1 files\)/)
  assert.equal(ops[0].sid, 'j1')
  assert.equal(ops[0].cwd, '/proj')
  assert.equal(ops[0].features.memory.scope, 'project')
  assert.equal(ops.at(-1).confirm, true)
  const text = await EXT.capabilities.run({ g, sid: 'd1' })
  assert.match(text, /memory/)
  assert.match(text, /dsh-gated native tools asked: bash/)
  const status = await facade.rpc('memory.status', { session_id: 'd1' })
  assert.ok(status.providers.some(p => p.name === 'agentcore-native' && p.available === true))
})
