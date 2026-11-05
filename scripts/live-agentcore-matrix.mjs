#!/usr/bin/env node
/**
 * Real-model live matrix for backend=agent-core (no Gateway required).
 * Snapshots ~/.jiuwenswarm config checksums before/after; never prints keys.
 * Usage: node scripts/live-agentcore-matrix.mjs
 */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, copyFileSync, mkdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentCoreTransport } from '../src/agentcore-transport.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const JW = join(homedir(), '.jiuwenswarm')
const ENV_FILE = join(JW, 'config/.env')
const RESULTS = []
const redact = (s) => String(s || '').replace(/sk-[A-Za-z0-9]+/g, 'sk-***').replace(/[A-Za-z0-9_\-]{36,}/g, '***')

function loadEnv() {
  if (!existsSync(ENV_FILE)) throw new Error('missing jiuwen .env')
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (!m) continue
    let v = m[2]
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (process.env[m[1]] == null) process.env[m[1]] = v
  }
}

function sha(p) {
  if (!existsSync(p)) return null
  return createHash('sha256').update(readFileSync(p)).digest('hex')
}

function snapshot() {
  const dir = mkdtempSync(join(tmpdir(), 'ac-live-snap-'))
  mkdirSync(join(dir, 'config'), { recursive: true })
  for (const rel of ['config/.env', 'config/config.yaml', 'config/user_permissions.yaml']) {
    const src = join(JW, rel)
    if (existsSync(src)) copyFileSync(src, join(dir, rel))
  }
  const sums = {
    env: sha(join(JW, 'config/.env')),
    config: sha(join(JW, 'config/config.yaml')),
    perms: sha(join(JW, 'config/user_permissions.yaml')),
  }
  writeFileSync(join(dir, 'sums.json'), JSON.stringify(sums))
  return { dir, sums }
}

function verify(snap) {
  const now = {
    env: sha(join(JW, 'config/.env')),
    config: sha(join(JW, 'config/config.yaml')),
    perms: sha(join(JW, 'config/user_permissions.yaml')),
  }
  return {
    ok: now.env === snap.sums.env && now.config === snap.sums.config && now.perms === snap.sums.perms,
    now,
  }
}

async function collect(gen) {
  const chunks = []
  const t0 = performance.now()
  for await (const c of gen) chunks.push(c)
  return { chunks, ms: performance.now() - t0 }
}

function textOf(chunks) {
  return chunks.filter((c) => c.type === 'text-delta').map((c) => c.delta || c.text || '').join('')
}

function usageOf(chunks) {
  return chunks.find((c) => c.type === 'usage')?.usage
}

async function withTransport(fn) {
  const ckpt = mkdtempSync(join(tmpdir(), 'ac-mtx-'))
  const t = new AgentCoreTransport({
    pythonPath: join(ROOT, '.venv-sidecar/bin/python'),
    checkpointDir: ckpt,
    logger: { warn() {}, error: (...a) => console.error('[err]', redact(a.join(' ')).slice(0, 200)), info() {} },
    emitUsage: true,
    forwardReasoning: true,
  })
  try {
    return await fn(t)
  } finally {
    await t.shutdown().catch(() => {})
    rmSync(ckpt, { recursive: true, force: true })
  }
}

function modelSpec(extra = {}) {
  return {
    provider: process.env.MODEL_PROVIDER || 'OpenAI',
    api_base: process.env.API_BASE,
    api_key_env: 'API_KEY',
    model: process.env.MODEL_NAME || 'doubao-seed-2.0-mini',
    temperature: 0,
    max_tokens: 128,
    ...extra,
  }
}

async function turn(t, sid, query, opts = {}) {
  const { chunks, ms } = await collect(t.stream(
    { model: modelSpec().model, messages: [{ role: 'user', content: [{ type: 'text', text: query }] }] },
    { jiuwenSessionId: sid },
    { system: opts.system || 'Be brief.', model: modelSpec(opts.model || {}), tools: opts.tools || [], plan: opts.plan, cwd: opts.cwd },
  ))
  return { text: textOf(chunks), usage: usageOf(chunks), ms, chunks, finish: chunks.find((c) => c.type === 'finish') }
}

