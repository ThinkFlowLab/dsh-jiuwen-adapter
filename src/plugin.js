import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createPersonaCapture } from './persona-capture.js'
/**
 * Cordis plugin: registers provider route `jiuwen` on ctx.llm.
 */
import { createRequire } from 'node:module'
import { resolveConfig } from './config.js'
import { validateConfig } from './config-validate.js'
import { Config } from './schema.js'
import { SessionStore } from './session-store.js'
import { createJiuwenAdapter } from './adapter.js'
import { createToolBridge } from './tool-bridge.js'
import { GatewayTransport } from './gateway-transport.js'
import { AgentCoreTransport } from './agentcore-transport.js'
import { isAgentCoreBackend } from './agentcore-api.js'
import { createAgentCoreFacade, bindAgentCoreFacade } from './agentcore-facade.js'
import { createAgentCoreState, statePathFromMapping } from './agentcore-state.js'
import { createInteractor } from './interaction.js'
import { createBusyRegistry } from './busy-interrupt.js'
import { createMcpBridge } from './mcp-bridge.js'
import { JIUWEN_SIDE_EFFECT_TOOLS, JIUWEN_HIDE_DENY_TOOLS } from './fs-route.js'
import { createPermissionLedger } from './perm-ledger.js'
import { createGoalBridge } from './goal-bridge.js'
import { createJiuwenCommand } from './commands.js'
import { createFeatureCache } from './features.js'

export { Config }
export const name = 'llm-jiuwen'
/** Cordis event carrying structured Jiuwen activity (see index.d.ts / docs/dsh-integration.md). */
import { JIUWEN_EVENT, JIUWEN_TYPED_EVENTS } from './typed-events.js'
import { typedEventFor, installSessionSync, createPlanBridge, createModelDiscovery } from './bridges.js'
import { installHostSync } from './host-sync.js'
import { installHostModelSettings } from './host-model-settings.js'
export { JIUWEN_EVENT, JIUWEN_TYPED_EVENTS }
// Only `llm` is required. agents/tools/approval are resolved lazily per call via service() (ctx.get),
// so hosts without them (plain Cordis + dsh-llm) still load the provider; Cordis has no optional
// inject, and requiring them kept the plugin from ever starting on such hosts.
export const inject = ['llm']

export { createJiuwenAdapter as JiuwenLlmAdapter }

const require = createRequire(import.meta.url)

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} config
 */
