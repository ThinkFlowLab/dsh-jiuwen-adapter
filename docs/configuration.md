# Configuration reference

Precedence: **environment variable > Cordis plugin config > default** (`provider` / `displayName` / `models` / `defaultModel` come from plugin config only).

| Plugin key | Env | Default | Meaning |
|---|---|---|---|
| `provider` | — | `jiuwen` | Provider id registered on `ctx.llm` |
| `displayName` | — | `JiuwenSwarm` | `providerInfo().name` |
| `mode` | `JIUWEN_MODE` | `gateway` | `gateway` (product, Jiuwen brain) / `openai` (diagnostics; aliases `llm`, `completions`) |
| `backend` | `JIUWEN_BACKEND` | `gateway` | When `mode=gateway`: `gateway` (Jiuwen WS) or `agent-core` (local sidecar). Default stays gateway. |
| `gatewayURL` | `JIUWEN_GATEWAY_URL` | `ws://127.0.0.1:19000/ws` | Gateway WebSocket |
| `baseURL` | `JIUWEN_BASE_URL` | `http://127.0.0.1:18080/v1` | OpenAI-compatible root (openai mode only) |
| `apiKey` | `JIUWEN_API_KEY` or `$apiKeyEnv` | — | Bearer key for openai mode |
| `apiKeyEnv` | — | `JIUWEN_API_KEY` | Name of an alternative env var holding the key |
| `authToken` | `JIUWEN_AUTH_TOKEN` | — | Gateway token (also fallback for `accessToken`) |
| `accessToken` | `JIUWEN_ACCESS_TOKEN` | = `authToken` | Sent as query `access_token` |
| `cookie` | `JIUWEN_COOKIE` | — | `Cookie` header (may contain `access_token=`) |
| `authorization` | `JIUWEN_AUTHORIZATION` | — | Raw `Authorization` header |
| `xToken` | `JIUWEN_X_TOKEN` | — | `X-Token` header |
| `userId` | `JIUWEN_USER_ID` | `dsh-adapter` | Gateway `user_id` |
| `models` | — | `jiuwen-default`, `jiuwen-swarm` (128k ctx, 8192 max; swarm → `chatMode: team.work.normal`) | Catalog `[{id,name,contextWindow,maxTokens, modelName?, chatMode?, agentTemplateName?, agentGroupName?}]` |
| `defaultModel` | — | first model id | |
| `mappingPath` | `JIUWEN_SESSION_MAP` | `$DSH_HOME/jiuwen-adapter/session-map.json` (`DSH_HOME`→`ctx path.home`→`HOME`→cwd) | Host session ↔ Jiuwen session map |
| `workMode` | `JIUWEN_WORK_MODE` | `agent` | `chat.send` `work_mode` |
| `projectDir` | `JIUWEN_PROJECT_DIR` | — | Forwarded project directory |
| `requestTimeoutMs` | `JIUWEN_TIMEOUT_MS` | `180000` | Per-turn timeout |
| `allowDshAgentLoop` | `JIUWEN_ALLOW_DSH_AGENT_LOOP=1` | `false` | openai mode: forward host tools, return `tool-call` chunks |
| `exposeJiuwenTools` | `JIUWEN_EXPOSE_TOOLS=1` | `false` | Enable `bridge.listJiuwenTools()` discovery |
| `surfaceGatewayToolEvents` | — | `true` | Render Jiuwen tool/subtask events as text markers |
| `eventDisplay` | `JIUWEN_EVENT_DISPLAY` | `reasoning` (`none` if `surfaceGatewayToolEvents: false`) | Jiuwen tool/subtask activity: `reasoning` block / legacy text `markers` / `none` |
| `forwardReasoning` | `JIUWEN_FORWARD_REASONING=0` disables | `true` | `chat.reasoning` → `reasoning-delta` |
| `showProcessingStatus` | `JIUWEN_SHOW_PROCESSING_STATUS=1` | `false` | Show `chat.processing_status` (filtered by default) |
| `emitUsage` | — | `true` | Emit `usage` chunk from `chat.usage_summary` |
| `historyMode` | `JIUWEN_HISTORY_MODE` | `gateway` | `gateway`: after turn 1 send only new user text; `transcript`: always recent transcript |
| `injectSystem` | `JIUWEN_INJECT_SYSTEM` | `full` | Forward the host system prompt to Jiuwen (its `chat.send` has no system/instructions field, so it rides as a `[System instructions from host]…[/System]` prefix on the first query). `full` (default) = whatever system/developer text the host supplies for the session, verbatim — any profile or role (plain chat, superagent Router/Worker, other plugins); no role detection. Keep `full` when the host needs the complete orchestrator/role prompt in Jiuwen. Ordinary dsh chats may set `persona` or `off` to cut overlap with Jiuwen's own rails. `persona` = the sections named by an optional `hostProfile` object, else the dsh persona sections when present (needs `hostSync`); `off` disables. Sent once per Jiuwen session, resent only when its hash changes (prefixed `[System instructions from host — updated; they replace the previous host instructions]`), and again after a Jiuwen-side `command.compact`; latest in-history system message wins; any error → plain query |
| `injectSystemMaxBytes` | `JIUWEN_INJECT_SYSTEM_MAX_BYTES` | `65536` | Byte cap for the forwarded host prompt (min 1024); longer text is cut and ends with `…[host system prompt truncated by dsh-jiuwen adapter: kept N of M bytes]` |
| `hostProfile` | — | none | Optional object describing your host's prompt: `personaSections` / `personaStop` (regex strings per line) pick the persona for `injectSystem: persona`; `personaAlways` appends fixed lines; `groupEvents` lists `session/event` types that re-inject the persona (`syncGroup`). The adapter ships no host-specific profile; without one, persona mode uses the generic dsh persona source and no group events are watched (see `src/host-profiles.js`) |
| `injectSystemUpdate` | `JIUWEN_INJECT_SYSTEM_UPDATE` | `diff` | When the host prompt changes mid-session: `diff` (default) resends only the changed heading sections (plus a list of removed headings) when that is safe (preamble unchanged, no reordering) and < 60% of the full prompt, else falls back to the full block; `full` always resends everything |
| `hostSystemSectionsAllow` | `JIUWEN_HOST_SYSTEM_SECTIONS_ALLOW` (comma) | `[]` | Keep only host system sections whose markdown heading (`#` / `##` / `###` line) matches one of these regexes. Empty = no allow filter. Applied when building `[System instructions from host]` **before** hash/diff. The preamble (text before the first heading) has an empty heading `""` — include `^$` in the list if you want to keep it under a non-empty allow. No built-in allowlist |
| `hostSystemSectionsDeny` | `JIUWEN_HOST_SYSTEM_SECTIONS_DENY` (comma) | `[]` | Drop host system sections whose heading matches one of these regexes (applied after allow). Empty = no deny filter. No built-in denylist. Heading matching uses the same fenced-code-safe `splitSections` as `injectSystemUpdate: diff` |
| `hostSkillInject` | `JIUWEN_HOST_SKILL_INJECT` | `index` | Host skills Jiuwen lacks: `index` sends name + one-line description once per Jiuwen session (re-sent only when the set changes) and the model loads a body on demand through `skillLoaderTool` (always passed through under index mode, even with a restrictive `toolAllowlist`). If the loader tool is still missing this turn (e.g. not on the host tools list / MCP not attached), the adapter stays **index-only** and logs a warning — it does **not** silently dump full bodies. `body` = explicit inline bodies; `off` = nothing. Bodies/descriptions, and the `skillLoaderTool` output in `index` mode, go through a **best-effort** pattern redactor (common token shapes, `Authorization`/`Bearer`, `user:pass@` URLs, `key: value` / JSON `"key": "value"` assignments). It is not a guarantee: unknown formats or encoded secrets pass through, so do not keep live credentials in host skills |
| `skillSyncMax` | `JIUWEN_SKILL_SYNC_MAX` | `20` | Max host skills Jiuwen lacks that are forwarded per sync (the rest are logged and skipped) |
| `skillBodyMaxChars` | `JIUWEN_SKILL_BODY_MAX_CHARS` | `4000` | Per-skill body cap; a longer body ends with `…[host skill truncated by dsh-jiuwen adapter: capped at N of M chars]` |
| `redactSkillOutput` | — | `true` | Apply the redactor to the `skillLoaderTool` passthrough result |
| `skillLoaderTool` | `JIUWEN_SKILL_LOADER_TOOL` | `skill` | Passthrough host tool that returns a skill body by name (used by `hostSkillInject: index`). Under index mode it is always added to a restricted `toolAllowlist` and force-included in the MCP passthrough set when present on the host tools list |
| `sessionOverrides` | — | `[]` | Per-profile defaults, first match wins: `[{ preset: 'reviewer*', modelName, chatMode, agentTemplateName }]`. `preset` globs the host agent preset/profile name; `match` (legacy) globs the dsh session id; all keys set must match. They only fill fields the request, the catalog model, and `/jiuwen mode`/`model` leave unset (e.g. a faster / non-reasoning model for sub-agent or worker sessions). Explicit request options and `/jiuwen mode` still win |
| `trajectoryDetail` | `JIUWEN_TRAJECTORY_DETAIL` | `full` | Set `summary` for one-line activity only. `full`: Jiuwen tool calls/results, subtasks, todos and `trace.*` steps as Markdown steps (header, args, result; 4 KB per item) in the reasoning block (dsh Trajectory tab). Never emits tool-call blocks. Needs `eventDisplay: reasoning` |
| `ignoreMessagePatterns` | — | `['^Current runtime context\\.', '^Time sampled while preparing turn \\d+']` | Regexes; matching user blocks (from match onward) are not forwarded |
| `chatMode` | `JIUWEN_CHAT_MODE` | = `workMode` | chat.send `mode` (`agent`, `agent.plan`, `agent.fast`, `agent.work.normal`, `agent.code.normal`, `team`, `team.work.normal`, …). Per-session override via `/jiuwen mode` (stored in the session map) |
| `agentTemplateName` | `JIUWEN_AGENT_TEMPLATE` | — | Jiuwen expert (`agent_template_name`); may also be stored per-session in the map |
| `agentGroupName` | `JIUWEN_AGENT_GROUP` | — | Jiuwen expert group for Team (`agent_group_name`) |
| `skills` | `JIUWEN_SKILLS` (comma list) | — | Selected Jiuwen skills; may also be stored per-session in the map |
| `forwardModelName` | `JIUWEN_FORWARD_MODEL=0` disables | `true` | Send non-catalog model ids as `model_name` |
| `supportsUserInteraction` | `JIUWEN_SUPPORTS_USER_INTERACTION=1\|0` | `auto` | `auto`: tell Jiuwen it may ask when the host has `ctx.userQuestions` and a live answerer (not headless); questions are answered via dsh user-questions (see [dsh-integration.md](./dsh-integration.md)) |
| `questionTimeoutMs` | `JIUWEN_QUESTION_TIMEOUT_MS` | `600000` | Max wait for a dsh answer, then `noUiAnswer` |
| `approvalTimeoutMs` | `JIUWEN_APPROVAL_TIMEOUT_MS` | `0` (none) | Optional adapter-side limit on waiting for a decision on a Jiuwen permission ask, plan review, SwarmFlow human turn or the legacy `dsh` gate, then **deny**. Default none, as in native dsh: the ask waits for the user or the dsh turn's abort (policy `never` rejects at once). When set together with `toolCallTimeoutMs` it is part of the passthrough call cap |
| `toolPassthrough` | `JIUWEN_TOOL_PASSTHROUGH` | `mcp` when `hostSync` on, else `off` | `mcp`: expose allowlisted dsh tools to Jiuwen as a local MCP server |
| `toolAllowlist` | `JIUWEN_TOOL_ALLOWLIST` (comma) | `["*"]` when `hostSync` on, else `[]` | Tool names / `prefix*` / `*`. Default passes every host/plugin tool through (Jiuwen still discovers them progressively — leave progressive discovery enabled; do not turn it off for cost). `core` (as the value or a list entry) = restricted set: `bash, read, edit, write, glob, grep`, the `skillLoaderTool`, and the read-only `session_*` query tools. Under `hostSkillInject: index`, `skillLoaderTool` is always added even when the list is restricted |
| `toolAllowlistExtra` | `JIUWEN_TOOL_ALLOWLIST_EXTRA` (comma) | `[]` | With a restricted `toolAllowlist`: extra names/globs to add (e.g. `orchestrator_*`, `web_*`) |
| `toolHostDeclared` | `JIUWEN_TOOL_HOST_DECLARED` | `true` | With a restricted `toolAllowlist`: also pass host tools whose schema declares `passthrough: true` (or `meta.jiuwenPassthrough: true`) |
| `toolApproval` | `JIUWEN_TOOL_APPROVAL` | `host` | How a Jiuwen-issued passthrough call is authorised. `host`: run it through dsh's own tool pipeline (`tools.execute`), so dsh's pre-execute policy, sandbox guards and approval policy decide exactly as for a native call, and post-execute hooks, content finalizers, `tools/result` observers and the per-tool timeout policy run. Falls back to `dsh` when the host has no tools runtime with `execute()` or no live agent for the session. `dsh`: legacy per-call gate — every call needs `ctx.approval` `allowed-once` (so approval policy `never` denies every non-exempt call), then the definition runs directly. `none`: run the definition directly, no approval |
| `toolApprovalExempt` | `JIUWEN_TOOL_APPROVAL_EXEMPT` | session-query + goal tools | Tools that skip the **legacy** gate (`toolApproval: dsh`, or the `host` fallback): `session_search`, `session_event_search`, `session_event_read`, `session_trace`, `session_event_trace`, `get_goal`, `update_goal`, `create_goal`. `*` suffix = prefix. Under `host` dsh's own policy decides for every tool (dsh does not ask for these anyway), so the list has no effect there |
| `toolCallTimeoutMs` | `JIUWEN_TOOL_CALL_TIMEOUT_MS` | `0` (none) | Optional adapter-side cap on one passthrough call. Default none, as for a native call: dsh's per-tool timeout policy bounds the run inside the pipeline, and the dsh turn's abort (or a dropped proxy connection) cancels it. When set, the adapter aborts after `toolCallTimeoutMs` + `approvalTimeoutMs` (`toolCallTimeoutMs` alone with `toolApproval: none`) |
| `mcpCallTimeoutMs` | `JIUWEN_MCP_CALL_TIMEOUT_MS` | caps + 5 s, else `3600000` | Transport deadline of one passthrough call: the Jiuwen MCP registration's `timeout_s` and the stdio proxy's wait (advertised in the endpoint file; `DSH_JIUWEN_PROXY_CALL_TIMEOUT_MS` still overrides the proxy). A changed value re-registers the proxy (Jiuwen's recorded `timeout_s` is compared) |
| `mapJiuwenFsToDsh` | `JIUWEN_MAP_JIUWEN_FS_TO_DSH=0` disables | `true` when `toolPassthrough: mcp` | dsh tool routing: Jiuwen's shell / file IO goes through the passed-through dsh tools (dsh sandbox + approval policy). Adds a `[Host FS routing]` hint to the first query and keeps Jiuwen's `bash` / `write_file` / `edit_file` denied (adapter-owned, see `hideJiuwenBuiltins` and the permission ledger below) |
| `hideJiuwenBuiltins` | `JIUWEN_HIDE_JIUWEN_BUILTINS` | `deny` | With dsh tool routing on, what happens to Jiuwen built-ins that duplicate a passed-through dsh tool (`read_file`→`read`, `glob`, `grep`, `list_files`→`glob`, `skill_tool`→`skill`, `subagent_spawn`/`task_tool`→`subagent`, `fetch_webpage`→`web_fetch`, `free_search`/`paid_search`→`web_search`, `get_current_goal`→`get_goal`, `submit_goal_report`→`update_goal`, plus the denied `bash`/`write_file`/`edit_file`). Only pairs whose dsh tool is actually passed through this session count. All modes but `off`: (1) the hint lists *builtin → `mcp_<server>_<dsh tool>`*; (2) a Jiuwen **permission ask** for such a builtin never becomes a dsh card: reads (`read_file`/`glob`/`grep`/`list_files`) of Jiuwen's own data (`~/.jiuwenswarm/…`, `$JIUWENSWARM_DATA_DIR`, e.g. plan-mode `.plans/*.md`) are allowed once, anything else is declined with feedback naming the dsh tool to call instead (Jiuwen gets it as the tool result and retries with the dsh tool) — before, these asks were dsh approval cards that waited forever (`approvalTimeoutMs: 0`); (3) Jiuwen's own goal is not armed for dsh goals and Jiuwen `submit_goal_report complete/blocked` is mirrored onto dsh `update_goal`. `deny` additionally keeps `subagent_spawn` / `task_tool` globally denied (owned, restored when routing is off) while dsh `subagent` is passed through, so delegation uses dsh sub-agents. `prompt` = the same without that deny. `off` = legacy behaviour (core hint only, asks go to dsh) |
| `mcpServerName` | `JIUWEN_MCP_SERVER_NAME` | `dsh-tools` | Name of the stable stdio MCP proxy registered once in Jiuwen (experimental) |
| `mcpStateDir` | `JIUWEN_MCP_STATE_DIR` | `~/.cache/dsh-jiuwen/mcp/<name>` | Shared dir: `schemas.json` + `ep-<pid>.json` read by the proxy |
| `mcpRpcTimeoutMs` | `JIUWEN_MCP_RPC_TIMEOUT_MS` | `30000` | Timeout for `mcp.register_custom` / `connect` / `disconnect` |
| `mcpSessionIdleMs` | `JIUWEN_MCP_SESSION_IDLE_MS` | `1800000` | Release a per-session `dsh-tools-<sha16>` proxy (disconnect + `mcp.delete_custom`) after this long without a turn or tool call; `0` = only on session end. Kept while another live dsh process still serves the session |
| `mcpGcOnStart` | `JIUWEN_MCP_GC_ON_START` | `true` | On the first passthrough turn, delete stale `<mcpServerName>-<sha16>` registrations whose state dir is under this `mcpStateDir` and has no live endpoint (never touches servers without a local state dir) |
| `mcpGcGraceMs` | `JIUWEN_MCP_GC_GRACE_MS` | `120000` | GC leaves state dirs modified within this window alone |
| `auxSession` | `JIUWEN_AUX_SESSION` | `stable` | Aux calls (compaction, titles): `stable` reuses `<jiuwenSessionId>-aux` (deleted with the main session); `fresh` = new session per call |
| `noUiAnswer` | — | "No interactive user is available…" | Reply sent to Jiuwen when no dsh answerer exists |
| `interruptOnAbort` | — | `true` | Host abort → `chat.interrupt {intent:'cancel'}` |
| `finalGraceMs` | `JIUWEN_FINAL_GRACE_MS` | `1500` | Idle grace after `chat.final` (turn normally ends on `processing_status.is_complete`) |
| `terminalFinalGraceMs` | `JIUWEN_TERMINAL_FINAL_GRACE_MS` | `100` | JiuwenSwarm sends an empty, request-scoped `chat.final` (no `final_mode`) ~0.7 s before `processing_status.is_complete`; the turn ends this long after it if nothing else arrives. Negative = wait for `processing_status`/`finalGraceMs` |
| `postCancelSettleMs` | `JIUWEN_POST_CANCEL_SETTLE_MS` | `1000` | After a cancel, delay the next `chat.send` on that session until this long after the cancel (JiuwenSwarm drops a send that arrives within ~300 ms of `chat.interrupt`). `0` disables |
| `onBusyMessage` | `JIUWEN_ON_BUSY_MESSAGE` | `interrupt` | A new user message reaches a host session whose Jiuwen turn is still running. `interrupt`: `chat.interrupt {intent:'cancel'}` that turn, wait for it to settle, then resend the new message(s) as one step with an interruption note. `queue`: wait until the turn ends (pre-0.2.x behaviour). See [Interrupt on busy](#interrupt-on-busy-onbusymessage) |
| `interruptSettleMs` | `JIUWEN_INTERRUPT_SETTLE_MS` | `8000` | Max wait for Jiuwen to confirm the interrupt (`chat.interrupt_result`, `processing_status{is_complete}` or `stream.end`) before the resend |
| `busyIgnoreSources` | — | automation kinds (see below) | Inbox `source.kind`s that never trigger an interrupt; messages with `source.form: 'notice'` never do either |
| `titleMode` | `JIUWEN_TITLE_MODE` | `local` | `purpose: session-title` answered locally (`local`) or by Jiuwen (`jiuwen`) |
| `compactionMode` | `JIUWEN_COMPACTION_MODE` | `local` | `purpose: compaction`: `local` digest (no Jiuwen call) / `local+jiuwen` (+ `command.compact` on the Jiuwen session) / `jiuwen` (legacy aux turn) |
| `registerCommands` | `JIUWEN_REGISTER_COMMANDS=0` disables | `true` | Register `/jiuwen <sub>` on `ctx.commands` ([dsh-integration.md](./dsh-integration.md#5-jiuwen-slash-command-dsh-command-registry)) |
| `commandName` | `JIUWEN_COMMAND_NAME` | `jiuwen` | Slash command name. If another plugin owns `/jiuwen`, registration fails soft (warning) — pick a unique name |
| `swarmflowStopOnAbort` | `JIUWEN_SWARMFLOW_STOP_ON_ABORT=0` disables | `true` | Host abort also sends `swarmflow.stop` for the last SwarmFlow run seen in that Jiuwen session (only when a run id was seen) |
| `swarmflowReply` | — | `true` | SwarmFlow human turns (`source: swarmflow_human`) → a `ctx.userQuestions` card (`ctx.approval` only without one) → `chat.swarmflow_reply` (`approved` / typed reply / `rejected (…)`; never fails open) |
| `documentPersist` | `JIUWEN_DOCUMENT_PERSIST=1` | `false` | Opt-in: `document.persist` document attachments on the turn socket before `chat.send` (fail soft: originals are sent if it fails) |
| `modelDiscovery` | `JIUWEN_MODEL_DISCOVERY=1` | `false` | **Opt-in.** Append Jiuwen `models.list` to this provider's catalog as unique ids `<discoveryPrefix><model_name>` (routed as `model_name`), and offer `llm.registerModelDiscovery(discoveryNamespace)` when the host has it. Never sets a default model |
| `discoveryNamespace` | — | `jiuwen` | Settings namespace for `registerModelDiscovery`; requests for other providers get `[]` |
| `recoverOnDrop` | `JIUWEN_RECOVER_ON_DROP=0` disables | `true` | If the Gateway socket drops mid-turn, poll `history.get` and return the reply, with the visible mark `[Recovered from Jiuwen history after the Gateway connection dropped]`. If nothing is recovered, the original error is kept |
| `recoverWindowMs` | `JIUWEN_RECOVER_WINDOW_MS` | `15000` | How long to poll history for the dropped reply |
| `discoveryPrefix` | — | `jiuwen-model:` | Id prefix for discovered models (keeps them distinct from `jiuwen-default` / other providers) |
| `sessionSync` | `JIUWEN_SESSION_SYNC=0` disables | `true` (with `hostSync`) | `session/created` → ensure mapping; `session/disposed` → clear pending question / SwarmFlow run (mapping kept). Jiuwen sessions only |
| `planBridge` | `JIUWEN_PLAN_BRIDGE=0` disables | `true` (with `hostSync`) | After a Jiuwen turn / plan event, mirror `session.plan_status.in_plan` onto `ctx.planMode`. Jiuwen sessions with a live agent only |
| `typedEvents` | `JIUWEN_TYPED_EVENTS=1` | `false` | **Opt-in.** Also emit `jiuwen/tool`, `jiuwen/plan`, `jiuwen/approval`, `jiuwen/swarm` (declared in `index.d.ts`). `jiuwen/event` is always emitted |
| `traceFile` | `JIUWEN_TRACE_FILE` | — | Append JSONL trace of turns/events |
| `serviceName` | — | `jiuwenAdapter` | ctx service name for the helper API (unique per instance). Exposed only via `ctx.provide`; a host without it (or a name clash) logs a warning instead of writing `ctx[serviceName]` |
| `llmAdapterModule` | `JIUWEN_LLM_ADAPTER_MODULE` | — | Explicit module/path exporting `LlmAdapter` |
| — | `DSH_NODE_MODULES` / `DSH_LLM_PATH` / `DSH_CORDIS_PATH` | global npm dsh install | Used by `scripts/cordis-load-smoke.mjs` only |

## Jiuwen global permissions (adapter-owned ledger)

JiuwenSwarm's tool permissions (`permissions.tools.*`, `~/.jiuwenswarm/config/config.yaml`) are **global**: shared by every session and every client of that JiuwenSwarm (web UI, TUI, other adapters). The Gateway offers no per-session deny (the session layer drops `deny_tools` / `ask_tools`; `run_permissions` / agent definitions apply only to channel `process_cli`), so routing must write global entries. To keep that reversible the adapter records every value it writes in `jiuwen-permissions.json` next to `mappingPath`, per Gateway URL: tool, level written, the level before (`prior`) and the owner (`route` = dsh tool routing, `preset` = dsh permission-preset mirror).

- Routing on: `bash` / `write_file` / `edit_file` = `deny` (+ `subagent_spawn` / `task_tool` under `hideJiuwenBuiltins: deny` when dsh `subagent` is passed through), applied on the first passthrough turn.
- Routing off (or `hideJiuwenBuiltins` no longer asking for a deny): the owned entries are restored to `prior` (an entry that did not exist is removed) shortly after start.
- **User wins:** an owned entry whose current value differs from what the adapter wrote is dropped from the ledger and never touched again.
- **Upgrade from older versions** (no ledger file yet): `bash` / `write_file` / `edit_file` already `deny` are adopted as adapter-owned (older versions wrote them without tracking), so they are lifted when routing is off. Other entries (e.g. Jiuwen's own `write: ask`) are never adopted.
- `/jiuwen permissions` lists the owned entries; `/jiuwen permissions release` previews and `/jiuwen permissions release confirm` restores all of them now (routing re-applies its denies on the next turn while it is on).

Auth resolution order (matches Jiuwen web_proxy): query `access_token`/`token` → `Authorization: Bearer` / `X-Token` → Cookie `access_token` → config/env. Node WS sends both query and headers.

## Full example (`cordis.patch.yml`)

```yaml
- insert:
    - id: llm-jiuwen
      name: '@dsh-jiuwen/adapter'
      config:
        provider: jiuwen
        mode: gateway
        gatewayURL: ws://127.0.0.1:19000/ws
        userId: alice
        workMode: agent
        requestTimeoutMs: 180000
        models:
          - { id: jiuwen-default, name: Jiuwen Default, contextWindow: 128000, maxTokens: 8192 }
- id: agent-default-model
  config: { provider: jiuwen, model: jiuwen-default }
```

## JiuwenSwarm model config (`~/.jiuwenswarm/config/.env`)

Never commit this file. Fields:

| Field | Meaning |
|---|---|
| `API_BASE` | Model endpoint base URL |
| `API_KEY` | Model key |
| `MODEL_NAME` | Model name |
| `MODEL_PROVIDER` | Protocol: `OpenAI` (compatible) or `Anthropic` |
| `ENDPOINT_PROFILE` | OpenAI dialect: `openai` / `deepseek` / `openrouter` / `siliconflow` / `dashscope` / `openai_compatible` / `ollama` / `lmstudio` / `vllm` / `sglang` |
| `CUSTOM_HEADERS` | Extra request headers |
| `EMBED_API_BASE` / `EMBED_API_KEY` / `EMBED_MODEL` | Embeddings (memory) |
| `VIDEO_API_BASE` / `VIDEO_API_KEY` / `VIDEO_MODEL_NAME` / `VIDEO_PROVIDER` | Video model |
| `OPENROUTER_API_KEY` / `TYPESAFE_API_KEY` | Optional browser-decision credentials |

Other settings: `~/.jiuwenswarm/config/config.yaml`.

## Per-request options

Any `GenerateOptions` may carry `providerOptions.jiuwen` (or `metadata.jiuwen` / `jiuwen`):

```js
ctx.llm.stream({ provider: 'jiuwen', model: 'jiuwen-default', messages, providerOptions: { jiuwen: {
  chatMode: 'agent.plan', agentTemplateName: 'coder', agentGroupName: 'g1', skills: ['pptx-generator'],
  pluginNames: [], modelName: 'doubao-seed-2.0-mini', projectDir: '/repo', sessionId: 'existing-jiuwen-session',
  historyMode: 'transcript', supportsUserInteraction: true, metadata: {}, onEvent: e => console.log(e),
} } })
```

Precedence: request > catalog model entry > plugin config.

## Compatibility guarantees

With `hostSync: false` (and `sessionSync`/`planBridge` off) behaviour matches the pre-sync adapter: no global listeners besides the plugin's own dispose, no host service is written except `ctx.provide(serviceName)`, no default model / permission preset / built-in command / tool is touched, and only namespaced names are used (`/jiuwen`, `jiuwen/*` events, `jiuwen_*` tools, `jiuwenAdapter`). Gateway methods are feature-detected (an `unknown method` answer is cached per Gateway URL; the subcommand soft-fails and disappears from `/jiuwen help`). Covered by `test/compat.test.js`.

**Permission presets → Jiuwen:** read-only → deny, workspace-write → ask, full/danger-full-access → allow, auto (dsh-experimental-auto-review) → ask. The derived `custom` state is not forwarded.


## Validation

On load the adapter checks its config and logs `[jiuwen] …` warnings. It never throws and never prints values:

- **Unknown key**: `unknown config key "gatewayUrl" (did you mean "gatewayURL"?)`
- **Deprecated**: `apiKey`, because inline secrets end up in profile files. Put the key in an env var and name it with `apiKeyEnv`. Also `compactionMode: "jiuwen"`, because it runs a full Jiuwen turn; use the default `local`
- **Wrong type**: a value of the wrong kind, such as an object where a string is expected

`index.d.ts` exports `JiuwenAdapterConfig` for typed configs.


## Interrupt on busy (`onBusyMessage`)

JiuwenSwarm has no mid-turn message injection. Without this option a message sent while a Jiuwen turn
is running waits in the host inbox until that turn finishes (so "do A … actually do B" first finishes A,
and a burst of messages runs one turn each). With `onBusyMessage: 'interrupt'` (default) the adapter:

1. listens to the host's generic `agent/inbox/inserted` event (any session, any plugin/profile; subscribed
   lazily on the first Jiuwen turn) and reacts to person-originated input: dsh web/RPC prompts and messages a
   plugin relays on behalf of a person. Host automation never interrupts: source kinds in `busyIgnoreSources`
   (default `user-question-reply`, `schedule`, `goal`, `subagent`, `subagent-settled`, `agent-message`,
   `runtime-context`, `system`) and any injected notice (`source.form: 'notice'`);
2. sends `chat.interrupt {intent:'cancel', request_id}` for the running request **once per turn** and
   waits up to `interruptSettleMs` for it to settle; the next `chat.send` still honours `postCancelSettleMs`;
3. moves every message still queued for later turns (`next-turn`) to the step boundary (`next-step`, the
   same as the host's "steer a queued message" action) so all messages that arrived meanwhile **coalesce
   into one resend**;
4. ends the host stream with `stop` and the marker `⏹ (interrupted — a new message arrived; continuing with it)`;
   the host loop runs the next step at once, and the adapter prefixes that query (after the PR #3 host-system
   block, which is unchanged) with: *your previous turn was interrupted because the user sent a new message …
   tool calls and side effects that already ran were NOT rolled back — check the current state … the message(s)
   below supersede the interrupted request*. The note is sent exactly once.

Interactions:

| Situation | Behaviour |
| --- | --- |
| Approval card pending (`permission_interrupt` / `confirm_interrupt` / `plan.approval_required` / SwarmFlow human) | **Deferred**: the user's approve/reject decision is still delivered to Jiuwen (never auto-rejected by a chat message); the interrupt fires right after the card resolves |
| Jiuwen question card pending (`ask_user`) | Unchanged: the typed message supersedes the question (existing behaviour), no extra interrupt |
| Host stop / cancel | Wins: the turn ends `aborted` (normal cancel path), nothing is promoted and no note is sent |
| Turn already finishing (terminal `chat.final` seen) | Not interrupted; the message is handled next as usual |
| Another message arrives while the resend is still waiting out `postCancelSettleMs` (before its `chat.send`) | The resend is not sent (send-then-cancel makes Jiuwen drop the query unrecorded). Its text is carried into the next resend: one note (`N new messages`), the carried text, then the newest message(s). `settled` trace: `settledBy: before-send`, `carried` |
| Compaction / title (aux calls) | Never interrupted; they are local and not Jiuwen turns |
| `injectSystem` (host system prompt) | Unaffected; the hash-gated block is prepended before the note as before |

Trace (`traceFile`): `{"at":"turn-interrupt","phase":"requested"|"deferred"|"coalesced"|"settled"|"resend", …}`
(`settled` carries `messages`, `promoted`, `waitedMs`, `settledBy`, and `carried` when text is carried), plus `turn-end` with `interrupted:true`.
