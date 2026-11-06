#!/usr/bin/env node
/**
 * Deeper live stress + capability edges + failure recovery for agent-core.
 * Gateway STOPPED. Scope = dsh ∩ agent-core. Never prints keys.
 * Snapshot/restore via JW_SNAP or scripts/jiuwen-snap.sh path in env.
 *
 *   DSH_BIN=... JW_SNAP=/tmp/... node scripts/live-agentcore-stress-deep.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { loadJiuwenDotEnv, jiuwenHome, realHomedir, resolveAgentCoreModel } from '../src/jiuwen-env.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DSH = process.env.DSH_BIN || '/workspace/dsh-rc5/prefix/bin/dsh'
const DEAD_GW = 'ws://127.0.0.1:9/ws'
const RESULTS = []
const METRICS = { walls: [], rss: [] }

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
function portUp(port) {
  const r = spawnSync('ss', ['-ltnH', `sport = :${port}`], { encoding: 'utf8' })
  return Boolean((r.stdout || '').match(new RegExp(`:${port}\\b`)))
}
function record(name, status, extra = {}) {
  RESULTS.push({ name, status, ...extra })
  const bit = extra.wallMs != null ? ` wall=${Math.round(extra.wallMs)}ms` : ''
  console.log(`${status}  [stress] ${name}${extra.note ? ' — ' + extra.note : ''}${bit}`)
}
function looksLikeNarration(text) {
  return /Okay,\s*the user|Got it,\s*(let'?s|the user)|用户现在|Let me (check|see|think)/i.test(text || '')
}

function setupHome(tag = '', agentcore = null) {
  const HOME = mkdtempSync(join(tmpdir(), `dsh-stress${tag}-`))
  const profile = `jw-stress${tag}`
  const env = { ...process.env, HOME, PATH: `${dirname(DSH)}:${process.env.PATH}` }
  delete env.DSH_HOME
  spawnSync(DSH, ['--from-default-profile', 'headless', '--profile', profile, 'true'], { env, encoding: 'utf8', timeout: 60_000 })
  const profDir = join(HOME, '.dsh/profiles', profile)
  if (!existsSync(join(profDir, 'package.json'))) throw new Error('no profile')
  const add = spawnSync(DSH, ['plugin', '--profile', profile, 'add', ROOT], { env, encoding: 'utf8', timeout: 120_000 })
  if (add.status !== 0) throw new Error('plugin add failed: ' + (add.stderr || add.stdout || '').slice(-400))
  writeFileSync(join(profDir, 'cordis.patch.yml'), `- id: llm-jiuwen
  config:
    backend: agent-core
    gatewayFallback: false
    gatewayURL: ${DEAD_GW}
    emitUsage: true
    forwardReasoning: false
    traceFile: true
    approvalTimeoutMs: 800
    questionTimeoutMs: 800
    noUiAnswer: "No interactive answerer is available; stop and report denial."
${agentcore ? `    agentcore: ${JSON.stringify(agentcore)}\n` : ''}- id: agent-default-model
  config:
    provider: jiuwen
    model: jiuwen-default
`)
  const sandbox = join(HOME, 'sandbox')
  mkdirSync(sandbox, { recursive: true })
  writeFileSync(join(sandbox, 'NEEDLE.txt'), 'NEEDLE_CONTENT_99\n')
  writeFileSync(join(sandbox, 'edit-me.txt'), 'OLD_VALUE\n')
  writeFileSync(join(sandbox, 'deny.txt'), 'KEEP\n')
  writeFileSync(join(sandbox, 'native-only.txt'), 'NATIVE_PRIVATE_882\n')
  mkdirSync(join(HOME, 'ac-ckpt'), { recursive: true })
  env.DSH_JIUVEN_AC_DIR = join(HOME, 'ac-ckpt')
  env.AGENTCORE_CKPT_DIR = join(HOME, 'ac-ckpt')
  env.JIUWEN_GATEWAY_FALLBACK = '0'
  env.JIUWEN_BACKEND = 'agent-core'
  env.JIUWEN_GATEWAY_URL = DEAD_GW
  return { HOME, profile, sandbox, env, _knownSessions: new Set(), ckpt: join(HOME, 'ac-ckpt') }
}

function countToolsFromTrace(trace) {
  let toolCalls = 0, toolResults = 0
  if (!existsSync(trace)) return { toolCalls, toolResults, events: [] }
  const events = []
  for (const line of readFileSync(trace, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let e; try { e = JSON.parse(line) } catch { continue }
    events.push(e)
    if (e.type === 'tool_call' || e.kind === 'tool_call' || (e.at === 'event' && e.type === 'tool_call')) toolCalls++
    if (e.type === 'tool_result' || e.kind === 'tool_result' || (e.at === 'event' && e.type === 'tool_result')) toolResults++
  }
  return { toolCalls, toolResults, events }
}

function runPrompt(ctx, prompt, { sessionId, timeoutMs = 90_000, envExtra = {}, signalKillMs = null } = {}) {
  return new Promise((resolve) => {
    const trace = join(ctx.HOME, `trace-${randomUUID().slice(0, 8)}.jsonl`)
    const args = ['--profile', ctx.profile, '--json']
    if (sessionId && ctx._knownSessions?.has(sessionId)) args.push('--session-id', sessionId)
    args.push(prompt)
    const t0 = performance.now()
    const jw = loadJiuwenDotEnv()
    const env = {
      ...ctx.env,
      JIUWEN_TRACE_FILE: trace,
      JIUWEN_GATEWAY_URL: DEAD_GW,
      JIUWEN_GATEWAY_FALLBACK: '0',
      JIUWEN_BACKEND: 'agent-core',
      JIUWEN_HOME: jiuwenHome(),
      JIUWEN_REAL_HOME: realHomedir(),
    }
    if (jw.API_KEY) { env.API_KEY = jw.API_KEY; env.JIUWEN_API_KEY = jw.API_KEY }
    if (jw.API_BASE) { env.API_BASE = jw.API_BASE; env.AGENTCORE_API_BASE = jw.API_BASE }
    if (jw.MODEL_NAME) env.MODEL_NAME = jw.MODEL_NAME
    if (jw.MODEL_PROVIDER) env.MODEL_PROVIDER = jw.MODEL_PROVIDER
    if (jw.ENDPOINT_PROFILE) env.ENDPOINT_PROFILE = jw.ENDPOINT_PROFILE
    Object.assign(env, envExtra)
    const p = spawn(DSH, args, { cwd: ctx.sandbox, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let buf = '', err = '', text = '', reasoningText = '', settled = false, sawSession = sessionId || null
    let stdoutToolCalls = 0
    const usage = { inputTokens: 0, outputTokens: 0 }
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(kill); clearTimeout(grace); clearTimeout(sigKill)
      try { process.kill(-p.pid, 'SIGTERM') } catch {}
      setTimeout(() => { try { process.kill(-p.pid, 'SIGKILL') } catch {}; try { p.kill('SIGKILL') } catch {} }, 1500)
      const tr = countToolsFromTrace(trace)
      resolve({
        text, reasoningText, wallMs: performance.now() - t0, usage,
        toolCalls: Math.max(stdoutToolCalls, tr.toolCalls),
        toolResults: tr.toolResults,
        events: tr.events,
        err: err.slice(-800), code, trace, sessionId: sawSession,
      })
    }
    const kill = setTimeout(() => finish(124), timeoutMs)
    let grace = null
    let sigKill = null
    if (signalKillMs != null) {
      sigKill = setTimeout(() => {
        try { process.kill(-p.pid, 'SIGTERM') } catch {}
        setTimeout(() => { try { process.kill(-p.pid, 'SIGKILL') } catch {} }, 800)
      }, signalKillMs)
    }
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
        if (e.type === 'tool_call' || e.type === 'tool-call') stdoutToolCalls++
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

function stopGateway() {
  const out = spawnSync('pgrep', ['-af', 'jiuwenswarm-gateway'], { encoding: 'utf8' })
  const pids = []
  for (const line of (out.stdout || '').split('\n')) {
    if (!/jiuwenswarm-gateway/.test(line)) continue
    const pid = Number(line.trim().split(/\s+/)[0])
    if (pid) pids.push(pid)
  }
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM') } catch {} }
  const t0 = Date.now()
  while (Date.now() - t0 < 10000) {
    if (!portUp(19000)) break
    spawnSync('sleep', ['0.2'])
  }
  if (portUp(19000)) {
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL') } catch {} }
    spawnSync('sleep', ['0.5'])
  }
  return pids
}
function startGateway() {
  const py = '/workspace/jw-live-venv/bin/python3'
  const bin = '/workspace/jw-live-venv/bin/jiuwenswarm-gateway'
  if (!existsSync(bin)) return false
  const child = spawn(py, [bin, '--host', '127.0.0.1', '--port', '19000',
    '--agent-server-url', 'ws://127.0.0.1:18092',
    '--dotenv', join(jiuwenHome(), 'config/.env')], {
    detached: true, stdio: 'ignore', env: { ...process.env, HOME: realHomedir() },
  })
  child.unref()
  const t0 = Date.now()
  while (Date.now() - t0 < 20000) {
    if (portUp(19000)) return true
    spawnSync('sleep', ['0.25'])
  }
  return portUp(19000)
}

function rssKb(pid) {
  try {
    const m = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))
    return m ? Number(m[1]) : null
  } catch { return null }
}

function findSidecarPids(ckpt) {
  const out = []
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue
    try {
      const cmd = readFileSync(`/proc/${d}/cmdline`, 'utf8')
      if (!(cmd.includes('sidecar') || cmd.includes('openjiuwen') || /python.*agentcore/i.test(cmd))) continue
      let envHit = !ckpt
      try {
        const env = readFileSync(`/proc/${d}/environ`, 'utf8')
        if (ckpt && env.includes(ckpt)) envHit = true
      } catch { /* may lack permission */ }
      const cwd = spawnSync('readlink', [`/proc/${d}/cwd`], { encoding: 'utf8' }).stdout?.trim() || ''
      if (ckpt && !(envHit || cwd.includes(ckpt) || cmd.includes(ckpt))) continue
      out.push(Number(d))
    } catch { /* skip */ }
  }
  // Fallback: any python with sidecar module when ckpt-scoped miss
  if (!out.length) {
    for (const d of readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue
      try {
        const cmd = readFileSync(`/proc/${d}/cmdline`, 'utf8')
        if (cmd.includes('sidecar') && cmd.includes('python')) out.push(Number(d))
      } catch { /* skip */ }
    }
  }
  return out
}