export function apply(ctx, config = {}) {
  if (process.env.JIUWEN_TRACE_FILE) {
    try { appendFileSync(process.env.JIUWEN_TRACE_FILE, `${JSON.stringify({ t: new Date().toISOString(), up: Math.round(performance.now()), at: 'plugin-apply' })}\n`) } catch { /* ignore */ }
  }
  const dshHome = process.env.DSH_HOME
    || (typeof ctx.get === 'function' ? ctx.get('path')?.home : undefined)
    || undefined

  let resolved = resolveConfig(config, { dshHome })
  const sessions = new SessionStore(resolved.mappingPath)

  const readConfig = () => {
    resolved = resolveConfig(config, { dshHome })
    return resolved
  }
  /** dsh tool routing: Jiuwen file/shell work goes through the dsh passthrough (mapJiuwenFsToDsh + MCP). */
  const routingOn = (c = readConfig()) => Boolean(c.mapJiuwenFsToDsh && c.toolPassthrough === 'mcp')

  const logger = ctx.logger ?? console
  const modelSettings = installHostModelSettings({ ctx, readConfig, logger })
  // Warn (never throw) about unknown/misspelled/deprecated keys so a typo cannot silently disable a feature.
  for (const w of validateConfig(config)) { try { logger.warn?.(`[jiuwen] ${w}`) } catch { /* ignore */ } }
  const LlmAdapter = loadLlmAdapter(logger, resolved)

  const listeners = new Set()
  let planBridge = null
  const onEvent = (e) => {
    for (const fn of listeners) { try { fn(e) } catch { /* ignore */ } }
    try { ctx.emit?.(JIUWEN_EVENT, e) } catch { /* host may not declare the event */ }
    const c = resolved
    if (c.typedEvents) {
      try { const t = typedEventFor(e); if (t) ctx.emit?.(t[0], t[1]) } catch { /* ignore */ }
    }
    if (c.planBridge && planBridge) { try { planBridge(e) } catch { /* ignore */ } }
  }
  const service = (name) => { try { return (typeof ctx.get === 'function' ? ctx.get(name) : undefined) ?? ctx[name] } catch { return undefined } }
  const interact = createInteractor({
    config: readConfig,
    logger,
    services: () => ({ userQuestions: service('userQuestions'), approval: service('approval'), agents: service('agents') }),
    // Subscribed lazily on the first jiuwen question card, so hosts that never see one get no listener.
    onUserMessage: (fn) => ctx.on?.('agent/inbox/inserted', fn, { global: true }),
    // dsh tool routing for a session: Jiuwen permission asks for hidden duplicate built-ins are decided here.
    routing: (sid) => {
      const c = readConfig()
      if (!routingOn(c)) return { on: false }
      return { on: true, serverName: mcpBridge.sessionServerName(sid), exposed: mcpBridge.exposed(sid) }
    },
  })
  const mcpBridge = createMcpBridge({
    config: readConfig,
    logger,
    services: () => ({ tools: service('tools'), approval: service('approval'), agents: service('agents') }),
    rpc: (method, params, opts) => gatewayFor().rpc(method, params, opts),
  })
  // Jiuwen global tool permissions the adapter owns (perm-ledger.js): with dsh tool routing on, deny
  // Jiuwen's bash/write_file/edit_file (shell/file IO goes through dsh: sandbox/approval/jobs) and,
  // with hideJiuwenBuiltins 'deny' and dsh's `subagent` passed through, Jiuwen's delegation
  // built-ins; with routing off, restore whatever the adapter wrote before. Never stomps a value
  // someone else changed. Desired entries only grow within a process (sessions differ in tools).
  const permLedger = createPermissionLedger({
    file: join(dirname(String(readConfig().mappingPath)), 'jiuwen-permissions.json'),
    rpc: (method, params, opts) => gatewayFor().rpc(method, params, opts),
    logger,
    target: String(readConfig().gatewayURL || 'default'),
  })
  const wantDeny = new Set()
  let permsKey = null
  let permsRun = null
  const ensurePermissions = (exposedTools) => {
    const c = readConfig()
    if (routingOn(c)) {
      for (const t of JIUWEN_SIDE_EFFECT_TOOLS) wantDeny.add(t)
      if (c.hideJiuwenBuiltins === 'deny' && Array.isArray(exposedTools) && exposedTools.includes('subagent')) for (const t of JIUWEN_HIDE_DENY_TOOLS) wantDeny.add(t)
    } else wantDeny.clear()
    const desired = Object.fromEntries([...wantDeny].map(t => [t, 'deny']))
    const key = JSON.stringify(desired)
    if (key === permsKey) return permsRun
    permsKey = key
    // Pre-ledger entries: the routed denies this adapter always wrote (adopted only on the first run).
    const adopt = Object.fromEntries(JIUWEN_SIDE_EFFECT_TOOLS.map(t => [t, 'deny']))
    permsRun = permLedger.reconcile(desired, { owner: 'route', adopt }).then((r) => {
      if (!r.ok) permsKey = null // retry on the next turn
      if (r.applied?.length || r.released?.length || r.adopted?.length || r.dropped?.length) {
        logger?.info?.(`[dsh-jiuwen] Jiuwen permissions reconciled: denied=[${r.applied}] restored=[${r.released}] adopted=[${r.adopted}] left-to-user=[${r.dropped}]`)
      }
      return r
    }).catch((e) => { permsKey = null; logger?.warn?.(`[dsh-jiuwen] Jiuwen permission reconcile failed: ${e?.message || e}`) })
    return permsRun
  }
  const originalPrepare = mcpBridge.prepare.bind(mcpBridge)
  mcpBridge.prepare = async (...args) => {
    const r = await originalPrepare(...args)
    if (routingOn()) await ensurePermissions(mcpBridge.exposed(args[1]))
    return r
  }
  // Routing off (or toggled off since the last run): restore the adapter's entries at start (background).
  if (!routingOn() && readConfig().hostSync !== false) {
    const t = setTimeout(() => { ensurePermissions() }, 1500); t.unref?.()
  }
  const goalBridge = createGoalBridge({
    callTool: (sid, name, args) => mcpBridge.callTool(sid, name, args),
    exposed: (sid) => mcpBridge.exposed(sid),
    enabled: () => routingOn() && readConfig().hideJiuwenBuiltins !== 'off',
    logger,
  })
  // Startup GC of stale per-session MCP proxies (background, fail-soft) before the first turn.
  if (readConfig().toolPassthrough === 'mcp' && readConfig().mcpGcOnStart !== false) {
    const gcTimer = setTimeout(() => { mcpBridge.startGc().catch?.(() => {}) }, 1000); gcTimer.unref?.()
  }
  // Generic persona source (plain dsh personas); observe-only, off with hostSync:false or injectSystem!=persona.
  let hostSync
  const personaCfg = readConfig()
  const personaCapture = personaCfg.hostSync !== false && personaCfg.injectSystem === 'persona' ? createPersonaCapture(ctx, logger) : { get: () => undefined, dispose: () => {} }
  // Interrupt-on-busy (onBusyMessage): generic, keyed by host session id via agent/inbox/inserted.
  const busy = createBusyRegistry({
    config: readConfig,
    logger,
    agentFor: (id) => { try { return service('agents')?.get?.(id) } catch { return undefined } },
    trace: (rec) => { const f = readConfig().traceFile; if (f) { try { appendFileSync(f, `${JSON.stringify({ t: new Date().toISOString(), up: Math.round(performance.now()), ...rec })}\n`) } catch { /* ignore */ } } },
    // Subscribed lazily on the first Jiuwen turn (hosts that never run one get no listener).
    subscribe: (onMessage) => ctx.on?.('agent/inbox/inserted', ({ agent, message } = {}) => {
      if (!agent?.id) return
      const r = onMessage(String(agent.id), message)
      if (r === 'interrupt' || r === 'deferred') logger?.info?.(`[dsh-jiuwen] new user message on busy session ${agent.id}: ${r === 'deferred' ? 'interrupt deferred until the pending approval resolves' : 'interrupting the running Jiuwen turn'}`)
    }, { global: true }),
  })
  const AdapterClass = createJiuwenAdapter(LlmAdapter, {
    busy,
    personaFor: (id) => personaCapture.get(id),
    // sessionOverrides `preset`: the host agent's preset/profile name (best-effort across host shapes).
    profileFor: (id) => {
      let agent
      try { agent = service('agents')?.get?.(id) } catch { return undefined }
      const v = agent?.preset?.name ?? agent?.presetName ?? agent?.preset?.id ?? (typeof agent?.preset === 'string' ? agent.preset : undefined)
        ?? agent?.profile?.name ?? (typeof agent?.profile === 'string' ? agent.profile : undefined)
      return v === undefined ? undefined : String(v)
    },
    // Wait (bounded) for host→Jiuwen work a turn depends on: a fork remap, the first skill sync.
    awaitHostSync: async (id) => {
      const p = hostSync?.pendingFor?.(id)
      if (!p) return
      let t
      await Promise.race([p, new Promise(r => { t = setTimeout(r, 5000) })])
      clearTimeout(t)
    },
    interact,
    mcpBridge,
    goalBridge,
    // `auto` needs a live answerer, not just the service: headless dsh loads ctx.userQuestions but no
    // client listens on `user-questions/request`, so enabling it there only adds Jiuwen's ask_user
    // tool (~920 input tokens/turn) for questions that are always NO_PROVIDER.
    hasUserQuestions: () => Boolean(service('userQuestions')?.ask) && hasQuestionAnswerer(ctx),
    config: readConfig,
    sessions,
    logger,
    onEvent,
    // modelDiscovery (opt-in): Jiuwen models as unique `<discoveryPrefix><model_name>` catalog ids.
    discoverModels: () => (readConfig().modelDiscovery ? modelDiscovery.list() : Promise.resolve([])),
    resolveChildEnv: modelSettings.resolveChildEnv,
    // Host default selection (dsh-agent-default-model), so a legacy alias default stays routable in the picker.
    hostDefaultModel: () => service('agentDefaultModel')?.currentSelection?.(),
    // Optional host attachment store (generic Cordis service name `attachments`).
    attachments: () => {
      try { return (typeof ctx.get === 'function' ? ctx.get('attachments') : undefined) ?? ctx.attachments } catch { return undefined }
    },
    /** Host tool runner for agent-core LocalFunction callbacks (ctx.tools.execute). */
    executeTool: async (name, args, info = {}) => {
      const tools = service('tools')
      const agents = service('agents')
      let agent
      try { agent = agents?.get?.(info.dshSessionId || info.sessionId) } catch { agent = undefined }
      // openjiuwen SchemaUtils fills omitted optionals with null; dsh schemas reject null.
      const cleanArgs = stripNullishToolArgs(args)
      const runtime = tools && typeof tools.execute === 'function' ? tools : (agent?.ctx?.tools && typeof agent.ctx.tools.execute === 'function' ? agent.ctx.tools : null)
      if (runtime) {
        const callId = info.callId || `ac-${Date.now()}`
        // dsh >=0.2.2 `tools.execute` takes a batch ({ calls: [block] }) and
        // returns { results: [{ callId, result }] }; older hosts take one exec.
        // Send both shapes; each host reads only its own keys.
        const exec = {
          calls: [{ id: callId, name, arguments: JSON.stringify(cleanArgs ?? {}) }],
          callId,
          name,
          arguments: cleanArgs,
          agent,
          signal: info.signal,
        }
        // NDJSON callbacks run outside the agent driver's async context, just
        // like Gateway MCP callbacks. Preserve native dsh initiator semantics.
        const run = () => runtime.execute(exec)
        const live = agent && typeof agents?.withInitiator === 'function' && agents.get?.(agent.id) === agent
        const result = unwrapToolBatch(await (live ? agents.withInitiator(agent, run) : run()), callId)
        if (result?.isError) {
          const err = new Error(toolResultText(result) || `tool ${name} failed`)
          err.isError = true
          throw err
        }
        return toolResultText(result) ?? result?.content ?? result
      }
      // Legacy: direct definition execute
      let def
      try { def = agent ? tools?.get?.(name, agent) : tools?.get?.(name) } catch { def = undefined }
      if (!def?.execute) throw new Error(`dsh tool ${name} not found`)
      return def.execute(cleanArgs, { callId: info.callId, name, arguments: cleanArgs, agent, signal: info.signal })
    },
  })
  const modelDiscovery = createModelDiscovery({ gateway: () => gatewayFor(), config: readConfig })
  const adapter = new AdapterClass()
  const cfg = readConfig()
  const registration = ctx.llm.registerAdapter([cfg.provider], adapter)

  const bridge = createToolBridge(cfg)
  const features = createFeatureCache()
  const agentcoreFor = () => {
    const c = readConfig()
    return adapter._agentcoreTransport?.() || new AgentCoreTransport({
      pythonPath: c.agentcorePython, checkpointDir: c.agentcoreCheckpointDir, logger,
    })
  }
  const acState = createAgentCoreState(statePathFromMapping(readConfig().mappingPath))
  const acFacade = createAgentCoreFacade({
    sessions,
    getConfig: readConfig,
    getAgentcore: agentcoreFor,
    state: acState,
    getHostServices: () => ({
      skills: service('skills'),
      planMode: service('planMode'),
      agents: service('agents'),
    }),
    logger,
  })
    const gatewayFor = () => {
    const c = readConfig()
    const t = new GatewayTransport({
      gatewayURL: c.gatewayURL,
      userId: c.userId,
      authToken: c.authToken,
      accessToken: c.accessToken,
      cookie: c.cookie,
      authorization: c.authorization,
      xToken: c.xToken,
      workMode: c.workMode,
      projectDir: c.projectDir,
      requestTimeoutMs: c.requestTimeoutMs,
      surfaceToolEvents: c.surfaceGatewayToolEvents,
    })
    // Every unary helper goes through this.rpc → feature-detect cache (unknown methods fail fast).
    t.rpc = features.wrap(c.gatewayURL, t.rpc.bind(t))
    t.features = features
    return t
  }
  /** Accept a host session id (mapped) or a raw Jiuwen session id. */
  const jw = (sid) => sessions.get(String(sid))?.jiuwenSessionId || sid
  const api = {
    sessions,
    bridge,
    /** Verify the dsh-tools passthrough registration on the Gateway (mcp.show; never throws). */
    mcpVerify: async (sessionId) => {
      if (isAgentCoreBackend(readConfig())) {
        return { ok: true, mode: 'local-function', serverName: readConfig().mcpServerName || 'dsh-tools', sessionId }
      }
      return mcpBridge.verify(sessionId)
    },
    config: readConfig,
    provider: cfg.provider,
    /** Subscribe to structured Jiuwen events ({type, name, ...}); returns unsubscribe. */
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    /** Jiuwen session id for a host session id (creates mapping). */
    jiuwenSessionId: (sid) => sessions.ensure(String(sid)).jiuwenSessionId,
    /** Unary E2A helpers (history/models/mcp/memory/files/swarm) — brain stays on Jiuwen. */
    gateway: {
      rpc: (method, params, opts) => gatewayFor().rpc(method, params, opts),
      /** Probe a Gateway method once (cached): true when /ws routes it. Never throws. */
      supports: (method, params) => { const t = gatewayFor(); return features.probe(readConfig().gatewayURL, (m, p, o) => GatewayTransport.prototype.rpc.call(t, m, p, o), method, params) },
      /** Methods this Gateway answered `unknown method` for (cached). */
      unsupported: () => features.unsupported(readConfig().gatewayURL),
      historyGet: async (sid, extra) => {
        if (isAgentCoreBackend(readConfig())) return agentcoreFor().sessionHistory(jw(sid))
        return gatewayFor().historyGet(jw(sid), extra)
      },
      historyListTurns: (sid, extra) => gatewayFor().historyListTurns(jw(sid), extra),
      /** Collect one streamed history.get page (0.2.7: ack + `history.message` events). */
      historyMessages: (sid, extra) => gatewayFor().historyMessages(jw(sid), extra),
      sessionMetadata: (sid, extra) => gatewayFor().sessionMetadata(jw(sid), extra),
      sessionList: (extra) => gatewayFor().sessionList(extra),
      sessionCreate: (extra) => gatewayFor().sessionCreate(extra),
      sessionDelete: async (sid, extra) => {
        if (isAgentCoreBackend(readConfig())) return agentcoreFor().sessionDelete(jw(sid))
        return gatewayFor().sessionDelete(jw(sid), extra)
      },
      sessionFork: async (sid, extra) => {
        if (isAgentCoreBackend(readConfig())) {
          const from = jw(sid)
          const to = extra?.new_session_id || extra?.to || `fork-${Date.now().toString(36)}`
          return agentcoreFor().sessionFork(from, to, extra || {})
        }
        return gatewayFor().sessionFork(jw(sid), extra)
      },
      sessionRename: (sid, title, extra) => gatewayFor().sessionRename(jw(sid), title, extra),
      sessionPin: (sid, pinned, extra) => gatewayFor().sessionPin(jw(sid), pinned, extra),
      sessionSwitch: (sid, extra) => gatewayFor().sessionSwitch(jw(sid), extra),
      sessionArchive: (sid, extra) => gatewayFor().sessionArchive(Array.isArray(sid) ? sid.map(jw) : jw(sid), extra),
      sessionUnarchive: (sid, extra) => gatewayFor().sessionUnarchive(Array.isArray(sid) ? sid.map(jw) : jw(sid), extra),
      skillsList: (extra) => gatewayFor().skillsList(extra),
      skillsInstalled: (extra) => gatewayFor().skillsInstalled(extra),
      skillsToggle: (name, enabled, extra) => gatewayFor().skillsToggle(name, enabled, extra),
      agentsList: (extra) => gatewayFor().agentsList(extra),
      teamTemplatesList: (extra) => gatewayFor().teamTemplatesList(extra),
      teamList: (extra) => gatewayFor().teamList(extra),
      agentsToolsList: (...args) => gatewayFor().agentsToolsList(...args),
      hooksList: (...args) => gatewayFor().hooksList(...args),
      permissionsToolsGet: (...args) => gatewayFor().permissionsToolsGet(...args),
      permissionsToolsUpdate: (tool, level, extra) => gatewayFor().permissionsToolsUpdate(tool, level, extra),
      permissionsToolsDelete: (tool, extra) => gatewayFor().permissionsToolsDelete(tool, extra),
      permissionsRulesGet: (...args) => gatewayFor().permissionsRulesGet(...args),
      pluginsList: (...args) => gatewayFor().pluginsList(...args),
      pluginsEnable: (name, extra) => gatewayFor().pluginsEnable(name, extra),
      pluginsDisable: (name, extra) => gatewayFor().pluginsDisable(name, extra),
      projectList: (...args) => gatewayFor().projectList(...args),
      projectInfo: (projectId, extra) => gatewayFor().projectInfo(projectId, extra),
      projectGetSessions: (projectId, extra) => gatewayFor().projectGetSessions(projectId, extra),
      sessionArchivedList: (...args) => gatewayFor().sessionArchivedList(...args),
      sessionAssetsList: (...args) => gatewayFor().sessionAssetsList(...args),
      updaterStatus: (...args) => gatewayFor().updaterStatus(...args),
      heartbeatConf: (...args) => gatewayFor().heartbeatConf(...args),
      heartbeatSetConf: (conf, extra) => gatewayFor().heartbeatSetConf(conf, extra),
      heartbeatJobList: (...args) => gatewayFor().heartbeatJobList(...args),
      pathGet: (...args) => gatewayFor().pathGet(...args),
      localeGetConf: (...args) => gatewayFor().localeGetConf(...args),
      cronJobList: (...args) => gatewayFor().cronJobList(...args),
      agentTemplatesList: (...args) => gatewayFor().agentTemplatesList(...args),
      commandsList: (extra) => gatewayFor().commandsList(extra),
      compact: (sid, extra) => gatewayFor().compact(jw(sid), extra),
      goal: (sid, opts) => gatewayFor().goal(jw(sid), opts),
      btw: (sid, question, extra) => gatewayFor().btw(jw(sid), question, extra),
      recap: (sid, extra) => gatewayFor().recap(jw(sid), extra),
      planStatus: (sid, extra) => gatewayFor().planStatus(jw(sid), extra),
      interrupt: (sid, intent, extra) => gatewayFor().chatInterrupt(jw(sid), intent, extra),
      userAnswer: (sid, answers, extra) => gatewayFor().userAnswer(jw(sid), answers, {
        ...(sessions.get(String(sid))?.pendingQuestion?.requestId ? { request_id: sessions.get(String(sid)).pendingQuestion.requestId } : {}),
        ...extra,
      }),
      chatResume: (sid, extra) => gatewayFor().chatResume(jw(sid), extra),
      modelsList: (extra) => gatewayFor().modelsList(extra),
      modelsGet: (modelId, extra) => gatewayFor().modelsGet(modelId, extra),
      mcpList: (filter) => gatewayFor().mcpList(filter),
      memoryList: (sid, extra) => gatewayFor().memoryList(jw(sid), extra),
      memoryStatus: (sid, extra) => gatewayFor().memoryStatus(jw(sid), extra),
      filesList: (sid, extra) => gatewayFor().filesList(jw(sid), extra),
      chatCancel: (sid, extra) => gatewayFor().chatInterrupt(jw(sid), 'cancel', extra),
      workflows: (sid, action, extra) => gatewayFor().workflows(jw(sid), action, extra),
    },
  }
  api.gateway = bindAgentCoreFacade(api.gateway, acFacade, readConfig)
  api.agentcoreState = acState
  api.backend = () => readConfig().backend || 'gateway'
  api.isAgentCore = () => isAgentCoreBackend(readConfig())
  exposeService(ctx, cfg.serviceName, api, logger)

  // `/jiuwen <sub>` slash command when the host has a command registry (dsh-commands).
  // Local (dsh) title for `/jiuwen rename`: public sessionTitle.rename(session, title) only; no-op on hosts without it.
  const localRename = (dshId, title) => {
    const titles = service('sessionTitle')
    const live = service('sessions')?.get?.(dshId)
    if (typeof titles?.rename !== 'function' || !live) return false
    titles.rename(live, title)
    return true
  }
  /** Gateway-shaped object for /jiuwen: agent-core routes via api.gateway (clear UNSUPPORTED). */
  const commandGateway = () => {
    if (isAgentCoreBackend(readConfig())) {
      // Full agent-core facade (bound); aliases match GatewayTransport names used by commands.js.
      const g = api.gateway
      return new Proxy(g, {
        get(target, prop, receiver) {
          if (prop === 'features') return { isUnsupported: () => false }
          if (prop === 'gatewayURL') return 'agent-core://local'
          if (prop === 'chatInterrupt') {
            return (sid, intent, extra) => target.interrupt(sid, intent, extra)
          }
          return Reflect.get(target, prop, receiver)
        },
      })
    }
    return gatewayFor()
  }
  const command = createJiuwenCommand({ sessions, gateway: commandGateway, config: readConfig, mcpBridge, features, localRename, permLedger: { ...permLedger, release: async (o) => { const r = await permLedger.release(o); permsKey = null; return r } } })
  api.command = command.run
  if (cfg.registerCommands !== false && typeof ctx.inject === 'function') {
    try {
      ctx.inject(['commands'], (c) => {
        // Fail soft inside the inject callback: a duplicate name or a registry error must not
        // break the host fiber (or other plugins sharing it).
        try {
          const dispose = c.commands.register({ ...command.definition, name: cfg.commandName })
          if (typeof dispose === 'function') {
            if (typeof c.effect === 'function') c.effect(function* () { yield () => { try { dispose() } catch { /* ignore */ } } }, 'llm-jiuwen command')
            else c.on?.('dispose', () => { try { dispose() } catch { /* ignore */ } })
          }
        } catch (error) {
          logger.warn?.(`[dsh-jiuwen] could not register /${cfg.commandName} (${error?.message || error}); set config.commandName to a unique name`)
        }
      })
    } catch (error) {
      logger.debug?.(`[dsh-jiuwen] commands registry unavailable: ${error?.message || error}`)
    }
  }

  // ── Bridges + host→Jiuwen sync (hostSync defaults ON) ──
  const disposers = []
  try {
    if (cfg.planBridge) {
      planBridge = createPlanBridge({
        services: () => ({ planMode: service('planMode'), agents: service('agents'), agentPresets: service('agentPresets') }),
        gateway: () => gatewayFor(), sessions, logger,
      })
    }
    if (cfg.sessionSync) disposers.push(installSessionSync({ ctx, config: readConfig, sessions, logger, mcpBridge }))
    if (cfg.modelDiscovery && typeof ctx.llm?.registerModelDiscovery === 'function') {
      const off = ctx.llm.registerModelDiscovery(cfg.discoveryNamespace, async (request) => {
        if (request?.provider && request.provider !== readConfig().provider) return []
        return (await modelDiscovery.list()).map(m => ({ id: m.id, name: m.name, ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}) }))
      })
      if (typeof off === 'function') disposers.push(off)
    }
    if (cfg.hostSync !== false) {
      disposers.push(hostSync = installHostSync({
        ctx, config: readConfig, sessions, gateway: gatewayFor, agentcore: agentcoreFor,
        agentcoreRpc: (method, params) => acFacade.rpc(method, params),
        logger, mcpBridge, permLedger,
        services: () => ({
          skills: service('skills'),
          planMode: service('planMode'),
          agents: service('agents'),
          tools: service('tools'),
          workingDirectory: service('workingDirectory'),
          schedule: service('schedule'),
          goals: service('goals'),
          agentPresets: service('agentPresets'),
          sessionPersistence: service('sessionPersistence'),
        }),
      }))
    }
  } catch (error) {
    logger.warn?.(`[dsh-jiuwen] optional bridge setup failed (continuing without it): ${error?.message || error}`)
  }

  let disposedAll = false
  const disposeAll = () => {
    if (disposedAll) return
    disposedAll = true
    for (const d of disposers) { try { d() } catch { /* ignore */ } }
    disposers.length = 0
    try { modelSettings.dispose() } catch { /* ignore */ }
    try { registration() } catch { /* already disposed */ }
    const pending = [mcpBridge.dispose()]
    // The Python child owns referenced stdio pipes. Leaving it alive prevents
    // headless dsh from exiting and leaks a process on plugin reload/dispose.
    if (typeof adapter._agentcore?.shutdown === 'function') pending.push(adapter._agentcore.shutdown())
    listeners.clear?.()
    personaCapture.dispose()
    return Promise.allSettled(pending)
  }
  if (typeof ctx.effect === 'function') {
    ctx.effect(function* () { yield disposeAll }, 'llm-jiuwen')
  } else {
    ctx.on?.('dispose', disposeAll)
  }

  logger.info?.(`[dsh-jiuwen] registered provider "${cfg.provider}" brain=${cfg.brainOwnership} mode=${cfg.mode} backend=${cfg.backend || "gateway"} mapping=${cfg.mappingPath}`)
}

