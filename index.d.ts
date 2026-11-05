/**
 * Types for @dsh-jiuwen/adapter: the `jiuwen/event` Cordis event and the `ctx.jiuwenAdapter` helper service.
 * Every event also carries `dshSessionId` (host session), `sessionId` (Jiuwen session) and `requestId` (chat.send id).
 */
export declare const JIUWEN_EVENT: 'jiuwen/event'
/** Typed event names (emitted only when config.typedEvents is on; `jiuwen/event` is always emitted). */
export declare const JIUWEN_TYPED_EVENTS: {
  readonly tool: 'jiuwen/tool'
  readonly plan: 'jiuwen/plan'
  readonly approval: 'jiuwen/approval'
  readonly swarm: 'jiuwen/swarm'
}

interface JiuwenEventBase {
  readonly dshSessionId?: string
  readonly sessionId?: string
  readonly requestId?: string
  /** Original Jiuwen payload (shape owned by JiuwenSwarm; may change between versions). */
  readonly raw?: unknown
}

export type JiuwenEvent = JiuwenEventBase & (
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; name: string; id?: string; arguments?: unknown }
  | { type: 'tool_update'; name?: string; id?: string; status?: string }
  | { type: 'tool_result'; name?: string; id?: string; success?: boolean; result?: string }
  | { type: 'subtask_update' | 'subagent_activity' | 'todo.updated' | 'team.task' | 'team.member' | 'team.message'; summary: string }
  | { type: 'processing_status'; isProcessing?: boolean; isComplete?: boolean }
  | { type: 'usage'; usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number }; model?: string }
  | { type: 'media' | 'file'; name: string; path?: string; url?: string }
  | { type: 'ask_user'; questions: unknown[] }
  | { type: 'interaction_answered'; eventType: string; source?: string; kind: 'question' | 'approval'; outcome?: string; requestIdOfQuestion?: string; answers: unknown[] }
  | { type: 'error'; message: string }
  | { type: 'interrupt'; intent: 'cancel' }
  | { type: 'interrupt_result' }
  /** Any other Jiuwen event, by normalized name (e.g. context.usage, chat.output_phase, task.global_running). */
  | { type: 'raw'; event: string }
)

export type JiuwenToolEvent = JiuwenEvent & { type: 'tool_call' | 'tool_update' | 'tool_result' }
export type JiuwenApprovalEvent = JiuwenEventBase & (
  | { type: 'ask_user'; questions: unknown[] }
  | { type: 'interaction_answered'; eventType: string; source?: string; kind: 'question' | 'approval' | 'swarmflow'; outcome?: string; requestIdOfQuestion?: string; answers: unknown[] }
)
export type JiuwenPlanEvent = JiuwenEventBase & { type: 'plan'; event: string; inPlan?: boolean; status?: string }
export type JiuwenSwarmEvent = JiuwenEventBase & { type: 'swarm'; event: string; runId?: string; summary?: string }

