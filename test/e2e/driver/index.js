// Mounted in an isolated real dsh web profile, never in a user's profile.
import { writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
export const name = 'jiuwen-e2e-driver'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const text = m => (m?.content || []).filter(x => x.type === 'text').map(x => x.text).join('')
export function apply(ctx) {
  if (!process.env.E2E_OUT) return
  const results = []
  let streamDeltas = 0
  // Test-owned policy exercises the REAL dsh approval pipeline without a human.
  ctx.on('tools/pre-execute', async (exec, next) => {
    // This fixture is native-only: host fallbacks must not mask the native denial.
    if (JSON.stringify(exec.arguments || {}).includes('/native-only.txt')) return { kind: 'deny', reason: 'native-only E2E fixture; no host fallback' }
    if (/ask_user|question/.test(exec.name)) return { kind: 'deny', reason: 'unattended test; report without asking' }
    if (exec.name === 'write' && String(exec.arguments?.file_path || '').endsWith('/deny.txt')) return { kind: 'ask', reason: 'E2E fixture explicitly requires approval' }
    return next()
  })
  ctx.on('llm/stream', (_options, next) => (async function* () {
    for await (const c of next()) { if (c.type === 'text-delta' && c.text) streamDeltas++; yield c }
  })())
  const check = (name, ok) => { results.push({ name, status: ok ? 'PASS' : 'FAIL' }); writeFileSync(process.env.E2E_OUT + '.partial', JSON.stringify(results)) }
  setTimeout(async () => {
    try {
      await ctx.get('loader')?.await()
      const g = n => ctx.get(n), sc = g('sessionController'), sessions = g('sessions'), api = g('jiuwenAdapter')
      const cwd = process.env.E2E_CWD
      const create = async () => {
        const id = (await sc.create({ cwd }, new AbortController().signal)).sessionId
        g('approval').setPolicy(g('agents').get(id), 'never')
        return id
      }
      const agent = id => g('agents').get(id) || sessions.get(id)?.agent
      const events = id => sessions.get(id)?.snapshotEvents?.() || []
      const reply = id => events(id).filter(e => e.type === 'assistant/message').map(e => text(e.data.message)).at(-1) || ''
      let lastTools = new Set(), lastHostRequests = 0, lastDenied = false
      const prompt = async (id, q) => {
        const before = existsSync(process.env.JIUWEN_TRACE_FILE) ? readFileSync(process.env.JIUWEN_TRACE_FILE, 'utf8').length : 0
        await sc.prompt({ requestId: crypto.randomUUID(), sessionId: id, mode: 'queue', content: [{ type: 'text', text: q }] }, new AbortController().signal)
        await Promise.race([agent(id).whenIdle(), sleep(180000).then(() => { throw new Error('turn timeout') })])
        const traced = readFileSync(process.env.JIUWEN_TRACE_FILE, 'utf8').slice(before).split('\n').filter(Boolean).map(l => JSON.parse(l))
        lastTools = new Set(traced.filter(e => e.at === 'event' && ['tool_call','native_tool_call'].includes(e.type)).map(e=>e.name))
        lastDenied = traced.some(e => e.type === 'tool_result' && /denied|rejected|read-only file system/i.test(String(e.result)))
        lastHostRequests = traced.filter(e => e.at === 'event' && e.type === 'host_request').length
        return reply(id)
      }
      const calls = id => events(id).filter(e => /tool.*call/.test(e.type))
      // Native + host tool names are asserted by the parent against adapter NDJSON trace.
      const id = await create()
      check('plain-chat', /CHAT_OK/.test(await prompt(id, 'Reply exactly CHAT_OK.')))
      check('streaming-deltas', streamDeltas > 1)
      await prompt(id, 'Remember the random code APRICOT_924. Reply SEED_OK.')
      check('multi-turn-recall', /APRICOT_924/.test(await prompt(id, 'What code did I ask you to remember?')))
      check('capabilities-command', /agent.core|skills|memory/i.test(String(await api.command(id, 'capabilities'))))
      const toolsId = await create()
      check('bash', /BASH_OK_42/.test(await prompt(toolsId, 'Use bash to run `echo BASH_OK_42`, then return its stdout.')) && lastTools.has('bash'))
      check('read', /NEEDLE_CONTENT_99/.test(await prompt(toolsId, `Use read to read ${join(cwd, 'NEEDLE.txt')}, return its contents.`)) && lastTools.has('read'))
      await prompt(toolsId, `Use write to create ${join(cwd, 'out.txt')} containing WRITE_OK_7. Then say DONE.`)
      check('write', lastTools.has('write') && existsSync(join(cwd, 'out.txt')) && readFileSync(join(cwd, 'out.txt'), 'utf8').includes('WRITE_OK_7'))
      await prompt(toolsId, `Use edit on ${join(cwd, 'edit-me.txt')} replacing OLD_VALUE with NEW_VALUE. Then say DONE.`)
      check('edit', lastTools.has('edit') && readFileSync(join(cwd, 'edit-me.txt'), 'utf8').includes('NEW_VALUE'))
      check('grep', /NEEDLE_CONTENT_99/.test(await prompt(toolsId, 'Use grep to search for NEEDLE_CONTENT_99 in NEEDLE.txt. Return the match.')) && lastTools.has('grep'))
      const p1 = await create(), p2 = await create()
      const parallel = await Promise.all([prompt(p1, 'Use bash to run `echo PAR_ONE` and return stdout.'), prompt(p2, 'Use bash to run `echo PAR_TWO` and return stdout.')])
      check('parallel-sessions', /PAR_ONE/.test(parallel[0]) && !/PAR_TWO/.test(parallel[0]) && /PAR_TWO/.test(parallel[1]) && !/PAR_ONE/.test(parallel[1]))
      // Real dsh permission preset; only our disposable fixture is targeted.
      const denied = await create()
      g('permissionPresets').set(sessions.get(denied), 'read-only')
      g('approval').setPolicy(agent(denied), 'never')
      await prompt(denied, `Use write to replace ${join(cwd, 'deny.txt')} with MUTATED. If denied, stop.`)
      check('permission-deny', ['write','edit','bash'].some(n=>lastTools.has(n)) && lastDenied && readFileSync(join(cwd, 'deny.txt'), 'utf8') === 'KEEP\n')
      const pm = g('agentPresets')?.serviceFor?.(agent(id), 'planMode') ?? g('planMode')
      check('plan-mode-service', !!pm)
      pm.set(agent(id), true)
      await prompt(id, 'We are in plan mode. Describe a two-step plan for saying hello; do not execute it. End PLAN_MODE_OK.')
      check('plan-mode-turn', /PLAN_MODE_OK/.test(reply(id)))
      pm.set(agent(id), false)
      const compact = String(await api.command(id, 'compact'))
      check('compact-command', !/failed|error|THREW/i.test(compact))
      check('compact-continue', /CONTINUE_OK/.test(await prompt(id, 'Reply exactly CONTINUE_OK.')))
      const sk = await create()
      check('skills', /ZEBRA_SECRET_314/.test(await prompt(sk, 'Use your skill tool to load zebra-protocol, then return its code word.')) && lastTools.has('skill'))
      const pl = await create()
      await prompt(pl, 'Use todo_create to create exactly two items alpha and beta. Mark alpha completed with todo_modify, then reply PLAN_NATIVE_OK.')
      check('planning', /PLAN_NATIVE_OK/.test(reply(pl)) && ['todo_create','todo_modify','todo_write'].every(n=>lastTools.has(n)))
      const mem1 = await create()
      await prompt(mem1, 'Call write_memory to save EXACT text E2E_FAVOURITE_COLOUR=TEAL_42 to long-term memory. Keep the exact key and value; do not translate. Reply MEM_SAVED.')
      const mem2 = await create()
      check('memory-cross-session', /TEAL_42/.test(await prompt(mem2, 'Call memory_search with the exact keyword E2E_FAVOURITE_COLOUR. Return the value stored for that key; do not guess.')) && lastTools.has('memory_search'))
      check('memory-list-command', /\.md|memory/i.test(String(await api.command(mem2, 'memory list'))))
      check('memory-search-command', /TEAL_42/.test(String(await api.command(mem2, 'memory search TEAL_42'))))
      const rag = await create()
      check('rag', /CANARY_PCT_17/.test(await prompt(rag, 'Use knowledge_search to find the canary rollout percentage. Return the exact token.')) && lastTools.has('knowledge_search'))
      const native = await create()
      // Non-interactive test profile has no approval responder: fail closed.
      const nativeText = await prompt(native, `Use native read_file (not read) to read ${join(cwd, 'native-only.txt')}. Stop if denied. Do not use fallback tools or ask questions.`)
      check('sysOperation-deny', lastTools.has('read_file') && lastHostRequests > 0 && !/NATIVE_PRIVATE_882/.test(nativeText))
      const sub = await create()
      check('subagents', /SUB_OK_7/.test(await prompt(sub, 'Call task_tool with subagent_type "general-purpose" and task_description "Use bash to run echo SUB_OK_7 and return stdout". Do not run bash yourself. Return the child output.')) && lastTools.has('task_tool') && lastTools.has('bash'))
      const cancel = await create()
      const cancelStart = readFileSync(process.env.JIUWEN_TRACE_FILE, 'utf8').length
      const running = prompt(cancel, 'Use bash to run `sleep 20; echo NEVER_FINISH` and return stdout.')
      // Wait for the actual tool call, not an arbitrary model latency.
      let seen = false
      for (let n = 0; n < 600; n++) { if (readFileSync(process.env.JIUWEN_TRACE_FILE, 'utf8').slice(cancelStart).split('\n').filter(Boolean).some(l => { const e=JSON.parse(l); return e.type==='tool_call' && e.name==='bash' && /sleep 20/.test(JSON.stringify(e.arguments)) })) { seen = true; break }; await sleep(100) }
      if (seen) agent(cancel).cancel({ kind: 'user' })
      await running
      check('cancel', seen && !/NEVER_FINISH/.test(reply(cancel)))
      check('after-cancel', /AFTER_CANCEL_OK/.test(await prompt(cancel, 'Reply exactly AFTER_CANCEL_OK.')))
      // Memory clear requires confirm; confirm actually clears.
      check('memory-clear-requires-confirm', /clear confirm|deletes|confirm/i.test(String(await api.command(mem2, 'memory clear'))) )
      const cleared = String(await api.command(mem2, 'memory clear confirm'))
      const afterClear = String(await api.command(mem2, 'memory search TEAL_42'))
      const afterList = String(await api.command(mem2, 'memory list'))
      check('memory-clear-confirm', /cleared|removed/i.test(cleared) && (/no hits|empty/i.test(afterClear + afterList) || !/TEAL_42/.test(afterList)))
      // Missing skill soft-fail
      const miss = await create()
      const missText = await prompt(miss, 'Use the skill tool with name definitely-missing-skill-xyz. After the tool returns, reply MISSING_SKILL_OK if it failed or was not found.')
      check('skill-missing', /MISSING_SKILL_OK|not found|unknown|missing|no such|does not exist|failed|error/i.test(missText) || lastTools.has('skill') || lastTools.has('skill_tool'))
      // Deny then allow: read-only deny write, then restore and write
      const da = await create()
      g('permissionPresets').set(sessions.get(da), 'read-only')
      g('approval').setPolicy(agent(da), 'never')
      await prompt(da, `Use write to replace ${join(cwd, 'deny.txt')} with MUTATED_AGAIN. If denied, stop.`)
      const deniedAgain = lastDenied && readFileSync(join(cwd, 'deny.txt'), 'utf8') === 'KEEP\n'
      g('permissionPresets').set(sessions.get(da), 'workspace-write')
      g('approval').setPolicy(agent(da), 'never')
      await prompt(da, `Use write to create ${join(cwd, 'allow-next.txt')} containing ALLOW_NEXT_3. Reply DONE.`)
      check('deny-then-allow', deniedAgain && existsSync(join(cwd, 'allow-next.txt')) && readFileSync(join(cwd, 'allow-next.txt'), 'utf8').includes('ALLOW_NEXT_3'))
      // Capabilities under concurrent sessions
      const cids = await Promise.all([create(), create(), create(), create()])
      const caps = await Promise.all(cids.map(id => api.command(id, 'capabilities')))
      check('capabilities-under-load', caps.every(c => /agent.core|skills|memory/i.test(String(c))))
      // Archive round-trip and explicit destructive confirmation semantics.

      const archive = String(await api.command(mem2, 'archive'))
      let unarchive = ''
      for (let n=0;n<30;n++) { unarchive=String(await api.command(mem2,'unarchive')); if (!/resource operation is already running/i.test(unarchive)) break; await sleep(100) }
      check('archive-unarchive', /^Archived/.test(archive) && /^Unarchived/.test(unarchive))
      check('delete-requires-confirm', /confirm/i.test(String(await api.command(mem2,'delete'))) && !!api.sessions.get(mem2))
      check('delete-confirm', /deleted|cleared/i.test(String(await api.command(mem2,'delete confirm'))) && !api.sessions.get(mem2))
      check('no-cwd-junk', !['AGENT.md','memory','coding_memory','.agent','rag'].some(f=>existsSync(join(cwd,f))))
    } catch (e) { check('driver-completed', false); try { writeFileSync(process.env.E2E_OUT + '.error', String(e && e.stack || e), { mode: 0o600 }) } catch {} ; console.error('[e2e] driver error:', e.message) }
    finally { writeFileSync(process.env.E2E_OUT, JSON.stringify(results, null, 2)) }
  }, 1000)
}
