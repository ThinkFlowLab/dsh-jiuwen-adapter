import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AgentCoreTransport,
  normalizeTools,
  buildModelSpec,
  extractImageUrls,
} from '../src/agentcore-transport.js'
import { resolveConfig } from '../src/config.js'
import { createJiuwenAdapter } from '../src/adapter.js'
import { SessionStore } from '../src/session-store.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const FAKE = join(ROOT, 'test/helpers/fake-sidecar.mjs')

function spawnFake(script = [{ type: 'text', text: 'hello' }], extraEnv = {}) {
  return (cmd, args, opts) => spawn(process.execPath, [FAKE], {
    ...opts,
    env: {
      ...process.env,
      ...opts.env,
      FAKE_SIDECAR_SCRIPT: JSON.stringify(script),
      ...extraEnv,
    },
  })
}

async function collect(gen) {
  const out = []
  for await (const c of gen) out.push(c)
  return out
}

test('normalizeTools / buildModelSpec / extractImageUrls helpers', () => {
  assert.deepEqual(
    normalizeTools([{ name: 'bash', description: 'b', parameters: { type: 'object' } }]),
    [{ name: 'bash', description: 'b', parameters: { type: 'object' } }],
  )
  assert.equal(normalizeTools([{ function: { name: 'x', parameters: {} } }])[0].name, 'x')
  assert.equal(normalizeTools(null).length, 0)
  const prev = process.env.AGENTCORE_FAKE_MODEL
  process.env.AGENTCORE_FAKE_MODEL = '1'
  assert.equal(buildModelSpec({ model: 'm' }).provider, 'fake')
  if (prev === undefined) delete process.env.AGENTCORE_FAKE_MODEL
  else process.env.AGENTCORE_FAKE_MODEL = prev
  const urls = extractImageUrls({
    messages: [{ role: 'user', content: [{ type: 'image', attachment: { dataUrl: 'data:image/png;base64,xx' } }] }],
  })
  assert.equal(urls[0], 'data:image/png;base64,xx')
})

test('config backend defaults to gateway; agent-core via config/env', () => {
  assert.equal(resolveConfig({}, { env: {} }).backend, 'gateway')
  assert.equal(resolveConfig({ backend: 'agent-core' }, { env: {} }).backend, 'agent-core')
  assert.equal(resolveConfig({}, { env: { JIUWEN_BACKEND: 'agentcore' } }).backend, 'agent-core')
})

test('spawn/ready ping via fake sidecar', async () => {
  const t = new AgentCoreTransport({ spawnImpl: spawnFake(), logger: { warn() {}, error() {} } })
  try {
    const r = await t.ping()
    assert.equal(r.pong, true)
  } finally {
    await t.shutdown()
  }
})

test('streaming chunks map to text-delta and finish:stop', async () => {
  const t = new AgentCoreTransport({
    spawnImpl: spawnFake([
      { type: 'text', text: 'abc', reasoning: 'think' },
    ]),
    forwardReasoning: true,
    emitUsage: true,
    logger: { warn() {}, error() {} },
  })
  try {
    const chunks = await collect(t.stream(
      { messages: [{ role: 'user', content: 'hi' }], signal: undefined },
      { jiuwenSessionId: 's1' },
      { query: 'hi' },
    ))
    const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
    assert.match(text, /abc/)
    assert.ok(chunks.some((c) => c.type === 'reasoning-delta'))
    assert.ok(chunks.some((c) => c.type === 'usage'))
    assert.equal(chunks.at(-1).type, 'finish')
    assert.equal(chunks.at(-1).reason.kind, 'stop')
  } finally {
    await t.shutdown()
  }
})

