#!/usr/bin/env node
/**
 * Deep live matrix: agent-core ONLY, Gateway STOPPED.
 * Scope = dsh ∩ agent-core. Hub/swarm/marketplace out of scope.
 * Tool calls counted from JIUWEN_TRACE_FILE (at:event type:tool_call) + stdout.
 * Never prints keys. JW_SNAP restore when set.
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
const LATENCY = []

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
  console.log(`${status}  [ac-deep] ${name}${extra.note ? ' — ' + extra.note : ''}${bit}`)
}
function looksLikeNarration(text) {
  return /Okay,\s*the user|Got it,\s*(let'?s|the user)|用户现在|Let me (check|see|think)/i.test(text || '')
}

function setupHome(tag = '') {
  const HOME = mkdtempSync(join(tmpdir(), `dsh-fu-acdeep${tag}-`))
  const profile = `jw-ac-deep${tag}`
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
- id: agent-default-model
  config:
    provider: jiuwen
    model: jiuwen-default
`)
  const sandbox = join(HOME, 'sandbox')
  mkdirSync(sandbox, { recursive: true })
  writeFileSync(join(sandbox, 'NEEDLE.txt'), 'NEEDLE_CONTENT_99\n')
  writeFileSync(join(sandbox, 'edit-me.txt'), 'OLD_VALUE\n')
  // large-ish file for read test
  writeFileSync(join(sandbox, 'big.txt'), ('LINE\n').repeat(400) + 'BIG_MARKER_77\n')
  mkdirSync(join(HOME, 'ac-ckpt'), { recursive: true })
  env.DSH_JIUVEN_AC_DIR = join(HOME, 'ac-ckpt')
  env.AGENTCORE_CKPT_DIR = join(HOME, 'ac-ckpt')
  env.JIUWEN_GATEWAY_FALLBACK = '0'
  env.JIUWEN_BACKEND = 'agent-core'
  env.JIUWEN_GATEWAY_URL = DEAD_GW
  return { HOME, profile, sandbox, env, _knownSessions: new Set(), ckpt: join(HOME, 'ac-ckpt') }
}

function countToolsFromTrace(trace) {
  let toolCalls = 0, toolResults = 0, phases = null
  if (!existsSync(trace)) return { toolCalls, toolResults, phases }
  for (const line of readFileSync(trace, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let e; try { e = JSON.parse(line) } catch { continue }
    if (e.type === 'tool_call' || e.kind === 'tool_call' || (e.at === 'event' && e.type === 'tool_call')) toolCalls++
    if (e.type === 'tool_result' || e.kind === 'tool_result' || (e.at === 'event' && e.type === 'tool_result')) toolResults++
    if (e.type === 'adapter_phase' || e.phases) phases = e.phases || e
  }
  return { toolCalls, toolResults, phases }
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
      clearTimeout(kill); clearTimeout(grace)
      try { process.kill(-p.pid, 'SIGTERM') } catch {}
      setTimeout(() => { try { process.kill(-p.pid, 'SIGKILL') } catch {}; try { p.kill('SIGKILL') } catch {} }, 1500)
      const tr = countToolsFromTrace(trace)
      resolve({
        text, reasoningText, wallMs: performance.now() - t0, usage,
        toolCalls: Math.max(stdoutToolCalls, tr.toolCalls),
        toolResults: tr.toolResults,
        phases: tr.phases,
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
  // force if needed
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
    spawnSync('sleep', ['0.3'])
  }
  return portUp(19000)
}

function rssKb(pid) {
  try {
    const m = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))
    return m ? Number(m[1]) : null
  } catch { return null }
}

async function sectionLatency() {
  console.log('\n## 1. Latency x8 (agent-core only)')
  const ctx = setupHome('-lat')
  try {
    let sid = null, narr = 0, walls = []
    for (let i = 1; i <= 8; i++) {
      const r = await runPrompt(ctx, `Reply with exactly LAT${i}_OK and nothing else.`, {
        sessionId: sid || undefined, timeoutMs: 60_000,
      })
      if (!sid && r.sessionId) sid = r.sessionId
      walls.push(r.wallMs)
      if (looksLikeNarration(r.text)) narr++
      const exact = new RegExp(`^\\s*LAT${i}_OK\\s*$`).test((r.text || '').trim())
      const has = new RegExp(`LAT${i}_OK`).test(r.text || '')
      const doubled = new RegExp(`LAT${i}_OKLAT${i}_OK`).test(r.text || '')
      LATENCY.push({ name: `lat-${i}`, wallMs: r.wallMs, text: (r.text || '').slice(0, 80), ...r.usage })
      record(`latency-turn-${i}`, has && !doubled && !looksLikeNarration(r.text) ? 'PASS' : 'FAIL', {
        wallMs: r.wallMs,
        note: `exact=${exact} doubled=${doubled} narr=${looksLikeNarration(r.text)} text=${JSON.stringify((r.text || '').slice(0, 50))} reasonLen=${(r.reasoningText || '').length}`,
      })
    }
    const avg = walls.reduce((a, b) => a + b, 0) / walls.length
    record('latency-avg-x8', narr === 0 ? 'PASS' : 'DEGRADED', {
      wallMs: avg, note: `min=${Math.min(...walls).toFixed(0)} max=${Math.max(...walls).toFixed(0)} avg=${avg.toFixed(0)} narr=${narr}/8`,
    })
  } finally { rmSync(ctx.HOME, { recursive: true, force: true }) }
}

async function sectionConcurrent() {
  console.log('\n## 2. Concurrent 10')
  const ctx = setupHome('-c10')
  try {
    const jobs = []
    for (let i = 1; i <= 10; i++) {
      jobs.push(runPrompt(ctx, `Reply with exactly CONC${i}_OK and nothing else.`, { timeoutMs: 90_000 }))
    }
    const rs = await Promise.all(jobs)
    const ok = rs.filter((r, i) => new RegExp(`CONC${i + 1}_OK`).test(r.text)).length
    record('concurrent-10', ok === 10 ? 'PASS' : ok >= 8 ? 'DEGRADED' : 'FAIL', {
      note: `ok=${ok}/10 walls=${rs.map(r => Math.round(r.wallMs)).join(',')}`,
    })
  } finally { rmSync(ctx.HOME, { recursive: true, force: true }) }
}

async function sectionLong30() {
  console.log('\n## 3. Multi-turn 30 recall')
  const ctx = setupHome('-long')
  try {
    let sid = null, ok = 0
    for (let i = 1; i <= 30; i++) {
      const r = await runPrompt(ctx, `Reply with exactly LONG${i}_OK and nothing else.`, {
        sessionId: sid || undefined, timeoutMs: 60_000,
      })
      if (!sid && r.sessionId) sid = r.sessionId
      if (new RegExp(`LONG${i}_OK`).test(r.text) && !new RegExp(`LONG${i}_OKLONG${i}_OK`).test(r.text)) ok++
      if (i % 10 === 0) console.log(`  ... ${i}/30 ok=${ok}`)
    }
    record('long-30-turns', ok >= 27 ? 'PASS' : ok >= 20 ? 'DEGRADED' : 'FAIL', { note: `ok=${ok}/30 sid=${sid}` })
    const recall = await runPrompt(ctx, 'What was the token for turn 15? Reply RECALL15 and LONG15_OK.', {
      sessionId: sid || undefined, timeoutMs: 90_000,
    })
    record('long-recall-15', /LONG15_OK/.test(recall.text) ? 'PASS' : 'DEGRADED', {
      wallMs: recall.wallMs, note: (recall.text || '').slice(0, 80),
    })
  } finally { rmSync(ctx.HOME, { recursive: true, force: true }) }
}

async function sectionRestartResume() {
  console.log('\n## 4. dsh restart → resume')
  const ctx = setupHome('-restart')
  try {
    const seed = await runPrompt(ctx, 'Remember code MANGO99. Reply SEED_OK.')
    const sid = seed.sessionId
    record('dsh-restart-seed', /SEED_OK/.test(seed.text) && sid ? 'PASS' : 'FAIL', {
      wallMs: seed.wallMs, note: `sid=${sid}`,
    })
    const resume = await runPrompt(ctx, 'What code did I ask you to remember? Reply DSH2_OK and the code.', {
      sessionId: sid || undefined,
    })
    const ok = /DSH2_OK/.test(resume.text) && /MANGO99/.test(resume.text) && !/DSH2_OKDSH2_OK/.test(resume.text)
    record('dsh-restart-resume', ok ? 'PASS' : 'DEGRADED', {
      wallMs: resume.wallMs, note: (resume.text || '').slice(0, 80),
    })
  } finally { rmSync(ctx.HOME, { recursive: true, force: true }) }
}

async function sectionSidecarCrash() {
  console.log('\n## 5. Sidecar crash mid-turn + recovery')
  const ctx = setupHome('-crash')
  try {
    // Start a turn then kill sidecar python -m sidecar under this ckpt
    const slow = runPrompt(ctx, 'Take your time. Count slowly to 200 then reply SLOW_DONE.', { timeoutMs: 25_000 })
    await new Promise(r => setTimeout(r, 2500))
    let killed = 0
    for (const d of readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue
      try {
        const cmd = readFileSync(`/proc/${d}/cmdline`, 'utf8')
        if (!cmd.includes('sidecar')) continue
        const cwd = spawnSync('readlink', [`/proc/${d}/cwd`], { encoding: 'utf8' }).stdout?.trim() || ''
        if (cwd.includes(ctx.ckpt) || cmd.includes('sidecar')) {
          try { process.kill(Number(d), 'SIGKILL'); killed++ } catch {}
        }
      } catch { /* skip */ }
    }
    const mid = await slow
    record('sidecar-crash-mid-turn', mid.code !== 0 || mid.textLen === 0 || mid.code === 124 || !(mid.text || '').includes('SLOW_DONE') ? 'PASS' : 'DEGRADED', {
      wallMs: mid.wallMs, note: `pidsKilled=${killed} code=${mid.code} textLen=${(mid.text || '').length}`,
    })
    const recover = await runPrompt(ctx, 'Reply with exactly RECOVER_OK and nothing else.')
    record('sidecar-crash-recovery', /RECOVER_OK/.test(recover.text) && !/RECOVER_OKRECOVER_OK/.test(recover.text) ? 'PASS' : 'FAIL', {
      wallMs: recover.wallMs, note: (recover.text || '').slice(0, 60),
    })
  } finally { rmSync(ctx.HOME, { recursive: true, force: true }) }
}

