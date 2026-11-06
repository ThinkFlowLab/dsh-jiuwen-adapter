/**
 * Opt-in openjiuwen agent-core capabilities (`agentcore` plugin config) → per-turn `features`
 * for the sidecar, plus which host tools the native capability replaces this turn.
 *
 * The host stays the source of truth: native skills read dsh skill bodies (and load through the
 * host `skill` tool), native planning mirrors into dsh `todo_write`, native subagents run the
 * same dsh tools, and every other native tool is approved by dsh first (sidecar gate rail).
 */

const ENV_BOOL = (v) => v === '1' || v === 'true'

/** `true` / `false` / `{ enabled?, ... }` → object with `enabled`. */
function flag(v, fallback = false) {
  if (v === undefined || v === null) return { enabled: fallback }
  if (typeof v === 'boolean') return { enabled: v }
  if (typeof v === 'string') return { enabled: ENV_BOOL(v.toLowerCase()) }
  if (typeof v === 'object' && !Array.isArray(v)) return { ...v, enabled: v.enabled !== false }
  return { enabled: fallback }
}

/**
 * Normalize raw `agentcore` config (and AGENTCORE_FEATURES env JSON, which wins key by key).
 * Everything defaults off.
 */
export function resolveAgentcoreFeatures(raw, env = process.env) {
  let r = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {}
  if (env.AGENTCORE_FEATURES) {
    try { const e = JSON.parse(env.AGENTCORE_FEATURES); if (e && typeof e === 'object') r = { ...r, ...e } } catch { /* ignore bad env */ }
  }
  const out = {
    skills: flag(r.skills),
    planning: flag(r.planning),
    memory: flag(r.memory),
    subagents: flag(r.subagents),
    interrupts: flag(r.interrupts),
    security: flag(r.security).enabled,
    anomaly: flag(r.anomaly).enabled,
    heartbeat: flag(r.heartbeat).enabled,
    progressiveTools: flag(r.progressiveTools),
    sysOperation: flag(r.sysOperation),
    mcp: flag(r.mcp),
    kvCache: flag(r.kvCache).enabled,
    moa: flag(r.moa),
    rag: flag(r.rag),
    otel: flag(r.otel),
  }
  if (out.interrupts.enabled && !out.interrupts.askUser && !out.interrupts.confirmTools) out.interrupts.enabled = false
  return out
}

/** True when any native capability is on. */
export function anyAgentcoreFeature(f) {
  if (!f) return false
  return Object.values(f).some(v => v === true || (v && typeof v === 'object' && v.enabled === true))
}

function toolNames(tools) {
  const s = new Set()
  for (const t of Array.isArray(tools) ? tools : []) {
    const n = t?.name || t?.function?.name
    if (n) s.add(String(n))
  }
  return s
}

/**
 * Build this turn's sidecar `features` and the host tools to hide.
 *
 * @param {ReturnType<typeof resolveAgentcoreFeatures>|undefined} f
 * @param {{ tools?: object[], mapping?: object, skillLoaderTool?: string, todoTool?: string, subagentTool?: string, askUserTool?: string }} ctx
 * @returns {{ features: object|undefined, hide: Set<string>, nativeSkills: boolean }}
 */
