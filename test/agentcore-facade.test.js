import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from '../src/session-store.js'
import { createAgentCoreState, statePathFromMapping } from '../src/agentcore-state.js'
import { createAgentCoreFacade, bindAgentCoreFacade } from '../src/agentcore-facade.js'
import { resolveConfig } from '../src/config.js'

test('resolveConfig default backend is agent-core', () => {
  assert.equal(resolveConfig({}, { env: {} }).backend, 'agent-core')
})

test('agentcore-state heartbeat/permissions/plugins/skills round-trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acs-'))
  const st = createAgentCoreState(join(dir, 'state.json'))
  assert.equal(st.getHeartbeat().every, 3600)
  st.setHeartbeat({ every: 120 })
  assert.equal(st.getHeartbeat().every, 120)
  st.updatePermission('bash', 'deny')
  assert.equal(st.getPermissions().tools.bash, 'deny')
  st.deletePermission('bash')
  assert.equal(st.getPermissions().tools.bash, undefined)
  st.setPlugin('demo', true)
  assert.equal(st.listPlugins().plugins[0].enabled, true)
  st.setSkill('s1', false)
  assert.equal(st.listSkills().skills.find(s => s.name === 's1').enabled, false)
  assert.ok(statePathFromMapping('/x/map.json').endsWith('agentcore-state.json'))
})

test('facade covers session/skills/goal/plan/permissions/heartbeat/mcp/memory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acf-'))
  const sessions = new SessionStore(join(dir, 'map.json'))
  const state = createAgentCoreState(join(dir, 'state.json'))
  const acCalls = []
  const ac = {
    sessionHistory: async (sid) => { acCalls.push(['hist', sid]); return { messages: [{ role: 'user', content: 'hi' }] } },
    sessionDelete: async (sid) => { acCalls.push(['del', sid]); return { ok: true } },
    sessionFork: async (from, to) => { acCalls.push(['fork', from, to]); return { session_id: to } },
    cancel: async (sid) => { acCalls.push(['cancel', sid]); return { ok: true } },
  }
  const facade = createAgentCoreFacade({
    sessions,
    getConfig: () => ({ models: [{ id: 'm1', modelName: 'm1' }], defaultModel: 'm1', mcpServerName: 'dsh-tools' }),
    getAgentcore: () => ac,
    state,
    getHostServices: () => ({
      skills: {
        list: async () => [{ name: 'host-skill', description: 'd' }],
        get: async () => ({ content: 'BODY' }),
      },
    }),
  })

  sessions.ensure('d1', { preferredJiuwenId: 'j1' })
  await facade.sessionRename('d1', 'Hello')
  assert.equal(sessions.get('d1').title, 'Hello')
  await facade.sessionPin('d1', true)
  assert.equal(sessions.get('d1').pinned, true)
  await facade.sessionArchive('d1')
  assert.equal(sessions.get('d1').archived, true)
  await facade.sessionUnarchive('d1')
  assert.equal(sessions.get('d1').archived, false)
  await facade.sessionSwitch('d1')
  assert.equal(sessions.get('d1').active, true)

  const meta = await facade.sessionMetadata('d1')
  assert.equal(meta.title, 'Hello')

  await facade.goal('d1', { action: 'set', objective: 'ship it' })
  assert.equal(sessions.get('d1').goal.objective, 'ship it')
  assert.equal((await facade.goal('d1', { action: 'get' })).goal.objective, 'ship it')
  await facade.goal('d1', { action: 'pause' })
  assert.equal(sessions.get('d1').goal.phase, 'paused')
  await facade.goal('d1', { action: 'clear' })
  assert.equal(sessions.get('d1').goal, undefined)

  sessions.update('d1', { chatMode: 'agent.plan' })
  assert.equal((await facade.planStatus('d1')).in_plan, true)

  await facade.permissionsToolsUpdate('bash', 'ask')
  assert.equal((await facade.permissionsToolsGet()).tools.bash, 'ask')
  await facade.heartbeatSetConf({ every: 99 })
  assert.equal((await facade.heartbeatConf()).every, 99)

  const skills = await facade.skillsList()
  assert.ok(skills.skills.some(s => s.name === 'host-skill'))
  await facade.skillsToggle('host-skill', true)
  assert.ok(sessions.get('d1').skills.includes('host-skill'))

  const mcp = await facade.mcpList()
  assert.equal(mcp.servers[0].transport, 'local-function')
  assert.equal((await facade.memoryStatus('d1')).bridge, 'adapter')
  assert.equal((await facade.modelsList()).active_model, 'm1')

  await facade.rpc('session.rename', { session_id: 'd1', title: 'T2' })
  assert.equal(sessions.get('d1').title, 'T2')
  await facade.rpc('command.goal', { session_id: 'd1', action: 'set', objective: 'g2' })
  assert.equal(sessions.get('d1').goal.objective, 'g2')
  await facade.rpc('heartbeat.set_conf', { every: 42 })
  assert.equal((await facade.heartbeatConf()).every, 42)

  await facade.historyGet('d1')
  await facade.sessionFork('d1', { to: 'fork-x' })
  await facade.interrupt('d1')
  assert.ok(acCalls.some(c => c[0] === 'hist'))
  assert.ok(acCalls.some(c => c[0] === 'fork'))
  assert.ok(acCalls.some(c => c[0] === 'cancel'))

  // bind: agent-core routes to facade; gateway keeps base
  const base = { skillsList: async () => ({ skills: ['gw'] }), rpc: async () => ({ via: 'gw' }) }
  let backend = 'agent-core'
  const bound = bindAgentCoreFacade(base, facade, () => ({ backend }))
  assert.ok((await bound.skillsList()).skills.some(s => s.name === 'host-skill'))
  backend = 'gateway'
  assert.deepEqual(await bound.skillsList(), { skills: ['gw'] })
})