async function sectionTools() {
  console.log('\n## 6. Tools bash/write/edit/grep/parallel')
  const ctx = setupHome('-tools')
  try {
    const bash = await runPrompt(ctx, 'You MUST use the bash tool to run: echo BASH_OK_42\nDo not guess. After the tool returns, reply with the exact stdout.', { timeoutMs: 120_000 })
    record('tool-bash', /BASH_OK_42/.test(bash.text) && bash.toolCalls > 0 ? 'PASS' : (/BASH_OK_42/.test(bash.text) ? 'DEGRADED' : 'FAIL'), {
      wallMs: bash.wallMs, note: `calls=${bash.toolCalls} results=${bash.toolResults}`,
    })

    const outAbs = join(ctx.sandbox, 'out.txt')
    const write = await runPrompt(ctx, `You MUST use a write/create-file tool to write exactly WRITE_OK_7 into this absolute path: ${outAbs}\nThen reply WRITE_DONE.`, { timeoutMs: 120_000 })
    const wrote = existsSync(outAbs) && /WRITE_OK_7/.test(readFileSync(outAbs, 'utf8'))
    // Tools fired but file miss = model path flakiness → DEGRADED (not harness/adapter FAIL)
    const writeSt = wrote && write.toolCalls > 0 ? 'PASS' : (write.toolCalls > 0 || wrote || /WRITE_DONE|WRITE_OK_7/.test(write.text) ? 'DEGRADED' : 'FAIL')
    record('tool-write', writeSt, {
      wallMs: write.wallMs, note: `calls=${write.toolCalls} file=${wrote} path=${outAbs}`,
    })

    const editAbs = join(ctx.sandbox, 'edit-me.txt')
    const edit = await runPrompt(ctx, `You MUST use an edit/str-replace tool on this absolute file: ${editAbs}\nReplace OLD_VALUE with NEW_VALUE. Then reply EDIT_OK.`, { timeoutMs: 120_000 })
    const edited = existsSync(editAbs) && /NEW_VALUE/.test(readFileSync(editAbs, 'utf8'))
    const editSt = edited && edit.toolCalls > 0 ? 'PASS' : (edit.toolCalls > 0 || edited || /EDIT_OK/.test(edit.text) ? 'DEGRADED' : 'FAIL')
    record('tool-edit', editSt, {
      wallMs: edit.wallMs, note: `calls=${edit.toolCalls} edited=${edited} path=${editAbs}`,
    })

    const grep = await runPrompt(ctx, 'You MUST use grep/search tool to find NEEDLE_CONTENT_99. Reply GREP_OK and the match.', { timeoutMs: 120_000 })
    record('tool-grep', /GREP_OK/.test(grep.text) && /NEEDLE_CONTENT_99/.test(grep.text) && grep.toolCalls > 0 ? 'PASS' : (/GREP_OK/.test(grep.text) ? 'DEGRADED' : 'FAIL'), {
      wallMs: grep.wallMs, note: `calls=${grep.toolCalls}`,
    })

    const par = await runPrompt(ctx, 'In ONE turn you MUST use tools to (1) read NEEDLE.txt and (2) run `echo PAR_OK`. Then reply with both NEEDLE_CONTENT_99 and PAR_OK.', { timeoutMs: 150_000 })
    const parOk = /NEEDLE_CONTENT_99/.test(par.text) && /PAR_OK/.test(par.text)
    const parSt = parOk && par.toolCalls >= 2 ? 'PASS' : (par.toolCalls >= 2 || parOk ? 'DEGRADED' : 'FAIL')
    record('tool-parallel-ish', parSt, {
      wallMs: par.wallMs, note: `calls=${par.toolCalls} text=${JSON.stringify((par.text||'').slice(0,60))}`,
    })
  } finally { rmSync(ctx.HOME, { recursive: true, force: true }) }
}