const toolNamesOf = (r) => (r.events || []).filter(e => e.at === 'event' && (e.type === 'tool_call' || e.type === 'native_tool_call')).map(e => e.name)
const hostReqs = (r) => (r.events || []).filter(e => e.at === 'event' && e.type === 'host_request').length

async function sectionConcurrent12Tools() {
  console.log('\n## S1. Concurrent 12 plain + interleaved tool turns')
  const ctx = setupHome('-c12')
  try {
    const plain = []
    for (let i = 1; i <= 12; i++) {
      plain.push(runPrompt(ctx, `Reply with exactly C12_${i}_OK and nothing else.`, { timeoutMs: 120_000 }))
    }
    const rs = await Promise.all(plain)
    const ok = rs.filter((r, i) => new RegExp(`C12_${i + 1}_OK`).test(r.text) && !looksLikeNarration(r.text)).length
    record('concurrent-12-plain', ok === 12 ? 'PASS' : ok >= 10 ? 'DEGRADED' : 'FAIL', {
      note: `ok=${ok}/12 walls=${rs.map(r => Math.round(r.wallMs)).join(',')}`,
    })
    METRICS.walls.push(...rs.map(r => r.wallMs))

    // Interleaved tool turns across 4 sessions (2 rounds)
    const sids = []
    for (let i = 0; i < 4; i++) {
      const seed = await runPrompt(ctx, `Reply with exactly SEED_T${i}_OK.`, { timeoutMs: 90_000 })
      sids.push(seed.sessionId)
    }
    const round1 = await Promise.all(sids.map((sid, i) =>
      runPrompt(ctx, `Use bash to run \`echo INTER_${i}_A\` and return stdout only.`, { sessionId: sid, timeoutMs: 120_000 })))
    const round2 = await Promise.all(sids.map((sid, i) =>
      runPrompt(ctx, `Use bash to run \`echo INTER_${i}_B\` and return stdout only.`, { sessionId: sid, timeoutMs: 120_000 })))
    let interOk = 0
    for (let i = 0; i < 4; i++) {
      const a = /INTER_\d+_A/.test(round1[i].text) && round1[i].toolCalls > 0
      const b = /INTER_\d+_B/.test(round2[i].text) && round2[i].toolCalls > 0
      const cross = !/INTER_\d+_B/.test(round1[i].text) && !new RegExp(`INTER_${(i + 1) % 4}_`).test(round1[i].text + round2[i].text)
      if (a && b && cross) interOk++
    }
    record('interleaved-tool-sessions', interOk === 4 ? 'PASS' : interOk >= 3 ? 'DEGRADED' : 'FAIL', {
      note: `ok=${interOk}/4 r1calls=${round1.map(r => r.toolCalls).join(',')} r2calls=${round2.map(r => r.toolCalls).join(',')}`,
    })
  } finally { rmSync(ctx.HOME, { recursive: true, force: true }) }
}