test('facade covers remaining session/list/create/archive/memory/plugins/misc RPCs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acf2-'))
  const sessions = new SessionStore(join(dir, 'map.json'))
  const state = createAgentCoreState(join(dir, 'state.json'))
  const ac = {
    sessionHistory: async () => ({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] }),
    sessionDelete: async (sid) => ({ deleted: sid }),
    sessionFork: async (_f, to) => ({ session_id: to }),
    cancel: async () => ({ ok: true }),
  }
  const facade = createAgentCoreFacade({
    sessions,
    getConfig: () => ({ models: [{ id: 'm' }], projectDir: '/w', mcpServerName: 'dsh-tools' }),
    getAgentcore: () => ac,
    state,
    getHostServices: () => ({ skills: { list: async () => { throw new Error('no skills') } } }),
  })
  const created = await facade.sessionCreate({ title: 'N', dsh_session_id: 'd2' })
  assert.ok(created.session_id)
  assert.equal(sessions.get('d2').title, 'N')
  const listed = await facade.sessionList()
  assert.ok(listed.sessions.length >= 1)
  await facade.sessionArchive('d2')
  const arch = await facade.sessionArchivedList()
  assert.ok(arch.sessions.some(s => s.session_id === sessions.get('d2').jiuwenSessionId))
  await facade.sessionUnarchive(['d2'])
  assert.equal(sessions.get('d2').archived, false)

  assert.equal((await facade.historyListTurns('d2')).turns, 2)
  assert.ok(await facade.historyMessages('d2'))
  await facade.chatCancel('d2')
  await facade.chatResume('d2')
  assert.equal(sessions.get('d2').paused, false)
  assert.ok((await facade.modelsGet('m')).model)
  await facade.skillsInstalled()
  await facade.permissionsToolsDelete('x')
  assert.deepEqual((await facade.permissionsRulesGet()).rules, [])
  await facade.pluginsEnable('p1')
  await facade.pluginsDisable('p1')
  assert.equal((await facade.pluginsList()).plugins.find(p => p.name === 'p1').enabled, false)
  assert.deepEqual((await facade.heartbeatJobList()).jobs, [])
  await facade.compact('d2')
  assert.equal(sessions.get('d2').systemHash, undefined)
  assert.ok((await facade.memoryList('d2')).bridge)
  assert.ok(Array.isArray((await facade.filesList('d2')).files))
  assert.ok((await facade.agentsList()).agents)
  assert.deepEqual((await facade.teamList()).teams, [])
  assert.ok((await facade.teamTemplatesList()).templates.length >= 1)
  assert.deepEqual((await facade.agentsToolsList()).tools, [])
  assert.deepEqual((await facade.hooksList()).hooks, [])
  assert.deepEqual((await facade.projectList()).projects, [])
  assert.equal((await facade.projectInfo()).project, null)
  assert.ok(Array.isArray((await facade.projectGetSessions()).sessions))
  assert.equal((await facade.updaterStatus()).backend, 'agent-core')
  assert.equal((await facade.pathGet()).path, '/w')
  assert.equal((await facade.localeGetConf()).locale, 'en')
  assert.deepEqual((await facade.cronJobList()).jobs, [])
  assert.deepEqual((await facade.agentTemplatesList()).templates, [])
  assert.deepEqual((await facade.commandsList()).commands, [])
  assert.ok((await facade.btw('d2', 'q')).note)
  assert.ok((await facade.recap('d2')).recap)
  await facade.userAnswer('d2', { a: 1 })
  assert.deepEqual((await facade.workflows()).workflows, [])
  assert.ok((await facade.sessionAssetsList()).assets)
  assert.ok(Array.isArray((await facade.memoryStatus('d2')).providers))
  assert.ok(Array.isArray((await facade.skillsMarketplaceList()).marketplaces))
  assert.equal((await facade.teamList()).gatewayFallback, true)

  // gateway auto-route when facade marks gatewayFallback
  {
    let routed = false
    const baseGw = {
      rpc: async () => ({ g: 1 }),
      teamList: async () => { routed = true; return { teams: [{ team_name: 'from-gw' }] } },
      skillsMarketplaceList: async () => ({ marketplaces: [{ name: 'hub' }] }),
    }
    const bound = bindAgentCoreFacade(baseGw, facade, () => ({ backend: 'agent-core', gatewayURL: 'ws://127.0.0.1:19000/ws' }))
    const tl = await bound.teamList()
    assert.equal(routed, true)
    assert.equal(tl.routedVia, 'gateway')
    assert.equal(tl.teams[0].team_name, 'from-gw')
  }

  // rpc coverage for remaining methods
  for (const [m, p] of [
    ['session.list', {}],
    ['session.create', { dsh_session_id: 'd3', title: 'x' }],
    ['session.metadata', { session_id: 'd2' }],
    ['session.pin', { session_id: 'd2', pinned: false }],
    ['session.switch', { session_id: 'd2' }],
    ['session.archived.list', {}],
    ['chat.resume', { session_id: 'd2' }],
    ['models.get', { model_id: 'm' }],
    ['skills.installed', {}],
    ['permissions.tools.delete', { tool: 'z' }],
    ['permissions.rules.get', {}],
    ['plugins.enable', { name: 'px' }],
    ['plugins.disable', { name: 'px' }],
    ['plugins.list', {}],
    ['heartbeat.get_conf', {}],
    ['plan.status', { session_id: 'd2' }],
    ['command.compact', { session_id: 'd2' }],
    ['mcp.list', {}],
    ['memory.list', { session_id: 'd2' }],
    ['memory.status', { session_id: 'd2' }],
  ]) {
    assert.ok(await facade.rpc(m, p))
  }
  assert.equal(await facade.supports('session.rename'), true)
  await assert.rejects(() => facade.rpc('no.such.method', {}), (e) => e.code === 'UNSUPPORTED')
  assert.deepEqual(facade.unsupported(), [])

  // bind gateway passthrough for non-function props
  const base = { rpc: async () => ({ g: 1 }), skillsList: async () => ({ skills: [] }), meta: 1 }
  const bound = bindAgentCoreFacade(base, facade, () => ({ backend: 'gateway' }))
  assert.equal(bound.meta, 1)
  assert.deepEqual(await bound.rpc('x', {}), { g: 1 })
  const boundAc = bindAgentCoreFacade(base, facade, () => ({ backend: 'agent-core' }))
  assert.ok(await boundAc.rpc('models.list', {}))
})

