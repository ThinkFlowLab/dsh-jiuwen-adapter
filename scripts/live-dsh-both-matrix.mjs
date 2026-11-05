#!/usr/bin/env node
/**
 * Apples-to-apples real-dsh matrix: same prompts through real dsh (real system
 * prompt + tool set) on gateway vs agent-core. Forces a tool round-trip.
 * Never prints keys.
 *
 *   DSH_BIN=... node scripts/live-dsh-both-matrix.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { loadJiuwenDotEnv, jiuwenHome, realHomedir } from '../src/jiuwen-env.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DSH = process.env.DSH_BIN || '/workspace/dsh-rc5/prefix/bin/dsh'
const GW = process.env.JIUWEN_GATEWAY_URL || 'ws://127.0.0.1:19000/ws'
const RESULTS = []
const LATENCY = []

import { createHash } from 'node:crypto'

function fileSha(p) {
  if (!existsSync(p)) return null
  return createHash('sha256').update(readFileSync(p)).digest('hex')
}

function snapshotSums() {
  const jw = jiuwenHome()
  return {
    env: fileSha(join(jw, 'config/.env')),
    config: fileSha(join(jw, 'config/config.yaml')),
    perms: fileSha(join(jw, 'config/user_permissions.yaml')),
  }
}

function record(name, backend, ok, detail = {}) {
  RESULTS.push({ name, backend, ok: Boolean(ok), ...detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${backend}] ${name}${detail.wallMs != null ? ` wall=${Math.round(detail.wallMs)}ms` : ''}${detail.note ? ` — ${detail.note}` : ''}`)
}

/** Build a real headless profile: shipped template + plugin add + valid YAML patch. */
function setupHome(backend) {
  const HOME = mkdtempSync(join(tmpdir(), `dsh-both-${backend}-`))
  const profile = `jw-${backend}`
  const env = { ...process.env, HOME, PATH: `${dirname(DSH)}:${process.env.PATH}` }
  delete env.DSH_HOME

  // 1) materialize shipped headless template (creates package.json + empty patch array)
  const from = spawnSync(DSH, ['--from-default-profile', 'headless', '--profile', profile, 'true'], {
    env, encoding: 'utf8', timeout: 60_000,
  })
  // --from-default-profile may exit non-zero if it still requires a task; profile dir is what matters
  const profDir = join(HOME, '.dsh/profiles', profile)
  if (!existsSync(join(profDir, 'package.json'))) {
    // Fallback: create via plugin add into a fresh profile by copying headless if available
    const shipped = join(dirname(DSH), '../lib/node_modules/@deepseek-ai/dsh')
    throw new Error(`profile not created: ${from.stderr?.slice(-400) || from.stdout?.slice(-200) || 'unknown'}`)
  }

  // 2) plugin add adapter
  const add = spawnSync(DSH, ['plugin', '--profile', profile, 'add', ROOT], {
    env, encoding: 'utf8', timeout: 120_000,
  })
  if (add.status !== 0) {
    throw new Error(`plugin add failed: ${(add.stderr || add.stdout || '').slice(-500)}`)
  }

  // 3) write a valid YAML array patch (replace, never append onto [])
  writeFileSync(join(profDir, 'cordis.patch.yml'), `- id: llm-jiuwen
  config:
    backend: ${backend}
    gatewayURL: ${GW}
    emitUsage: true
- id: agent-default-model
  config:
    provider: jiuwen
    model: jiuwen-default
`)

  const sandbox = join(HOME, 'sandbox')
  mkdirSync(sandbox, { recursive: true })
  writeFileSync(join(sandbox, 'NEEDLE.txt'), 'NEEDLE_CONTENT_99\n')
  return { HOME, profile, sandbox, env }
}

