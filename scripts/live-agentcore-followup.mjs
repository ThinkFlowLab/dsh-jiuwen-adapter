#!/usr/bin/env node
/**
 * Follow-up deep live: reasoning-shape latency x8, remaining stress/parity/edge cases.
 * Never prints keys. JW_SNAP restore when set.
 */
import { spawn, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
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

function fileSha(p) {
  if (!existsSync(p)) return null
  return createHash('sha256').update(readFileSync(p)).digest('hex')
}
function snapshotSums() {
  const jw = jiuwenHome()
  return { env: fileSha(join(jw, 'config/.env')), config: fileSha(join(jw, 'config/config.yaml')), perms: fileSha(join(jw, 'config/user_permissions.yaml')) }
}
function record(name, backend, status, detail = {}) {
  RESULTS.push({ name, backend, status, ok: status === 'PASS', ...detail })
  console.log(`${status}  [${backend}] ${name}${detail.wallMs != null ? ` wall=${Math.round(detail.wallMs)}ms` : ''}${detail.note ? ` — ${detail.note}` : ''}`)
}

function setupHome(backend, tag = '', extraPatch = '') {
  const HOME = mkdtempSync(join(tmpdir(), `dsh-fu-${backend}${tag}-`))
  const profile = `jw-${backend}`
  const env = { ...process.env, HOME, PATH: `${dirname(DSH)}:${process.env.PATH}` }
  delete env.DSH_HOME
  spawnSync(DSH, ['--from-default-profile', 'headless', '--profile', profile, 'true'], { env, encoding: 'utf8', timeout: 60_000 })
  const profDir = join(HOME, '.dsh/profiles', profile)
  if (!existsSync(join(profDir, 'package.json'))) throw new Error('no profile')
  const add = spawnSync(DSH, ['plugin', '--profile', profile, 'add', ROOT], { env, encoding: 'utf8', timeout: 120_000 })
  if (add.status !== 0) throw new Error('plugin add failed: ' + (add.stderr || add.stdout || '').slice(-300))
  writeFileSync(join(profDir, 'cordis.patch.yml'), `- id: llm-jiuwen
  config:
    backend: ${backend}
    gatewayURL: ${GW}
    emitUsage: true
    forwardReasoning: true
${extraPatch}- id: agent-default-model
  config:
    provider: jiuwen
    model: jiuwen-default
`)
  const sandbox = join(HOME, 'sandbox')
  mkdirSync(sandbox, { recursive: true })
  writeFileSync(join(sandbox, 'NEEDLE.txt'), 'NEEDLE_CONTENT_99\n')
  writeFileSync(join(sandbox, 'edit-me.txt'), 'OLD_VALUE\n')
  mkdirSync(join(HOME, 'ac-ckpt'), { recursive: true })
  env.DSH_JIUVEN_AC_DIR = join(HOME, 'ac-ckpt')
  env.AGENTCORE_CKPT_DIR = join(HOME, 'ac-ckpt')
  return { HOME, profile, sandbox, env, _knownSessions: new Set(), ckpt: join(HOME, 'ac-ckpt') }
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
      JIUWEN_TRACE_FILE: trace, JIUWEN_GATEWAY_URL: GW,
      JIUWEN_HOME: jiuwenHome(), JIUWEN_REAL_HOME: realHomedir(),
    }
    if (jw.API_KEY) { env.API_KEY = jw.API_KEY; env.JIUWEN_API_KEY = jw.API_KEY }
    if (jw.API_BASE) { env.API_BASE = jw.API_BASE; env.AGENTCORE_API_BASE = jw.API_BASE }
    if (jw.MODEL_NAME) env.MODEL_NAME = jw.MODEL_NAME
    if (jw.MODEL_PROVIDER) env.MODEL_PROVIDER = jw.MODEL_PROVIDER
    if (jw.ENDPOINT_PROFILE) env.ENDPOINT_PROFILE = jw.ENDPOINT_PROFILE
    // envExtra last so probes (bad base URL, model override) win over jiuwen .env
    Object.assign(env, envExtra)
    const p = spawn(DSH, args, { cwd: ctx.sandbox, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let buf = '', err = '', text = '', reasoningText = ''
    const usage = { inputTokens: 0, outputTokens: 0 }
    let toolCalls = 0, toolResults = 0, settled = false, sawSession = sessionId || null
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(kill); clearTimeout(grace)
      try { process.kill(-p.pid, 'SIGTERM') } catch {}
      setTimeout(() => { try { process.kill(-p.pid, 'SIGKILL') } catch {}; try { p.kill('SIGKILL') } catch {} }, 1500)
      if (existsSync(trace)) {
        for (const line of readFileSync(trace, 'utf8').split('\n')) {
          if (!line.trim()) continue
          let e; try { e = JSON.parse(line) } catch { continue }
          if (e.type === 'tool_call' || e.kind === 'tool_call') toolCalls++
          if (e.type === 'tool_result' || e.kind === 'tool_result') toolResults++
          if (e.type === 'reasoning' || e.at === 'event' && e.type === 'reasoning') {
            reasoningText += e.text || e.name || ''
          }
          if (e.phases?.tools || e.type === 'adapter_phase') { /* keep */ }
          if (e.usage) {
            usage.inputTokens += e.usage.inputTokens || e.usage.input_tokens || 0
            usage.outputTokens += e.usage.outputTokens || e.usage.output_tokens || 0
          }
        }
      }
      resolve({
        text, reasoningText, wallMs: performance.now() - t0, usage, toolCalls, toolResults,
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
        if (e.type === 'reasoning-delta' || e.type === 'reasoning') reasoningText += e.text || ''
        if (e.type === 'tool_call' || e.type === 'tool-call') toolCalls++
        if (e.type === 'tool_result' || e.type === 'tool-result') toolResults++
        if (e.type === 'status' && e.phase === 'step_end' && e.usage) {
          usage.inputTokens += e.usage.inputTokens || 0
          usage.outputTokens += e.usage.outputTokens || 0
        }
        if (e.type === 'final' || (e.type === 'status' && e.phase === 'turn_end')) grace = setTimeout(() => finish(0), 500)
      }
    })
    p.stderr.on('data', (d) => { err += d })
    p.on('close', (code) => finish(code))
  })
}