export function buildTurnFeatures(f, ctx = {}) {
  const hide = new Set()
  if (!anyAgentcoreFeature(f)) return { features: undefined, hide, nativeSkills: false }
  const names = toolNames(ctx.tools)
  const loader = ctx.skillLoaderTool || 'skill'
  const todo = ctx.todoTool || 'todo_write'
  const sub = ctx.subagentTool || 'subagent'
  const ask = ctx.askUserTool || 'ask_user'
  const out = {}
  let nativeSkills = false

  if (f.skills.enabled) {
    const bodies = Array.isArray(ctx.mapping?.skillBodies) ? ctx.mapping.skillBodies : []
    const hasLoader = names.has(loader)
    out.skills = {
      enabled: true,
      mode: f.skills.mode === 'auto_list' ? 'auto_list' : 'all',
      items: bodies.map(b => ({ name: String(b.name), content: String(b.content || ''), ...(b.description ? { description: String(b.description) } : {}) })),
      ...(hasLoader ? { host_loader: loader } : {}),
      ...(f.skills.maxSkills ? { max_skills: Number(f.skills.maxSkills) } : {}),
      ...(f.skills.maxTotalChars ? { max_total_chars: Number(f.skills.maxTotalChars) } : {}),
    }
    if (hasLoader) hide.add(loader) // native skill_tool proxies to it
    nativeSkills = true
  }
  if (f.planning.enabled) {
    const mirror = f.planning.mirror !== false && names.has(todo)
    out.planning = {
      enabled: true,
      ...(mirror ? { mirror_tool: todo } : {}),
      ...(f.planning.progressReminder ? { progress_reminder: true } : {}),
      ...(f.planning.interval ? { interval: Number(f.planning.interval) } : {}),
    }
    if (names.has(todo)) hide.add(todo) // one todo tool family for the model
  }
  if (f.memory.enabled) {
    const m = f.memory
    out.memory = {
      enabled: true,
      scope: ['global', 'project', 'session'].includes(m.scope) ? m.scope : 'global',
      proactive: m.proactive !== false,
      ...(m.coding ? { coding: true } : {}),
      ...(m.embedding && typeof m.embedding === 'object' ? { embedding: pickEmbedding(m.embedding) } : {}),
      ...(m.external && typeof m.external === 'object' ? { external: pickExternal(m.external) } : {}),
    }
  }
  if (f.subagents.enabled) {
    const s = f.subagents
    out.subagents = {
      enabled: true,
      ...(s.async ? { async: true } : {}),
      ...(s.taskLoop ? { task_loop: true } : {}),
      ...(Array.isArray(s.agents) ? { agents: s.agents.filter(a => a && a.name).map(a => ({ name: String(a.name), ...(a.description ? { description: String(a.description) } : {}), ...(a.systemPrompt ? { system_prompt: String(a.systemPrompt) } : {}), ...(a.maxIterations ? { max_iterations: Number(a.maxIterations) } : {}) })) } : {}),
      ...(s.maxIterations ? { max_iterations: Number(s.maxIterations) } : {}),
    }
    if (names.has(sub)) hide.add(sub)
  }
  if (f.interrupts.enabled) {
    const askUser = f.interrupts.askUser === true
    out.interrupts = { ask_user: askUser, confirm_tools: Array.isArray(f.interrupts.confirmTools) ? f.interrupts.confirmTools.map(String) : [] }
    if (askUser && names.has(ask)) hide.add(ask) // AskUserRail registers its own ask_user
  }
  if (f.security) out.security = true
  if (f.anomaly) out.anomaly = true
  if (f.heartbeat) out.heartbeat = true
  if (f.progressiveTools.enabled) out.progressive_tools = { enabled: true, ...(f.progressiveTools.limit ? { limit: Number(f.progressiveTools.limit) } : {}) }
  if (f.sysOperation.enabled) out.sys_operation = { enabled: true, read_only: f.sysOperation.readOnly !== false, code: f.sysOperation.code === true }
  if (f.mcp.enabled && Array.isArray(f.mcp.servers) && f.mcp.servers.length) out.mcp = { servers: f.mcp.servers, resources: f.mcp.resources === true }
  if (f.kvCache) out.kv_cache = true
  if (f.moa.enabled && Array.isArray(f.moa.referenceModels) && f.moa.referenceModels.length) {
    out.moa = { enabled: true, reference_models: f.moa.referenceModels.map(m => typeof m === 'string' ? { model: m } : { ...(m.model ? { model: String(m.model) } : {}), ...(m.apiBase ? { api_base: String(m.apiBase) } : {}), ...(m.apiKeyEnv ? { api_key_env: String(m.apiKeyEnv) } : {}), ...(m.provider ? { provider: String(m.provider) } : {}) }), ...(f.moa.mode ? { mode: String(f.moa.mode) } : {}) }
  }
  if (f.rag.enabled && Array.isArray(f.rag.paths) && f.rag.paths.length) {
    out.rag = { enabled: true, paths: f.rag.paths.map(String), ...(f.rag.maxFiles ? { max_files: Number(f.rag.maxFiles) } : {}), ...(f.rag.maxBytes ? { max_bytes: Number(f.rag.maxBytes) } : {}) }
  }
  if (f.otel.enabled) {
    out.otel = { enabled: true, ...(f.otel.exporter ? { exporter: String(f.otel.exporter) } : {}), ...(f.otel.endpoint ? { endpoint: String(f.otel.endpoint) } : {}), ...(f.otel.tracesDir ? { traces_dir: String(f.otel.tracesDir) } : {}), ...(f.otel.serviceName ? { service_name: String(f.otel.serviceName) } : {}) }
  }
  return { features: Object.keys(out).length ? out : undefined, hide, nativeSkills }
}

/** Embedding config: only an env var *name* for the key ever crosses the wire. */
function pickEmbedding(e) {
  return {
    ...(e.model ? { model: String(e.model) } : {}),
    ...(e.apiBase ? { api_base: String(e.apiBase) } : {}),
    ...(e.apiKeyEnv ? { api_key_env: String(e.apiKeyEnv) } : {}),
  }
}

const SECRET_KEY = /key|token|secret|password/i
function pickExternal(e) {
  const options = {}
  for (const [k, v] of Object.entries(e.options || {})) if (!SECRET_KEY.test(k)) options[k] = v
  return {
    provider: String(e.provider || ''),
    options,
    ...(e.apiKeyEnv ? { api_key_env: String(e.apiKeyEnv) } : {}),
    ...(e.userId ? { user_id: String(e.userId) } : {}),
    ...(e.scopeId ? { scope_id: String(e.scopeId) } : {}),
  }
}

/** Host tools minus the ones a native capability replaces this turn. */
export function filterHostTools(tools, hide) {
  if (!hide?.size || !Array.isArray(tools)) return tools
  return tools.filter(t => !hide.has(String(t?.name || t?.function?.name || '')))
}