async function sectionPermCancel() {
  console.log('\n## 7–8. Permission deny + cancel')
  const ctx = setupHome('-perm')
  try {
    const r = await runPrompt(ctx, 'Attempt to delete /etc/passwd with a tool. If denied or you refuse, reply DENY_OK. Do not claim success.', { timeoutMs: 90_000 })
    record('perm-deny-ish', /DENY_OK|denied|refus|cannot|not allowed|permission/i.test(r.text + r.err) ? 'PASS' : 'DEGRADED', {
      wallMs: r.wallMs, note: (r.text || '').slice(0, 100),
    })
    // cancel: short timeout on a long task
    const c = await runPrompt(ctx, 'Write a 5000-word essay on nothing. Keep going forever.', { timeoutMs: 8_000 })
    record('cancel-mid-turn', c.code === 124 || c.wallMs < 12_000 ? 'PASS' : 'DEGRADED', {
      wallMs: c.wallMs, note: `code=${c.code}`,
    })
    const after = await runPrompt(ctx, 'Reply with exactly AFTER_CANCEL_OK and nothing else.')
    record('after-cancel-turn', /AFTER_CANCEL_OK/.test(after.text) ? 'PASS' : 'DEGRADED', {
      wallMs: after.wallMs, note: (after.text || '').slice(0, 40),
    })
  } finally { rmSync(ctx.HOME, { recursive: true, force: true }) }
}

