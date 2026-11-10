/**
 * Adapter configuration. Env wins over Cordis plugin config for deployment knobs.
 *
 * Architecture (see ARCHITECTURE.md):
 *   JiuwenSwarm owns chat loop, tools, memory, sessions, models.
 *   DSH is Cordis plugin ABI / shell only.
 *
 * Modes:
 *   gateway — DEFAULT. WebSocket chat.send; full Jiuwen agent/swarm turn.
 *   openai  — diagnostics / connectivity fallback only (not the product brain).
 */
import { DEFAULT_BUSY_IGNORE_SOURCES } from './busy-interrupt.js'
import { resolveAgentcoreFeatures } from './agentcore-features.js'
import { unwrapConfig } from './host-model-settings.js'

const DEFAULT_MODELS = [
  { id: 'jiuwen-default', name: 'Jiuwen Default', contextWindow: 128_000, maxTokens: 8192 },
  { id: 'jiuwen-swarm', name: 'Jiuwen Swarm', contextWindow: 128_000, maxTokens: 8192, chatMode: 'team.work.normal' },
]

/** @typedef {{
 *   provider: string,
 *   displayName: string,
 *   mode: 'openai' | 'gateway',
 *   brainOwnership: 'jiuwen',
 *   baseURL: string,
 *   gatewayURL: string,
 *   apiKey: string | undefined,
 *   apiKeyEnv: string,
 *   authToken: string | undefined,
 *   accessToken: string | undefined,
 *   cookie: string | undefined,
 *   authorization: string | undefined,
 *   xToken: string | undefined,
 *   userId: string,
 *   defaultModel: string,
 *   models: Array<{id:string,name:string,contextWindow?:number,maxTokens?:number}>,
 *   mappingPath: string,
 *   workMode: string,
 *   projectDir: string | undefined,
 *   requestTimeoutMs: number,
 *   allowDshAgentLoop: boolean,
 *   exposeJiuwenTools: boolean,
 *   surfaceGatewayToolEvents: boolean,
 *   llmAdapterModule: string | undefined,
 * }} ResolvedConfig */

/**
 * @param {Record<string, unknown>} [raw]
 * @param {{ env?: NodeJS.ProcessEnv, dshHome?: string }} [opts]
 * @returns {ResolvedConfig}
 */
/** Restricted passthrough set (toolAllowlist: 'core'): generic shell/file IO plus dsh's read-only session-query tools. */
export const DEFAULT_PASSTHROUGH_TOOLS = Object.freeze(['bash', 'read', 'edit', 'write', 'glob', 'grep', 'session_search', 'session_event_search', 'session_event_read', 'session_trace', 'session_event_trace'])