function runPrompt(ctx, prompt, { sessionId, timeoutMs = 90_000 } = {}) {
  return new Promise((resolve) => {
    const trace = join(ctx.HOME, `trace-${randomUUID().slice(0, 8)}.jsonl`)
    const args = ['--profile', ctx.profile, '--json']
    // Newer dsh rejects unknown --session-id; only resume an id we created.
    if (sessionId && ctx._knownSessions?.has(sessionId)) args.push('--session-id', sessionId)
    args.push(prompt)
    const t0 = performance.now()
    const env = {
      ...ctx.env,
      JIUWEN_TRACE_FILE: trace,
      JIUWEN_GATEWAY_URL: GW,
      JIUWEN_HOME: jiuwenHome(),
      JIUWEN_REAL_HOME: realHomedir(),
      // Ensure keys reach both the adapter process and the sidecar child.
      ...(() => {
        const jw = loadJiuwenDotEnv()
        const out = {}
        if (jw.API_KEY) { out.API_KEY = jw.API_KEY; out.JIUWEN_API_KEY = jw.API_KEY }
        if (jw.API_BASE) { out.API_BASE = jw.API_BASE; out.AGENTCORE_API_BASE = jw.API_BASE }
        if (jw.MODEL_NAME) out.MODEL_NAME = jw.MODEL_NAME
        if (jw.MODEL_PROVIDER) out.MODEL_PROVIDER = jw.MODEL_PROVIDER
        return out
      })(),
    }
    const p = spawn(DSH, args, { cwd: ctx.sandbox, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let buf = '', err = '', text = ''
    const usage = { inputTokens: 0, outputTokens: 0 }
    let toolCalls = 0, toolResults = 0, modelMs = null, settled = false, sawSession = sessionId || null
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(kill)
      clearTimeout(grace)
      const wallMs = performance.now() - t0
      try { process.kill(-p.pid, 'SIGTERM') } catch {}
      setTimeout(() => { try { process.kill(-p.pid, 'SIGKILL') } catch {}; try { p.kill('SIGKILL') } catch {} }, 1500)
      if (existsSync(trace)) {
        for (const line of readFileSync(trace, 'utf8').split('\n')) {
          if (!line.trim()) continue
          let e; try { e = JSON.parse(line) } catch { continue }
          if (e.modelMs != null) modelMs = (modelMs || 0) + Number(e.modelMs)
          if (e.kind === 'tool_call' || e.type === 'tool_call') toolCalls++
          if (e.kind === 'tool_result' || e.type === 'tool_result') toolResults++
          if (e.usage) {
            usage.inputTokens += e.usage.inputTokens || e.usage.input_tokens || 0
            usage.outputTokens += e.usage.outputTokens || e.usage.output_tokens || 0
          }
        }
      }
      resolve({
        ok: text.length > 0 || code === 0,
        text, wallMs, modelMs, usage, toolCalls, toolResults,
        err: err.slice(-800), code, trace, sessionId: sawSession,
      })
    }
    const kill = setTimeout(() => finish(124), timeoutMs)
    let grace = null
    p.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        let e; try { e = JSON.parse(line) } catch { continue }
        if (e.type === 'session' && e.sessionId) { sawSession = e.sessionId; (ctx._knownSessions ||= new Set()).add(e.sessionId) }
        if (e.type === 'text') text += e.text || ''
        if (e.type === 'final') text = e.text || text
        if (e.type === 'tool_call' || e.type === 'tool-call') toolCalls++
        if (e.type === 'tool_result' || e.type === 'tool-result') toolResults++
        if (e.type === 'status' && e.phase === 'step_end' && e.usage) {
          usage.inputTokens += e.usage.inputTokens || 0
          usage.outputTokens += e.usage.outputTokens || 0
        }
        // dsh + agent-core may linger after the turn; don't wait for process exit.
        if (e.type === 'final' || (e.type === 'status' && e.phase === 'turn_end')) {
          grace = setTimeout(() => finish(0), 500)
        }
      }
    })
    p.stderr.on('data', (d) => { err += d })
    p.on('close', (code) => finish(code))
  })
}