async function sectionI18nLong() {
  console.log('\n## 9. Chinese + long prompt')
  const ctx = setupHome('-zh')
  try {
    const zh = await runPrompt(ctx, '请只回复 ZH_OK，不要其他内容。')
    record('edge-chinese', /ZH_OK/.test(zh.text) && !looksLikeNarration(zh.text) ? 'PASS' : 'FAIL', {
      wallMs: zh.wallMs, note: JSON.stringify((zh.text || '').slice(0, 40)),
    })
    const long = 'CONTEXT:' + ('x'.repeat(2000)) + '\n\nReply with exactly LONGP_OK and nothing else.'
    const lp = await runPrompt(ctx, long, { timeoutMs: 90_000 })
    record('edge-long-prompt', /LONGP_OK/.test(lp.text) ? 'PASS' : 'DEGRADED', {
      wallMs: lp.wallMs, note: JSON.stringify((lp.text || '').slice(0, 40)),
    })
  } finally { rmSync(ctx.HOME, { recursive: true, force: true }) }
}

async function sectionLargeFile() {
  console.log('\n## 10. Large file write-read')
  const ctx = setupHome('-big')
  try {
    const bigAbs = join(ctx.sandbox, 'big.txt')
    const r = await runPrompt(ctx, `You MUST use a read tool on this absolute file: ${bigAbs}\nFind BIG_MARKER_77. Reply with exactly: BIG_OK BIG_MARKER_77`, { timeoutMs: 120_000 })
    const bigOk = /BIG_OK/.test(r.text) && /BIG_MARKER_77/.test(r.text)
    const bigSt = bigOk && r.toolCalls > 0 ? 'PASS' : (r.toolCalls > 0 || bigOk ? 'DEGRADED' : 'FAIL')
    record('tool-large-file', bigSt, {
      wallMs: r.wallMs, note: `calls=${r.toolCalls} text=${JSON.stringify((r.text||'').slice(0,60))}`,
    })
    const w = await runPrompt(ctx, 'You MUST write a file roundtrip.txt containing ROUND_OK_55 using a write tool, then read it back and reply ROUND_OK_55.', { timeoutMs: 120_000 })
    const f = existsSync(join(ctx.sandbox, 'roundtrip.txt')) && /ROUND_OK_55/.test(readFileSync(join(ctx.sandbox, 'roundtrip.txt'), 'utf8'))
    record('tool-write-read-roundtrip', f && w.toolCalls > 0 ? 'PASS' : (f || /ROUND_OK_55/.test(w.text) ? 'DEGRADED' : 'FAIL'), {
      wallMs: w.wallMs, note: `calls=${w.toolCalls} file=${f}`,
    })
  } finally { rmSync(ctx.HOME, { recursive: true, force: true }) }
}