export function resolveConfig(raw = {}, opts = {}) {
  raw = unwrapConfig(raw)
  const env = opts.env ?? process.env
  // Product default is gateway (Jiuwen brain). openai only if explicitly requested.
  const modeRaw = String(env.JIUWEN_MODE || raw.mode || 'gateway').toLowerCase()
  const mode = modeRaw === 'openai' || modeRaw === 'llm' || modeRaw === 'completions'
    ? 'openai'
    : 'gateway'
  // Product brain backend when mode=gateway: local agent-core sidecar (default), or classic Jiuwen Gateway WS.
  const backendRaw = String(env.JIUWEN_BACKEND || raw.backend || 'agent-core').toLowerCase()
  const backend = (backendRaw === 'gateway' || backendRaw === 'gw' || backendRaw === 'ws')
    ? 'gateway'
    : 'agent-core'

  const apiKeyEnv = String(raw.apiKeyEnv || 'JIUWEN_API_KEY')
  const apiKey = firstNonEmpty(
    env.JIUWEN_API_KEY,
    env[apiKeyEnv],
    typeof raw.apiKey === 'string' ? raw.apiKey : undefined,
  )
  const authToken = firstNonEmpty(env.JIUWEN_AUTH_TOKEN, typeof raw.authToken === 'string' ? raw.authToken : undefined)
  const accessToken = firstNonEmpty(env.JIUWEN_ACCESS_TOKEN, typeof raw.accessToken === 'string' ? raw.accessToken : undefined, authToken)
  const cookie = firstNonEmpty(env.JIUWEN_COOKIE, typeof raw.cookie === 'string' ? raw.cookie : undefined)
  const authorization = firstNonEmpty(env.JIUWEN_AUTHORIZATION, typeof raw.authorization === 'string' ? raw.authorization : undefined)
  const xToken = firstNonEmpty(env.JIUWEN_X_TOKEN, typeof raw.xToken === 'string' ? raw.xToken : undefined)

  const dshHome = opts.dshHome || env.DSH_HOME || env.HOME || process.cwd()
  const mappingPath = String(
    raw.mappingPath
    || env.JIUWEN_SESSION_MAP
    || `${dshHome}/jiuwen-adapter/session-map.json`,
  )

  const models = Array.isArray(raw.models) && raw.models.length > 0
    ? raw.models.map(normalizeModel)
    : DEFAULT_MODELS.map(m => ({ ...m }))

  const allowDshAgentLoop = env.JIUWEN_ALLOW_DSH_AGENT_LOOP === '1'
    || raw.allowDshAgentLoop === true

  const hostSync = raw.hostSync !== false && env.JIUWEN_HOST_SYNC !== '0'
  const syncBit = (k, e) => hostSync && raw[k] !== false && env[e] !== '0'

  const toolPassthrough = pickEnum(env.JIUWEN_TOOL_PASSTHROUGH || raw.toolPassthrough, ['off', 'mcp'],
    (raw.hostSync === false || env.JIUWEN_HOST_SYNC === '0') ? 'off' : 'mcp')
  const mapJiuwenFsToDsh = raw.mapJiuwenFsToDsh !== undefined || env.JIUWEN_MAP_JIUWEN_FS_TO_DSH
    ? (raw.mapJiuwenFsToDsh !== false && env.JIUWEN_MAP_JIUWEN_FS_TO_DSH !== '0')
    : toolPassthrough === 'mcp'
  return {
    provider: String(raw.provider || 'jiuwen'),
    displayName: String(raw.displayName || 'JiuwenSwarm'),
    /** ctx service name for the helper API (ctx.jiuwenAdapter). */
    serviceName: String(raw.serviceName || 'jiuwenAdapter'),
    mode,
    /** agent-core (default) | gateway — which product backend mode=gateway uses. */
    backend,
    /**
     * When backend=agent-core: auto-route marked RPCs to Gateway if reachable.
     * Default false (agent-core-only). Opt in with gatewayFallback: true or
     * JIUWEN_GATEWAY_FALLBACK=1 when a Gateway is available.
     */
    gatewayFallback: env.JIUWEN_GATEWAY_FALLBACK === '1' || raw.gatewayFallback === true,
    /** Opt-in openjiuwen agent-core capabilities (skills, planning, memory, subagents, …); all off by default. */
    agentcore: resolveAgentcoreFeatures(raw.agentcore, env),
    brainOwnership: 'jiuwen',
    baseURL: stripTrailingSlash(String(
      raw.baseURL
      || env.JIUWEN_BASE_URL
      || 'http://127.0.0.1:18080/v1',
    )),
    gatewayURL: String(
      env.JIUWEN_GATEWAY_URL
      || raw.gatewayURL
      || 'ws://127.0.0.1:19000/ws',
    ),
    apiKey,
    apiKeyEnv,
    authToken,
    accessToken,
    cookie,
    authorization,
    xToken,
    userId: String(env.JIUWEN_USER_ID || raw.userId || 'dsh-adapter'),
    defaultModel: String(raw.defaultModel || models[0]?.id || 'jiuwen-default'),
    models,
    mappingPath,
    /** Absolute path to sidecar python (default: <repo>/.venv-sidecar/bin/python). */
    agentcorePython: firstNonEmpty(env.AGENTCORE_PYTHON, typeof raw.agentcorePython === 'string' ? raw.agentcorePython : undefined),
    /** Checkpointer dir for agent-core sidecar (default: $DSH_HOME/jiuwen-adapter/ac). */
    agentcoreCheckpointDir: firstNonEmpty(env.DSH_JIUVEN_AC_DIR, env.AGENTCORE_CKPT_DIR, typeof raw.agentcoreCheckpointDir === 'string' ? raw.agentcoreCheckpointDir : undefined)
      || `${dshHome}/jiuwen-adapter/ac`,
    workMode: String(raw.workMode || env.JIUWEN_WORK_MODE || 'agent'),
    projectDir: firstNonEmpty(env.JIUWEN_PROJECT_DIR, typeof raw.projectDir === 'string' ? raw.projectDir : undefined),
    requestTimeoutMs: Number(raw.requestTimeoutMs || env.JIUWEN_TIMEOUT_MS || 180_000),
    allowDshAgentLoop,
    exposeJiuwenTools: raw.exposeJiuwenTools === true || env.JIUWEN_EXPOSE_TOOLS === '1',
    surfaceGatewayToolEvents: raw.surfaceGatewayToolEvents !== false,
    // ── Gateway features ──
    /** How Jiuwen tool/subtask/status activity is shown: reasoning | markers | none */
    eventDisplay: pickEnum(env.JIUWEN_EVENT_DISPLAY || raw.eventDisplay, ['reasoning', 'markers', 'none'],
      raw.surfaceGatewayToolEvents === false ? 'none' : 'reasoning'),
    /** Forward Jiuwen chat.reasoning as reasoning-delta. */
    forwardReasoning: raw.forwardReasoning !== false && env.JIUWEN_FORWARD_REASONING !== '0',
    /** Show chat.processing_status (filtered by default; it is UI state, not content). */
    showProcessingStatus: raw.showProcessingStatus === true || env.JIUWEN_SHOW_PROCESSING_STATUS === '1',
    /** Emit a usage chunk from chat.usage_summary / usage_metadata. */
    emitUsage: raw.emitUsage !== false,
    /** gateway: after the first turn send only the newest user message (Jiuwen keeps history). transcript: always send recent transcript. */
    historyMode: pickEnum(env.JIUWEN_HISTORY_MODE || raw.historyMode, ['gateway', 'transcript'], 'gateway'),
    /** chat.send `mode` (e.g. agent.work.normal, agent.plan, agent.fast, code.normal, team). Defaults to workMode. */
    chatMode: firstNonEmpty(env.JIUWEN_CHAT_MODE, typeof raw.chatMode === 'string' ? raw.chatMode : undefined),
    agentTemplateName: firstNonEmpty(env.JIUWEN_AGENT_TEMPLATE, typeof raw.agentTemplateName === 'string' ? raw.agentTemplateName : undefined),
    agentGroupName: firstNonEmpty(env.JIUWEN_AGENT_GROUP, typeof raw.agentGroupName === 'string' ? raw.agentGroupName : undefined),
    skills: Array.isArray(raw.skills) ? raw.skills.map(String) : (env.JIUWEN_SKILLS ? env.JIUWEN_SKILLS.split(',').map(x => x.trim()).filter(Boolean) : undefined),
    /** Forward model id as model_name (false → let Jiuwen use its default model). */
    forwardModelName: raw.forwardModelName !== false && env.JIUWEN_FORWARD_MODEL !== '0',
    /** Tell Jiuwen whether the host can answer ask_user questions (default false: Jiuwen proceeds on its own). */
    /**
     * Tell Jiuwen whether the host can answer ask_user questions: 'auto' (default: true when the host has
     * ctx.userQuestions) | true | false. Approvals are always routed to ctx.approval (deny when unavailable).
     */
    supportsUserInteraction: raw.supportsUserInteraction === true || env.JIUWEN_SUPPORTS_USER_INTERACTION === '1' ? true
      : (raw.supportsUserInteraction === false || env.JIUWEN_SUPPORTS_USER_INTERACTION === '0' ? false : 'auto'),
    /** Max wait for a dsh user-questions answer (ms; 0 = no limit). */
    questionTimeoutMs: Number(raw.questionTimeoutMs ?? env.JIUWEN_QUESTION_TIMEOUT_MS ?? 600_000),
    /**
     * Optional adapter-side limit on waiting for a dsh decision (permission ask, plan review, SwarmFlow
     * human turn, legacy 'dsh' gate) before denying (ms). Default 0 = none, as in native dsh: the ask
     * waits for the user, the dsh turn's abort, or the approval policy (`never` rejects at once).
     */
    approvalTimeoutMs: Number(raw.approvalTimeoutMs ?? env.JIUWEN_APPROVAL_TIMEOUT_MS ?? 0),
    /** dsh tools → Jiuwen: 'mcp' (default when hostSync on; allowlisted dsh tools as MCP) | 'off'. */
    toolPassthrough,
    /**
     * Tool names (exact, prefix*, or '*') exposed when toolPassthrough=mcp. Default ['*']: every host /
     * plugin tool (as on main). 'core' (string, or an entry in the list) expands to the restricted set:
     * core shell/file tools, the skill loader and the read-only session tools. With a restricted list,
     * `toolAllowlistExtra` is added and host-declared tools (`passthrough: true`) still pass. Empty = none.
     */
    toolAllowlist: (() => {
      const off = raw.hostSync === false || env.JIUWEN_HOST_SYNC === '0' || String(env.JIUWEN_TOOL_PASSTHROUGH || raw.toolPassthrough || '').toLowerCase() === 'off'
      let list = Array.isArray(raw.toolAllowlist) ? raw.toolAllowlist.map(String)
        : typeof raw.toolAllowlist === 'string' ? raw.toolAllowlist.split(',').map(x => x.trim()).filter(Boolean)
          : env.JIUWEN_TOOL_ALLOWLIST ? env.JIUWEN_TOOL_ALLOWLIST.split(',').map(x => x.trim()).filter(Boolean)
            : (off ? [] : ['*'])
      if (list.includes('*') || !list.length) return list
      const extra = Array.isArray(raw.toolAllowlistExtra) ? raw.toolAllowlistExtra.map(String) : String(env.JIUWEN_TOOL_ALLOWLIST_EXTRA || '').split(',').map(x => x.trim()).filter(Boolean)
      const loader = String(raw.skillLoaderTool || env.JIUWEN_SKILL_LOADER_TOOL || 'skill')
      if (list.includes('core')) list = [...list.filter(x => x !== 'core'), ...DEFAULT_PASSTHROUGH_TOOLS, loader]
      // hostSkillInject:index needs the loader tool even under a restrictive allowlist (never silent body dump).
      const hsi = String(env.JIUWEN_HOST_SKILL_INJECT || raw.hostSkillInject || 'index').toLowerCase()
      if (hsi === 'index' && loader) list = [...list, loader]
      return [...new Set([...list, ...extra])]
    })(),
    /** Honour host-declared passthrough flags on tool schemas (in addition to toolAllowlist). */
    toolHostDeclared: raw.toolHostDeclared !== false && env.JIUWEN_TOOL_HOST_DECLARED !== '0',
    /**
     * How a Jiuwen-issued passthrough call is authorised:
     *  - 'host' (default): run it through dsh's own tool pipeline (ToolRuntime.execute) so dsh's
     *    pre-execute policy / sandbox guards / approval policy decide, as for a native call; falls
     *    back to 'dsh' when the host has no tools runtime with execute() or no live agent.
     *  - 'dsh': legacy per-call gate: every call needs ctx.approval allowed-once (deny when unavailable).
     *  - 'none': run the tool definition directly, no approval.
     */
    toolApproval: pickEnum(env.JIUWEN_TOOL_APPROVAL || raw.toolApproval, ['host', 'dsh', 'none'], 'host'),
    /** Tools that skip the legacy per-call gate ('dsh' mode / 'host' fallback): read-only session-query tools and goal CRUD (dsh itself never asks for them). Under 'host' dsh's own policy decides. */
    toolApprovalExempt: Array.isArray(raw.toolApprovalExempt) ? raw.toolApprovalExempt.map(String)
      : env.JIUWEN_TOOL_APPROVAL_EXEMPT !== undefined ? String(env.JIUWEN_TOOL_APPROVAL_EXEMPT).split(',').map(x => x.trim()).filter(Boolean)
        : ['session_search', 'session_event_search', 'session_event_read', 'session_trace', 'session_event_trace', 'get_goal', 'update_goal', 'create_goal'],
    mapJiuwenFsToDsh,
    /**
     * With dsh tool routing on (mapJiuwenFsToDsh + MCP passthrough), how Jiuwen built-ins that
     * duplicate a passed-through dsh tool are hidden:
     *  - 'deny' (default): prompt hint + adapter-decided permission asks (never a dsh card) + owned,
     *    reversible Jiuwen deny of the delegation built-ins (subagent_spawn / task_tool) when dsh's
     *    `subagent` is passed through; Jiuwen's own goal is not armed when dsh's goal tools are.
     *  - 'prompt': the same without the extra Jiuwen deny.
     *  - 'off': legacy (only bash / write_file / edit_file denied, permission asks become dsh cards).
     */
    hideJiuwenBuiltins: pickEnum(env.JIUWEN_HIDE_JIUWEN_BUILTINS || raw.hideJiuwenBuiltins, ['deny', 'prompt', 'off'], 'deny'),

    /**
     * Optional adapter-side cap on one passthrough call (ms). Default 0 = none, as for a native call:
     * dsh's own per-tool timeout policy bounds the run inside the pipeline, the dsh turn's abort cancels it.
     */
    toolCallTimeoutMs: Number(raw.toolCallTimeoutMs ?? env.JIUWEN_TOOL_CALL_TIMEOUT_MS ?? 0),
    /** Transport deadline of one passthrough call (Jiuwen MCP timeout_s + proxy wait). Unset: caps + 5 s, or 1 h without caps. */
    mcpCallTimeoutMs: raw.mcpCallTimeoutMs ?? env.JIUWEN_MCP_CALL_TIMEOUT_MS ?? undefined,
    mcpServerName: String(raw.mcpServerName || env.JIUWEN_MCP_SERVER_NAME || 'dsh-tools'),
    /** Shared dir for the stable MCP proxy (schemas.json + ep-<pid>.json). Default ~/.cache/dsh-jiuwen/mcp/<mcpServerName>. */
    mcpStateDir: raw.mcpStateDir || env.JIUWEN_MCP_STATE_DIR || undefined,
    mcpRpcTimeoutMs: Number(raw.mcpRpcTimeoutMs ?? env.JIUWEN_MCP_RPC_TIMEOUT_MS ?? 30_000),
    /** Release a per-session MCP proxy registration after this long without a turn/tool call (0 = only on session end). */
    mcpSessionIdleMs: Number(raw.mcpSessionIdleMs ?? env.JIUWEN_MCP_SESSION_IDLE_MS ?? 30 * 60_000),
    /** On first passthrough turn, delete stale `<mcpServerName>-<sha16>` registrations no live process serves. */
    mcpGcOnStart: raw.mcpGcOnStart !== false && env.JIUWEN_MCP_GC_ON_START !== '0',
    /** GC leaves state dirs modified within this window alone (a process may be registering). */
    mcpGcGraceMs: Number(raw.mcpGcGraceMs ?? env.JIUWEN_MCP_GC_GRACE_MS ?? 120_000),
    /** Aux calls (compaction, titles): `stable` = one `<jiuwenSessionId>-aux` session per dsh session; `fresh` = new session per call (legacy). */
    auxSession: (raw.auxSession ?? env.JIUWEN_AUX_SESSION) === 'fresh' ? 'fresh' : 'stable',
    /** Register the `/jiuwen` slash command on ctx.commands when available. */
    registerCommands: raw.registerCommands !== false && env.JIUWEN_REGISTER_COMMANDS !== '0',
    // ── Bridges (sessionSync/planBridge default ON with hostSync; modelDiscovery/typedEvents still opt-in) ──
    /** Advertise Jiuwen models.list in this provider's catalog as `<discoveryPrefix><model_name>` (+ llm.registerModelDiscovery). */
    modelDiscovery: raw.modelDiscovery === true || env.JIUWEN_MODEL_DISCOVERY === '1',
    discoveryNamespace: String(raw.discoveryNamespace || 'jiuwen'),
    discoveryPrefix: String(raw.discoveryPrefix || 'jiuwen-model:'),
    /** DSH session/created|disposed → local Jiuwen mapping upkeep (jiuwen sessions only). */
    sessionSync: raw.sessionSync !== undefined || env.JIUWEN_SESSION_SYNC ? (raw.sessionSync !== false && env.JIUWEN_SESSION_SYNC !== '0') : hostSync,
    /** Jiuwen session.plan_status → ctx.planMode (jiuwen sessions only). */
    planBridge: raw.planBridge !== undefined || env.JIUWEN_PLAN_BRIDGE ? (raw.planBridge !== false && env.JIUWEN_PLAN_BRIDGE !== '0') : hostSync,
    /** Also emit typed jiuwen/tool | jiuwen/plan | jiuwen/approval | jiuwen/swarm events. */
    typedEvents: raw.typedEvents === true || env.JIUWEN_TYPED_EVENTS === '1',
    /** Slash command name (default 'jiuwen'); change it if another plugin already owns /jiuwen. */
    commandName: String(raw.commandName || env.JIUWEN_COMMAND_NAME || 'jiuwen').replace(/^\//, ''),
    /** Reply sent to Jiuwen when it asked but no dsh answerer exists. */
    noUiAnswer: String(raw.noUiAnswer || 'No interactive user is available. Proceed with your best judgment and state your assumptions.'),
    /** Cancel in-flight Jiuwen turn (chat.interrupt intent=cancel) when the host aborts. */
    interruptOnAbort: raw.interruptOnAbort !== false,
    /** On host abort also send swarmflow.stop for the last SwarmFlow run seen in that Jiuwen session. */
    swarmflowStopOnAbort: raw.swarmflowStopOnAbort !== false && env.JIUWEN_SWARMFLOW_STOP_ON_ABORT !== '0',
    /** Answer SwarmFlow human turns (source swarmflow_human) through ctx.approval + chat.swarmflow_reply. */
    swarmflowReply: raw.swarmflowReply !== false,
    /** Opt-in: pre-persist document attachments with document.persist before chat.send (jiuwen sessions only). */
    documentPersist: raw.documentPersist === true || env.JIUWEN_DOCUMENT_PERSIST === '1',
    /** Idle grace after chat.final before ending the turn (waits for usage / processing_status). */
    finalGraceMs: Number(raw.finalGraceMs ?? env.JIUWEN_FINAL_GRACE_MS ?? 1500),
    terminalFinalGraceMs: Number(raw.terminalFinalGraceMs ?? env.JIUWEN_TERMINAL_FINAL_GRACE_MS ?? 100),
    /** After a mid-turn Gateway drop, look for the turn's answer in Jiuwen history (history.get) and emit it, marked as recovered. */
    recoverOnDrop: (raw.recoverOnDrop ?? env.JIUWEN_RECOVER_ON_DROP ?? 'true') !== false && String(raw.recoverOnDrop ?? env.JIUWEN_RECOVER_ON_DROP ?? 'true') !== 'false',
    /** How long to keep polling history for the dropped turn's final answer. */
    recoverWindowMs: Number(raw.recoverWindowMs ?? env.JIUWEN_RECOVER_WINDOW_MS ?? 15_000),
    postCancelSettleMs: Number(raw.postCancelSettleMs ?? env.JIUWEN_POST_CANCEL_SETTLE_MS ?? 1000),
    /**
     * A new user message reaches a host session whose Jiuwen turn is still running:
     * 'interrupt' (default) = chat.interrupt the turn, then resend with the new message(s) coalesced
     * into one step and a note that the previous turn was interrupted; 'queue' = wait for the turn to end.
     */
    onBusyMessage: pickEnum(env.JIUWEN_ON_BUSY_MESSAGE || raw.onBusyMessage, ['interrupt', 'queue'], 'interrupt'),
    /** Inbox source kinds that never trigger interrupt-on-busy (automation, not a person). */
    busyIgnoreSources: Array.isArray(raw.busyIgnoreSources) ? raw.busyIgnoreSources.map(String) : DEFAULT_BUSY_IGNORE_SOURCES,
    /** Max wait for chat.interrupt to settle before the resend (interrupt-on-busy). */
    interruptSettleMs: Number(raw.interruptSettleMs ?? env.JIUWEN_INTERRUPT_SETTLE_MS ?? 8000),
    /** Host auxiliary calls (GenerateOptions.purpose): session-title → 'local' (instant heuristic) | 'jiuwen'. */
    titleMode: pickEnum(env.JIUWEN_TITLE_MODE || raw.titleMode, ['local', 'jiuwen'], 'local'),
    /**
     * purpose=compaction: 'local' (default; local digest, no Jiuwen call) | 'local+jiuwen' (also send
     * command.compact to the mapped Jiuwen session) | 'jiuwen' (legacy: full Jiuwen turn in a throwaway session).
     */
    compactionMode: pickEnum(env.JIUWEN_COMPACTION_MODE || raw.compactionMode, ['local', 'local+jiuwen', 'jiuwen'], 'local'),
    /** User-message blocks matching these regexes are not forwarded (default: DSH runtime-context and dsh-time-context snapshots; Jiuwen stamps its own time/runtime). */
    ignoreMessagePatterns: (Array.isArray(raw.ignoreMessagePatterns) ? raw.ignoreMessagePatterns : ['^Current runtime context\\.', '^Time sampled while preparing turn \\d+'])
      .map(p => { try { return new RegExp(String(p), 'm') } catch { return null } }).filter(Boolean),
    /** Forward the host system prompt to Jiuwen once per session (hash-gated): full (default; keep for hosts that need the full orchestrator/role prompt) | persona | off (ordinary dsh chats may use persona/off to cut overlap with Jiuwen rails). */
    /** Optional user-supplied host prompt profile object (persona sections, group events); see host-profiles.js. None by default. */
    hostProfile: raw.hostProfile && typeof raw.hostProfile === 'object' ? raw.hostProfile : undefined,
    injectSystem: pickEnum(env.JIUWEN_INJECT_SYSTEM || raw.injectSystem, ['off', 'persona', 'full'], 'full'),
    /** Byte cap for the forwarded host system prompt; longer text is cut with an explicit truncation marker. */
    injectSystemMaxBytes: (() => { const n = Number(env.JIUWEN_INJECT_SYSTEM_MAX_BYTES ?? raw.injectSystemMaxBytes); return Number.isFinite(n) && n >= 1024 ? Math.floor(n) : 64 * 1024 })(),
    /** Jiuwen steps in the reasoning block: summary (one line each, default) | full (structured Markdown). */
    trajectoryDetail: pickEnum(env.JIUWEN_TRAJECTORY_DETAIL || raw.trajectoryDetail, ['summary', 'full'], 'full'),
    // ── Host → Jiuwen sync (defaults ON; hostSync:false / JIUWEN_HOST_SYNC=0 disables all) ──
    hostSync,
    syncSkills: syncBit('syncSkills', 'JIUWEN_SYNC_SKILLS'),
    syncMcp: syncBit('syncMcp', 'JIUWEN_SYNC_MCP'),
    syncModel: syncBit('syncModel', 'JIUWEN_SYNC_MODEL'),
    syncPlanMode: syncBit('syncPlanMode', 'JIUWEN_SYNC_PLAN'),
    syncWorkDir: syncBit('syncWorkDir', 'JIUWEN_SYNC_WORKDIR'),
    syncTitle: syncBit('syncTitle', 'JIUWEN_SYNC_TITLE'),
    syncDelete: syncBit('syncDelete', 'JIUWEN_SYNC_DELETE'),
    syncGoal: syncBit('syncGoal', 'JIUWEN_SYNC_GOAL'),
    /** When the host system prompt changes mid-session: diff (default; resend only changed heading sections when clearly smaller) | full (resend everything). Safety gates (preamble change, reorder, size) still fall back to full. */
    injectSystemUpdate: pickEnum(env.JIUWEN_INJECT_SYSTEM_UPDATE || raw.injectSystemUpdate, ['diff', 'full'], 'diff'),
    /**
     * Optional filters for the forwarded host system prompt, by markdown heading (`#`..`###` line).
     * Regex strings (or RegExp). Empty allow + empty deny = all sections. Applied before hash/diff.
     * No built-in denylist. See filterHostSystemSections in system-inject.js.
     */
    hostSystemSectionsAllow: (() => {
      if (Array.isArray(raw.hostSystemSectionsAllow)) return raw.hostSystemSectionsAllow.map(String)
      const e = env.JIUWEN_HOST_SYSTEM_SECTIONS_ALLOW
      return e ? String(e).split(',').map(x => x.trim()).filter(Boolean) : []
    })(),
    hostSystemSectionsDeny: (() => {
      if (Array.isArray(raw.hostSystemSectionsDeny)) return raw.hostSystemSectionsDeny.map(String)
      const e = env.JIUWEN_HOST_SYSTEM_SECTIONS_DENY
      return e ? String(e).split(',').map(x => x.trim()).filter(Boolean) : []
    })(),
    /** Host skills Jiuwen lacks: index (default; name+description once, bodies on demand via skillLoaderTool which is always allowlisted in index mode) | body (explicit inline bodies) | off. Index never silently dumps bodies when the loader is missing — stays index-only. */
    hostSkillInject: pickEnum(env.JIUWEN_HOST_SKILL_INJECT || raw.hostSkillInject, ['index', 'body', 'off'], 'index'),
    /** Passthrough host tool that returns a skill body by name (dsh: `skill`). */
    /** Host skills Jiuwen lacks: forward at most this many per sync, each body capped at skillBodyMaxChars (a truncation marker is appended). */
    skillSyncMax: Number(raw.skillSyncMax ?? env.JIUWEN_SKILL_SYNC_MAX ?? 20),
    skillBodyMaxChars: Number(raw.skillBodyMaxChars ?? env.JIUWEN_SKILL_BODY_MAX_CHARS ?? 4000),
    /** Best-effort secret masking on the skill loader tool's passthrough output. */
    redactSkillOutput: raw.redactSkillOutput !== false,
    skillLoaderTool: firstNonEmpty(env.JIUWEN_SKILL_LOADER_TOOL, typeof raw.skillLoaderTool === 'string' ? raw.skillLoaderTool : undefined) || 'skill',
    /** Per-profile overrides: [{ preset: 'reviewer*', modelName, chatMode, agentTemplateName }] (host agent preset/profile glob; `match` = legacy session-id glob). First match wins; empty by default. */
    sessionOverrides: (Array.isArray(raw.sessionOverrides) ? raw.sessionOverrides : [])
      .filter(o => o && (typeof o.match === 'string' || typeof o.preset === 'string'))
      .map(o => ({ ...(typeof o.match === 'string' ? { match: o.match } : {}), ...(typeof o.preset === 'string' ? { preset: o.preset } : {}), ...(typeof o.modelName === 'string' ? { modelName: o.modelName } : {}), ...(typeof o.chatMode === 'string' ? { chatMode: o.chatMode } : {}), ...(typeof o.agentTemplateName === 'string' ? { agentTemplateName: o.agentTemplateName } : {}) })),
    syncPause: syncBit('syncPause', 'JIUWEN_SYNC_PAUSE'),
    syncPermissions: syncBit('syncPermissions', 'JIUWEN_SYNC_PERMISSIONS'),
    syncFork: syncBit('syncFork', 'JIUWEN_SYNC_FORK'),
    syncGroup: syncBit('syncGroup', 'JIUWEN_SYNC_GROUP'),
    syncSchedule: syncBit('syncSchedule', 'JIUWEN_SYNC_SCHEDULE'),
    syncMemory: syncBit('syncMemory', 'JIUWEN_SYNC_MEMORY'),
    syncPlugins: syncBit('syncPlugins', 'JIUWEN_SYNC_PLUGINS'),
    syncSkillInstall: syncBit('syncSkillInstall', 'JIUWEN_SYNC_SKILL_INSTALL'),
    /** Append JSONL trace of turns/events here (debugging). */
    traceFile: firstNonEmpty(env.JIUWEN_TRACE_FILE, typeof raw.traceFile === 'string' ? raw.traceFile : undefined),
    llmAdapterModule: firstNonEmpty(env.JIUWEN_LLM_ADAPTER_MODULE, typeof raw.llmAdapterModule === 'string' ? raw.llmAdapterModule : undefined),
  }
}

function pickEnum(value, allowed, fallback) {
  const v = String(value || '').toLowerCase()
  return allowed.includes(v) ? v : fallback
}

function normalizeModel(m) {
  const id = String(m.id || m.name || 'model')
  return {
    id,
    name: String(m.name || id),
    contextWindow: Number(m.contextWindow || 128_000),
    maxTokens: Number(m.maxTokens || 8192),
    // Optional Jiuwen-side routing for this catalog entry.
    ...(m.modelName ? { modelName: String(m.modelName) } : {}),
    ...(m.chatMode ? { chatMode: String(m.chatMode) } : (id === 'jiuwen-swarm' ? { chatMode: 'team.work.normal' } : {})),
    ...(m.agentTemplateName ? { agentTemplateName: String(m.agentTemplateName) } : {}),
    ...(m.agentGroupName ? { agentGroupName: String(m.agentGroupName) } : {}),
  }
}

function stripTrailingSlash(url) {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

function firstNonEmpty(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return undefined
}
