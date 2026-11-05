/**
 * Gateway-mode features against bin/mock-gateway.mjs (real Jiuwen wire shapes):
 * structured events, reasoning, usage, processing_status filtering, legacy markers,
 * session continuity, cancel → chat.interrupt, per-request agent/mode/skills/model,
 * multimodal base64Data, ask_user, extra E2A RPCs.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as plugin from '../index.js'
import { GatewayTransport } from '../src/gateway-transport.js'
import { spawnMockGateway } from './helpers/spawn-mock-gateway.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
let URL_
let gw, dir

function host(config = {}) {
  const adapters = new Map()
  const ctx = {
    llm: { registerAdapter(ids, a) { ids.forEach(i => adapters.set(i, a)); return () => {} } },
    logger: { info() {}, warn() {}, error() {} },
    provide(n, v) { this[n] = v }, on() {},
  }
  plugin.apply(ctx, { backend: 'gateway', gatewayURL: URL_, mappingPath: join(dir, `m-${Math.random()}.json`), finalGraceMs: 300, ...config })
  const a = adapters.get('jiuwen')
  return {
    api: ctx.jiuwenAdapter,
    async run(o) {
      const chunks = []
      for await (const c of a.stream({ provider: 'jiuwen', model: 'jiuwen-default', sessionId: 's', ...o })) chunks.push(c)
      return chunks
    },
  }
}
const txt = cs => cs.filter(c => c.type === 'text-delta').map(c => c.text).join('')
const rsn = cs => cs.filter(c => c.type === 'reasoning-delta').map(c => c.text).join('')
const user = t => [{ role: 'user', content: t }]
const debug = () => new GatewayTransport({ gatewayURL: URL_ }).rpc('debug.state', {})

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jw-feat-'))
  gw = await spawnMockGateway()
  URL_ = gw.url
})
after(async () => { await gw?.stop(); rmSync(dir, { recursive: true, force: true }) })

import { extractPersona, applySystemInjection, latestSystemText, capBytes } from '../src/system-inject.js'
import { resolveConfig as loadConfig } from '../src/config.js'

const PROFILE = { personaSections: ['^# Identity\\s*$', '^# Group\\s*$'], personaStop: ['^## Team rules\\s*$'], personaAlways: [{ match: "^- Reply in the user's language\\.\\s*$", line: "Reply in the user's language." }], groupEvents: ['host/group-changed'] }
const HOSTSYS = [
  '# Tools', 'bash: run commands', '',
  '# Identity', 'You are Ada, a bot on the user\'s team. Your role: 编辑.', '', 'Write haiku only.', '',
  '## Team rules', '- Call list_bots whenever.', '- Reply in the user\'s language.', '',
  '# Group', 'Members: the user and you.', '',
  '# Environment', 'cwd=/tmp',
].join('\n')

test('extractPersona keeps identity/instructions/group/language, drops tool/env/team rules', () => {
  const p = extractPersona(HOSTSYS, PROFILE)
  assert.match(p, /You are Ada/); assert.match(p, /Write haiku only/); assert.match(p, /# Group/)
  assert.match(p, /Reply in the user's language/)
  assert.doesNotMatch(p, /bash: run|list_bots|cwd=/)
  assert.equal(extractPersona('plain system without markers', PROFILE), '')
})

test('applySystemInjection: off/no markers → unchanged; hash gates resend; latest in-history system wins; cap', () => {
  const opts = { system: HOSTSYS, messages: user('hi') }
  assert.equal(applySystemInjection('hi', opts, {}, 'off').query, 'hi')
  assert.equal(applySystemInjection('hi', { system: 'x', messages: [] }, {}, 'persona').query, 'hi')
  const a = applySystemInjection('hi', opts, { jiuwenSessionId: 'j' }, 'persona', undefined, undefined, 'full', PROFILE)
  assert.match(a.query, /^\[System instructions from host\]\n# Identity[\s\S]*\[\/System\]\n\nhi$/)
  assert.equal(applySystemInjection('hi', opts, { jiuwenSessionId: 'j', systemHash: a.hash }, 'persona', undefined, undefined, 'full', PROFILE).query, 'hi')
  assert.notEqual(applySystemInjection('hi', opts, { jiuwenSessionId: 'k', systemHash: a.hash }, 'persona', undefined, undefined, 'full', PROFILE).hash, undefined)
  const f = applySystemInjection('hi', opts, {}, 'full'); assert.match(f.query, /cwd=\/tmp/)
  assert.equal(latestSystemText({ system: 'old', messages: [{ role: 'system', content: 'a' }, { role: 'user', content: 'u' }, { role: 'system', content: 'new' }] }), 'new')
  assert.ok(Buffer.byteLength(capBytes('é'.repeat(9000), 8192)) <= 8192)
  assert.equal(applySystemInjection('q', { get messages() { throw new Error('boom') } }, {}, 'full').query, 'q')
})

test('config defaults: injectSystem full, trajectoryDetail full; bad values fall back', () => {
  const c = loadConfig({}, { env: {} }); assert.equal(c.injectSystem, 'full'); assert.equal(c.trajectoryDetail, 'full')
  const d = loadConfig({ injectSystem: 'nope', trajectoryDetail: 'FULL' }, { env: {} }); assert.equal(d.injectSystem, 'full'); assert.equal(d.trajectoryDetail, 'full')
})

test('config opt-outs: off / summary still valid via raw and env', () => {
  const c = loadConfig({ injectSystem: 'off', trajectoryDetail: 'summary' }, { env: {} }); assert.equal(c.injectSystem, 'off'); assert.equal(c.trajectoryDetail, 'summary')
  const e = loadConfig({}, { env: { JIUWEN_INJECT_SYSTEM: 'off', JIUWEN_TRAJECTORY_DETAIL: 'summary' } }); assert.equal(e.injectSystem, 'off'); assert.equal(e.trajectoryDetail, 'summary')
})

test('live: persona sent once per Jiuwen session, resent on change', async () => {
  const h = host({ injectSystem: 'persona', hostProfile: PROFILE })
  const t1 = await h.run({ sessionId: 'p1', system: HOSTSYS, messages: user('echo-params first') })
  assert.match(txt(t1), /System instructions from host/)
  const t2 = await h.run({ sessionId: 'p1', system: HOSTSYS, messages: [...user('echo-params first'), { role: 'assistant', content: 'x' }, ...user('echo-params second')] })
  assert.match(txt(t2), /query="echo-params second"/)
  const t3 = await h.run({ sessionId: 'p1', system: HOSTSYS.replace('haiku', 'limericks'), messages: [...user('a'), { role: 'assistant', content: 'x' }, ...user('echo-params third')] })
  assert.match(txt(t3), /limericks/)
})

test('trajectoryDetail=full renders structured steps in reasoning, no tool-call blocks; summary unchanged', async () => {
  const full = await host({ trajectoryDetail: 'full' }).run({ messages: user('ping') })
  const r = rsn(full)
  assert.match(r, /#### Step 1 · 🔧 Tool call: `bash`/)
  assert.match(r, /\*\*Arguments\*\*\n\n```json\n\{\n  "command": "echo ok"\n\}\n```/)
  assert.match(r, /\*\*Result\*\* ✓ `bash`/)
  assert.ok(!full.some(c => c.type === 'tool-call' || c.blockType === 'tool-call'))
  assert.equal(txt(full), 'pong-from-gateway-mock')
  const sum = rsn(await host({ trajectoryDetail: 'summary' }).run({ messages: user('ping') }))
  assert.match(sum, /🔧 bash \{"command":"echo ok"\}/); assert.doesNotMatch(sum, /#### Step/)
})