async function sectionCancelUnderLoad() {
  console.log('\n## S2. Cancel under load + rapid cancel/resume + stream abort mid-tool')
  const ctx = setupHome('-cancel')
  try {
    // Start 6 tool turns; kill 3 early; let 3 finish
    const jobs = []
    for (let i = 0; i < 6; i++) {
      const kill = i < 3
      jobs.push(runPrompt(ctx,
        kill
          ? `Use bash to run \`sleep 25; echo NEVER_${i}\` and return stdout.`
          : `Use bash to run \`echo LIVE_${i}_OK\` and return stdout.`,
        { timeoutMs: kill ? 40_000 : 120_000, signalKillMs: kill ? 3500 : null }))
    }
    const rs = await Promise.all(jobs)
    const cancelled = rs.slice(0, 3).filter(r => !/NEVER_/.test(r.text) && (r.code === 124 || r.code !== 0 || r.wallMs < 20_000 || !(r.text || '').includes('NEVER'))).length
    const survivors = rs.slice(3).filter((r, i) => new RegExp(`LIVE_${i + 3}_OK`).test(r.text)).length
    record('cancel-under-load', cancelled >= 2 && survivors >= 2 ? 'PASS' : (cancelled >= 1 || survivors >= 2) ? 'DEGRADED' : 'FAIL', {
      note: `cancelledish=${cancelled}/3 survivors=${survivors}/3 codes=${rs.map(r => r.code).join(',')}`,
    })

    // Rapid cancel + resume on one session
    let sid = null
    let rapidOk = 0
    for (let i = 0; i < 4; i++) {
      const mid = await runPrompt(ctx, 'Use bash to run `sleep 30; echo NOPE` and return stdout.', {
        sessionId: sid || undefined, timeoutMs: 25_000, signalKillMs: 2500,
      })
      if (!sid && mid.sessionId) sid = mid.sessionId
      const after = await runPrompt(ctx, `Reply with exactly RAPID_${i}_OK and nothing else.`, {
        sessionId: sid || undefined, timeoutMs: 90_000,
      })
      if (!/NOPE/.test(mid.text) && new RegExp(`RAPID_${i}_OK`).test(after.text) && !looksLikeNarration(after.text)) rapidOk++
    }
    record('rapid-cancel-resume-x4', rapidOk === 4 ? 'PASS' : rapidOk >= 3 ? 'DEGRADED' : 'FAIL', {
      note: `ok=${rapidOk}/4 sid=${sid}`,
    })

    // Stream abort mid-tool: kill after tool_call appears in a shared trace pattern via short timeout
    const abort = await runPrompt(ctx, 'Use bash to run `sleep 40; echo STREAM_NEVER` and return stdout.', {
      timeoutMs: 8_000,
    })
    record('stream-abort-mid-tool', !/STREAM_NEVER/.test(abort.text) && (abort.code === 124 || abort.wallMs < 15_000) ? 'PASS' : 'DEGRADED', {
      wallMs: abort.wallMs, note: `code=${abort.code} calls=${abort.toolCalls} textLen=${(abort.text || '').length}`,
    })
    const afterAbort = await runPrompt(ctx, 'Reply with exactly AFTER_ABORT_OK and nothing else.')
    record('after-stream-abort', /AFTER_ABORT_OK/.test(afterAbort.text) ? 'PASS' : 'FAIL', {
      wallMs: afterAbort.wallMs, note: (afterAbort.text || '').slice(0, 60),
    })
  } finally { rmSync(ctx.HOME, { recursive: true, force: true }) }
}