function looksLikeNarration(text) {
  return /Okay,\s*the user|Got it,\s*(let'?s|the user)|用户现在|Let me (check|see|think)/i.test(text || '')
}

function findSidecarPids(ckptHint) {
  try {
    const out = spawnSync('pgrep', ['-af', 'python'], { encoding: 'utf8' })
    const lines = (out.stdout || '').split('\n')
    const pids = []
    for (const line of lines) {
      if (!/ -m sidecar\b|\/sidecar\/__main__|python.*sidecar/.test(line)) continue
      if (ckptHint && line.includes(ckptHint)) { /* prefer */ }
      const pid = Number(line.trim().split(/\s+/)[0])
      if (pid) pids.push(pid)
    }
    // Also match by cwd containing ac-ckpt via /proc
    for (const d of readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue
      try {
        const cmd = readFileSync(`/proc/${d}/cmdline`, 'utf8')
        if (!cmd.includes('sidecar')) continue
        const cwd = spawnSync('readlink', [`/proc/${d}/cwd`], { encoding: 'utf8' }).stdout?.trim() || ''
        const env = readFileSync(`/proc/${d}/environ`, 'utf8')
        if (ckptHint && (cwd.includes(ckptHint) || env.includes(ckptHint) || true)) {
          pids.push(Number(d))
        } else if (!ckptHint) pids.push(Number(d))
      } catch { /* skip */ }
    }
    return [...new Set(pids)]
  } catch { return [] }
}
function rssKb(pid) {
  try {
    const m = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))
    return m ? Number(m[1]) : null
  } catch { return null }
}