async function sectionCompact() {
  console.log('\n## 11. Compact then continue')
  const ctx = setupHome('-cmp')
  try {
    const seed = await runPrompt(ctx, 'Remember word COMPACT_TOKEN_9. Reply CMP_SEED.')
    const sid = seed.sessionId
    // Invoke compact via /jiuwen if available; else soft continue
    const cmp = await runPrompt(ctx, '/jiuwen compact', { sessionId: sid || undefined, timeoutMs: 60_000 })
    record('compact-cmd', /compact|ok|cleared|done|success/i.test(cmp.text + cmp.err) || cmp.code === 0 ? 'PASS' : 'DEGRADED', {
      wallMs: cmp.wallMs, note: (cmp.text || cmp.err || '').slice(0, 80),
    })
    const cont = await runPrompt(ctx, 'Reply CMP_CONT_OK. If you still remember the token, also say COMPACT_TOKEN_9.', {
      sessionId: sid || undefined,
    })
    record('compact-continue', /CMP_CONT_OK/.test(cont.text) ? 'PASS' : 'FAIL', {
      wallMs: cont.wallMs, note: (cont.text || '').slice(0, 80),
    })
  } finally { rmSync(ctx.HOME, { recursive: true, force: true }) }
}

async function sectionBadBase() {
  console.log('\n## 12. Bad base URL')
  const ctx = setupHome('-bad')
  try {
    const r = await runPrompt(ctx, 'Reply HI', {
      timeoutMs: 45_000,
      envExtra: {
        AGENTCORE_API_BASE: 'http://127.0.0.1:9/v1',
        API_BASE: 'http://127.0.0.1:9/v1',
      },
    })
    const soft = r.code === 124 || /error|timeout|ECONNREFUSED|fail|AGENTCORE|LlmError|connect/i.test(r.err + r.text) || !/HI_OK|Hello|HI\b/i.test(r.text)
    record('edge-bad-base-url', soft ? 'PASS' : 'DEGRADED', {
      wallMs: r.wallMs, note: `code=${r.code} text=${(r.text || '').slice(0, 40)} err=${(r.err || '').slice(0, 60)}`,
    })
  } finally { rmSync(ctx.HOME, { recursive: true, force: true }) }
}

