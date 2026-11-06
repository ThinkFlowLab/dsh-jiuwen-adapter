#!/usr/bin/env node
// Live /jiuwen command pass against the selected backend and a scripted model (test/live/run.mjs).
// Every turn-control / session command runs on a real Jiuwen session and is read back where Jiuwen exposes it.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../../index.js'
import { GATEWAY, gatewayUp, skip, sleep } from './lib.mjs'

if (!(await gatewayUp())) skip(`Gateway offline at ${GATEWAY}`)
delete process.env.JIUWEN_GATEWAY_URL
const dir = mkdtempSync(join(tmpdir(), 'jw-cmd-'))
const adapters = new Map(); const commands = []
const ctx = {
  llm: { registerAdapter(ids, a) { ids.forEach(i => adapters.set(i, a)); return () => {} } },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  provide(n, v) { this[n] = v }, get() {}, on() { return () => {} },
  inject(_d, cb) { cb({ commands: { register(d) { commands.push(d); return () => {} } }, on() {} }) },
}
plugin.apply(ctx, { gatewayURL: GATEWAY, mappingPath: join(dir, 'm.json'), requestTimeoutMs: 120_000 })
const a = adapters.get('jiuwen'); const api = ctx.jiuwenAdapter; const def = commands.find(c => c.name === 'jiuwen')
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${String(detail).slice(0, 240)}` : ''}`) }
const run = async (sid, q) => { const cs = []; for await (const c of a.stream({ provider: 'jiuwen', model: 'jiuwen-default', sessionId: sid, messages: [{ role: 'user', content: q }] })) cs.push(c); return cs.filter(c => c.type === 'text-delta').map(c => c.text).join('') }
const cmd = async (line, sid) => { try { const r = await def.handler({ agent: { id: sid }, rawInput: line }); return String(r?.text ?? r ?? '') } catch (e) { return `THREW ${e.message}` } }
const bad = t => /THREW|unknown (sub)?command|not supported|Jiuwen: .*error/i.test(t)
const rows = async () => (await api.gateway.rpc('session.list', { limit: 500 }))?.sessions || []
const ts = Date.now().toString(36); const sid = `cmd-${ts}`
const created = new Set()
try {
  await run(sid, 'TAG:c1 hello'); await run(sid, 'TAG:c2 again')
  const jw = api.sessions.get(sid).jiuwenSessionId; created.add(jw)
  let t = await cmd(`rename cmd 标题 ${ts}`, sid); check('rename → Jiuwen title', (await rows()).find(r => r.session_id === jw)?.title === `cmd 标题 ${ts}`, t)
  t = await cmd('status', sid); check('status', !bad(t) && t.includes(jw), t)
  t = await cmd('history', sid); check('history shows the turns', /c1|c2|stand-in reply/.test(t), t)
  t = await cmd('mode', sid); check('mode (read)', !bad(t), t)
  t = await cmd('pause', sid); check('pause', !bad(t), t)
  t = await cmd('resume', sid); check('resume', !bad(t), t)
  t = await cmd('goal set ship the probe', sid); const g1 = await cmd('goal get', sid); check('goal set/get', !bad(t) && /ship the probe/.test(g1), g1)
  t = await cmd('goal clear', sid); const g2 = await cmd('goal get', sid); check('goal clear', !bad(t) && !/ship the probe/.test(g2), g2)
  t = await cmd('workflows list', sid); check('workflows list', !bad(t), t)
  t = await cmd('plan-status', sid); check('plan-status', !bad(t) && /plan-status/.test(t), t)
  t = await cmd('btw TAG:cbtw quick side question', sid); check('btw answers without a new turn', /^btw:/.test(t) && !bad(t), t)
  t = await cmd('recap', sid); check('recap (or feature-detected as unavailable)', (/^recap:/.test(t) && !bad(t)) || /not available on this Gateway/.test(t), t)
  t = await cmd('supplement TAG:csup extra detail', sid); check('supplement', !bad(t), t)
  const skills = (await api.gateway.rpc('skills.list', {}))?.skills || []
  const sk = skills.find(s => s.enabled === true) || skills[0]
  if (sk) {
    t = await cmd(`skill-toggle ${sk.name} ${sk.enabled ? 'off' : 'on'}`, sid)
    const mid = ((await api.gateway.rpc('skills.list', {}))?.skills || []).find(s => s.name === sk.name)?.enabled
    await cmd(`skill-toggle ${sk.name} ${sk.enabled ? 'on' : 'off'}`, sid)
    const back = ((await api.gateway.rpc('skills.list', {}))?.skills || []).find(s => s.name === sk.name)?.enabled
    check('skill-toggle flips and restores', mid === !sk.enabled && back === sk.enabled, `${sk.enabled}→${mid}→${back} ${t}`)
  } else check('skill-toggle (no skills installed)', true)
  t = await cmd('compact', sid); check('compact (Jiuwen-side)', !bad(t), t)
  const after = await run(sid, 'TAG:c3 after commands'); check('session still answers after the commands', /stand-in reply c3/.test(after), after)
  t = await cmd('fork', sid); const fid = t.match(/new session_id=([^\s)]+)/)?.[1] || (t.match(/(dsh-[0-9a-f]{16}|web_[0-9a-z_]+)/g) || []).find(x => x !== jw); if (fid) created.add(fid)
  // Agent-core's raw fork is checkpoint-only, not a new dsh mapping. Verify its
  // actual cloned history instead of assuming every backend lists unmapped forks.
  const forkHistory = fid ? await api.gateway.rpc('history.get', { session_id: fid }) : undefined
  check('fork preserves independent Jiuwen history', !!fid && fid !== jw && JSON.stringify(forkHistory).includes('stand-in reply c3'), t)
  t = await cmd('archive', sid); const arch = JSON.stringify(await api.gateway.rpc('session.archived.list', {}).catch(e => ({ e: e.message })))
  check('archive', !bad(t) && arch.includes(jw), t)
  // Gateway archive releases its resource lock asynchronously. Retry only that busy result.
  for (let attempt = 0; attempt < 30; attempt++) {
    t = await cmd('unarchive', sid)
    if (!/resource operation is already running/i.test(t)) break
    await sleep(100)
  }
  check('unarchive', !bad(t) && (await rows()).some(r => r.session_id === jw), t)
  t = await cmd('delete', sid); check('delete needs confirm', /confirm/i.test(t) && (await rows()).some(r => r.session_id === jw), t)
  t = await cmd('delete confirm', sid); check('delete confirm removes the Jiuwen session + mapping', !(await rows()).some(r => r.session_id === jw) && !api.sessions.get(sid), t)
  for (const l of ['help', 'version', 'models', 'sessions', 'skills', 'agents', 'tools', 'teams', 'permissions', 'plugins', 'mcp', 'heartbeat', 'cron', 'commands', 'templates', 'path', 'locale', 'archived']) {
    t = await cmd(l, sid); check(`read-only: ${l}`, !bad(t) && t.length > 0, t)
  }
} finally {
  for (const id of created) await api.gateway.rpc('session.delete', { session_id: id }).catch(() => {})
  rmSync(dir, { recursive: true, force: true })
}
await sleep(100)
console.log(`\ncommands: ${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