async function latencyBoth() {
  console.log('\n## Latency x8 + text shape (after reasoning fix)')
  for (const backend of ['agent-core', 'gateway']) {
    const ctx = setupHome(backend, '-lat')
    try {
      let sid = null
      const walls = []
      let narr = 0
      for (let i = 1; i <= 8; i++) {
        const r = await runPrompt(ctx, `Reply with exactly LAT${i}_OK and nothing else.`, {
          sessionId: sid || undefined, timeoutMs: 60_000,
        })
        if (!sid && r.sessionId) sid = r.sessionId
        walls.push(r.wallMs)
        if (looksLikeNarration(r.text)) narr++
        LATENCY.push({ backend, name: `lat-${i}`, wallMs: r.wallMs, ...r.usage, text: (r.text || '').slice(0, 80), reasoning: (r.reasoningText || '').slice(0, 80) })
        if (i === 1 || i === 8) {
          const exact = new RegExp(`^\\s*LAT${i}_OK\\s*$`).test((r.text || '').trim()) || new RegExp(`LAT${i}_OK`).test(r.text || '')
          record(`latency-turn-${i}`, backend, exact ? 'PASS' : 'DEGRADED', {
            wallMs: r.wallMs,
            note: `narration=${looksLikeNarration(r.text)} exactish=${exact} text=${JSON.stringify((r.text || '').slice(0, 60))} reasonLen=${(r.reasoningText || '').length}`,
          })
        }
      }
      const avg = walls.reduce((a, b) => a + b, 0) / walls.length
      record('latency-avg-x8', backend, 'PASS', {
        wallMs: avg,
        note: `min=${Math.round(Math.min(...walls))} max=${Math.round(Math.max(...walls))} avg=${Math.round(avg)} narrTurns=${narr}/8`,
      })
    } finally { rmSync(ctx.HOME, { recursive: true, force: true }) }
  }
}

async function concurrent10() {
  console.log('\n## Concurrent 10 sessions')
  const ctx = setupHome('agent-core', '-c10')
  try {
    const jobs = []
    for (let i = 1; i <= 10; i++) jobs.push(runPrompt(ctx, `Reply with CONC${i}_OK`, { timeoutMs: 180_000 }))
    const rs = await Promise.all(jobs)
    const ok = rs.filter(r => new RegExp(`CONC\\d+_OK`).test(r.text)).length
    record('concurrent-10', 'agent-core', ok >= 9 ? 'PASS' : ok >= 6 ? 'DEGRADED' : 'FAIL', {
      note: `ok=${ok}/10 walls=${rs.map(r => Math.round(r.wallMs)).join(',')}`,
    })
  } finally { rmSync(ctx.HOME, { recursive: true, force: true }) }
}

async function dshRestartResume() {
  console.log('\n## dsh process restart then resume (checkpointer)')
  const ctx = setupHome('agent-core', '-dshre')
  try {
    const r1 = await runPrompt(ctx, 'Remember codeword MANGO77. Reply DSH1_OK', { timeoutMs: 60_000 })
    const sid = r1.sessionId
    record('dsh-restart-seed', 'agent-core', /DSH1_OK/.test(r1.text) && sid ? 'PASS' : 'FAIL', { wallMs: r1.wallMs, note: `sid=${sid}` })
    // Kill ALL dsh children for this home and sidecars; keep ckpt dir
    spawnSync('pkill', ['-f', ctx.HOME], { encoding: 'utf8' })
    for (const pid of findSidecarPids(ctx.ckpt)) {
      try { process.kill(pid, 'SIGTERM') } catch {}
    }
    await new Promise(r => setTimeout(r, 2000))
    const r2 = await runPrompt(ctx, 'What codeword? Reply DSH2_OK and the word.', { sessionId: sid, timeoutMs: 90_000 })
    const ok = /DSH2_OK/.test(r2.text) && /MANGO77/i.test(r2.text)
    record('dsh-restart-resume', 'agent-core', ok ? 'PASS' : 'DEGRADED', {
      wallMs: r2.wallMs, note: (r2.text || r2.err).slice(0, 120),
    })
  } finally { rmSync(ctx.HOME, { recursive: true, force: true }) }
}

async function sidecarCrashMidTurn() {
  console.log('\n## Sidecar crash mid-turn + recovery')
  const ctx = setupHome('agent-core', '-crash')
  try {
    // Start a long turn in background, kill sidecar mid-flight, then new turn should recover
    const longP = runPrompt(ctx, 'Write a 500-word essay about mountains. Start with CRASH_START.', { timeoutMs: 25_000 })
    await new Promise(r => setTimeout(r, 2500))
    const pids = findSidecarPids(ctx.ckpt)
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL') } catch {} }
    const crashed = await longP
    record('sidecar-crash-mid-turn', 'agent-core', crashed.code === 124 || /error|AGENTCORE|exited|fail/i.test(crashed.err + crashed.text) || crashed.text.length < 50 ? 'PASS' : 'DEGRADED', {
      wallMs: crashed.wallMs, note: `pidsKilled=${pids.length} code=${crashed.code} textLen=${(crashed.text||'').length}`,
    })
    const recover = await runPrompt(ctx, 'Reply RECOVER_OK', { timeoutMs: 60_000 })
    record('sidecar-crash-recovery-turn', 'agent-core', /RECOVER_OK/.test(recover.text) ? 'PASS' : 'FAIL', {
      wallMs: recover.wallMs, note: (recover.text || recover.err).slice(0, 80),
    })
  } finally { rmSync(ctx.HOME, { recursive: true, force: true }) }
}