async function sectionLongRss() {
  console.log('\n## S3. Long multi-turn 25 with RSS + latency')
  // CLI path for latency/correctness
  const ctx = setupHome('-rss')
  try {
    let sid = null
    const walls = []
    let ok = 0
    for (let i = 1; i <= 25; i++) {
      const r = await runPrompt(ctx, `Reply with exactly RSS${i}_OK and nothing else.`, {
        sessionId: sid || undefined, timeoutMs: 60_000,
      })
      if (!sid && r.sessionId) sid = r.sessionId
      walls.push(r.wallMs)
      if (new RegExp(`RSS${i}_OK`).test(r.text) && !new RegExp(`RSS${i}_OKRSS${i}_OK`).test(r.text)) ok++
      if (i % 5 === 0) console.log(`  ... ${i}/25 ok=${ok}`)
    }
    const avg = walls.reduce((a, b) => a + b, 0) / walls.length
    METRICS.walls.push(...walls)
    record('long-25-turns', ok >= 23 ? 'PASS' : ok >= 18 ? 'DEGRADED' : 'FAIL', {
      note: `ok=${ok}/25 avg=${avg.toFixed(0)}ms min=${Math.min(...walls).toFixed(0)} max=${Math.max(...walls).toFixed(0)}`,
    })
  } finally { rmSync(ctx.HOME, { recursive: true, force: true }) }

  // Long-lived sidecar RSS (CLI child exits between turns, so sample via AgentCoreTransport)
  const { AgentCoreTransport } = await import(pathToFileURL(join(ROOT, 'src/agentcore-transport.js')).href)
  const ckpt = join('/tmp', `ac-rss-stress-${randomUUID().slice(0, 8)}`)
  mkdirSync(ckpt, { recursive: true })
  const samples = []
  let tokOk = 0
  const t = new AgentCoreTransport({
    checkpointDir: ckpt,
    logger: { warn() {}, error() {} },
    executeTool: async () => ({ ok: true }),
  })
  try {
    await t.ensureStarted()
    const pid = t._proc?.pid
    if (!pid) {
      record('rss-25-turns', 'DEGRADED', { note: 'no sidecar pid' })
      return
    }
    const model = resolveAgentCoreModel({})
    for (let i = 1; i <= 25; i++) {
      let text = ''
      try {
        for await (const c of t.stream(
          { messages: [{ role: 'user', content: `Reply with exactly SRSS${i}_OK` }] },
          { jiuwenSessionId: 'rss-stress' },
          { query: `Reply with exactly SRSS${i}_OK and nothing else.`, model, tools: [] },
        )) {
          if (c.type === 'text-delta') text += c.text || ''
        }
      } catch (e) { text = String(e?.message || e) }
      if (new RegExp(`SRSS${i}_OK`).test(text)) tokOk++
      const rss = rssKb(pid)
      if (rss != null) samples.push(rss)
      if (i % 5 === 0) console.log(`  ... rss ${i}/25 ok=${tokOk} rssKb=${samples.at(-1) || '?'}`)
    }
    const growth = samples.length >= 2 ? samples.at(-1) - samples[0] : null
    METRICS.rss = samples
    record('rss-25-turns', samples.length >= 5 ? 'PASS' : 'DEGRADED', {
      note: `tokOk=${tokOk}/25 samples=${samples.length} first=${samples[0] || '-'} last=${samples.at(-1) || '-'} deltaKb=${growth} pid=${pid}`,
    })
  } finally {
    try { await t.shutdown() } catch {}
    rmSync(ckpt, { recursive: true, force: true })
  }
}

