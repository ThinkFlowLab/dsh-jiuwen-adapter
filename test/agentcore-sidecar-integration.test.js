/**
 * Integration: real Python sidecar with AGENTCORE_FAKE_MODEL=1 (offline).
 * Skips when .venv-sidecar is missing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentCoreTransport } from '../src/agentcore-transport.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PY = join(ROOT, '.venv-sidecar', 'bin', 'python')
const hasSidecar = existsSync(PY)

async function collect(gen) {
  const out = []
  for await (const c of gen) out.push(c)
  return out
}

function wrapSpawn(wrapperPath, ckpt) {
  return (cmd, args, opts) => spawn(PY, [wrapperPath], {
    ...opts,
    cwd: ROOT,
    env: {
      ...process.env,
      ...opts.env,
      AGENTCORE_FAKE_MODEL: '1',
      LLM_SSL_VERIFY: 'false',
      DSH_JIUVEN_AC_DIR: ckpt,
      PYTHONPATH: ROOT,
      PYTHONUNBUFFERED: '1',
    },
  })
}

test('real sidecar: ping + default fake turn finishes', { skip: !hasSidecar }, async () => {
  const ckpt = mkdtempSync(join(tmpdir(), 'ac-int-'))
  const t = new AgentCoreTransport({
    pythonPath: PY,
    cwd: ROOT,
    checkpointDir: ckpt,
    env: { AGENTCORE_FAKE_MODEL: '1', LLM_SSL_VERIFY: 'false', PYTHONPATH: ROOT },
    logger: { warn() {}, error() {} },
    readyTimeoutMs: 90_000,
    requestTimeoutMs: 120_000,
  })
  try {
    assert.equal((await t.ping()).pong, true)
    const chunks = await collect(t.stream(
      { messages: [{ role: 'user', content: 'hello' }] },
      { jiuwenSessionId: 'int1' },
      {
        query: 'hello',
        system: 'test',
        tools: [],
        model: { provider: 'fake', api_base: 'http://127.0.0.1:9/v1', api_key_env: 'NO_KEY', model: 'fake' },
      },
    ))
    assert.equal(chunks.at(-1).type, 'finish')
  } finally {
    await t.shutdown()
    rmSync(ckpt, { recursive: true, force: true })
  }
})

test('real sidecar: tool callback + fork/history + cancel', { skip: !hasSidecar }, async () => {
  const ckpt = mkdtempSync(join(tmpdir(), 'ac-int2-'))
  const wrapper = join(ckpt, 'wrap.py')
  writeFileSync(wrapper, `
import os, sys, json
os.environ["AGENTCORE_FAKE_MODEL"] = "1"
os.environ.setdefault("LLM_SSL_VERIFY", "false")
root = ${JSON.stringify(ROOT)}
sys.path.insert(0, root)
from openjiuwen.core.foundation.llm import AssistantMessage, ToolCall
from sidecar import fake_model
fake_model.install_fake_model()
fake_model.reset_script([
  AssistantMessage(content="", reasoning_content="r", tool_calls=[ToolCall(id="c1", type="function", name="dsh_echo", arguments=json.dumps({"text": "hi"}))]),
  AssistantMessage(content="done"),
  AssistantMessage(content="SLOW"),
  AssistantMessage(content="after-cancel"),
  AssistantMessage(content="child-ok"),
])
from sidecar.__main__ import main
main()
`)
  const calls = []
  const t = new AgentCoreTransport({
    pythonPath: PY,
    cwd: ROOT,
    checkpointDir: ckpt,
    spawnImpl: wrapSpawn(wrapper, ckpt),
    logger: { warn() {}, error() {} },
    executeTool: async (name, args) => {
      calls.push({ name, args })
      return { echo: String(args.text || '').toUpperCase() }
    },
    readyTimeoutMs: 90_000,
    requestTimeoutMs: 180_000,
  })
  try {
    const chunks = await collect(t.stream(
      { messages: [{ role: 'user', content: 'tool' }] },
      { jiuwenSessionId: 't1' },
      {
        query: 'tool',
        tools: [{
          name: 'dsh_echo',
          description: 'echo',
          parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        }],
        model: { provider: 'fake', model: 'fake', api_base: 'http://127.0.0.1:9/v1', api_key_env: 'NO_KEY' },
      },
    ))
    assert.equal(calls.length, 1)
    assert.equal(calls[0].name, 'dsh_echo')
    assert.equal(chunks.at(-1).reason.kind, 'stop')

    // cancel a slow turn then continue
    const ac = new AbortController()
    const gen = t.stream(
      { messages: [{ role: 'user', content: 'slow' }], signal: ac.signal },
      { jiuwenSessionId: 't2' },
      { query: 'slow', tools: [], model: { provider: 'fake', model: 'fake', api_base: 'http://127.0.0.1:9/v1', api_key_env: 'NO_KEY' } },
    )
    const it = gen[Symbol.asyncIterator]()
    await it.next()
    ac.abort()
    let last
    while (true) {
      const n = await it.next()
      if (n.done) break
      last = n.value
    }
    assert.equal(last?.reason?.kind, 'aborted')

    const next = await collect(t.stream(
      { messages: [{ role: 'user', content: 'next' }] },
      { jiuwenSessionId: 't2' },
      { query: 'next', tools: [], model: { provider: 'fake', model: 'fake', api_base: 'http://127.0.0.1:9/v1', api_key_env: 'NO_KEY' } },
    ))
    assert.equal(next.at(-1).reason.kind, 'stop')

    await t.sessionFork('t1', 'child')
    const hist = await t.sessionHistory('child')
    assert.ok(Array.isArray(hist.messages))
  } finally {
    await t.shutdown()
    rmSync(ckpt, { recursive: true, force: true })
  }
})
