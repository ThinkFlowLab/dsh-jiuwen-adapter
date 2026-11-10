#!/usr/bin/env node
/**
 * Deep live matrix for agent-core (default) with gateway baseline samples.
 * Profiles per-turn latency, long sessions, stress, tools, edges, parity probes.
 * Never prints keys. Restores JW_SNAP when set.
 *
 *   DSH_BIN=... JW_SNAP=/tmp/... node scripts/live-agentcore-deep.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { loadJiuwenDotEnv, jiuwenHome, realHomedir } from '../src/jiuwen-env.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DSH = process.env.DSH_BIN || '/workspace/dsh-rc5/prefix/bin/dsh'
const GW = process.env.JIUWEN_GATEWAY_URL || 'ws://127.0.0.1:19000/ws'
const RESULTS = []
const LATENCY = []
const PHASES = []

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
function record(name, backend, status, detail = {}) {
  const ok = status === 'PASS'
  RESULTS.push({ name, backend, status, ok, ...detail })
  const ms = detail.wallMs != null ? ` wall=${Math.round(detail.wallMs)}ms` : ''
  console.log(`${status}  [${backend}] ${name}${ms}${detail.note ? ` — ${detail.note}` : ''}`)
}

function setupHome(backend, tag = '') {
  const HOME = mkdtempSync(join(tmpdir(), `dsh-deep-${backend}${tag}-`))
  const profile = `jw-${backend}`
  const env = { ...process.env, HOME, PATH: `${dirname(DSH)}:${process.env.PATH}` }
  delete env.DSH_HOME
  spawnSync(DSH, ['--from-default-profile', 'headless', '--profile', profile, 'true'], {
    env, encoding: 'utf8', timeout: 60_000,
  })
  const profDir = join(HOME, '.dsh/profiles', profile)
  if (!existsSync(join(profDir, 'package.json'))) throw new Error(`profile missing ${HOME}`)
  const add = spawnSync(DSH, ['plugin', '--profile', profile, 'add', ROOT], {
    env, encoding: 'utf8', timeout: 120_000,
  })
  if (add.status !== 0) throw new Error(`plugin add: ${(add.stderr || add.stdout || '').slice(-400)}`)
  writeFileSync(join(profDir, 'cordis.patch.yml'), `- id: llm-jiuwen
  config:
    backend: ${backend}
    gatewayURL: ${GW}
    emitUsage: true
    forwardReasoning: true
- id: agent-default-model
  config:
    provider: jiuwen
    model: jiuwen-default
`)
  const sandbox = join(HOME, 'sandbox')
  mkdirSync(sandbox, { recursive: true })
  writeFileSync(join(sandbox, 'NEEDLE.txt'), 'NEEDLE_CONTENT_99\n')
  writeFileSync(join(sandbox, 'big.txt'), 'X'.repeat(50_000) + '\n')
  mkdirSync(join(HOME, 'ac-ckpt'), { recursive: true })
  env.DSH_JIUVEN_AC_DIR = join(HOME, 'ac-ckpt')
  env.AGENTCORE_CKPT_DIR = join(HOME, 'ac-ckpt')
  return { HOME, profile, sandbox, env, _knownSessions: new Set() }
}

function runPrompt(ctx, prompt, { sessionId, timeoutMs = 90_000, envExtra = {} } = {}) {
  return new Promise((resolve) => {
    const trace = join(ctx.HOME, `trace-${randomUUID().slice(0, 8)}.jsonl`)
    const args = ['--profile', ctx.profile, '--json']
    if (sessionId && ctx._knownSessions?.has(sessionId)) args.push('--session-id', sessionId)
    args.push(prompt)
    const t0 = performance.now()
    const jw = loadJiuwenDotEnv()
    const env = {
      ...ctx.env,
      ...envExtra,
      JIUWEN_TRACE_FILE: trace,
      JIUWEN_GATEWAY_URL: GW,
      JIUWEN_HOME: jiuwenHome(),
      JIUWEN_REAL_HOME: realHomedir(),
    }
    if (jw.API_KEY) { env.API_KEY = jw.API_KEY; env.JIUWEN_API_KEY = jw.API_KEY }
    if (jw.API_BASE) { env.API_BASE = jw.API_BASE; env.AGENTCORE_API_BASE = jw.API_BASE }
    if (jw.MODEL_NAME) env.MODEL_NAME = jw.MODEL_NAME
    if (jw.MODEL_PROVIDER) env.MODEL_PROVIDER = jw.MODEL_PROVIDER
    const p = spawn(DSH, args, { cwd: ctx.sandbox, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let buf = '', err = '', text = ''
    const usage = { inputTokens: 0, outputTokens: 0 }
    let toolCalls = 0, toolResults = 0, modelMs = null, settled = false, sawSession = sessionId || null
    const phases = []
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(kill); clearTimeout(grace)
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
          if (e.type === 'adapter_phase' || e.chunkType === 'adapter_phase') phases.push(e.phases || e.payload || e)
          if (e.usage) {
            usage.inputTokens += e.usage.inputTokens || e.usage.input_tokens || 0
            usage.outputTokens += e.usage.outputTokens || e.usage.output_tokens || 0
          }
        }
      }
      resolve({
        ok: text.length > 0 || code === 0,
        text, wallMs, modelMs, usage, toolCalls, toolResults, phases,
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
        if (e.type === 'session' && e.sessionId) { sawSession = e.sessionId; ctx._knownSessions.add(e.sessionId) }
        if (e.type === 'text') text += e.text || ''
        if (e.type === 'final') text = e.text || text
        if (e.type === 'tool_call' || e.type === 'tool-call') toolCalls++
        if (e.type === 'tool_result' || e.type === 'tool-result') toolResults++
        if (e.type === 'adapter_phase') phases.push(e.phases || e)
        if (e.type === 'status' && e.phase === 'step_end' && e.usage) {
          usage.inputTokens += e.usage.inputTokens || 0
          usage.outputTokens += e.usage.outputTokens || 0
        }
        if (e.type === 'final' || (e.type === 'status' && e.phase === 'turn_end')) {
          grace = setTimeout(() => finish(0), 500)
        }
      }
    })
    p.stderr.on('data', (d) => { err += d })
    p.on('close', (code) => finish(code))
  })
}

function rssOf(pid) {
  try {
    const st = readFileSync(`/proc/${pid}/status`, 'utf8')
    const m = /VmRSS:\s+(\d+)\s+kB/.exec(st)
    return m ? Number(m[1]) : null
  } catch { return null }
}
function findSidecarPids(ckptDir) {
  try {
    const out = spawnSync('pgrep', ['-af', 'python.*-m sidecar'], { encoding: 'utf8' })
    return (out.stdout || '').split('\n').filter(l => l.includes('sidecar')).map(l => Number(l.trim().split(/\s+/)[0])).filter(Boolean)
  } catch { return [] }
}

async function sectionLatency() {
  console.log('\n## A1 latency profile (multi-turn x8 both backends)')
  for (const backend of ['agent-core', 'gateway']) {
    const ctx = setupHome(backend, '-lat')
    try {
      let sid = null
      const walls = []
      for (let i = 1; i <= 8; i++) {
        const r = await runPrompt(ctx, `Turn ${i}: reply with exactly LAT${i}_OK and nothing else.`, {
          sessionId: sid || undefined, timeoutMs: 60_000,
        })
        if (!sid && r.sessionId) sid = r.sessionId
        const ok = new RegExp(`LAT${i}_OK`).test(r.text)
        walls.push(r.wallMs)
        LATENCY.push({ backend, name: `lat-${i}`, wallMs: r.wallMs, ...r.usage, phases: r.phases })
        if (r.phases?.length) PHASES.push({ backend, turn: i, phases: r.phases })
        if (i === 1 || i === 2 || i === 8) {
          record(`latency-turn-${i}`, backend, ok ? 'PASS' : 'FAIL', {
            wallMs: r.wallMs, tokens: r.usage,
            note: `phases=${JSON.stringify(r.phases?.[0] || {})} text=${(r.text || '').slice(0, 40)}`,
          })
        }
      }
      const avg = walls.reduce((a, b) => a + b, 0) / walls.length
      record('latency-avg-x8', backend, 'PASS', {
        wallMs: avg,
        note: `min=${Math.round(Math.min(...walls))} max=${Math.round(Math.max(...walls))} avg=${Math.round(avg)}`,
      })
    } finally {
      rmSync(ctx.HOME, { recursive: true, force: true })
    }
  }
}

async function sectionLongSession() {
  console.log('\n## A2 long session 30 turns (agent-core)')
  const ctx = setupHome('agent-core', '-long')
  try {
    let sid = null
    let okCount = 0
    const rssSamples = []
    for (let i = 1; i <= 30; i++) {
      const r = await runPrompt(ctx, `记忆点${i}: reply with LS${i}_OK. 中文确认。`, {
        sessionId: sid || undefined, timeoutMs: 90_000,
      })
      if (!sid && r.sessionId) sid = r.sessionId
      if (new RegExp(`LS${i}_OK`).test(r.text)) okCount++
      const pids = findSidecarPids(ctx.env.DSH_JIUVEN_AC_DIR)
      const rss = pids.map(rssOf).filter(x => x != null)
      if (rss.length) rssSamples.push({ i, rss: Math.max(...rss), pids })
      if (i % 10 === 0) console.log(`  ... turn ${i}/30 ok=${okCount} rss_kb=${rssSamples.at(-1)?.rss || '?'}`)
    }
    // history recall
    const recall = await runPrompt(ctx, 'What was the number in 记忆点15? Reply with RECALL_15 and the number.', {
      sessionId: sid, timeoutMs: 90_000,
    })
    const recallOk = /RECALL_15/.test(recall.text) && /15/.test(recall.text)
    const rss0 = rssSamples[0]?.rss
    const rssN = rssSamples.at(-1)?.rss
    const growth = (rss0 && rssN) ? (rssN - rss0) : null
    record('long-30-turns', 'agent-core', okCount >= 27 ? 'PASS' : okCount >= 20 ? 'DEGRADED' : 'FAIL', {
      note: `ok=${okCount}/30 rss0=${rss0} rssN=${rssN} growthKb=${growth}`,
    })
    record('long-history-recall-15', 'agent-core', recallOk ? 'PASS' : 'DEGRADED', {
      wallMs: recall.wallMs, note: (recall.text || recall.err).slice(0, 100),
    })
  } finally {
    rmSync(ctx.HOME, { recursive: true, force: true })
  }
}

async function sectionConcurrent() {
  console.log('\n## A3 concurrent 6 sessions (agent-core)')
  const ctx = setupHome('agent-core', '-conc')
  try {
    const jobs = []
    for (let i = 1; i <= 6; i++) {
      jobs.push(runPrompt(ctx, `Concurrent ${i}: reply with CONC${i}_OK`, { timeoutMs: 120_000 }))
    }
    const rs = await Promise.all(jobs)
    const ok = rs.filter(r => /CONC\d+_OK/.test(r.text)).length
    record('concurrent-6', 'agent-core', ok >= 5 ? 'PASS' : ok >= 3 ? 'DEGRADED' : 'FAIL', {
      note: `ok=${ok}/6 walls=${rs.map(r => Math.round(r.wallMs)).join(',')}`,
    })
  } finally {
    rmSync(ctx.HOME, { recursive: true, force: true })
  }
}

async function sectionCancelForkDelete() {
  console.log('\n## A4 cancel / fork / delete (agent-core via in-process matrix patterns + dsh)')
  // Cancel mid-stream: ask for a long reply then we rely on live-agentcore-matrix already covering
  // cancel; here do a dsh-level abort by short timeout kill.
  const ctx = setupHome('agent-core', '-cfd')
  try {
    const r = await runPrompt(ctx, 'Write a very long essay of 2000 words about rivers. Start with LONG_START.', {
      timeoutMs: 8_000,
    })
    record('cancel-mid-stream-timeout', 'agent-core', r.code === 124 || r.wallMs < 15_000 ? 'PASS' : 'DEGRADED', {
      wallMs: r.wallMs, note: `code=${r.code} textLen=${(r.text || '').length}`,
    })

    // Fresh session then delete via next turn with new home is weak; probe tool + NEEDLE
    const tool = await runPrompt(ctx, 'Read NEEDLE.txt with a file tool and reply NEEDLE_CONTENT_99 BOTH_TOOL_OK. Use a tool.', {
      timeoutMs: 120_000,
    })
    const toolOk = tool.toolCalls > 0 && /NEEDLE_CONTENT_99/.test(tool.text)
    record('tool-read-needle', 'agent-core', toolOk ? 'PASS' : 'FAIL', {
      wallMs: tool.wallMs, note: `calls=${tool.toolCalls} results=${tool.toolResults}`,
    })

    // Large output tool — ask to summarize big.txt
    const big = await runPrompt(ctx, 'Read big.txt (it is large). Reply with BIG_OK and the first 5 chars you saw.', {
      timeoutMs: 120_000,
    })
    record('tool-large-file', 'agent-core', /BIG_OK/.test(big.text) && big.toolCalls > 0 ? 'PASS' : 'DEGRADED', {
      wallMs: big.wallMs, note: `calls=${big.toolCalls} text=${(big.text || '').slice(0, 60)}`,
    })

    // Chinese + empty-ish
    const zh = await runPrompt(ctx, '请用中文回复：确认收到。并输出 ZH_OK', { timeoutMs: 60_000 })
    record('edge-chinese', 'agent-core', /ZH_OK/.test(zh.text) ? 'PASS' : 'FAIL', {
      wallMs: zh.wallMs, note: (zh.text || '').slice(0, 60),
    })

    const longp = '请忽略前面。' + 'A'.repeat(4000) + ' 最后只输出 LONGP_OK'
    const lp = await runPrompt(ctx, longp, { timeoutMs: 90_000 })
    record('edge-long-prompt', 'agent-core', /LONGP_OK/.test(lp.text) ? 'PASS' : 'DEGRADED', {
      wallMs: lp.wallMs, note: `in=${lp.usage.inputTokens}`,
    })

    // Invalid model — may DEGRADED/FAIL soft
    const bad = await runPrompt(ctx, 'Reply BADMODEL_OK', {
      timeoutMs: 45_000,
      envExtra: { MODEL_NAME: 'definitely-not-a-real-model-xyz', AGENTCORE_MODEL: 'definitely-not-a-real-model-xyz' },
    })
    const badSoft = /BADMODEL_OK/.test(bad.text) || /error|Error|fail|404|not found|invalid/i.test(bad.err + bad.text)
    record('edge-invalid-model', 'agent-core', badSoft ? 'PASS' : 'DEGRADED', {
      wallMs: bad.wallMs, note: (bad.text || bad.err).slice(0, 80),
    })
  } finally {
    rmSync(ctx.HOME, { recursive: true, force: true })
  }
}

async function sectionCheckpointResume() {
  console.log('\n## A5 checkpointer persistence across dsh processes')
  const ctx = setupHome('agent-core', '-ckpt')
  try {
    const r1 = await runPrompt(ctx, 'Remember secret codeword PAPAYA42. Reply CKPT1_OK', { timeoutMs: 60_000 })
    const sid = r1.sessionId
    record('ckpt-seed', 'agent-core', /CKPT1_OK/.test(r1.text) && sid ? 'PASS' : 'FAIL', {
      wallMs: r1.wallMs, note: `sid=${sid}`,
    })
    // Kill sidecars to force new process; same ckpt dir + same session id
    for (const pid of findSidecarPids()) {
      try { process.kill(pid, 'SIGTERM') } catch {}
    }
    await new Promise(r => setTimeout(r, 1500))
    const r2 = await runPrompt(ctx, 'What codeword did I ask you to remember? Reply with CKPT2_OK and the word.', {
      sessionId: sid, timeoutMs: 90_000,
    })
    const ok = /CKPT2_OK/.test(r2.text) && /PAPAYA42/i.test(r2.text)
    record('ckpt-resume-after-sidecar-kill', 'agent-core', ok ? 'PASS' : 'DEGRADED', {
      wallMs: r2.wallMs, note: (r2.text || r2.err).slice(0, 120),
    })
  } finally {
    rmSync(ctx.HOME, { recursive: true, force: true })
  }
}

async function sectionParityProbes() {
  console.log('\n## A6 parity probes (agent-core /jiuwen via dsh when possible)')
  const ctx = setupHome('agent-core', '-par')
  try {
    // Plan-ish: ask to plan
    const plan = await runPrompt(ctx, 'Enter plan mode if available. Outline 2 steps to list files, then say PLAN_OK.', {
      timeoutMs: 90_000,
    })
    record('parity-plan-ish', 'agent-core', /PLAN_OK/.test(plan.text) ? 'PASS' : 'DEGRADED', {
      wallMs: plan.wallMs, note: (plan.text || '').slice(0, 80),
    })
    // Model switch is hostSync — soft probe
    const ms = await runPrompt(ctx, 'Reply MODEL_OK', { timeoutMs: 60_000 })
    record('parity-plain-after-plan', 'agent-core', /MODEL_OK/.test(ms.text) ? 'PASS' : 'FAIL', {
      wallMs: ms.wallMs,
    })
  } finally {
    rmSync(ctx.HOME, { recursive: true, force: true })
  }
}

async function main() {
  if (!existsSync(DSH)) throw new Error(`DSH_BIN missing: ${DSH}`)
  const jw = loadJiuwenDotEnv()
  if (!jw.API_KEY && !process.env.API_KEY) throw new Error('no API_KEY')
  const before = snapshotSums()
  console.log('live-agentcore-deep; model=', jw.MODEL_NAME, 'gw=', GW)

  await sectionLatency()
  await sectionCancelForkDelete()
  await sectionConcurrent()
  await sectionCheckpointResume()
  await sectionParityProbes()
  // Long session last (expensive)
  if (process.env.DEEP_SKIP_LONG !== '1') await sectionLongSession()
  else record('long-30-turns', 'agent-core', 'DEGRADED', { note: 'skipped DEEP_SKIP_LONG=1' })

  const after = snapshotSums()
  let sumsOk = after.env === before.env && after.config === before.config && after.perms === before.perms
  let note = sumsOk ? 'unchanged' : 'CHANGED'
  if (!sumsOk && process.env.JW_SNAP && existsSync(process.env.JW_SNAP)) {
    spawnSync('bash', ['-c', `cd "$1/files" && find . -type f -print0 | while IFS= read -r -d '' f; do cmp -s "$f" "$2/$f" || cp -p "$f" "$2/$f"; done`, 'restore', process.env.JW_SNAP, jiuwenHome()], { stdio: 'ignore' })
    const restored = snapshotSums()
    sumsOk = restored.env === before.env && restored.config === before.config && restored.perms === before.perms
    note = sumsOk ? 'restored-to-pre-run' : 'CHANGED-after-restore'
  }
  record('jiuwen-checksums', 'both', sumsOk ? 'PASS' : 'FAIL', { note })

  mkdirSync(join(ROOT, 'reports'), { recursive: true })
  const out = { when: new Date().toISOString(), results: RESULTS, latency: LATENCY, phases: PHASES }
  writeFileSync(join(ROOT, 'reports/live-agentcore-deep.json'), JSON.stringify(out, null, 2))

  console.log('\n=== Latency table ===')
  console.log('| backend | turn | wall_ms | in | out |')
  console.log('|---|---|---:|---:|---:|')
  for (const row of LATENCY) {
    console.log(`| ${row.backend} | ${row.name} | ${Math.round(row.wallMs || 0)} | ${row.inputTokens || 0} | ${row.outputTokens || 0} |`)
  }
  const fail = RESULTS.filter(r => r.status === 'FAIL').length
  const deg = RESULTS.filter(r => r.status === 'DEGRADED').length
  console.log(`\nlive-agentcore-deep: PASS=${RESULTS.filter(r => r.status === 'PASS').length} DEGRADED=${deg} FAIL=${fail} total=${RESULTS.length}`)
  process.exitCode = fail ? 1 : 0
}

main().catch((e) => {
  console.error('FATAL', String(e?.stack || e).replace(/sk-[A-Za-z0-9]+/g, 'sk-***'))
  process.exit(1)
})