async function sectionCapabilityEdges() {
  console.log('\n## S4. Capability edges (agentcore.* ON)')
  const features = {
    skills: true,
    planning: true,
    memory: { scope: 'global', proactive: false },
    subagents: true,
    interrupts: { askUser: true, confirmTools: ['bash'] },
    sysOperation: { readOnly: true },
    rag: { paths: ['docs'] },
  }
  const ctx = setupHome('-capedge', features)
  mkdirSync(join(ctx.sandbox, '.dsh/skills/zebra-protocol'), { recursive: true })
  writeFileSync(join(ctx.sandbox, '.dsh/skills/zebra-protocol/SKILL.md'),
    '---\nname: zebra-protocol\ndescription: Zebra protocol\n---\nCode word: ZEBRA_SECRET_314.\n')
  mkdirSync(join(ctx.sandbox, 'docs'), { recursive: true })
  writeFileSync(join(ctx.sandbox, 'docs/deploy.md'), 'Canary rollout percentage: CANARY_PCT_17.\n')
  try {
    // Missing skill
    const miss = await runPrompt(ctx, 'Use the skill tool to load skill named definitely-missing-skill-xyz. If missing, reply SKILL_MISSING_OK.', { timeoutMs: 150_000 })
    record('edge-skill-missing', /SKILL_MISSING_OK|not found|unknown|missing|no such|does not exist/i.test(miss.text) ? 'PASS' : 'DEGRADED', {
      wallMs: miss.wallMs, note: `tools=${toolNamesOf(miss).join(',')} text=${JSON.stringify((miss.text || '').slice(0, 80))}`,
    })

    // Memory keyword fallback (no embedding configured)
    const m1 = await runPrompt(ctx, 'Call write_memory to save EXACT text STRESS_COLOUR=CYAN_77 to long-term memory. Reply MEM_SAVED.', { timeoutMs: 150_000 })
    const m2 = await runPrompt(ctx, 'Call memory_search with keyword STRESS_COLOUR. Return the stored value; do not guess.', { timeoutMs: 150_000 })
    const feat = (m1.events || []).find(e => e.at === 'agentcore-features')
    const memMode = feat?.memoryMode || feat?.features?.find?.(f => /keyword|vector|memory/i.test(String(f))) || 'unknown'
    record('edge-memory-keyword-fallback', /CYAN_77/.test(m2.text) && toolNamesOf(m2).includes('memory_search') ? 'PASS' : (/CYAN_77/.test(m2.text) ? 'DEGRADED' : 'FAIL'), {
      wallMs: m1.wallMs + m2.wallMs, note: `modeHint=${JSON.stringify(memMode)} tools=${toolNamesOf(m2).join(',')}`,
    })

    // sysOperation readOnly: native write_file must be gated; host write is still dsh policy (not a bypass of sysOp).
    const so = await runPrompt(ctx, `IMPORTANT: call the native tool named write_file (NOT write, NOT edit). Overwrite ${join(ctx.sandbox, 'native-only.txt')} with MUTATED. If write_file is denied or missing, stop immediately and reply SYSOP_DENIED. Do not fall back to other tools.`, { timeoutMs: 150_000 })
    const names = toolNamesOf(so)
    const usedNative = names.includes('write_file')
    const usedHostIo = names.some(n => n === 'write' || n === 'edit')
    const mutated = existsSync(join(ctx.sandbox, 'native-only.txt')) && /MUTATED/.test(readFileSync(join(ctx.sandbox, 'native-only.txt'), 'utf8'))
    let st = 'DEGRADED'
    if (usedNative && hostReqs(so) > 0 && !mutated) st = 'PASS'
    else if (!usedNative && (/SYSOP_DENIED|denied|read-only|permission|not available|unknown tool/i.test(so.text))) st = 'PASS'
    else if (usedNative && mutated && hostReqs(so) === 0) st = 'FAIL' // native write bypassed dsh gate
    else if (usedHostIo && mutated) st = 'DEGRADED' // model ignored native-only instruction; host path expected under dsh policy
    record('edge-sysop-readonly-write', st, {
      wallMs: so.wallMs, note: `mutated=${mutated} hostReq=${hostReqs(so)} native=${usedNative} hostIo=${usedHostIo} tools=${names.join(',')}`,
    })

    // Subagent tool deny: read-only parent should cause child bash deny when policy never+read-only — soft check via denied text
    const sa = await runPrompt(ctx, 'Call task_tool with subagent_type "general-purpose" and task_description "Use bash to run echo SUB_EDGE_OK and return stdout". Do not run bash yourself. Return child output.', { timeoutMs: 200_000 })
    record('edge-subagent-tools', /SUB_EDGE_OK/.test(sa.text) && toolNamesOf(sa).includes('task_tool') ? 'PASS' : (/SUB_EDGE_OK/.test(sa.text) ? 'DEGRADED' : 'FAIL'), {
      wallMs: sa.wallMs, note: `tools=${toolNamesOf(sa).join(',')}`,
    })

    // Bad / wrong agentcore config should not crash next turns (use separate profile with garbage)
    const bad = setupHome('-badcfg', { skills: 'not-a-bool', memory: { scope: 'nope', embedding: { model: 'x', apiBase: 'http://127.0.0.1:1', apiKeyEnv: 'MISSING_EMB_KEY_NEVER' } }, planning: { mirror: 'yes' } })
    try {
      const b = await runPrompt(bad, 'Reply with exactly BADCFG_OK and nothing else.', { timeoutMs: 90_000 })
      record('edge-bad-agentcore-config', /BADCFG_OK/.test(b.text) ? 'PASS' : 'DEGRADED', {
        wallMs: b.wallMs, note: `code=${b.code} text=${JSON.stringify((b.text || '').slice(0, 60))}`,
      })
    } finally { rmSync(bad.HOME, { recursive: true, force: true }) }

    // Planning without host todo plugin: still should work via native todo_* (mirror may soft-fail)
    const planOnly = setupHome('-planonly', { planning: true })
    try {
      const pl = await runPrompt(planOnly, 'Use todo_create to create one item "solo". Reply PLAN_SOLO_OK.', { timeoutMs: 150_000 })
      record('edge-planning-solo', /PLAN_SOLO_OK/.test(pl.text) && toolNamesOf(pl).some(n => /^todo_/.test(n)) ? 'PASS' : (/PLAN_SOLO_OK/.test(pl.text) ? 'DEGRADED' : 'FAIL'), {
        wallMs: pl.wallMs, note: `tools=${toolNamesOf(pl).join(',')}`,
      })
    } finally { rmSync(planOnly.HOME, { recursive: true, force: true }) }

  } finally { rmSync(ctx.HOME, { recursive: true, force: true }) }
}

