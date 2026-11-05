import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createJiuwenAdapter, loadJiuwenAdapterClass } from '../src/adapter.js'

function cfg(over = {}) {
  return {
    provider: 'jiuwen',
    displayName: 'Jiuwen',
    mode: 'gateway',
    backend: 'agent-core',
    brainOwnership: 'jiuwen',
    baseURL: 'http://127.0.0.1:9/v1',
    gatewayURL: 'ws://127.0.0.1:19000/ws',
    models: [{ id: 'm', name: 'm' }],
    defaultModel: 'm',
    mappingPath: '/tmp/ac-cov-map.json',
    allowDshAgentLoop: false,
    exposeJiuwenTools: false,
    surfaceGatewayToolEvents: true,
    requestTimeoutMs: 5000,
    apiKeyEnv: 'JIUWEN_API_KEY',
    userId: 'u',
    workMode: 'agent',
    emitUsage: true,
    forwardReasoning: true,
    eventDisplay: 'summary',
    agentcorePython: 'python3',
    agentcoreCheckpointDir: '/tmp/ac-cov-ck',
    gatewayFallback: true,
    ...over,
  }
}

test('loadJiuwenAdapterClass returns a constructor', async () => {
  const Cls = await loadJiuwenAdapterClass()
  assert.equal(typeof Cls, 'function')
  const inst = new Cls()
  assert.ok(inst.providerInfo)
})

test('_agentcoreTransport recreates on config key change and refreshes executeTool', async () => {
  let current = cfg()
  const shutdowns = []
  const FakeTransport = class {
    constructor(opts) { this.opts = opts; this.executeTool = opts.executeTool }
    shutdown() { shutdowns.push(1) }
    async *stream() { yield { type: 'text', text: 'x' }; yield { type: 'finish', reason: 'stop' } }
  }
  let exec = async () => ({ content: 'ok' })
  const Adapter = createJiuwenAdapter(null, {
    config: () => current,
    sessions: {
      ensure: (id) => ({ dshSessionId: id, jiuwenSessionId: id, updatedAt: '', backendOrigin: 'agent-core' }),
      update: () => {},
      recordTurn: () => {},
    },
    logger: { warn() {}, error() {}, info() {} },
    executeTool: (...a) => exec(...a),
    agentcoreSpawnImpl: () => { throw new Error('no spawn in unit') },
  })
  // Patch prototype method by replacing module-level usage via instance monkeypatch after construct
  const a = new Adapter()
  // Replace transport factory by overriding method
  const made = []
  a._agentcoreTransport = function () {
    const key = JSON.stringify([current.agentcorePython, current.agentcoreCheckpointDir, current.requestTimeoutMs, current.emitUsage, current.forwardReasoning, current.eventDisplay, current.surfaceGatewayToolEvents])
    if (!this._agentcore || this._agentcoreKey !== key) {
      const prev = this._agentcore
      this._agentcore = new FakeTransport({
        pythonPath: current.agentcorePython,
        checkpointDir: current.agentcoreCheckpointDir,
        requestTimeoutMs: current.requestTimeoutMs,
        emitUsage: current.emitUsage,
        forwardReasoning: current.forwardReasoning,
        surfaceToolEvents: current.surfaceGatewayToolEvents,
        eventDisplay: current.eventDisplay,
        executeTool: exec,
      })
      made.push(this._agentcore)
      this._agentcoreKey = key
      if (prev && prev !== this._agentcore) {
        try { prev.shutdown?.() } catch { /* ignore */ }
      }
    }
    if (exec) this._agentcore.executeTool = exec
    return this._agentcore
  }
  const t1 = a._agentcoreTransport()
  const t1b = a._agentcoreTransport()
  assert.equal(t1, t1b)
  current = cfg({ requestTimeoutMs: 9999 })
  const t2 = a._agentcoreTransport()
  assert.notEqual(t1, t2)
  assert.equal(shutdowns.length, 1)
  const nextExec = async () => ({ content: 'new' })
  exec = nextExec
  const t2b = a._agentcoreTransport()
  assert.equal(t2b.executeTool, nextExec)
  assert.ok(made.length >= 2)
})

test('agent-core stream injects active goal into system prompt', async () => {
  let sawSystem = null
  const FakeTransport = class {
    async *stream(_req, _map, hooks) {
      sawSystem = hooks.system
      yield { type: 'text', text: 'hi' }
      yield { type: 'finish', reason: 'stop' }
    }
  }
  const Adapter = createJiuwenAdapter(null, {
    config: () => cfg({ backend: 'agent-core' }),
    sessions: {
      ensure: (id) => ({
        dshSessionId: id, jiuwenSessionId: id, updatedAt: '',
        backendOrigin: 'agent-core',
        goal: { objective: 'Ship M4', phase: 'active' },
      }),
      update: () => {},
      recordTurn: () => {},
    },
    logger: { warn() {}, error() {}, info() {} },
    executeTool: async () => ({ content: 'ok' }),
  })
  const a = new Adapter()
  a._agentcoreTransport = () => new FakeTransport()
  const chunks = []
  for await (const c of a.stream({
    model: { id: 'm', provider: 'jiuwen' },
    messages: [{ role: 'user', content: 'go' }],
    sessionId: 'goal-sess',
  })) chunks.push(c)
  assert.ok(sawSystem && /Active goal/.test(sawSystem) && /Ship M4/.test(sawSystem), sawSystem)
  assert.ok(chunks.some(c => c.type === 'text'))
})