test('facade assets/teams/workflows/marketplace/memory providers + gatewayFallback off', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-facade2-'))
  const sessions = new SessionStore(join(dir, 'map.json'))
  const state = createAgentCoreState(join(dir, 'state.json'))
  state.upsertTeam({ team_name: 'local-team' })
  state.setWorkflows([{ id: 'wf1', name: 'demo' }])
  state.setMarketplaces([{ name: 'local-hub', enabled: true }])
  const facade = createAgentCoreFacade({
    sessions,
    getConfig: () => ({ backend: 'agent-core', projectDir: dir, agentcoreCheckpointDir: dir, gatewayFallback: false }),
    getAgentcore: () => ({
      sessionHistory: async () => ({ messages: [] }),
      sessionDelete: async () => ({ ok: true }),
      sessionFork: async () => ({ session_id: 'f' }),
      cancel: async () => ({ ok: true }),
    }),
    state,
  })
  const assets = await facade.sessionAssetsList()
  assert.ok(Array.isArray(assets.assets))
  assert.equal((await facade.teamList()).teams[0].team_name, 'local-team')
  assert.ok((await facade.teamTemplatesList()).templates.some(t => t.name === 'hierarchical'))
  assert.equal((await facade.workflows()).workflows[0].id, 'wf1')
  assert.equal((await facade.workflows(null, 'get_workflow', { workflow_id: 'wf1' })).workflow.id, 'wf1')
  assert.equal((await facade.skillsMarketplaceList()).marketplaces[0].name, 'local-hub')
  assert.ok((await facade.memoryStatus('x')).providers.some(p => p.name === 'mem0'))
  assert.ok(await facade.rpc('team.list', {}))
  assert.ok(await facade.rpc('session.assets.list', {}))
  // gatewayFallback disabled: keep local result even if base would route
  let called = false
  const bound = bindAgentCoreFacade({
    teamList: async () => { called = true; return { teams: [{ team_name: 'gw' }] } },
  }, facade, () => ({ backend: 'agent-core', gatewayURL: 'ws://127.0.0.1:19000/ws', gatewayFallback: false }))
  const tl = await bound.teamList()
  assert.equal(called, false)
  assert.equal(tl.teams[0].team_name, 'local-team')
  rmSync(dir, { recursive: true, force: true })
})