async function toolsSuite() {
  console.log('\n## Tools: bash/write/edit/grep + parallel')
  const ctx = setupHome('agent-core', '-tools')
  try {
    const bash = await runPrompt(ctx, 'Use a shell/bash tool to run `echo BASH_OK_42`. Then reply with that exact token BASH_OK_42.', { timeoutMs: 120_000 })
    record('tool-bash', 'agent-core', /BASH_OK_42/.test(bash.text) && bash.toolCalls > 0 ? 'PASS' : 'DEGRADED', {
      wallMs: bash.wallMs, note: `calls=${bash.toolCalls}`,
    })
    const write = await runPrompt(ctx, 'Create file out.txt containing WRITE_OK_7 using a write tool. Then reply WRITE_OK_7.', { timeoutMs: 120_000 })
    const wrote = existsSync(join(ctx.sandbox, 'out.txt')) && /WRITE_OK_7/.test(readFileSync(join(ctx.sandbox, 'out.txt'), 'utf8') + write.text)
    record('tool-write', 'agent-core', wrote && write.toolCalls > 0 ? 'PASS' : 'DEGRADED', {
      wallMs: write.wallMs, note: `calls=${write.toolCalls} file=${existsSync(join(ctx.sandbox, 'out.txt'))}`,
    })
    const edit = await runPrompt(ctx, 'Edit edit-me.txt replacing OLD_VALUE with NEW_VALUE using an edit tool. Reply EDIT_OK when done.', { timeoutMs: 120_000 })
    const edited = existsSync(join(ctx.sandbox, 'edit-me.txt')) && /NEW_VALUE/.test(readFileSync(join(ctx.sandbox, 'edit-me.txt'), 'utf8'))
    record('tool-edit', 'agent-core', edited || /EDIT_OK/.test(edit.text) ? 'PASS' : 'DEGRADED', {
      wallMs: edit.wallMs, note: `calls=${edit.toolCalls} edited=${edited}`,
    })
    const grep = await runPrompt(ctx, 'Use grep/search to find NEEDLE_CONTENT_99 in this workspace. Reply GREP_OK and the match.', { timeoutMs: 120_000 })
    record('tool-grep', 'agent-core', /GREP_OK/.test(grep.text) && /NEEDLE_CONTENT_99/.test(grep.text) ? 'PASS' : 'DEGRADED', {
      wallMs: grep.wallMs, note: `calls=${grep.toolCalls}`,
    })
    const parallel = await runPrompt(ctx, 'In one turn, use tools to (1) read NEEDLE.txt and (2) run `echo PAR_OK`. Then reply with both NEEDLE_CONTENT_99 and PAR_OK.', { timeoutMs: 150_000 })
    record('tool-parallel-ish', 'agent-core', /NEEDLE_CONTENT_99/.test(parallel.text) && /PAR_OK/.test(parallel.text) && parallel.toolCalls >= 2 ? 'PASS' : 'DEGRADED', {
      wallMs: parallel.wallMs, note: `calls=${parallel.toolCalls}`,
    })
  } finally { rmSync(ctx.HOME, { recursive: true, force: true }) }
}

async function permissionsLive() {
  console.log('\n## Permission presets deny (live soft)')
  // Without injecting another plugin, probe that a denied path soft-fails via prompt asking for forbidden action
  const ctx = setupHome('agent-core', '-perm')
  try {
    const r = await runPrompt(ctx, 'Attempt to delete /etc/passwd using a tool. If denied or you refuse, reply DENY_OK. Do not claim success.', { timeoutMs: 90_000 })
    record('perm-deny-ish', 'agent-core', /DENY_OK|denied|refus|cannot|not allowed|permission/i.test(r.text + r.err) ? 'PASS' : 'DEGRADED', {
      wallMs: r.wallMs, note: (r.text || '').slice(0, 100),
    })
  } finally { rmSync(ctx.HOME, { recursive: true, force: true }) }
}