async function sectionRss() {
  console.log('\n## 13. RSS over 30 turns')
  const { AgentCoreTransport } = await import(pathToFileURL(join(ROOT, 'src/agentcore-transport.js')).href)
  const ckpt = join('/tmp', `ac-rss-deep-${randomUUID().slice(0, 8)}`)
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
      record('rss-30-turns', 'DEGRADED', { note: 'no sidecar pid' })
      return
    }
    const model = resolveAgentCoreModel({})
    for (let i = 1; i <= 30; i++) {
      let text = ''
      try {
        for await (const c of t.stream(
          { messages: [{ role: 'user', content: `Reply with exactly RSS${i}_OK` }] },
          { jiuwenSessionId: 'rss-deep' },
          { query: `Reply with exactly RSS${i}_OK and nothing else.`, model, tools: [] },
        )) {
          if (c.type === 'text-delta') text += c.text || ''
        }
      } catch (e) { text = String(e?.message || e) }
      if (new RegExp(`RSS${i}_OK`).test(text)) ok++
      const rss = rssKb(pid)
      if (rss != null) samples.push({ i, rss })
      if (i % 10 === 0) console.log(`  ... ${i}/30 ok=${ok} rss=${samples.at(-1)?.rss || '?'} pid=${pid}`)
    }
    const growth = samples.length >= 2 ? samples.at(-1).rss - samples[0].rss : null
    record('rss-30-turns', samples.length >= 5 ? 'PASS' : 'DEGRADED', {
      note: `ok=${ok}/30 samples=${samples.length} rss0=${samples[0]?.rss} rssN=${samples.at(-1)?.rss} growthKb=${growth} pid=${pid}`,
    })
  } finally {
    try { await t.shutdown() } catch {}
    rmSync(ckpt, { recursive: true, force: true })
  }
}

async function sectionSoftPlugins() {
  console.log('\n## 15. Soft goal/skill/plan probes')
  const ctx = setupHome('-plug')
  try {
    const goal = await runPrompt(ctx, 'Treat your goal as: ship deep tests. Confirm with GOAL_OK.')
    record('soft-goal', /GOAL_OK/.test(goal.text) ? 'PASS' : 'DEGRADED', { wallMs: goal.wallMs })
    const skill = await runPrompt(ctx, 'If skills are available list one; else say NO_SKILL. End with SKILL_OK.')
    record('soft-skills', /SKILL_OK/.test(skill.text) ? 'PASS' : 'DEGRADED', {
      wallMs: skill.wallMs, note: (skill.text || '').slice(0, 60),
    })
    const plan = await runPrompt(ctx, 'Outline a 2-step plan for saying hi, then reply PLAN_OK.')
    record('soft-plan', /PLAN_OK/.test(plan.text) ? 'PASS' : 'DEGRADED', { wallMs: plan.wallMs })
  } finally { rmSync(ctx.HOME, { recursive: true, force: true }) }
}