/** Plugin config. Unknown or misspelled keys are reported as warnings at load (never thrown). */
export interface JiuwenAdapterConfig {
  accessToken?: string
  agentGroupName?: string
  agentTemplateName?: string
  allowDshAgentLoop?: boolean
  /** @deprecated Put the key in an environment variable and set `apiKeyEnv`. */
  apiKey?: string
  apiKeyEnv?: string
  /** Optional limit (ms) on waiting for a dsh decision before denying; default 0 = none (native dsh has no approval timeout). */
  approvalTimeoutMs?: number
  authToken?: string
  authorization?: string
  baseURL?: string
  chatMode?: string
  commandName?: string
  compactionMode?: string
  cookie?: string
  defaultModel?: string
  discoveryNamespace?: string
  discoveryPrefix?: string
  displayName?: string
  documentPersist?: boolean
  emitUsage?: boolean
  eventDisplay?: string
  exposeJiuwenTools?: boolean
  finalGraceMs?: number
  forwardModelName?: boolean
  forwardReasoning?: boolean
  gatewayURL?: string
  historyMode?: string
  /** Forward host system prompt once per Jiuwen session: full (default; keep for full orchestrator/role prompts) | persona | off (ordinary dsh chats may use persona/off to cut overlap with Jiuwen rails). Jiuwen sessions only; fail-soft. */
  injectSystem?: 'off' | 'persona' | 'full'
  /** Byte cap for the forwarded host system prompt (default 65536); longer text gets a truncation marker. */
  injectSystemMaxBytes?: number
  /** Optional host prompt profile: persona sections for injectSystem 'persona' and group-change event types (none by default). */
  hostProfile?: { name?: string, personaSections?: Array<string | RegExp>, personaStop?: Array<string | RegExp>, personaAlways?: Array<{ match: string | RegExp, line: string }>, groupEvents?: string[] }
  /** Mid-session host system prompt change: only changed heading sections (diff, default; safety gates may still send full) or everything (full). */
  injectSystemUpdate?: 'diff' | 'full'
  /** Keep only host system sections whose markdown heading matches one of these regexes (empty = no allow filter). Applied before hash/diff. */
  hostSystemSectionsAllow?: Array<string | RegExp>
  /** Drop host system sections whose markdown heading matches one of these regexes (empty = no deny filter). Applied after allow. No built-in denylist. */
  hostSystemSectionsDeny?: Array<string | RegExp>
  /** Host skills Jiuwen lacks: index (default; name+description, bodies on demand via skillLoaderTool which is always allowlisted) | body (explicit inline) | off. Index never silently dumps bodies. */
  hostSkillInject?: 'index' | 'body' | 'off'
  /** Passthrough host tool that loads a skill body by name (default 'skill'). Always passed through under hostSkillInject:index even with a restrictive toolAllowlist. */
  skillLoaderTool?: string
  /** Best-effort secret masking of the skill loader tool output (default true). */
  redactSkillOutput?: boolean
  /** Max host skills forwarded per sync (default 20). */
  skillSyncMax?: number
  /** Max chars per forwarded host skill body; longer bodies get a truncation marker (default 4000). */
  skillBodyMaxChars?: number
  /** Per-session overrides by dsh session id glob; first match wins. */
  sessionOverrides?: Array<{ preset?: string, match?: string, modelName?: string, chatMode?: string, agentTemplateName?: string }>
  /** Route Jiuwen built-in bash/write_file/edit_file to the dsh MCP passthrough tools. */
  mapJiuwenFsToDsh?: boolean
  /** With dsh tool routing on: how duplicate Jiuwen built-ins are hidden (default 'deny'). */
  hideJiuwenBuiltins?: 'deny' | 'prompt' | 'off'
  /** Jiuwen steps in reasoning: summary | full (default; structured Markdown). */
  trajectoryDetail?: 'summary' | 'full'
  ignoreMessagePatterns?: Array<string | RegExp>
  interruptOnAbort?: boolean
  /** New user message on a session whose Jiuwen turn is running: interrupt + resend (default) or queue until it ends. Env JIUWEN_ON_BUSY_MESSAGE. */
  onBusyMessage?: 'interrupt' | 'queue'
  /** Max ms to wait for chat.interrupt to settle before the resend (default 8000). Env JIUWEN_INTERRUPT_SETTLE_MS. */
  interruptSettleMs?: number
  /** Inbox source kinds that never interrupt (default: user-question-reply, schedule, goal, subagent, subagent-settled, agent-message, runtime-context, system; plus any source.form 'notice'). */
  busyIgnoreSources?: string[]
  llmAdapterModule?: string
  mappingPath?: string
  /** Sidecar python binary (default: .venv-sidecar/bin/python). */
  agentcorePython?: string
  /** Sidecar sqlite checkpointer directory. */
  agentcoreCheckpointDir?: string
  mcpRpcTimeoutMs?: number
  /** Release a per-session MCP proxy after this long idle (ms, 0 = only on session end). Default 1800000. */
  mcpSessionIdleMs?: number
  /** GC stale `<mcpServerName>-<sha16>` registrations on first passthrough turn. Default true. */
  mcpGcOnStart?: boolean
  /** GC skips state dirs modified within this window (ms). Default 120000. */
  mcpGcGraceMs?: number
  /** Aux calls (compaction/titles): one stable `<id>-aux` Jiuwen session, or a fresh one per call. Default 'stable'. */
  auxSession?: 'stable' | 'fresh'
  mcpServerName?: string
  mcpStateDir?: string
  mode?: 'gateway' | 'openai'
  /** Product backend when mode=gateway (default gateway). */
  backend?: 'gateway' | 'agent-core'
  modelDiscovery?: boolean
  models?: Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number; chatMode?: string }>
  noUiAnswer?: boolean
  planBridge?: boolean
  hostSync?: boolean
  syncSkills?: boolean
  syncMcp?: boolean
  syncModel?: boolean
  syncPlanMode?: boolean
  syncWorkDir?: boolean
  syncTitle?: boolean
  syncDelete?: boolean
  syncGoal?: boolean
  syncPause?: boolean
  syncPermissions?: boolean
  syncFork?: boolean
  syncGroup?: boolean
  syncSchedule?: boolean
  syncMemory?: boolean
  syncPlugins?: boolean
  syncSkillInstall?: boolean
  postCancelSettleMs?: number
  projectDir?: string
  provider?: string
  questionTimeoutMs?: number
  recoverOnDrop?: boolean
  recoverWindowMs?: number
  registerCommands?: boolean
  requestTimeoutMs?: number
  serviceName?: string
  sessionSync?: boolean
  showProcessingStatus?: boolean
  skills?: string[]
  supportsUserInteraction?: boolean
  surfaceGatewayToolEvents?: boolean
  swarmflowReply?: string
  swarmflowStopOnAbort?: boolean
  terminalFinalGraceMs?: number
  titleMode?: string
  /** Default ['*'] (all host tools). 'core' = restricted core set (string or list entry). */
  toolAllowlist?: string[] | string
  /** Added to a restricted toolAllowlist (ignored with '*'). */
  toolAllowlistExtra?: string[]
  /** Also pass through host tools whose schema sets `passthrough: true` / `meta.jiuwenPassthrough` (default true). */
  toolHostDeclared?: boolean
  /** 'host' (default): dsh's own tool pipeline decides | 'dsh': legacy per-call ctx.approval gate | 'none'. */
  toolApproval?: 'host' | 'dsh' | 'none' | string
  toolApprovalExempt?: string[]
  /** Optional adapter cap (ms) on one passthrough call; default 0 = none (dsh's per-tool timeout policy applies). */
  toolCallTimeoutMs?: number
  /** Transport deadline (ms) of one passthrough call: Jiuwen MCP timeout_s + proxy wait. Default: caps + 5 s, or 1 h. */
  mcpCallTimeoutMs?: number
  toolPassthrough?: boolean
  traceFile?: string
  typedEvents?: boolean
  userId?: string
  workMode?: string
  xToken?: string
}