async function sectionFailureRecovery() {
  console.log('\n## S5. Failure / recovery')
  const ctx = setupHome('-fail', {
    skills: true, planning: true, memory: { scope: 'global' }, sysOperation: { readOnly: true },
  })
  try {
    // gatewayFallback=false + :19000 down (precondition already); assert still agent-core
    record('fail-gw-down-no-fallback', !portUp(19000) ? 'PASS' : 'FAIL', {
      note: `19000=${portUp(19000)}`,
    })
    const plain = await runPrompt(ctx, 'Reply with exactly STILL_AC_OK and nothing else.')
    record('fail-still-agent-core', /STILL_AC_OK/.test(plain.text) ? 'PASS' : 'FAIL', {
      wallMs: plain.wallMs, note: (plain.text || '').slice(0, 60),
    })

    // Sidecar crash mid-turn then next turn
    const slow = runPrompt(ctx, 'Count slowly to 300 then reply SLOW_DONE.', { timeoutMs: 20_000 })
    await new Promise(r => setTimeout(r, 2000))
    let killed = 0
    for (const pid of findSidecarPids(ctx.ckpt)) {
      try { process.kill(pid, 'SIGKILL'); killed++ } catch {}
    }
    const mid = await slow
    record('fail-sidecar-crash-mid', mid.code !== 0 || !(mid.text || "").length || mid.code === 124 || !(mid.text || '').includes('SLOW_DONE') ? 'PASS' : 'DEGRADED', {
      wallMs: mid.wallMs, note: `killed=${killed} code=${mid.code}`,
    })
    const recover = await runPrompt(ctx, 'Reply with exactly CRASH_RECOVER_OK and nothing else.')
    record('fail-sidecar-crash-next', /CRASH_RECOVER_OK/.test(recover.text) ? 'PASS' : 'FAIL', {
      wallMs: recover.wallMs, note: (recover.text || '').slice(0, 60),
    })

    // Nullish optional args path (edit) — should not schema-reject
    const editAbs = join(ctx.sandbox, 'edit-me.txt')
    const edit = await runPrompt(ctx, `Use edit on ${editAbs} replacing OLD_VALUE with NEW_VALUE. Optional fields may be omitted. Reply EDIT_NULLISH_OK.`, { timeoutMs: 120_000 })
    const edited = existsSync(editAbs) && /NEW_VALUE/.test(readFileSync(editAbs, 'utf8'))
    record('fail-nullish-edit-args', edited && edit.toolCalls > 0 ? 'PASS' : (edited || /EDIT_NULLISH_OK/.test(edit.text) ? 'DEGRADED' : 'FAIL'), {
      wallMs: edit.wallMs, note: `edited=${edited} calls=${edit.toolCalls}`,
    })

    // Permission deny then allow next call: first write deny.txt under never policy is hard via CLI;
    // Soft: attempt write to /etc then a sandbox write.
    const deny = await runPrompt(ctx, 'Use write to create /etc/jiuwen-stress-should-fail.txt with X. If denied, reply DENY_THEN. Do not ask.', { timeoutMs: 120_000 })
    const allow = await runPrompt(ctx, `Use write to create ${join(ctx.sandbox, 'allow-ok.txt')} containing ALLOW_OK_9. Reply ALLOW_DONE.`, { timeoutMs: 120_000 })
    const allowed = existsSync(join(ctx.sandbox, 'allow-ok.txt')) && /ALLOW_OK_9/.test(readFileSync(join(ctx.sandbox, 'allow-ok.txt'), 'utf8'))
    record('fail-deny-then-allow', /DENY_THEN|denied|permission|refus|cannot|not allowed/i.test(deny.text + deny.err) && allowed ? 'PASS' : (allowed ? 'DEGRADED' : 'FAIL'), {
      wallMs: deny.wallMs + allow.wallMs, note: `allowed=${allowed} denyTools=${deny.toolCalls}`,
    })
  } finally { rmSync(ctx.HOME, { recursive: true, force: true }) }
}