/**
 * Resolve the standard `LlmAdapter` base class from @deepseek-ai/dsh-llm.
 * Generic order: explicit module (config.llmAdapterModule / JIUWEN_LLM_ADAPTER_MODULE)
 * → package resolution → common global DSH installs → built-in duck-typed base (works with any Cordis `llm` service
 * exposing registerAdapter()).
 */
export /** Expose the helper API on ctx under `serviceName` (generic across Cordis versions). */
function exposeService(ctx, serviceName, api, logger) {
  // Only the sanctioned Cordis service API: never assign ctx[serviceName] directly (that could
  // shadow another plugin's service or a Context method).
  if (typeof ctx.provide !== 'function') {
    logger.warn?.(`[dsh-jiuwen] host has no ctx.provide; helper service ctx.${serviceName} not exposed`)
    return false
  }
  try {
    ctx.provide(serviceName, api)
    return true
  } catch (error) {
    logger.warn?.(`[dsh-jiuwen] could not provide ctx.${serviceName} (${error?.message || error}); set config.serviceName to a unique name`)
    return false
  }
}

function loadLlmAdapter(logger, cfg = {}, env = process.env) {
  const home = env.HOME || ''
  const candidates = [
    ...(cfg.llmAdapterModule ? [cfg.llmAdapterModule] : []),
    '@deepseek-ai/dsh-llm',
    `${home}/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-llm`,
    '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm',
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm',
  ]
  for (const id of candidates) {
    try {
      const mod = require(id)
      if (mod?.LlmAdapter) return mod.LlmAdapter
    } catch {
      // try next
    }
  }
  try {
    const resolved = require.resolve('@deepseek-ai/dsh-llm', {
      paths: [`${home}/.dsh/profiles/web`, '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh'],
    })
    const mod = require(resolved)
    if (mod?.LlmAdapter) return mod.LlmAdapter
  } catch {
    // fall through
  }
  logger.info?.('[dsh-jiuwen] @deepseek-ai/dsh-llm not resolvable; using duck-typed LlmAdapter base')
  return null
}

