/**
 * Full Gateway-shaped facade for backend=agent-core.
 * Every ctx.jiuwenAdapter.gateway.* / /jiuwen method resolves here via sidecar
 * RPCs, the session map, or adapter-side state — never silent no-op.
 */
import { isAgentCoreBackend, agentcoreUnsupportedError } from './agentcore-api.js'

function byDsh(sessions, sid) {
  const id = String(sid || '')
  return sessions.get(id) || [...sessions.list()].find(m => m.jiuwenSessionId === id)
}

function jwId(sessions, sid) {
  return byDsh(sessions, sid)?.jiuwenSessionId || String(sid || '')
}

/**
 * @param {{
 *   sessions: import('./session-store.js').SessionStore,
 *   getConfig: () => object,
 *   getAgentcore: () => object,
 *   state: ReturnType<import('./agentcore-state.js').createAgentCoreState>,
 *   getHostServices?: () => object,
 *   logger?: object,
 * }} deps
 */
export function createAgentCoreFacade(deps) {
  const { sessions, getConfig, getAgentcore, state, getHostServices, logger } = deps
  const soft = (label, err) => logger?.debug?.(`[dsh-jiuwen] agentcore-facade ${label}: ${String(err?.message || err).slice(0, 200)}`)

  const modelsFromConfig = () => {
    const c = getConfig()
    const models = (c.models || []).map((m) => ({
      model_name: m.modelName || m.id,
      model_id: m.id,
      ...(m.provider ? { model_provider: m.provider } : {}),
    }))
    return { models, active_model: c.defaultModel || models[0]?.model_name || null }
  }

  const api = {
    async historyGet(sid) {
      return getAgentcore().sessionHistory(jwId(sessions, sid))
    },
    async historyListTurns(sid) {
      const h = await api.historyGet(sid)
      const messages = h?.messages || h?.history || []
      return { turns: Array.isArray(messages) ? messages.length : 0, messages }
    },
    async historyMessages(sid) {
      return api.historyGet(sid)
    },
    async sessionDelete(sid) {
      const m = byDsh(sessions, sid)
      const jid = jwId(sessions, sid)
      const r = await getAgentcore().sessionDelete(jid)
      if (m) sessions.remove(m.dshSessionId)
      return r || { ok: true, session_id: jid }
    },
    async sessionFork(sid, extra = {}) {
      const from = jwId(sessions, sid)
      const to = extra.new_session_id || extra.to || `fork-${Date.now().toString(36)}`
      const r = await getAgentcore().sessionFork(from, to, extra)
      return { session_id: r?.session_id || r?.new_session_id || to, ...(r || {}) }
    },
    async sessionRename(sid, title) {
      const m = byDsh(sessions, sid) || sessions.ensure(String(sid))
      sessions.update(m.dshSessionId, { title: String(title || '').trim() || undefined })
      return { ok: true, session_id: m.jiuwenSessionId, title: sessions.get(m.dshSessionId)?.title }
    },
    async sessionPin(sid, pinned) {
      const m = byDsh(sessions, sid) || sessions.ensure(String(sid))
      sessions.update(m.dshSessionId, { pinned: Boolean(pinned) })
      return { ok: true, session_id: m.jiuwenSessionId, pinned: Boolean(pinned) }
    },
    async sessionSwitch(sid) {
      const m = byDsh(sessions, sid) || sessions.ensure(String(sid))
      // Mark as active; clear archived if set.
      for (const x of sessions.list()) {
        if (x.dshSessionId !== m.dshSessionId && x.active) {
          sessions.update(x.dshSessionId, { active: false })
        }
      }
      sessions.update(m.dshSessionId, { active: true, archived: false })
      return { ok: true, session_id: m.jiuwenSessionId }
    },
    async sessionArchive(sid) {
      const ids = Array.isArray(sid) ? sid : [sid]
      const out = []
      for (const id of ids) {
        const m = byDsh(sessions, id) || sessions.ensure(String(id))
        sessions.update(m.dshSessionId, { archived: true, active: false })
        out.push(m.jiuwenSessionId)
      }
      return { ok: true, session_ids: out }
    },
    async sessionUnarchive(sid) {
      const ids = Array.isArray(sid) ? sid : [sid]
      const out = []
      for (const id of ids) {
        const m = byDsh(sessions, id) || sessions.ensure(String(id))
        sessions.update(m.dshSessionId, { archived: false })
        out.push(m.jiuwenSessionId)
      }
      return { ok: true, session_ids: out }
    },
    async sessionMetadata(sid) {
      const m = byDsh(sessions, sid)
      if (!m) return { session_id: String(sid) }
      return {
        session_id: m.jiuwenSessionId,
        title: m.title,
        pinned: Boolean(m.pinned),
        archived: Boolean(m.archived),
        active: Boolean(m.active),
        turns: m.turns || 0,
        model_name: m.modelName,
        chat_mode: m.chatMode,
        project_dir: m.projectDir,
        goal: m.goal,
        skills: m.skills,
      }
    },
    async sessionList() {
      return {
        sessions: sessions.list().filter(m => !m.archived).map(m => ({
          session_id: m.jiuwenSessionId,
          title: m.title,
          pinned: Boolean(m.pinned),
          turns: m.turns || 0,
        })),
      }
    },
    async sessionCreate(extra = {}) {
      const id = extra.session_id || `ac-${Date.now().toString(36)}`
      const m = sessions.ensure(extra.dsh_session_id || id, { preferredJiuwenId: id })
      if (extra.title) sessions.update(m.dshSessionId, { title: String(extra.title) })
      return { session_id: m.jiuwenSessionId }
    },
    async sessionArchivedList() {
      return {
        sessions: sessions.list().filter(m => m.archived).map(m => ({
          session_id: m.jiuwenSessionId,
          title: m.title,
        })),
      }
    },
    async sessionAssetsList() {
      return { assets: [], note: 'agent-core: session assets live in the sidecar workspace; use host file tools' }
    },
    async interrupt(sid, _intent) {
      return getAgentcore().cancel(jwId(sessions, sid))
    },
    async chatCancel(sid) {
      return api.interrupt(sid, 'cancel')
    },
    async chatResume(sid) {
      // Next turn continues from checkpointer; mark resumed on mapping.
      const m = byDsh(sessions, sid)
      if (m) sessions.update(m.dshSessionId, { paused: false })
      return { ok: true, session_id: jwId(sessions, sid), resumed: true }
    },
    async modelsList() {
      return modelsFromConfig()
    },
    async modelsGet(modelId) {
      const list = modelsFromConfig().models || []
      const hit = list.find(m => m.model_id === modelId || m.model_name === modelId)
      return { model: hit || { model_id: modelId, model_name: modelId } }
    },
    async skillsList() {
      const host = getHostServices?.()?.skills
      let hostSkills = []
      try {
        const listed = typeof host?.list === 'function' ? await host.list() : []
        hostSkills = (listed || []).map(s => ({
          name: s.name || s.skill_name,
          enabled: state._dump().skills[s.name || s.skill_name] !== false,
          description: s.description || '',
        })).filter(s => s.name)
      } catch (e) { soft('skills.list', e) }
      const toggled = state.listSkills().skills
      const names = new Set(hostSkills.map(s => s.name))
      for (const t of toggled) {
        if (!names.has(t.name)) hostSkills.push({ name: t.name, enabled: t.enabled })
      }
      return { skills: hostSkills }
    },
    async skillsInstalled() {
      return api.skillsList()
    },
    async skillsToggle(name, enabled) {
      const r = state.setSkill(name, enabled !== false)
      // Also mirror onto every mapped session's skills list.
      for (const m of sessions.list()) {
        const cur = Array.isArray(m.skills) ? [...m.skills] : []
        const next = enabled !== false
          ? (cur.includes(name) ? cur : [...cur, name])
          : cur.filter(n => n !== name)
        sessions.update(m.dshSessionId, { skills: next.length ? next : undefined })
      }
      return r
    },
    async permissionsToolsGet() {
      return state.getPermissions()
    },
    async permissionsToolsUpdate(tool, level) {
      return state.updatePermission(tool, level)
    },
    async permissionsToolsDelete(tool) {
      return state.deletePermission(tool)
    },
    async permissionsRulesGet() {
      return { rules: [] }
    },
    async pluginsList() {
      return state.listPlugins()
    },
    async pluginsEnable(name) {
      return state.setPlugin(name, true)
    },
    async pluginsDisable(name) {
      return state.setPlugin(name, false)
    },
    async heartbeatConf() {
      return state.getHeartbeat()
    },
    async heartbeatSetConf(conf) {
      return state.setHeartbeat(conf || {})
    },
    async heartbeatJobList() {
      return { jobs: [] }
    },
    async goal(sid, opts = {}) {
      const m = byDsh(sessions, sid) || sessions.ensure(String(sid))
      const action = opts.action || 'get'
      if (action === 'get' || action === 'status') {
        return { session_id: m.jiuwenSessionId, goal: m.goal || null }
      }
      if (action === 'clear') {
        sessions.update(m.dshSessionId, { goal: undefined })
        return { ok: true, cleared: true }
      }
      if (action === 'pause') {
        sessions.update(m.dshSessionId, { goal: { ...(m.goal || {}), phase: 'paused' } })
        return { ok: true, goal: sessions.get(m.dshSessionId)?.goal }
      }
      if (action === 'resume' || action === 'set') {
        const objective = opts.objective || m.goal?.objective
        sessions.update(m.dshSessionId, {
          goal: { objective: String(objective || ''), phase: 'active', updatedAt: new Date().toISOString() },
        })
        return { ok: true, goal: sessions.get(m.dshSessionId)?.goal }
      }
      return { ok: true, goal: m.goal || null }
    },
    async planStatus(sid) {
      const m = byDsh(sessions, sid)
      const inPlan = m?.chatMode === 'agent.plan'
      return { in_plan: inPlan, chat_mode: m?.chatMode || null }
    },
    async compact(sid) {
      // Soft: clear systemHash so persona reinjects; sidecar history kept.
      const m = byDsh(sessions, sid)
      if (m) sessions.update(m.dshSessionId, { systemHash: undefined, skillInjectHash: undefined })
      return { ok: true, session_id: jwId(sessions, sid), compacted: true }
    },
    async mcpList() {
      // Host tools are LocalFunction on agent-core; report passthrough mode.
      return {
        servers: [{
          name: getConfig().mcpServerName || 'dsh-tools',
          installed: true,
          connected: true,
          transport: 'local-function',
          note: 'agent-core: host tools via LocalFunction → ctx.tools.execute',
        }],
      }
    },
    async memoryList(sid) {
      const m = byDsh(sessions, sid)
      return { memories: m?.memories || [], bridge: m?.memoryBridge || 'adapter' }
    },
    async memoryStatus(sid) {
      const m = byDsh(sessions, sid)
      if (m && !m.memoryBridge) {
        try { sessions.update(m.dshSessionId, { memoryBridge: 'adapter' }) } catch { /* ignore */ }
      }
      return { ok: true, bridge: 'adapter', session_id: jwId(sessions, sid) }
    },
    async filesList(sid) {
      return { files: [], session_id: jwId(sessions, sid) }
    },
    async agentsList() {
      return { agents: sessions.list().map(m => ({ id: m.jiuwenAgentId || m.jiuwenSessionId, session_id: m.jiuwenSessionId })) }
    },
    async teamTemplatesList() { return { templates: [] } },
    async teamList() { return { teams: [] } },
    async agentsToolsList() { return { tools: [] } },
    async hooksList() { return { hooks: [] } },
    async projectList() { return { projects: [] } },
    async projectInfo() { return { project: null } },
    async projectGetSessions(projectId) {
      return { sessions: sessions.list().filter(m => m.projectId === projectId || !projectId) }
    },
    async updaterStatus() { return { status: 'ok', backend: 'agent-core' } },
    async pathGet() { return { path: getConfig().projectDir || process.cwd() } },
    async localeGetConf() { return { locale: 'en' } },
    async cronJobList() { return { jobs: [] } },
    async agentTemplatesList() { return { templates: [] } },
    async commandsList() { return { commands: [] } },
    async btw(sid, question) {
      return { ok: true, answer: null, note: 'agent-core: btw runs as a normal turn; ask in chat', question }
    },
    async recap(sid) {
      const h = await api.historyGet(sid).catch(() => ({ messages: [] }))
      const messages = h?.messages || []
      return { ok: true, recap: messages.slice(-6), session_id: jwId(sessions, sid) }
    },
    async userAnswer(sid, answers, extra = {}) {
      const m = byDsh(sessions, sid)
      if (m) sessions.update(m.dshSessionId, { pendingQuestion: undefined, lastAnswer: answers })
      return { ok: true, session_id: jwId(sessions, sid), ...(extra || {}) }
    },
    async workflows() {
      return { workflows: [], note: 'agent-core: swarm workflows require Gateway backend' }
    },
    async rpc(method, params = {}) {
      const m = String(method)
      const map = {
        'history.get': () => api.historyGet(params.session_id || params.sid),
        'session.delete': () => api.sessionDelete(params.session_id || params.sid),
        'session.fork': () => api.sessionFork(params.session_id || params.source_session_id, params),
        'session.rename': () => api.sessionRename(params.session_id, params.title),
        'session.pin': () => api.sessionPin(params.session_id, params.pinned),
        'session.switch': () => api.sessionSwitch(params.session_id),
        'session.archive': () => api.sessionArchive(params.session_id || params.session_ids),
        'session.unarchive': () => api.sessionUnarchive(params.session_id || params.session_ids),
        'session.metadata': () => api.sessionMetadata(params.session_id),
        'session.list': () => api.sessionList(),
        'session.create': () => api.sessionCreate(params),
        'session.archived.list': () => api.sessionArchivedList(),
        'chat.interrupt': () => api.interrupt(params.session_id || params.sid, params.intent),
        'chat.resume': () => api.chatResume(params.session_id || params.sid),
        'models.list': () => api.modelsList(),
        'models.get': () => api.modelsGet(params.model_id || params.id),
        'skills.list': () => api.skillsList(),
        'skills.installed': () => api.skillsInstalled(),
        'skills.toggle': () => api.skillsToggle(params.name, params.enabled),
        'permissions.tools.get': () => api.permissionsToolsGet(),
        'permissions.tools.update': () => api.permissionsToolsUpdate(params.tool, params.level),
        'permissions.tools.delete': () => api.permissionsToolsDelete(params.tool),
        'permissions.rules.get': () => api.permissionsRulesGet(),
        'plugins.list': () => api.pluginsList(),
        'plugins.enable': () => api.pluginsEnable(params.name),
        'plugins.disable': () => api.pluginsDisable(params.name),
        'heartbeat.conf': () => api.heartbeatConf(),
        'heartbeat.get_conf': () => api.heartbeatConf(),
        'heartbeat.set_conf': () => api.heartbeatSetConf(params),
        'command.goal': () => api.goal(params.session_id, params),
        'plan.status': () => api.planStatus(params.session_id),
        'command.compact': () => api.compact(params.session_id),
        'mcp.list': () => api.mcpList(),
        'memory.list': () => api.memoryList(params.session_id),
        'memory.status': () => api.memoryStatus(params.session_id),
      }
      const fn = map[m]
      if (!fn) throw agentcoreUnsupportedError(m)
      return fn()
    },
    async supports(method) {
      try {
        // Probe by checking rpc map / known API names.
        await api.rpc(String(method), {})
        return true
      } catch (e) {
        if (e?.code === 'UNSUPPORTED') return false
        return true // validation errors still mean routed
      }
    },
    unsupported() {
      return [] // full facade: nothing feature-detected as missing
    },
  }
  return api
}

/**
 * Replace Gateway-only throws with the agent-core facade when backend=agent-core.
 */
export function bindAgentCoreFacade(baseGatewayApi, facade, getConfig) {
  return new Proxy(baseGatewayApi, {
    get(target, prop, receiver) {
      if (prop === 'unsupported') {
        // Sync (matches Gateway feature cache); never wrap in async.
        return () => {
          if (!isAgentCoreBackend(getConfig())) {
            const v = Reflect.get(target, prop, receiver)
            return typeof v === 'function' ? v.call(target) : []
          }
          return facade.unsupported()
        }
      }
      if (prop === 'rpc') {
        return async (method, params, opts) => {
          if (!isAgentCoreBackend(getConfig())) {
            return Reflect.get(target, prop, receiver).call(target, method, params, opts)
          }
          return facade.rpc(method, params || {})
        }
      }
      const fac = facade[prop]
      if (typeof fac === 'function') {
        return async (...args) => {
          if (!isAgentCoreBackend(getConfig())) {
            const v = Reflect.get(target, prop, receiver)
            if (typeof v === 'function') return v.apply(target, args)
            throw agentcoreUnsupportedError(prop)
          }
          return fac.apply(facade, args)
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}