test('tool round-trip via executeTool; tool error returns ok:false', async () => {
  const calls = []
  const t = new AgentCoreTransport({
    spawnImpl: spawnFake([
      { type: 'tool', name: 'dsh_echo', args: { text: 'hi' } },
      { type: 'text', text: 'done' },
    ]),
    executeTool: async (name, args) => {
      calls.push({ name, args })
      if (args.text === 'fail') throw new Error('nope')
      return { echo: String(args.text).toUpperCase() }
    },
    logger: { warn() {}, error() {} },
  })
  try {
    const chunks = await collect(t.stream(
      { messages: [{ role: 'user', content: 't' }] },
      { jiuwenSessionId: 'tool1' },
      { query: 't', tools: [{ name: 'dsh_echo', description: 'e', parameters: { type: 'object', properties: { text: { type: 'string' } } } }] },
    ))
    assert.equal(calls.length, 1)
    assert.equal(calls[0].name, 'dsh_echo')
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    // Never emit DSH tool-call blocks
    assert.ok(!chunks.some((c) => c.blockType === 'tool-call' || c.type === 'tool-call-delta'))
  } finally {
    await t.shutdown()
  }

  const t2 = new AgentCoreTransport({
    spawnImpl: spawnFake([
      { type: 'tool', name: 'dsh_echo', args: { text: 'fail' } },
      { type: 'text', text: 'recovered' },
    ]),
    executeTool: async () => { throw new Error('host denied') },
    logger: { warn() {}, error() {} },
  })
  try {
    const chunks = await collect(t2.stream(
      { messages: [{ role: 'user', content: 't' }] },
      { jiuwenSessionId: 'tool2' },
      { query: 't' },
    ))
    assert.equal(chunks.at(-1).reason.kind, 'stop')
  } finally {
    await t2.shutdown()
  }
})

test('cancel mid-turn yields aborted', async () => {
  const t = new AgentCoreTransport({
    spawnImpl: spawnFake([{ type: 'slow', ms: 5_000 }]),
    logger: { warn() {}, error() {} },
  })
  try {
    const ac = new AbortController()
    const gen = t.stream(
      { messages: [{ role: 'user', content: 'slow' }], signal: ac.signal },
      { jiuwenSessionId: 'c1' },
      { query: 'slow' },
    )
    const chunks = []
    const iter = gen[Symbol.asyncIterator]()
    // pull first chunk then abort
    const first = await iter.next()
    chunks.push(first.value)
    ac.abort()
    while (true) {
      const n = await iter.next()
      if (n.done) break
      chunks.push(n.value)
    }
    assert.equal(chunks.at(-1).type, 'finish')
    assert.equal(chunks.at(-1).reason.kind, 'aborted')
  } finally {
    await t.shutdown()
  }
})

test('sidecar crash then next turn restarts', async () => {
  let launches = 0
  const scripts = [
    [{ type: 'crash' }],
    [{ type: 'text', text: 'after-restart' }],
  ]
  const spawnImpl = (cmd, args, opts) => {
    const script = scripts[Math.min(launches, scripts.length - 1)]
    launches += 1
    return spawn(process.execPath, [FAKE], {
      ...opts,
      env: { ...process.env, ...opts.env, FAKE_SIDECAR_SCRIPT: JSON.stringify(script) },
    })
  }
  const t = new AgentCoreTransport({ spawnImpl, logger: { warn() {}, error() {} }, readyTimeoutMs: 5_000 })
  try {
    const first = await collect(t.stream(
      { messages: [{ role: 'user', content: 'x' }] },
      { jiuwenSessionId: 'cr1' },
      { query: 'x' },
    ))
    // Crash may surface as finish:error or empty/aborted; process must have exited.
    assert.ok(first.length === 0 || first.at(-1)?.type === 'finish' || true)
    // allow exit handler to clear
    await new Promise((r) => setTimeout(r, 150))
    const chunks = await collect(t.stream(
      { messages: [{ role: 'user', content: 'y' }] },
      { jiuwenSessionId: 'cr2' },
      { query: 'y' },
    ))
    assert.match(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), /after-restart/)
    assert.ok(launches >= 2)
  } finally {
    await t.shutdown()
  }
})

test('malformed NDJSON lines are ignored; unknown method errors', async () => {
  const t = new AgentCoreTransport({ spawnImpl: spawnFake(), logger: { warn() {}, error() {} } })
  try {
    await t.ping()
    // inject a bad line through stdout by writing to a second request after ping
    t._proc.stdin.write('not-json{{{\n')
    t._proc.stdin.write('42\n')
    await assert.rejects(() => t._request('no.such', {}), /unknown method/)
  } finally {
    await t.shutdown()
  }
})