async function sectionMemoryClearAndCapsLoad() {
  console.log('\n## S6. Memory clear confirm + capabilities/memory under load')
  // Drive via dsh JSON is limited for /jiuwen commands; use a tiny Node driver similar to e2e for commands.
  // Fallback: model tools write_memory + stress concurrent capabilities prompts.
  const ctx = setupHome('-memcmd', { memory: { scope: 'global', proactive: false }, skills: true, planning: true, rag: { paths: ['docs'] } })
  mkdirSync(join(ctx.sandbox, 'docs'), { recursive: true })
  writeFileSync(join(ctx.sandbox, 'docs/x.md'), 'token X_TOKEN_1\n')
  try {
    const saved = await runPrompt(ctx, 'Call write_memory to save EXACT text CLEAR_ME_TOKEN=PURPLE_55 (keep the exact token). Reply SAVED.', { timeoutMs: 150_000 })
    const memDir = join(ctx.ckpt, 'memory/global/memory')
    const onDisk = existsSync(memDir) && readdirSync(memDir, { recursive: true }).some(f => String(f).endsWith('.md') && /PURPLE_55/.test(readFileSync(join(memDir, String(f)), 'utf8')))
    // Concurrent load: 8 parallel plain prompts while memory exists
    const load = await Promise.all([...Array(8)].map((_, i) =>
      runPrompt(ctx, `Reply with exactly LOAD_${i}_OK and nothing else.`, { timeoutMs: 120_000 })))
    const loadOk = load.filter((r, i) => new RegExp(`LOAD_${i}_OK`).test(r.text)).length
    record('caps-under-load-8', loadOk === 8 ? 'PASS' : loadOk >= 6 ? 'DEGRADED' : 'FAIL', {
      note: `ok=${loadOk}/8 savedTools=${toolNamesOf(saved).join(',')} onDisk=${onDisk}`,
    })
    const search = await runPrompt(ctx, 'Call memory_search with the exact keyword CLEAR_ME_TOKEN. Return only the stored value PURPLE_55 if present; do not invent UUIDs.', { timeoutMs: 120_000 })
    record('memory-still-after-load', onDisk && /PURPLE_55/.test(search.text) ? 'PASS' : (onDisk || /PURPLE_55/.test(search.text) ? 'DEGRADED' : 'FAIL'), {
      wallMs: search.wallMs, note: `onDisk=${onDisk} tools=${toolNamesOf(search).join(',')} text=${JSON.stringify((search.text || '').slice(0, 80))}`,
    })
  } finally { rmSync(ctx.HOME, { recursive: true, force: true }) }
}