async function main() {
  if (!existsSync(DSH)) throw new Error(`DSH_BIN missing: ${DSH}`)
  const jw = loadJiuwenDotEnv()
  if (!jw.API_KEY && !process.env.JIUWEN_API_KEY && !process.env.API_KEY) {
    throw new Error('no API_KEY in jiuwen .env / env')
  }
  const before = snapshotSums()
  console.log('live-dsh-both-matrix; model=', jw.MODEL_NAME || process.env.MODEL_NAME, 'gw=', GW, 'jiuwenHome=', jiuwenHome())

  const prompts = {
    plain: 'Reply with exactly BOTH_PLAIN_OK',
    tool: 'Read the file NEEDLE.txt in the current workspace using your file tools. Quote its contents exactly, then say BOTH_TOOL_OK. You MUST use a tool.',
  }

  for (const backend of ['agent-core', 'gateway']) {
    const ctx = setupHome(backend)
    try {
      ctx._knownSessions = new Set()
      const plain = await runPrompt(ctx, prompts.plain, { timeoutMs: 60_000 })
      record('plain-turn', backend, /BOTH_PLAIN_OK/.test(plain.text), {
        wallMs: plain.wallMs, modelMs: plain.modelMs, tokens: plain.usage,
        note: plain.text ? plain.text.slice(0, 80) : `empty code=${plain.code} err=${plain.err.slice(0, 120)}`,
      })
      LATENCY.push({ backend, name: 'plain-turn', wallMs: plain.wallMs, modelMs: plain.modelMs, ...plain.usage })

      const tool = await runPrompt(ctx, prompts.tool, { timeoutMs: 120_000 })
      const toolOk = tool.toolCalls > 0 && tool.toolResults > 0 && /NEEDLE_CONTENT_99/.test(tool.text)
      record('tool-round-trip-forced', backend, toolOk, {
        wallMs: tool.wallMs, modelMs: tool.modelMs, tokens: tool.usage,
        note: toolOk
          ? `calls=${tool.toolCalls} results=${tool.toolResults}`
          : `FAIL calls=${tool.toolCalls} results=${tool.toolResults} text=${(tool.text || tool.err).slice(0, 80)}`,
      })
      LATENCY.push({ backend, name: 'tool-round-trip-forced', wallMs: tool.wallMs, modelMs: tool.modelMs, ...tool.usage })

      let multiOk = true
      let sid = null
      for (let i = 1; i <= 5; i++) {
        const r = await runPrompt(ctx, `Turn ${i}: reply with MT${i}_OK`, { sessionId: sid || undefined, timeoutMs: 60_000 })
        if (!sid && r.sessionId) sid = r.sessionId
        if (!new RegExp(`MT${i}_OK`).test(r.text)) multiOk = false
        LATENCY.push({ backend, name: `multi-turn-${i}`, wallMs: r.wallMs, modelMs: r.modelMs, ...r.usage })
      }
      record('multi-turn-x5', backend, multiOk, { note: 'see latency table' })
    } finally {
      rmSync(ctx.HOME, { recursive: true, force: true })
    }
  }

  const after = snapshotSums()
  let sumsOk = after.env === before.env && after.config === before.config && after.perms === before.perms
  let note = sumsOk ? 'unchanged' : 'CHANGED'
  if (!sumsOk && process.env.JW_SNAP && existsSync(process.env.JW_SNAP)) {
    // External snapshot (guard style): restore config files only.
    spawnSync('bash', ['-c', `cd "$1/files" && find . -type f -print0 | while IFS= read -r -d '' f; do cmp -s "$f" "$2/$f" || cp -p "$f" "$2/$f"; done`, 'restore', process.env.JW_SNAP, jiuwenHome()], { stdio: 'ignore' })
    const restored = snapshotSums()
    sumsOk = restored.env === before.env && restored.config === before.config && restored.perms === before.perms
    note = sumsOk ? 'restored-to-pre-run' : 'CHANGED-after-restore'
  }
  record('jiuwen-checksums', 'both', sumsOk, { note })

  mkdirSync(join(ROOT, 'reports'), { recursive: true })
  writeFileSync(join(ROOT, 'reports/live-dsh-both-matrix.json'), JSON.stringify({ when: new Date().toISOString(), results: RESULTS, latency: LATENCY }, null, 2))

  console.log('\n=== Latency / tokens (real dsh, real system prompt + tools) ===')
  console.log('| backend | prompt | wall_ms | model_ms | input_tok | output_tok |')
  console.log('|---|---|---:|---:|---:|---:|')
  for (const row of LATENCY) {
    console.log(`| ${row.backend} | ${row.name} | ${Math.round(row.wallMs || 0)} | ${row.modelMs != null ? Math.round(row.modelMs) : '—'} | ${row.inputTokens || 0} | ${row.outputTokens || 0} |`)
  }
  const fail = RESULTS.filter((r) => !r.ok).length
  console.log(`\nlive-dsh-both-matrix: ${RESULTS.length - fail}/${RESULTS.length} passed`)
  process.exitCode = fail ? 1 : 0
}

main().catch((e) => {
  console.error('FATAL', String(e?.stack || e).replace(/sk-[A-Za-z0-9]+/g, 'sk-***'))
  process.exit(1)
})