export interface JiuwenAdapterService {
  readonly provider: string
  /** Active product backend (`gateway` | `agent-core`). */
  backend(): string
  /** True when `backend === 'agent-core'`. */
  isAgentCore(): boolean
  onEvent(listener: (event: JiuwenEvent) => void): () => void
  jiuwenSessionId(dshSessionId: string): string
  /** Run a `/jiuwen` sub-command (e.g. 'status', 'models', 'model <name>') for a host session. */
  command(dshSessionId: string, input: string): Promise<string>
  gateway: Record<string, (...args: any[]) => Promise<any>> & {
    rpc(method: string, params?: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<any>
    /** Probe once (cached per Gateway URL) whether `/ws` routes a method. Never throws. */
    supports(method: string, params?: Record<string, unknown>): Promise<boolean>
    /** Methods cached as `unknown method` for the configured Gateway. */
    unsupported(): string[]
  }
  [key: string]: unknown
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    'jiuwen/event'(event: JiuwenEvent): void
    'jiuwen/tool'(event: JiuwenToolEvent): void
    'jiuwen/plan'(event: JiuwenPlanEvent): void
    'jiuwen/approval'(event: JiuwenApprovalEvent): void
    'jiuwen/swarm'(event: JiuwenSwarmEvent): void
  }
  interface Context {
    jiuwenAdapter: JiuwenAdapterService
  }
}

export declare const name: string
export declare const inject: string[]
export declare function apply(ctx: any, config?: JiuwenAdapterConfig): void
export default apply