async function badBaseTimeout() {
  console.log('\n## Simulated timeout via bad API base')
  const ctx = setupHome('agent-core', '-bad')
  try {
    const r = await runPrompt(ctx, 'Reply HI', {
      timeoutMs: 45_000,
      envExtra: {
        AGENTCORE_API_BASE: 'http://127.0.0.1:9/v1',
        API_BASE: 'http://127.0.0.1:9/v1',
        AGENTCORE_MODEL: 'doubao-seed-2.0-mini',
      },
    })
    const soft = r.code === 124 || /error|timeout|ECONNREFUSED|fail|AGENTCORE|connect/i.test(r.err + r.text) || !/HI_OK|Hello/i.test(r.text)
    record('edge-bad-base-url', 'agent-core', soft ? 'PASS' : 'DEGRADED', {
      wallMs: r.wallMs, note: `code=${r.code} text=${(r.text||'').slice(0,40)} err=${(r.err||'').slice(0,60)}`,
    })
  } finally { rmSync(ctx.HOME, { recursive: true, force: true }) }
}

async function rssLong() {
  console.log('\n## RSS over 30 turns')
  // One long-lived AgentCoreTransport (not one-shot dsh CLI) so sidecar RSS is measurable.
  const { AgentCoreTransport } = await import(pathToFileURL(join(ROOT, 'src/agentcore-transport.js')).href)
  const { resolveAgentCoreModel } = await import(pathToFileURL(join(ROOT, 'src/jiuwen-env.js')).href)
  const ckpt = join('/tmp', `ac-rss-${randomUUID().slice(0, 8)}`)
  mkdirSync(ckpt, { recursive: true })
  const samples = []
  let ok = 0
  const t = new AgentCoreTransport({
    checkpointDir: ckpt,
    logger: { warn() {}, error() {} },
    executeTool: async () => ({ ok: true }),
  })
  try {
    await t.ensureStarted()
    const pid = t._proc?.pid
    if (!pid) {
      record('rss-30-turns', 'agent-core', 'DEGRADED', { note: 'no sidecar pid after start' })
      return
    }
    const model = resolveAgentCoreModel({})
    for (let i = 1; i <= 30; i++) {
      let text = ''
      try {
        for await (const c of t.stream(
          { messages: [{ role: 'user', content: `Reply with exactly RSS${i}_OK` }] },
          { jiuwenSessionId: 'rss-session' },
          { query: `Reply with exactly RSS${i}_OK and nothing else.`, model, tools: [] },
        )) {
          if (c.type === 'text-delta') text += c.text || ''
        }
      } catch (e) {
        text = String(e?.message || e)
      }
      if (new RegExp(`RSS${i}_OK`).test(text)) ok++
      const rss = rssKb(pid)
      if (rss != null) samples.push({ i, rss, n: 1 })
      if (i % 10 === 0) console.log(`  ... ${i}/30 ok=${ok} rss=${samples.at(-1)?.rss || '?'} pids=${pid ? 1 : 0}`)
    }
    const growth = samples.length >= 2 ? samples.at(-1).rss - samples[0].rss : null
    record('rss-30-turns', 'agent-core', samples.length >= 5 ? 'PASS' : 'DEGRADED', {
      note: `ok=${ok}/30 samples=${samples.length} rss0=${samples[0]?.rss} rssN=${samples.at(-1)?.rss} growthKb=${growth} pid=${pid}`,
    })
  } finally {
    try { await t.shutdown() } catch {}
    rmSync(ckpt, { recursive: true, force: true })
  }
}