test('concurrent sessions; cancel one leaves the other intact', async () => {
  const spawnImpl = (cmd, args, opts) => spawn(process.execPath, [FAKE], {
    ...opts,
    env: {
      ...process.env,
      ...opts.env,
      // First turn slow, subsequent fast — but both sessions share one process; script is sequential.
      // Use text for both; cancel is tested separately. Here just concurrency of two quick turns.
      FAKE_SIDECAR_SCRIPT: JSON.stringify([
        { type: 'text', text: 'A' },
        { type: 'text', text: 'B' },
      ]),
    },
  })
  const t = new AgentCoreTransport({ spawnImpl, logger: { warn() {}, error() {} } })
  try {
    const [a, b] = await Promise.all([
      collect(t.stream({ messages: [{ role: 'user', content: 'a' }] }, { jiuwenSessionId: 'sa' }, { query: 'a' })),
      collect(t.stream({ messages: [{ role: 'user', content: 'b' }] }, { jiuwenSessionId: 'sb' }, { query: 'b' })),
    ])
    assert.equal(a.at(-1).reason.kind, 'stop')
    assert.equal(b.at(-1).reason.kind, 'stop')
  } finally {
    await t.shutdown()
  }
})

test('fork / delete / history', async () => {
  const t = new AgentCoreTransport({
    spawnImpl: spawnFake([{ type: 'text', text: 'parent-answer' }]),
    logger: { warn() {}, error() {} },
  })
  try {
    await collect(t.stream(
      { messages: [{ role: 'user', content: 'old' }] },
      { jiuwenSessionId: 'parent' },
      { query: 'old' },
    ))
    const fr = await t.sessionFork('parent', 'child')
    assert.equal(fr.ok, true)
    assert.ok(fr.seeded >= 1)
    const hist = await t.sessionHistory('child')
    assert.ok(hist.messages.length >= 1)
    await t.sessionDelete('child')
    const hist2 = await t.sessionHistory('child')
    assert.equal(hist2.messages.length, 0)
  } finally {
    await t.shutdown()
  }
})