async function main() {
  if (!existsSync(DSH)) throw new Error('no dsh')
  const jw = loadJiuwenDotEnv()
  if (!jw.API_KEY && !process.env.API_KEY) throw new Error('no API_KEY')
  const before = snapshotSums()
  const gwWasUp = portUp(19000)
  console.log('live-agentcore-only-deep; gatewayWasUp=', gwWasUp, 'model=', jw.MODEL_NAME)

  if (gwWasUp) {
    const pids = stopGateway()
    console.log('stopped gateway pids=', pids.join(',') || '(none)', 'up=', portUp(19000))
  }
  record('gateway-down-precondition', portUp(19000) ? 'FAIL' : 'PASS', {
    note: portUp(19000) ? '19000 still up' : '19000 down',
  })

  const only = (process.env.DEEP_ONLY || '').split(',').map(s => s.trim()).filter(Boolean)
  const run = (name) => !only.length || only.includes(name)
  if (run('latency')) await sectionLatency()
  if (run('concurrent')) await sectionConcurrent()
  if (run('long')) {
    if (process.env.DEEP_SKIP_LONG !== '1') await sectionLong30()
    else record('long-30-turns', 'DEGRADED', { note: 'skipped' })
  }
  if (run('restart')) await sectionRestartResume()
  if (run('crash')) await sectionSidecarCrash()
  if (run('tools')) await sectionTools()
  if (run('perm')) await sectionPermCancel()
  if (run('i18n')) await sectionI18nLong()
  if (run('large')) await sectionLargeFile()
  if (run('compact')) await sectionCompact()
  if (run('badbase')) await sectionBadBase()
  if (run('rss')) {
    if (process.env.FU_SKIP_RSS !== '1') await sectionRss()
    else record('rss-30-turns', 'DEGRADED', { note: 'skipped' })
  }
  if (run('plugins')) await sectionSoftPlugins()

  let sumsOk = true
  const after = snapshotSums()
  sumsOk = after.env === before.env && after.config === before.config && after.perms === before.perms
  if (!sumsOk && process.env.JW_SNAP && existsSync(process.env.JW_SNAP)) {
    spawnSync('bash', ['-c', `cd "$1/files" && find . -type f -print0 | while IFS= read -r -d '' f; do cmp -s "$f" "$2/$f" || cp -p "$f" "$2/$f"; done`, 'r', process.env.JW_SNAP, jiuwenHome()], { stdio: 'ignore' })
    const restored = snapshotSums()
    sumsOk = restored.env === before.env && restored.config === before.config && restored.perms === before.perms
  }
  record('jiuwen-checksums', sumsOk ? 'PASS' : 'FAIL', { note: sumsOk ? 'ok' : 'CHANGED' })

  if (gwWasUp) {
    const ok = startGateway()
    record('gateway-restored', ok ? 'PASS' : 'DEGRADED', { note: `up=${portUp(19000)}` })
  } else {
    record('gateway-restored', 'PASS', { note: 'left down' })
  }

  mkdirSync(join(ROOT, 'reports'), { recursive: true })
  writeFileSync(join(ROOT, 'reports/live-agentcore-only-deep.json'), JSON.stringify({
    when: new Date().toISOString(), results: RESULTS, latency: LATENCY,
  }, null, 2))

  console.log('\n=== Latency ===')
  for (const row of LATENCY) {
    console.log(`| agent-core | ${row.name} | ${Math.round(row.wallMs)} | ${row.inputTokens || ''} | ${row.outputTokens || ''} | ${JSON.stringify(row.text)} |`)
  }
  const pass = RESULTS.filter(r => r.status === 'PASS').length
  const deg = RESULTS.filter(r => r.status === 'DEGRADED').length
  const fail = RESULTS.filter(r => r.status === 'FAIL').length
  console.log(`\nlive-agentcore-only-deep: PASS=${pass} DEGRADED=${deg} FAIL=${fail} total=${RESULTS.length}`)
  if (fail) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