test('bindAgentCoreFacade rpc auto-route + missing method + session delete/switch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-facade3-'))
  const sessions = new SessionStore(join(dir, 'map.json'))
  sessions.ensure('a', { preferredJiuwenId: 'ja' })
  sessions.ensure('b', { preferredJiuwenId: 'jb' })
  sessions.update('a', { active: true })
  const state = createAgentCoreState(join(dir, 'state.json'))
  let deleted = null
  const facade = createAgentCoreFacade({
    sessions,
    getConfig: () => ({ backend: 'agent-core', projectDir: dir, gatewayURL: 'ws://127.0.0.1:9/ws' }),
    getAgentcore: () => ({
      sessionHistory: async () => ({ messages: [{ role: 'user' }] }),
      sessionDelete: async (id) => { deleted = id; return null },
      sessionFork: async () => ({ new_session_id: 'nf' }),
      cancel: async () => ({ ok: true }),
    }),
    state,
  })
  await facade.sessionSwitch('b')
  assert.equal(sessions.get('b').active, true)
  assert.equal(sessions.get('a').active, false)
  await facade.sessionDelete('a')
  assert.equal(deleted, 'ja')
  assert.ok(!(sessions.get('a')))
  assert.equal((await facade.skillsGet('nope')).gatewayFallback, true)
  assert.ok(Array.isArray((await facade.skillsVersionsList('x')).versions))
  assert.equal((await facade.workflows(null, 'get', { id: 'missing' })).gatewayFallback, true)

  const base = {
    rpc: async (m) => ({ method: m, from: 'gw' }),
    unsupported: () => ['x'],
    onlyOnGateway: async () => ({ ok: 1 }),
    teamList: async () => { throw new Error('gw down') },
  }
  const bound = bindAgentCoreFacade(base, facade, () => ({ backend: 'agent-core', gatewayURL: 'ws://x', gatewayFallback: true }))
  assert.deepEqual(bound.unsupported(), [])
  const routedRpc = await bound.rpc('totally.unknown', {})
  assert.equal(routedRpc.routedVia, 'gateway')
  assert.equal(routedRpc.method, 'totally.unknown')
  const only = await bound.onlyOnGateway()
  assert.equal(only.routedVia, 'gateway')
  // teamList fallback catches gw error and keeps local
  const tl = await bound.teamList()
  assert.ok(!tl.routedVia)
  const boundGw = bindAgentCoreFacade(base, facade, () => ({ backend: 'gateway' }))
  assert.deepEqual(boundGw.unsupported(), ['x'])
  assert.deepEqual(await boundGw.rpc('z', {}), { method: 'z', from: 'gw' })
  rmSync(dir, { recursive: true, force: true })
})