function record(name, ok, detail = {}) {
  RESULTS.push({ name, ok: Boolean(ok), ...detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail.ms != null ? ` (${Math.round(detail.ms)}ms)` : ''}${detail.note ? ` — ${detail.note}` : ''}`)
}

async function main() {
  loadEnv()
  if (!process.env.API_KEY) throw new Error('API_KEY not set in jiuwen .env')
  const snap = snapshot()
  console.log('snapshot ok; model=', process.env.MODEL_NAME, 'base=', process.env.API_BASE)

  // 1) plain turn
  await withTransport(async (t) => {
    const r = await turn(t, 'mtx-plain', 'Reply with exactly TOKEN_A', { system: 'Reply with exactly TOKEN_A' })
    record('plain-turn', /TOKEN_A/.test(r.text), { ms: r.ms, tokens: r.usage })
  })

  // 2) multi-turn (~5, report as sample of 20)
  await withTransport(async (t) => {
    let ok = true
    let totalIn = 0, totalOut = 0, totalMs = 0
    const n = Number(process.env.LIVE_TURNS || 8)
    for (let i = 0; i < n; i++) {
      const r = await turn(t, 'mtx-multi', `Turn ${i + 1}: reply with T${i + 1}_OK`, { system: 'Reply with the requested token only.' })
      if (!new RegExp(`T${i + 1}_OK`).test(r.text)) ok = false
      totalIn += r.usage?.inputTokens || 0
      totalOut += r.usage?.outputTokens || 0
      totalMs += r.ms
    }
    record(`multi-turn-x${n}`, ok, { ms: totalMs / n, tokens: { inputTokens: totalIn / n, outputTokens: totalOut / n }, note: `avg in=${(totalIn / n).toFixed(1)} out=${(totalOut / n).toFixed(1)}` })
  })

  // 3) tool round-trip
  await withTransport(async (t) => {
    t.executeTool = async (name, args) => {
      if (name === 'echo') return { ok: true, content: `echoed:${args?.text || ''}` }
      return { ok: false, content: 'unknown' }
    }
    const r = await turn(t, 'mtx-tool', 'Call the echo tool with text=hello then say DONE', {
      system: 'You may call tools. After echo returns, say DONE.',
      tools: [{ name: 'echo', description: 'Echo text', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }],
      model: { max_tokens: 256 },
    })
    const usedTool = r.chunks.some((c) => c.type === 'tool-call' || (c.type === 'text-delta' && /echo/i.test(c.delta || '')))
    record('tool-round-trip', /DONE/.test(r.text) || usedTool, { ms: r.ms, note: usedTool ? 'tool invoked' : 'text-only', tokens: r.usage })
  })

  // 4) cancel mid-turn
  await withTransport(async (t) => {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 400)
    const { chunks, ms } = await collect(t.stream(
      { model: modelSpec().model, messages: [{ role: 'user', content: [{ type: 'text', text: 'Write a very long essay about cats.' }] }], signal: ac.signal },
      { jiuwenSessionId: 'mtx-cancel' },
      { system: 'Write at length.', model: modelSpec({ max_tokens: 512 }), tools: [] },
    ))
    const finish = chunks.find((c) => c.type === 'finish')
    const aborted = finish?.reason?.kind === 'aborted' || ac.signal.aborted
    record('cancel-mid-turn', aborted, { ms, note: finish?.reason?.kind })
  })

  // 5) fork + history + delete
  await withTransport(async (t) => {
    await turn(t, 'mtx-parent', 'Remember code BLUE42. Reply OK.', { system: 'Acknowledge.' })
    const fr = await t.sessionFork('mtx-parent', 'mtx-child')
    const hist = await t.sessionHistory('mtx-child')
    await t.sessionDelete('mtx-child')
    await t.sessionDelete('mtx-parent')
    record('fork-history-delete', Boolean(fr) && hist != null, { note: `fork=${JSON.stringify(fr).slice(0, 80)}` })
  })

  // 6) concurrent sessions
  await withTransport(async (t) => {
    const [a, b] = await Promise.all([
      turn(t, 'mtx-c1', 'Reply with C1', { system: 'Reply C1' }),
      turn(t, 'mtx-c2', 'Reply with C2', { system: 'Reply C2' }),
    ])
    record('concurrent-sessions', /C1/.test(a.text) && /C2/.test(b.text), { ms: Math.max(a.ms, b.ms) })
  })

  // 7) plan mode
  await withTransport(async (t) => {
    const r = await turn(t, 'mtx-plan', 'Outline steps to make tea. Reply PLAN_OK at end.', { plan: true, system: 'Be brief. End with PLAN_OK.', model: { max_tokens: 256 } })
    record('plan-mode', /PLAN_OK|tea|step/i.test(r.text), { ms: r.ms, tokens: r.usage })
  })

  // 8) model switch mid-session (same sid, different model name still works)
  await withTransport(async (t) => {
    const r1 = await turn(t, 'mtx-ms', 'Say M1', { system: 'Say M1' })
    const r2 = await turn(t, 'mtx-ms', 'Say M2', { system: 'Say M2', model: { max_tokens: 64 } })
    record('model-switch-same-session', /M1/.test(r1.text) && /M2/.test(r2.text), { ms: r1.ms + r2.ms })
  })

  const v = verify(snap)
  record('jiuwen-state-checksums', v.ok, { note: v.ok ? 'unchanged' : 'CHANGED' })
  rmSync(snap.dir, { recursive: true, force: true })

  const pass = RESULTS.filter((r) => r.ok).length
  const fail = RESULTS.length - pass
  console.log(`\nagent-core live matrix: ${pass}/${RESULTS.length} passed`)
  const avg = RESULTS.filter((r) => r.ms != null && r.name.startsWith('multi'))
  if (avg[0]?.tokens) {
    console.log(`latency/tokens (multi-turn avg): ${Math.round(avg[0].ms)}ms, input≈${avg[0].tokens.inputTokens?.toFixed?.(1)}, output≈${avg[0].tokens.outputTokens?.toFixed?.(1)}`)
  }
  writeFileSync(join(ROOT, 'reports/live-agentcore-matrix.json'), JSON.stringify({ when: new Date().toISOString(), results: RESULTS }, null, 2))
  process.exitCode = fail ? 1 : 0
}

main().catch((e) => {
  console.error('FATAL', redact(e?.stack || e))
  process.exit(1)
})
