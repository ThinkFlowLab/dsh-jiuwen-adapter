#!/usr/bin/env node
/** Real dsh -> adapter -> Python DeepAgent -> real model -> dsh tools.
 * Live is explicit; missing prerequisites SKIP. Failures never become skips.
 * No user profile, Gateway RPC, or FlyBot is used. Snapshot is always restored.
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadJiuwenDotEnv, jiuwenHome, realHomedir } from '../../src/jiuwen-env.js'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const skip = why => { console.log('SKIP e2e: ' + why); process.exit(0) }
if (process.env.JIUWEN_E2E_LIVE !== '1') skip('set JIUWEN_E2E_LIVE=1 (real model calls)')
const DSH = process.env.DSH_BIN || spawnSync('which', ['dsh'], { encoding: 'utf8' }).stdout?.trim()
if (!DSH || !existsSync(DSH)) skip('dsh missing; set DSH_BIN')
if (!existsSync(join(ROOT, '.venv-sidecar/bin/python'))) skip('run npm run sidecar:setup')
const jw = loadJiuwenDotEnv()
if (!jw.API_KEY && !process.env.API_KEY && !process.env.JIUWEN_API_KEY) skip('model key missing')
const pause = ms => new Promise(r => setTimeout(r, ms))
const portPid = p => Number(/pid=(\d+)/.exec(spawnSync('ss', ['-ltnpH', `sport = :${p}`], { encoding: 'utf8' }).stdout || '')?.[1]) || null
const up = p => Boolean(spawnSync('ss', ['-ltnH', `sport = :${p}`], { encoding: 'utf8' }).stdout?.trim())
const oldGateway = portPid(19000), protectedPid = portPid(3335)
if (up(19000) && process.env.E2E_MANAGE_GATEWAY !== '1') throw new Error('Stop gateway :19000, or opt in with E2E_MANAGE_GATEWAY=1')
let gatewayCmd
if (oldGateway) {
  gatewayCmd = readFileSync(`/proc/${oldGateway}/cmdline`, 'utf8').split('\0').filter(Boolean)
  if (!gatewayCmd.some(x => x.includes('jiuwenswarm-gateway'))) throw new Error('Refusing to stop a non-Gateway listener')
}
const HOME = mkdtempSync(join(tmpdir(), 'jiuwen-e2e-'))
const snapshot = join(HOME, 'snapshot'), cwd = join(HOME, 'sandbox'), output = join(HOME, 'result.json')
const trace = join(HOME, 'trace.jsonl'), profile = join(HOME, '.dsh/profiles/e2e')
const baseEnv = { ...process.env, JIUWEN_HOME: jiuwenHome(), JIUWEN_REAL_HOME: realHomedir() }
const snap = cmd => {
  const r = spawnSync('bash', [join(ROOT, 'scripts/jiuwen-snap.sh'), cmd, snapshot], { env: baseEnv, encoding: 'utf8' })
  if (r.status !== 0) throw new Error('Jiuwen snapshot ' + cmd + ' failed (snapshot retained at ' + snapshot + ')')
  console.log(r.stdout.trim())
}
let child, stopped = false, restored = false
const results = []
const record = (name, ok) => results.push({ name, status: ok ? 'PASS' : 'FAIL' })
const stopChild = async () => {
  if (!child) return
  try { process.kill(-child.pid, 'SIGTERM') } catch {}
  await pause(500)
  try { process.kill(-child.pid, 'SIGKILL') } catch {}
  child = null
}
let restorePromise
const restore = () => restorePromise ||= restoreOnce()
const restoreOnce = async () => {
  await stopChild()
  // Starting the Gateway may rewrite config; restore bytes AFTER it is healthy too.
  snap('restore')
  if (stopped) {
    const p = spawn(gatewayCmd[0], gatewayCmd.slice(1), { detached: true, stdio: 'ignore', env: { ...baseEnv, HOME: realHomedir() } })
    p.unref()
    for (let i = 0; i < 200 && !up(19000); i++) await pause(100)
    if (!up(19000)) throw new Error('Gateway failed to restart; snapshot retained at ' + snapshot)
    await pause(1500)
    snap('restore')
  }
  snap('verify')
  if (portPid(3335) !== protectedPid) throw new Error('protected :3335 listener changed')
  restored = true
}
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => { stopChild().then(restore).then(() => process.exit(130)).catch(() => process.exit(1)) })
try {
  snap('snap')
  if (oldGateway) {
    process.kill(oldGateway, 'SIGTERM'); stopped = true
    for (let n=0;n<150 && up(19000);n++) await pause(100)
    if (up(19000)) throw new Error('Gateway did not stop gracefully')
  }
  record('gateway-down', !up(19000))
  mkdirSync(join(profile, 'node_modules/@jiuwen-e2e'), { recursive: true })
  mkdirSync(join(profile, 'node_modules/@dsh-jiuwen'), { recursive: true })
  symlinkSync(join(ROOT, 'test/e2e/driver'), join(profile, 'node_modules/@jiuwen-e2e/driver'))
  symlinkSync(ROOT, join(profile, 'node_modules/@dsh-jiuwen/adapter'))
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ private: true, dependencies: { '@jiuwen-e2e/driver': `link:${ROOT}/test/e2e/driver`, '@dsh-jiuwen/adapter': `link:${ROOT}` }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@dsh-jiuwen/adapter', '@jiuwen-e2e/driver'] } } }))
  writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  mkdirSync(join(cwd, '.dsh/skills/zebra-protocol'), { recursive: true })
  mkdirSync(join(cwd, 'docs'), { recursive: true })
  writeFileSync(join(cwd, '.dsh/skills/zebra-protocol/SKILL.md'), '---\nname: zebra-protocol\ndescription: Zebra protocol code word\n---\nCode word: ZEBRA_SECRET_314.\n')
  for (const [f,t] of Object.entries({ 'NEEDLE.txt':'NEEDLE_CONTENT_99\n', 'edit-me.txt':'OLD_VALUE\n', 'deny.txt':'KEEP\n', 'native-only.txt':'NATIVE_PRIVATE_882\n', 'docs/deploy.md':'Canary rollout percentage: CANARY_PCT_17.\n' })) writeFileSync(join(cwd, f),t)
  const features = { skills:true, planning:true, memory:{scope:'global',proactive:false}, subagents:true, sysOperation:{readOnly:true}, rag:{paths:[join(cwd,'docs')]} }
  writeFileSync(join(profile, 'cordis.patch.yml'), `- id: hmr\n  disabled: true\n- id: llm-jiuwen\n  config:\n    backend: agent-core\n    gatewayFallback: false\n    gatewayURL: ws://127.0.0.1:9/ws\n    approvalTimeoutMs: 1000\n    questionTimeoutMs: 1000\n    toolAllowlist: [bash, read, write, edit, grep, glob, skill, todo_write]
    noUiAnswer: "No interactive answerer is available; stop and report denial."\n    agentcore: ${JSON.stringify(features)}\n- id: agent-default-model\n  config:\n    provider: jiuwen\n    model: jiuwen-default\n`)
  const env = { ...baseEnv, HOME, E2E_OUT:output, E2E_CWD:cwd, JIUWEN_TRACE_FILE:trace, JIUWEN_BACKEND:'agent-core', JIUWEN_GATEWAY_FALLBACK:'0', JIUWEN_GATEWAY_URL:'ws://127.0.0.1:9/ws', AGENTCORE_CKPT_DIR:join(HOME,'checkpoints') }
  delete env.DSH_HOME; delete env.AGENTCORE_FEATURES; delete env.AGENTCORE_FAKE_MODEL
  if (jw.API_KEY) { env.API_KEY=jw.API_KEY; env.JIUWEN_API_KEY=jw.API_KEY }
  if (jw.API_BASE) env.AGENTCORE_API_BASE=jw.API_BASE
  for (const k of ['MODEL_NAME','MODEL_PROVIDER','ENDPOINT_PROFILE']) if (jw[k]) env[k]=jw[k]
  child = spawn(DSH, ['--profile','e2e','--host','127.0.0.1','--port',process.env.E2E_PORT || '3489','--no-open'], { env, cwd, detached:true, stdio:['ignore','pipe','pipe'] })
  // Retain only redacted failure diagnostics, not prompts/tool arguments/model responses.
  let log = ''
  for (const stream of [child.stdout,child.stderr]) stream.on('data', b => { log += b; if (log.length>20000) log=log.slice(-20000) })
  let exited = false; child.on('exit',()=>{exited=true})
  for(let n=0;n<12000 && !existsSync(output) && !exited;n++) {
    if(n===600 && !existsSync(output+'.partial')) break
    await pause(100)
  }
  if (!existsSync(output)) {
    const secrets=[jw.API_KEY,process.env.API_KEY,process.env.JIUWEN_API_KEY].filter(Boolean)
    for (const s of secrets) log=log.split(s).join('[REDACTED]')
    log=log.replace(/([?&](?:token|access_token)=)[^\s&]+/g, '$1[REDACTED]')
    writeFileSync(join(HOME,'failure.log'),log,{mode:0o600})
    throw new Error('No completed driver output; private diagnostics: '+HOME)
  }
  results.push(...JSON.parse(readFileSync(output,'utf8')))
  const evs=existsSync(trace)?readFileSync(trace,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l)):[]
  const tools=new Set(evs.filter(e=>e.at==='event' && ['tool_call','native_tool_call'].includes(e.type)).map(e=>e.name))
  for(const name of ['bash','read','write','edit','grep','skill','todo_create','todo_modify','todo_write','write_memory','memory_search','knowledge_search','task_tool','read_file']) record('trace-tool-'+name,tools.has(name))
  record('native-permission-request',evs.some(e=>e.at==='event' && e.type==='host_request'))
  record('gateway-remained-down',!up(19000))
  await stopChild()
  // Headless only adopts headless sessions (web sessions use the standard preset).
  const pkg = JSON.parse(readFileSync(join(profile,'package.json'),'utf8'))
  pkg.dsh.profile.bundles = ['@deepseek-ai/dsh-base','@deepseek-ai/dsh-headless','@dsh-jiuwen/adapter']
  writeFileSync(join(profile,'package.json'),JSON.stringify(pkg))
  const cli = args => {
    const r=spawnSync(DSH,['--profile','e2e','--json',...args],{env,cwd,encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024,detached:true})
    if (r.error) { try { process.kill(-r.pid,'SIGKILL') } catch {} }
    const events=(r.stdout||'').split('\n').flatMap(l=>{try{return [JSON.parse(l)]}catch{return []}})
    return {status:r.status,events}
  }
  const resumeCode='RESUME_'+randomUUID().replaceAll('-','').slice(0,12)
  const seed=cli([`Remember this code for later: ${resumeCode}. Reply SAVED.`])
  const resumeId=seed.events.find(e=>e.type==='session')?.sessionId
  record('process-restart-seed', seed.status===0 && !!resumeId && seed.events.some(e=>e.type==='final' && /SAVED/.test(e.text)))
  const resumed=resumeId?cli(['--session-id',resumeId,'What code did I ask you to remember? Return the exact code.']):{status:1,events:[]}
  writeFileSync(join(HOME,'resume-diagnostics.json'),JSON.stringify({status:resumed.status,errors:resumed.events.filter(e=>e.type==='error').map(e=>e.message)}),{mode:0o600})
  record('process-restart-resume',resumed.status===0 && resumed.events.some(e=>e.type==='final' && e.text?.includes(resumeCode)))
} catch(e) { record('runner-completed',false); console.error(e.message) }
finally { try { await restore(); record('jiuwen-restored',true) } catch(e) { record('jiuwen-restored',false); console.error(e.message) } }
for(const r of results) console.log(`${r.status} ${r.name}`)
const report=process.env.E2E_REPORT || join(ROOT,'reports/e2e-live.json')
mkdirSync(dirname(report),{recursive:true});writeFileSync(report,JSON.stringify({ results },null,2))
const failed=results.filter(r=>r.status==='FAIL').length
console.log(`e2e: ${results.length-failed}/${results.length} passed; ${failed} failed`)
if(restored && !failed) rmSync(HOME,{recursive:true,force:true})
else console.log('Private failure artifacts retained: '+HOME)
process.exitCode=failed?1:0