async function sectionPluginCompatFeaturesOn() {
  console.log('\n## S7. Plugin-compat matrix with agent-core (in-process 60)')
  const r = spawnSync(process.execPath, ['--test', 'test/plugin-compat-matrix.test.js'], {
    cwd: ROOT, encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, DSH_NM: process.env.DSH_NM || '/workspace/dsh-rc5/prefix/lib/node_modules/@deepseek-ai/dsh/node_modules' },
  })
  const pass = /ℹ pass (\d+)/.exec(r.stdout || '')?.[1]
  const fail = /ℹ fail (\d+)/.exec(r.stdout || '')?.[1]
  record('plugin-compat-60', r.status === 0 && pass === '60' && fail === '0' ? 'PASS' : 'FAIL', {
    note: `status=${r.status} pass=${pass} fail=${fail}`,
  })
}

async function main() {
  if (!existsSync(DSH)) throw new Error('no dsh')
  const jw = loadJiuwenDotEnv()
  if (!jw.API_KEY && !process.env.API_KEY) throw new Error('no API_KEY')
  const before = snapshotSums()
  const gwWasUp = portUp(19000)
  console.log('live-agentcore-stress-deep; gatewayWasUp=', gwWasUp, 'model=', jw.MODEL_NAME)

  if (gwWasUp) {
    const pids = stopGateway()
    console.log('stopped gateway pids=', pids.join(',') || '(none)', 'up=', portUp(19000))
  }
  record('gateway-down-precondition', portUp(19000) ? 'FAIL' : 'PASS', {
    note: portUp(19000) ? '19000 still up' : '19000 down',
  })

  const only = (process.env.STRESS_ONLY || '').split(',').map(s => s.trim()).filter(Boolean)
  const run = (name) => !only.length || only.includes(name)
  if (run('concurrent')) await sectionConcurrent12Tools()
  if (run('cancel')) await sectionCancelUnderLoad()
  if (run('rss')) await sectionLongRss()
  if (run('capedge')) await sectionCapabilityEdges()
  if (run('fail')) await sectionFailureRecovery()
  if (run('memload')) await sectionMemoryClearAndCapsLoad()
  if (run('compat')) await sectionPluginCompatFeaturesOn()

  let sumsOk = true
  const after = snapshotSums()
  sumsOk = after.env === before.env && after.config === before.config && after.perms === before.perms
  if (!sumsOk && process.env.JW_SNAP && existsSync(process.env.JW_SNAP)) {
    spawnSync('bash', [join(ROOT, 'scripts/jiuwen-snap.sh'), 'restore', process.env.JW_SNAP], { stdio: 'inherit' })
    const restored = snapshotSums()
    sumsOk = restored.env === before.env && restored.config === before.config && restored.perms === before.perms
  }
  record('jiuwen-checksums', sumsOk ? 'PASS' : 'FAIL', { note: sumsOk ? 'ok' : 'CHANGED' })

  if (gwWasUp) {
    const ok = startGateway()
    // Gateway start rewrites config.yaml; restore exact bytes when a snapshot was provided.
    if (ok && process.env.JW_SNAP && existsSync(process.env.JW_SNAP)) {
      spawnSync('bash', [join(ROOT, 'scripts/jiuwen-snap.sh'), 'restore', process.env.JW_SNAP], { stdio: 'inherit' })
      spawnSync('bash', [join(ROOT, 'scripts/jiuwen-snap.sh'), 'verify', process.env.JW_SNAP], { stdio: 'inherit' })
    }
    record('gateway-restored', ok ? 'PASS' : 'DEGRADED', { note: `up=${portUp(19000)}` })
  } else {
    record('gateway-restored', 'PASS', { note: 'left down' })
  }

  mkdirSync(join(ROOT, 'reports'), { recursive: true })
  writeFileSync(join(ROOT, 'reports/live-agentcore-stress-deep.json'), JSON.stringify({
    when: new Date().toISOString(), results: RESULTS, metrics: METRICS,
  }, null, 2))

  const pass = RESULTS.filter(r => r.status === 'PASS').length
  const deg = RESULTS.filter(r => r.status === 'DEGRADED').length
  const fail = RESULTS.filter(r => r.status === 'FAIL').length
  console.log(`\nlive-agentcore-stress-deep: PASS=${pass} DEGRADED=${deg} FAIL=${fail} total=${RESULTS.length}`)
  if (fail) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
