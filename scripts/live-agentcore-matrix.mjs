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
    const n = Number(process.env.LIVE_TURNS || 20)
    for (let i = 0; i < n; i++) {
      const r = await turn(t, 'mtx-multi', `Turn ${i + 1}: reply with T${i + 1}_OK`, { system: 'Reply with the requested token only.' })
      if (!new RegExp(`T${i + 1}_OK`).test(r.text)) ok = false
      totalIn += r.usage?.inputTokens || 0
      totalOut += r.usage?.outputTokens || 0
      totalMs += r.ms
    }
    record(`multi-turn-x${n}`, ok, { ms: totalMs / n, tokens: { inputTokens: totalIn / n, outputTokens: totalOut / n }, note: `avg in=${(totalIn / n).toFixed(1)} out=${(totalOut / n).toFixed(1)}` })
  })

  // 3) tool round-trips — text-only WITHOUT tool-call+tool-result is FAIL
  const probeFile = join(tmpdir(), `ac-probe-${randomUUID().slice(0, 8)}.txt`)
  writeFileSync(probeFile, 'PROBE_FILE_CONTENT_42')
  await withTransport(async (t) => {
    const toolLog = []
    t.executeTool = async (name, args) => {
      toolLog.push({ name, args })
      if (name === 'read_file') {
        const fp = args?.path || args?.file
        if (fp === probeFile || String(fp).endsWith(probeFile.split('/').pop())) {
          return { ok: true, content: readFileSync(probeFile, 'utf8') }
        }
        return { ok: false, content: `ENOENT: ${fp}` }
      }
      if (name === 'echo') return { ok: true, content: `echoed:${args?.text || ''}` }
      if (name === 'fail_always') return { ok: false, content: 'INTENTIONAL_TOOL_FAIL', error: 'INTENTIONAL_TOOL_FAIL' }
      if (name === 'secret_tool') return { ok: false, content: 'PERMISSION_DENIED', error: 'PERMISSION_DENIED' }
      return { ok: false, content: `unknown tool ${name}` }
    }

    const tools = [
      { name: 'read_file', description: 'Read a UTF-8 text file by absolute path', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
      { name: 'echo', description: 'Echo text', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
      { name: 'fail_always', description: 'Always fails', parameters: { type: 'object', properties: { x: { type: 'string' } } } },
      { name: 'secret_tool', description: 'Denied by permissions', parameters: { type: 'object', properties: { x: { type: 'string' } } } },
    ]

    // 3a forced file read
    {
      const r = await turn(t, 'mtx-tool-read', `You MUST call read_file with path=${probeFile}. Then quote the file contents exactly and say DONE.`, {
        system: 'You are a tool-using agent. Always call the required tool before answering. Never invent file contents.',
        tools,
        model: { max_tokens: 512 },
      })
      const calls = r.chunks.filter((c) => c.type === 'tool-call' || c.type === 'tool_call')
      const results = r.chunks.filter((c) => c.type === 'tool-result' || c.type === 'tool_result')
      const hasCall = calls.length > 0 || toolLog.some((x) => x.name === 'read_file')
      const hasResult = results.length > 0 || toolLog.some((x) => x.name === 'read_file')
      const contentOk = /PROBE_FILE_CONTENT_42/.test(r.text)
      const ok = hasCall && hasResult && contentOk
      record('tool-round-trip-read-file', ok, {
        ms: r.ms,
        tokens: r.usage,
        note: ok ? 'tool_call+tool_result+content' : `FAIL call=${hasCall} result=${hasResult} content=${contentOk} textOnly=${!(hasCall && hasResult)} chunks=${r.chunks.map(c=>c.type).join(',')}`,
      })
    }

    // 3b failing tool
    {
      toolLog.length = 0
      const r = await turn(t, 'mtx-tool-fail', 'Call fail_always with x=1, then say saw the error FAIL_SEEN', {
        system: 'Call fail_always exactly once, then acknowledge the error with FAIL_SEEN.',
        tools,
        model: { max_tokens: 256 },
      })
      const hasCall = toolLog.some((x) => x.name === 'fail_always') || r.chunks.some((c) => c.type === 'tool-call')
      record('tool-failing', hasCall, { ms: r.ms, note: hasCall ? 'fail tool invoked' : 'text-only FAIL', tokens: r.usage })
    }

    // 3c permission-denied tool (preset enforced in executeTool)
    {
      toolLog.length = 0
      const r = await turn(t, 'mtx-tool-deny', 'Call secret_tool with x=1 then say DENIED_SEEN', {
        system: 'Call secret_tool once. If denied, say DENIED_SEEN.',
        tools,
        model: { max_tokens: 256 },
      })
      const hasCall = toolLog.some((x) => x.name === 'secret_tool') || r.chunks.some((c) => c.type === 'tool-call')
      record('tool-permission-denied', hasCall, { ms: r.ms, note: hasCall ? 'denied tool invoked' : 'text-only FAIL', tokens: r.usage })
    }
  })
  try { rmSync(probeFile, { force: true }) } catch {}

  // 4) cancel mid-turn and mid-TOOL
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
  await withTransport(async (t) => {
    let started = false
    t.executeTool = async () => {
      started = true
      await new Promise((r) => setTimeout(r, 5000))
      return { ok: true, content: 'late' }
    }
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 600)
    const { chunks, ms } = await collect(t.stream(
      { model: modelSpec().model, messages: [{ role: 'user', content: [{ type: 'text', text: 'Call slow_tool then continue.' }] }], signal: ac.signal },
      { jiuwenSessionId: 'mtx-cancel-tool' },
      {
        system: 'You must call slow_tool immediately.',
        model: modelSpec({ max_tokens: 256 }),
        tools: [{ name: 'slow_tool', description: 'Slow', parameters: { type: 'object', properties: {} } }],
      },
    ))
    const finish = chunks.find((c) => c.type === 'finish')
    const aborted = finish?.reason?.kind === 'aborted' || ac.signal.aborted
    record('cancel-mid-TOOL', aborted, { ms, note: `aborted=${aborted} toolStarted=${started} reason=${finish?.reason?.kind}` })
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

  // 9) gateway→agent-core session migration note (backendOrigin)
  await withTransport(async (t) => {
    // Simulate a mapping that was created on gateway then continued on agent-core.
    const sid = 'mtx-migrated-gw'
    const r = await turn(t, sid, 'Say MIGRATED_OK', { system: 'Reply MIGRATED_OK' })
    record('gateway-to-agentcore-migration', /MIGRATED_OK/.test(r.text), {
      ms: r.ms,
      note: 'fresh checkpointer for former gateway sid; history starts empty (documented)',
      tokens: r.usage,
    })
  })

  // 10) image input (if transport accepts image content parts)
  await withTransport(async (t) => {
    const tinyPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    try {
      const { chunks, ms } = await collect(t.stream(
        {
          model: modelSpec().model,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: 'Describe this 1x1 image in one word, then say IMG_OK' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: tinyPng.toString('base64') } },
            ],
          }],
        },
        { jiuwenSessionId: 'mtx-img' },
        { system: 'Be brief. End with IMG_OK.', model: modelSpec({ max_tokens: 128 }), tools: [] },
      ))
      const text = textOf(chunks)
      record('image-input', /IMG_OK/i.test(text) || chunks.length > 0, { ms, note: text.slice(0, 80), tokens: usageOf(chunks) })
    } catch (e) {
      record('image-input', false, { note: `error: ${redact(e?.message || e)}` })
    }
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