export default apply

/** True when some client listens on the `user-questions/request` waterfall (TUI/web remotes);
 *  unknown host internals → true (keep the documented `auto` behaviour). */
export function hasQuestionAnswerer(ctx) {
  try {
    const hooks = ctx.root?.events?._hooks
    if (!hooks || typeof hooks !== 'object') return true
    const h = hooks['user-questions/request']
    return Array.isArray(h) ? h.length > 0 : Boolean(h && (h.size ?? Object.keys(h).length))
  } catch { return true }
}

/** Drop null/undefined tool args (openjiuwen fills optionals with null; dsh rejects). */
function stripNullishToolArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args && typeof args === 'object' ? args : {}
  const out = {}
  for (const [k, v] of Object.entries(args)) {
    if (v === null || v === undefined) continue
    out[k] = v
  }
  return out
}

/** dsh tool results use content[].text (and sometimes error.message), not top-level .text. */
function toolResultText(result) {
  if (!result || typeof result !== 'object') return undefined
  if (typeof result.text === 'string' && result.text) return result.text
  if (typeof result.error?.message === 'string' && result.error.message) return result.error.message
  if (Array.isArray(result.content)) {
    const parts = result.content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
    if (parts.length) return parts.join('\n')
  }
  return undefined
}

/** Single result from a dsh batch settlement ({ results: [{ callId, result }] }); other shapes pass through. */
export function unwrapToolBatch(out, callId) {
  if (!out || typeof out !== 'object' || !Array.isArray(out.results)) return out
  const hit = out.results.find(r => r && r.callId === callId) || out.results[0]
  return hit && typeof hit === 'object' && 'result' in hit ? hit.result : hit
}