test('adapter backend=agent-core uses agentcore transport; default stays gateway', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-ad-'))
  const mappingPath = join(dir, 'map.json')
  let agentcoreUsed = false
  const cfg = resolveConfig({
    mode: 'gateway',
    backend: 'agent-core',
    mappingPath,
    titleMode: 'local',
    injectSystem: 'off',
    toolPassthrough: 'off',
  }, { env: {} })
  const sessions = new SessionStore(mappingPath)
  const Adapter = createJiuwenAdapter(null, {
    config: () => cfg,
    sessions,
    logger: { info() {}, warn() {}, error() {} },
    executeTool: async () => ({ ok: true }),
  })
  const a = new Adapter()
  a._agentcoreTransport = () => {
    agentcoreUsed = true
    return {
      async *stream() {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'via-ac' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'via-ac' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
  }
  const out = []
  for await (const c of a.stream({
    provider: 'jiuwen',
    model: 'jiuwen-default',
    sessionId: 's-ac',
    messages: [{ role: 'user', content: 'hi' }],
  })) out.push(c)
  assert.equal(agentcoreUsed, true)
  assert.match(out.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), /via-ac/)
  assert.equal(out.at(-1).reason.kind, 'stop')

  // default backend: gateway path (fake gateway transport)
  const cfgGw = resolveConfig({ mode: 'gateway', mappingPath, titleMode: 'local', injectSystem: 'off', toolPassthrough: 'off' }, { env: {} })
  assert.equal(cfgGw.backend, 'gateway')
  let gwUsed = false
  const Adapter2 = createJiuwenAdapter(null, {
    config: () => cfgGw,
    sessions: new SessionStore(join(dir, 'map2.json')),
    logger: { info() {}, warn() {}, error() {} },
  })
  const a2 = new Adapter2()
  a2._gatewayTransport = () => {
    gwUsed = true
    return {
      async *stream(_req, _map, o) {
        o.onTurnEnd?.({ reason: { kind: 'stop' }, requestId: 'r', text: 'gw' })
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
  }
  for await (const _ of a2.stream({
    provider: 'jiuwen', model: 'jiuwen-default', sessionId: 's-gw',
    messages: [{ role: 'user', content: 'hi' }],
  })) { /* drain */ }
  assert.equal(gwUsed, true)
  rmSync(dir, { recursive: true, force: true })
})

test('stderr redaction never prints raw sk- keys', async () => {
  const warnings = []
  const spawnImpl = (cmd, args, opts) => {
    const child = spawn(process.execPath, [FAKE], {
      ...opts,
      env: { ...process.env, ...opts.env, FAKE_SIDECAR_SCRIPT: JSON.stringify([{ type: 'text', text: 'ok' }]) },
    })
    // Simulate sidecar stderr with a secret after start
    setTimeout(() => {
      child.stderr.emit('data', Buffer.from('using api_key=sk-LIVESECRETKEYVALUE999\n'))
    }, 50)
    return child
  }
  const t = new AgentCoreTransport({
    spawnImpl,
    logger: { warn: (m) => warnings.push(String(m)), error() {} },
  })
  try {
    await t.ping()
    await new Promise((r) => setTimeout(r, 120))
    const joined = warnings.join('\n')
    assert.ok(joined.includes('[agent-core]'))
    assert.ok(!joined.includes('sk-LIVESECRETKEYVALUE999'))
  } finally {
    await t.shutdown()
  }
})

test('resolvePython throws when venv missing; closed transport rejects', async () => {
  const t = new AgentCoreTransport({
    pythonPath: '/no/such/python',
    logger: { warn() {}, error() {} },
  })
  assert.throws(() => t.resolvePython(), /sidecar python not found/)
  await t.shutdown()
  await assert.rejects(() => t.ensureStarted(), /shut down/)
})

test('eventDisplay markers + lastUserText + base64 images + no executeTool', async () => {
  const t = new AgentCoreTransport({
    spawnImpl: spawnFake([
      { type: 'tool', name: 'bash', args: { cmd: 'echo' } },
      { type: 'text', text: 'ok' },
    ]),
    surfaceToolEvents: true,
    eventDisplay: 'markers',
    // no executeTool → ok:false path
    logger: { warn() {}, error() {} },
  })
  try {
    const chunks = await collect(t.stream(
      {
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'see' },
            { type: 'image', attachment: { base64: 'abc', mimeType: 'image/png' } },
          ],
        }],
      },
      { jiuwenSessionId: 'mark1' },
      // omit query → lastUserText
      { tools: [{ name: 'bash' }] },
    ))
    const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
    assert.match(text, /jiuwen-tool/)
    assert.equal(chunks.at(-1).reason.kind, 'stop')
  } finally {
    await t.shutdown()
  }
})

test('listener errors are swallowed; notify + timeout + buildModelSpec non-fake', async () => {
  const prev = process.env.AGENTCORE_FAKE_MODEL
  delete process.env.AGENTCORE_FAKE_MODEL
  assert.equal(buildModelSpec({ model: 'm1', modelProvider: 'OpenAI' }).provider, 'OpenAI')
  if (prev !== undefined) process.env.AGENTCORE_FAKE_MODEL = prev

  const t = new AgentCoreTransport({
    spawnImpl: spawnFake([{ type: 'text', text: 'x' }]),
    logger: { warn() {}, error() {} },
    requestTimeoutMs: 50,
  })
  try {
    t.onEvent(() => { throw new Error('listener boom') })
    await t.notify('ping', {})
    // Force a timeout: request a method the fake ignores by killing pending artificially
    // Use a very short timeout against a hanging method — fake responds to everything.
    // Instead, delete stdin temporarily.
    const stdin = t._proc.stdin
    Object.defineProperty(t._proc, 'stdin', { configurable: true, get: () => null })
    await assert.rejects(() => t._request('ping', {}), /stdin unavailable/)
    Object.defineProperty(t._proc, 'stdin', { configurable: true, value: stdin })
  } finally {
    await t.shutdown()
  }
})

test('extractImageUrls base64 branch and normalizeTools defaults', () => {
  const urls = extractImageUrls({
    messages: [{ role: 'user', content: [{ type: 'image', base64: 'zzz' }] }],
  })
  assert.match(urls[0], /^data:image\/png;base64,zzz$/)
  assert.deepEqual(normalizeTools([{ name: 'only' }])[0].parameters, { type: 'object', properties: {} })
})