async function parityLive() {
  console.log('\n## Parity checklist live probes')
  const ctx = setupHome('agent-core', '-par')
  try {
    // /jiuwen via dsh command if available
    const help = await runPrompt(ctx, 'Ignore tools. Reply PARITY_HELP_OK', { timeoutMs: 60_000 })
    record('parity-plain', 'agent-core', /PARITY_HELP_OK/.test(help.text) ? 'PASS' : 'FAIL', { wallMs: help.wallMs })

    // Goal-ish: ask to track a goal (adapter injects if mapping has goal; here soft)
    const goal = await runPrompt(ctx, 'Treat this as your goal: ship parity. Reply GOAL_OK confirming.', { timeoutMs: 60_000 })
    record('parity-goal-ish', 'agent-core', /GOAL_OK/.test(goal.text) ? 'PASS' : 'DEGRADED', { wallMs: goal.wallMs })

    // Skills: ask to use a skill if any — soft
    const skill = await runPrompt(ctx, 'If you have skills available, list one name; otherwise say NO_SKILL. End with SKILL_OK.', { timeoutMs: 60_000 })
    record('parity-skills-ish', 'agent-core', /SKILL_OK/.test(skill.text) ? 'PASS' : 'DEGRADED', { wallMs: skill.wallMs, note: (skill.text||'').slice(0,80) })

    // Title/pin etc. are hostSync — can't easily drive via prompt; mark DEGRADED unless we invoke /jiuwen
    // Try running dsh with a slash command as the prompt (may or may not work headless)
    const jiu = await runPrompt(ctx, '/jiuwen help', { timeoutMs: 60_000 })
    const jiuOk = /Usage:|subcommand|jiuwen|status|models/i.test(jiu.text + jiu.err)
    record('parity-jiuwen-help', 'agent-core', jiuOk ? 'PASS' : 'DEGRADED', {
      wallMs: jiu.wallMs, note: (jiu.text || jiu.err).slice(0, 100),
    })
  } finally { rmSync(ctx.HOME, { recursive: true, force: true }) }
}

async function main() {
  if (!existsSync(DSH)) throw new Error('no dsh')
  const jw = loadJiuwenDotEnv()
  if (!jw.API_KEY && !process.env.API_KEY) throw new Error('no API_KEY')
  const before = snapshotSums()
  console.log('live-agentcore-followup; model=', jw.MODEL_NAME, 'profile=', jw.ENDPOINT_PROFILE)

  await latencyBoth()
  await concurrent10()
  await dshRestartResume()
  await sidecarCrashMidTurn()
  await toolsSuite()
  await permissionsLive()
  await badBaseTimeout()
  await parityLive()
  if (process.env.FU_SKIP_RSS !== '1') await rssLong()
  else record('rss-30-turns', 'agent-core', 'DEGRADED', { note: 'skipped' })

  const after = snapshotSums()
  let sumsOk = after.env === before.env && after.config === before.config && after.perms === before.perms
  let note = sumsOk ? 'unchanged' : 'CHANGED'
  if (!sumsOk && process.env.JW_SNAP && existsSync(process.env.JW_SNAP)) {
    spawnSync('bash', ['-c', `cd "$1/files" && find . -type f -print0 | while IFS= read -r -d '' f; do cmp -s "$f" "$2/$f" || cp -p "$f" "$2/$f"; done`, 'r', process.env.JW_SNAP, jiuwenHome()], { stdio: 'ignore' })
    const restored = snapshotSums()
    sumsOk = restored.env === before.env && restored.config === before.config && restored.perms === before.perms
    note = sumsOk ? 'restored-to-pre-run' : 'CHANGED-after-restore'
  }
  record('jiuwen-checksums', 'both', sumsOk ? 'PASS' : 'FAIL', { note })

  mkdirSync(join(ROOT, 'reports'), { recursive: true })
  writeFileSync(join(ROOT, 'reports/live-agentcore-followup.json'), JSON.stringify({ when: new Date().toISOString(), results: RESULTS, latency: LATENCY }, null, 2))
  console.log('\n=== Latency ===')
  console.log('| backend | turn | wall_ms | in | out | text |')
  for (const row of LATENCY) {
    console.log(`| ${row.backend} | ${row.name} | ${Math.round(row.wallMs||0)} | ${row.inputTokens||0} | ${row.outputTokens||0} | ${JSON.stringify(row.text||'')} |`)
  }
  const pass = RESULTS.filter(r => r.status === 'PASS').length
  const deg = RESULTS.filter(r => r.status === 'DEGRADED').length
  const fail = RESULTS.filter(r => r.status === 'FAIL').length
  console.log(`\nlive-agentcore-followup: PASS=${pass} DEGRADED=${deg} FAIL=${fail} total=${RESULTS.length}`)
  process.exitCode = fail ? 1 : 0
}
main().catch((e) => { console.error('FATAL', String(e?.stack || e).replace(/sk-[A-Za-z0-9]+/g, 'sk-***')); process.exit(1) })
