# agent-core sidecar (M1)

Thin Python stdio NDJSON-RPC process that wraps
[`openjiuwen`](https://github.com/openJiuwen-ai/agent-core) `0.1.20.post1`
(`create_deep_agent` / `Runner.run_agent_streaming`). The Node adapter will
spawn this process in a later milestone; M1 only delivers the sidecar, setup,
and offline tests.

## Setup

```bash
npm run sidecar:setup
# or: bash scripts/setup-sidecar
```

Creates `.venv-sidecar` and installs `openjiuwen==0.1.20.post1`, `aiosqlite`,
`pytest`, and `pytest-asyncio`.

## Run tests (offline, fake model)

```bash
npm run test:sidecar
# or:
#   AGENTCORE_FAKE_MODEL=1 DSH_JIUVEN_AC_DIR=/tmp/dsh-jiuwen-ac-test \
#     .venv-sidecar/bin/python -m pytest sidecar/tests -q
```

No network and no real API keys. `test:sidecar` runs pytest-cov and fails under 90% line coverage on `sidecar/` (tests excluded). The fake model is enabled by
`AGENTCORE_FAKE_MODEL=1` or a turn `model.provider` of `fake`.

## Protocol (one UTF-8 JSON object per line)

**Node → Python** `{id, method, params}`:

| method | params | result |
|---|---|---|
| `turn.start` | `{sid, query, system?, tools:[{name,description,parameters}], model:{provider,api_base,api_key_env,model}, images?, plan?, cwd?}` | streams then `{ok:true}` |
| `turn.cancel` | `{sid}` | cancels the consuming asyncio task |
| `tool.result` | `{callId, ok, content}` | resolves a pending LocalFunction await |
| `session.fork` | `{from, to, …}` | seeds child history from parent |
| `session.delete` | `{sid}` | `Runner.release` + `clear_context` |
| `session.history` | `{sid}` | `{ok, messages:[…]}` |
| `ping` | `{}` | `{ok:true, pong:true}` |
| `shutdown` | `{}` | stops the server |

**Python → Node**

- Response: `{id, result}` or `{id, error}`
- Unsolicited events (no `id`): `{event, params}`
  - `chunk` — `{type, payload, sid}` forwarded from agent-core
    (`llm_output`, `llm_reasoning`, `tool_call`, `tool_result`, `llm_usage`,
    `answer`, …)
  - `tool.call` — `{callId, name, args, sid}` from LocalFunction; host must
    reply with `tool.result`

## Persistence

SQLite checkpointer under `$DSH_JIUVEN_AC_DIR` (or `$AGENTCORE_CKPT_DIR`),
else `$DSH_HOME/jiuwen-adapter/ac/`, else `/tmp/dsh-jiuwen-ac/`. Requires
`aiosqlite`.

## Manual smoke

```bash
export AGENTCORE_FAKE_MODEL=1
export DSH_JIUVEN_AC_DIR=/tmp/dsh-jiuwen-ac-manual
.venv-sidecar/bin/python -m sidecar
# then write NDJSON lines to stdin
```

Log level defaults to `WARNING` (`AGENTCORE_LOG_LEVEL` to override). API keys
are read from `model.api_key_env` and are never logged.


## Coverage

`npm run test:sidecar` enforces ≥90% line coverage on `sidecar/` (tests omitted via `.coveragerc`).

Intentional gaps (keep thin; do not chase 100%):

| Area | Why uncovered |
|---|---|
| `fake_model` SLOW full 30s sleep | Cancelled early in tests to keep the suite fast |
| `RedactFilter` inner except | Defensive; only runs if logging guts misbehave |
| `server` task done-callback error paths | Race/cleanup edges exercised indirectly |
| `session_manager` set_llm / remove_ability except | Defensive around agent-core hot-reload quirks |
| `__main__` sys.path already-present branch | Only hit when imported twice from odd CWDs |


## Node transport (M2)

`src/agentcore-transport.js` spawns `.venv-sidecar/bin/python -m sidecar` and
speaks the NDJSON-RPC above. Select it with:

```yaml
# cordis / plugin config
backend: agent-core   # default (opt out with backend: gateway)
# or env JIUWEN_BACKEND=agent-core
```

Default remains `gateway`. Provider id stays `jiuwen`; stream still ends with
`finish: stop`. Sidecar `tool.call` events run through `ctx.tools.execute`
(or a test `executeTool` hook) and answer with `tool.result`.

```bash
npm run test:agentcore   # Node transport unit + real-sidecar integration (coverage ≥90% on transport)
npm test                 # full suite (must stay green)
npm run test:sidecar     # Python sidecar suite
```


### Node transport coverage

`npm run test:agentcore` enforces ≥90% line coverage on `src/agentcore-transport.js`.

Intentional gaps: spawn `error` / failed-ping kill paths, stdin write/drain races,
RPC timer edge, `safeArgs` JSON throw, and a few payload-field fallbacks in
`extractText` / `extractReasoning` (defensive).


## HostSync parity

Frontend-changeable settings that apply in jiuwen sessions (see [host-sync.md](./host-sync.md)) on agent-core:

| Setting | Effect |
|---|---|
| Model switch | `set_llm` on the cached DeepAgent each turn |
| System prompt | Host `system` with `prompt_mode=none` (no DeepAgent identity/skills/memory sections stacked) |
| Tools add/remove | LocalFunction ability sync each turn (`ability_manager`) |
| Reasoning / thinking | Forwarded when `forwardReasoning` is on (sidecar `reasoning` events) |
| Temperature / max_tokens / top_p | ModelRequestConfig fields on `turn.start` |
| Plan mode | `enable_plan_mode` + `default_mode=plan` when chatMode is `agent.plan` |
| Delete / fork / pause | Sidecar RPCs |


## Parity checklist

Every Gateway-backed feature has a native agent-core implementation (sidecar RPC, session map, or `agentcore-state.json`). Soft-no-op is not used.

| Feature | Gateway | agent-core | Unit / compat test | Live |
|---|---|---|---|---|
| Model switch | session map → chat.send | session map → `set_llm` / turn model | host-sync + agentcore-transport | live matrix |
| System prompt | injectSystem + chat.send | `prompt_mode=none` + turn system | sidecar prompt_mode test | live |
| Tools add/remove | MCP passthrough | LocalFunction → `ctx.tools.execute` | agentcore tool round-trip | live |
| Reasoning / thinking | forwardReasoning | sidecar reasoning events | agentcore-transport | live |
| Temperature / limits | chat.send extras | ModelRequestConfig | buildModelSpec + sidecar | live |
| Plan mode | planBridge / chatMode | `enable_plan_mode` + mapping | compat dsh-plan-mode | live |
| Skills enable + bodies | skills.toggle + inject | mapping skillBodies + inject | compat dsh-skill | live |
| MCP / host tools | mcp.register + proxy | LocalFunction (`mcpMode: local-function`) | mcpList facade + tools | live |
| Permissions presets | permissions.tools.update | agentcore-state + dsh tool pipeline | compat permission/auto-review | live |
| Session delete | session.delete | sidecar session.delete | host-sync + facade | live |
| Session fork | session.fork | sidecar session.fork | compat fork | live |
| Pause / cancel | chat.interrupt | sidecar cancel | agentcore cancel | live |
| Resume | chat.resume | mapping `paused=false` (next turn continues) | facade chatResume | live |
| Title rename | session.rename | session map title | compat session-title | live |
| Pin / archive / switch | session.* | session map flags | facade session* tests | live |
| Goal | command.goal | session map goal + system inject | compat dsh-goal + facade | live |
| Schedule / heartbeat | heartbeat.set_conf | agentcore-state heartbeat | compat dsh-schedule | live |
| Memory bridge | memory.status | mapping `memoryBridge: adapter` (+ host memory plugins via messages) | compat memory + facade | live |
| Plugins list/toggle | plugins.* | agentcore-state plugins | facade plugins* | /jiuwen plugins |
| Compact | command.compact | clear systemHash / reinject | facade compact | /jiuwen compact |
| Models list/get | models.* | config.models | facade modelsList | /jiuwen models |
| History | history.get | sidecar session.history | agentcore history | live |
| `/jiuwen` + `ctx.jiuwenAdapter.gateway.*` | GatewayTransport | `createAgentCoreFacade` | agentcore-facade.test.js | live |
| Auto-review | dsh plugin on tool pipeline | same (tools via `ctx.tools.execute`) | compat auto-review | live |

### Migration (Gateway → agent-core)

Existing `session-map.json` entries keep their `jiuwenSessionId`. On first agent-core turn the sidecar checkpointer is empty, so **history starts fresh** for that id; a one-time warning is logged (`backendOrigin: gateway` → migrated note). To keep Gateway history, set `backend: gateway`. New sessions record `backendOrigin: agent-core|gateway`.

### Remaining Gateway-dependent surfaces (agent-core implements what openjiuwen allows)

| Item | agent-core status | Why not full parity | Fallback |
|---|---|---|---|
| Swarm workflow **execution** / team graph runtime | List/registry in `agentcore-state`; openjiuwen `multi_agent` templates enumerated | Graph runner lives in Gateway agentserver, not in the sidecar `LocalFunction` agent loop — would need embedding agentserver or rewriting dsh swarm UX on TeamRuntime | Returns `{ unavailable:true, reason:'gateway-required' }` by default. Opt in with `gatewayFallback: true` + reachable `gatewayURL`, or `backend: gateway` |
| Hub skill **marketplace install** | `skillsMarketplaceList` + state registry; install still Gateway | Remote hub APIs are Gateway product endpoints | Auto-route list/install to Gateway; otherwise use host dsh skills (bodies injected) |
| Session assets browser | **Implemented**: lists sidecar checkpoint + `projectDir` files | Not the Gateway FS index / web UI browser | Host file tools; local listing is enough for agent use |
| External mem0 / lakebase memory | Status reports provider availability from env; openjiuwen ships providers | Needs live mem0/lakebase service + credentials; Gateway wires them into agentserver | Set `MEM0_*` / `LAKEBASE_*` / `OPENJIUWEN_MEMORY_ENABLED`, or use host memory plugins (`dsh-agent-instructions`, `dsh-session-reference`, `dsh-experimental-session-search`) |


## Agent-core-only mode (no Gateway)

Default product path: `backend: agent-core` and **`gatewayFallback: false`**.

Plain chat, tools (LocalFunction → `ctx.tools.execute`), sessions, fork/delete/history,
compact, permissions/auto-review (host), skills list (host), goal, plan status, heartbeat
config, memory status, and `/jiuwen` surfaces that the facade implements locally all work
**without** a running Gateway (`:19000` may be down).

### Opt back into Gateway auto-route

```yaml
# dsh profile / adapter config
backend: agent-core
gatewayFallback: true   # or env JIUWEN_GATEWAY_FALLBACK=1
gatewayURL: ws://127.0.0.1:19000/ws
```

Only methods that still mark `gatewayFallback: true` (when opted in) will auto-route —
hub marketplace, skill versions, swarm workflow get/execute, and unknown RPCs.

### Surfaces that return unavailable without Gateway

| Feature | Without Gateway | Opt-in gatewayFallback |
|---|---|---|
| workflow list (local registry) | empty local list `ok:true` | same |
| workflow get/execute (missing/run) | `unavailable` + `reason: gateway-required` | auto-route if Gateway up |
| skills marketplace (empty) | `unavailable` | auto-route |
| skillsGet miss / versions | `unavailable` | auto-route |
| team list / agents list | local adapter registry | local only (no auto-route) |
| swarm graph execute | `unavailable` | auto-route / `backend: gateway` |

Agent-core-only extras with **no dsh equivalent** (medical_kb, RSI, MoA, web_research_rail, …)
remain unwired.

### Out of scope (not a dsh surface)

Hub marketplace install/versions, swarm workflow **execute**, and other Gateway-only
product surfaces that dsh does not expose are **ignored** in agent-core-only mode —
documented as out-of-scope, not implemented as adapter substitutes. Related RPCs return
`{ unavailable:true, reason:'gateway-required' }` so callers fail closed without hanging.


## Reasoning / thinking (follow-up)

Gateway maps `REASONING` events; agent-core maps `llm_reasoning` → structured `reasoning` /
`reasoning-delta` (respects `forwardReasoning`). Default `reasoning.mode=disabled` (Volcengine
seed → `reasoning_effort=minimal`) to match Gateway chat turns. openjiuwen also emits a final
`answer` chunk that **duplicates** streamed `llm_output`; the transport drops `answer` when
`llm_output` was already seen (same dedupe as `agent_teams/monitor/stream_logger.py`).

## Feature ownership (dsh ↔ agent-core)

| feature | before | after | compat | notes |
|---|---|---|---|---|
| Tools / MCP execute | LocalFunction → `ctx.tools.execute` | **unchanged** (agent-core) | keep | single path; dsh plugins keep hooks |
| Permissions / auto-review | hostSync + toolApproval host | **unchanged** | keep | `enable_security_rail=False` avoids double-gate |
| Compact | adapter soft hash clear | **agent-core** `session.compact` → `create_new_context_engine` | keep | host memory plugins still authoritative |
| Team list / bindings | gatewayFallback list | **agent-core/adapter registry** (no auto-route) | keep | workflow *execute* still Gateway |
| Agents list | empty | DeepAgent + host agents; task-loop opt-in | keep | `AGENTCORE_TASK_LOOP=1` only |
| Task/subagent loop | unused | opt-in via env | keep | default off = no tool double-exec |
| Swarm workflow execute / hub / skill versions | gatewayFallback | **kept on Gateway** | — | needs agentserver |
| agent-core-only (medical_kb, RSI, MoA, web_research_rail, …) | — | **skipped** | — | no dsh equivalent |

## Feature coverage vs Gateway (deep audit)

Status legend: **native** = openjiuwen/sidecar; **adapter** = session map / `agentcore-state.json` / host pipeline; **fallback** = `gatewayFallback` auto-route; **missing** = not available.

### Host sync (see [host-sync.md](./host-sync.md))

| Feature | agent-core status | Live-tested |
|---|---|---|
| Skills enable/disable + body inject | adapter (mapping `skillBodies` + system inject) | unit/compat; deep parity probe |
| MCP / connectors sync | adapter (`mcpMode: local-function`; host tools via LocalFunction) | live tool round-trips |
| Model picker | native (`set_llm` / turn model) | live matrix model-switch |
| Plan mode | native (`enable_plan_mode`) | compat + deep plan-ish |
| Working directory | native (turn `cwd` / workspace) | live |
| Title rename | adapter (session map) | compat |
| Session delete | native (sidecar `session.delete`) | live matrix + deep |
| Goal create/pause/resume/clear | adapter (map + system inject) | compat |
| Host pause / cancel | native (sidecar `turn.cancel`) | live cancel-mid-TOOL + deep timeout |
| Permission presets | adapter (dsh tool pipeline / ledger) | compat |
| Session fork | native (sidecar `session.fork`) | live matrix + compat |
| Schedule / heartbeat | adapter (`agentcore-state` heartbeat) | compat |
| Memory bridge probe | adapter (`memoryBridge: adapter`; host memory plugins) | compat memory |

### `/jiuwen` subcommands → agent-core

| Subcommand | status | Live-tested |
|---|---|---|
| status, models, model, model-info, mode | adapter / config | unit facade |
| pause, resume, interrupt | native cancel / mapping | live cancel |
| rename, pin, switch, archive, unarchive, sessions, archived | adapter (session map) | facade |
| fork, delete, unmap | native / adapter | live + facade |
| goal, plan-status | adapter | compat |
| history, compact, btw, recap | native history / adapter compact | facade; history live |
| skill-toggle, skills, skill-info | adapter (+ host skills) | compat |
| workflows, teams, agents, templates, bindings | **fallback** (list local; execute needs Gateway) | facade gatewayFallback |
| tools, hooks, permissions, plugins | adapter (state / empty lists) | facade |
| projects, path, locale, commands, version, updater | adapter stubs | facade |
| heartbeat, cron | adapter state | compat schedule |
| mcp, mcp-reset | adapter local-function verify | mcpVerify live |
| marketplaces | **fallback** | facade |
| assets | native-ish (checkpoint + projectDir listing) | facade |
| help | adapter | unit |
| supplement, agent | adapter / thin | facade |

### `ctx.jiuwenAdapter.*` / `gateway.*`

| API surface | status | Live-tested |
|---|---|---|
| `gateway.history*` / `session*` CRUD | native or adapter | live + facade |
| `gateway.interrupt` / `chatCancel` / `chatResume` | native / adapter | live cancel |
| `gateway.models*` / `skills*` / `permissions*` / `plugins*` | adapter | facade |
| `gateway.heartbeat*` / `goal` / `planStatus` / `compact` | adapter | facade/compat |
| `gateway.mcpList` / `memory*` / `filesList` | adapter (+ env memory providers) | facade |
| `gateway.workflows` / `team*` / `skillsMarketplace*` | **fallback** | facade |
| `mcpVerify` | adapter (`local-function`) | live |
| `onEvent` / `config` / `backend` / `isAgentCore` | adapter | unit |

### Config options (agent-core-relevant)

| Option | status |
|---|---|
| `backend` / `JIUWEN_BACKEND` (default `agent-core`) | native switch |
| `agentcorePython` / `agentcoreCheckpointDir` | native |
| `gatewayFallback` (default **off**) | opt-in Gateway auto-route |
| `forwardReasoning` / `emitUsage` / `eventDisplay` | native stream map |
| `hostSync` + `sync*` flags | adapter (same flags as Gateway) |
| `gatewayURL` | required for fallback; optional for pure agent-core |

### Totals (feature rows above)

| Bucket | Count |
|---|---|
| native | 18 |
| adapter | 42 |
| fallback | 6 |
| missing | 0 (soft-no-op avoided; stubs or fallback) |
| **Covered without Gateway** (native+adapter) | **60 / 66 ≈ 91%** |
| **Needs Gateway for full UX** (fallback) | **6 / 66 ≈ 9%** |

Live deep-suite (`scripts/live-agentcore-deep.mjs`, Asia/Shanghai 2026-11-05): **21 PASS / 1 DEGRADED / 0 FAIL**
(DEGRADED: `edge-invalid-model` before env-override fix). Highlights: 30/30 long turns + history recall;
6/6 concurrent; checkpointer resume after sidecar kill (PAPAYA42); forced tools; Chinese + long prompt;
cancel-via-timeout. Latency x8: agent-core avg **9669 ms** (in≈5.8k) vs gateway avg **5112 ms** (in≈28k).
Fake-model microbench after tool fingerprint skip: turn1 **2460 ms**, turns 2–5 **≈10 ms**.

## What openjiuwen / agent-core provides

Pinned runtime: **`openjiuwen==0.1.20.post1`** (sources `/workspace/agent-core-src/agent-core-v0.1.20.post1`). Develop tree: `/workspace/agent-core-src/agent-core` (pyproject still labels `0.1.20`).

### Capability inventory

| Area | Module path (0.1.20.post1) | Adapter uses now? | Could use later? |
|---|---|---|---|
| **DeepAgent factory** | `openjiuwen/harness/factory.py` (`create_deep_agent`) | **yes** — sidecar builds one DeepAgent per dsh session | — |
| **ReAct / single agent** | `openjiuwen/core/single_agent/` | **yes** (inner `react_agent`) | Direct ReActAgent without DeepAgent harness |
| **Streaming run** | `openjiuwen/core/runner` (`Runner.run_agent_streaming`) | **yes** | — |
| **Abort / cancel** | turn task cancel; rails `harness/rails/interrupt/` | **yes** (`turn.cancel`) | ConfirmInterruptRail / ask-user rails |
| **LocalFunction tools** | `openjiuwen/core/foundation/tool` | **yes** — host `ctx.tools.execute` bridge | — |
| **MCP servers on agent** | `create_deep_agent(mcps=…)` + `harness/rails/mcp_rail.py` | no (dsh MCP stays on host) | Register selected MCP servers inside sidecar |
| **Checkpointer / persistence** | `core/session/checkpointer/` (`persistence` sqlite, inmemory, noop) | **yes** — sqlite under `DSH_JIUVEN_AC_DIR` | Cross-host shared DB |
| **Context engine / compaction** | `core/context_engine/` | **yes** (engine inside DeepAgent; host `/jiuwen compact` clears hash) | Tune compressors / offloaders |
| **Plan mode** | `harness/rails/agent_mode_rail.py`, `enable_plan_mode` | **yes** | Task-planning rail (`enable_task_planning`) |
| **Skills** | `harness/skills/`, `core/operator/skill_call` | partial — host skill bodies injected as system text | Native DeepAgent `skills=` paths |
| **Memory** | `core/memory/` + rails `harness/rails/memory/` (mem0, lakebase, openviking, agentarts, …) | status/env only; host memory plugins | Wire `OPENJIUWEN_MEMORY_ENABLED` / mem0 |
| **Security rails** | `harness/rails/security/` | **off** (`enable_security_rail=False`) | Opt-in prompt/tool security |
| **Model anomaly / tool-loop rail** | `harness/rails/model_anomaly_detection_rail.py` | **off** in sidecar (Gateway agentserver may still enforce) | Opt-in with higher thresholds |
| **Heartbeat rail** | `harness/rails/heartbeat_rail.py` | no — adapter-state heartbeat only | Native heartbeat scheduling |
| **Sys operation / sandbox** | `extensions/sys_operation/`, `sys_operation_rail` | no — file/bash via dsh tools | Sidecar sandbox for untrusted code |
| **Multimodal** | vision/audio model configs; `multimodal_*` rails; image window mutator | **yes** — image URLs on turn | Audio / native read_image |
| **Subagents / task loop** | `harness/subagent*`, `enable_task_loop` | no | Parallel subagents for heavy tasks |
| **Multi-agent / teams / swarm** | `core/multi_agent/`, `agent_teams/` | list/templates only; **execute → gatewayFallback** | Embed TeamRuntime in sidecar |
| **Graph / Symphony** | `core/graph/`, `symphony/` | no | Advanced workflows |
| **LSP / progressive tools / MoA** | `harness/rails/lsp_rail.py`, `progressive_tool_rail.py`, `moa_rail.py` | no | Coding-agent extras |
| **KV cache** | `core/kv_cache/`, harness kv_cache | no | Latency wins on long sessions |
| **Evaluation / evolving / RSI** | `agent_evolving/`, `auto_harness/`, `rsi/` | no | Offline eval pipelines |
| **Observability / OTEL** | `extensions/observability`, `extensions/tracer_otel` | logs only | Full traces |
| **LLM providers** | `core/foundation/llm` (`ProviderType`: OpenAI, OpenAIAccount, Anthropic, DashScope, OpenRouter, SiliconFlow, …) | **yes** via `Model` + env key | Provider routing / AnthropicMessages |
| **Parallel tool calls** | `create_deep_agent(parallel_tool_calls=True)` default | inherited | — |

### Develop tree beyond 0.1.20.post1

Notable additions under `/workspace/agent-core-src/agent-core` (not in the pinned wheel):

| Addition | Path |
|---|---|
| `jiuwen_memory_rail.py` | `openjiuwen/harness/rails/memory/jiuwen_memory_rail.py` |
| `web_research_rail.py` | `openjiuwen/harness/rails/web_research_rail.py` |
| Context cancellation helper | `openjiuwen/core/context_engine/context/cancellation.py` |
| Logging `invocation.py` | `openjiuwen/core/common/logging/invocation.py` |
| Agent-teams **experts** + scheduled dispatch prompts/tools | `openjiuwen/agent_teams/experts/`, new prompt/tool locale files |
| `tool_expert.py`, `swarmflow_infra.py`, `external_swarmflow_host.py` | `openjiuwen/agent_teams/tools/`, `…/workflow/` |
| Top-level `plugins/medical_kb` | `/workspace/agent-core-src/agent-core/plugins/` |
| Various rails/memory/progressive_tool/context_engineer edits | diff vs post1 |

The adapter stays on **0.1.20.post1** until a deliberate bump; develop features above are candidates, not dependencies.

### Sidecar performance note

Per-turn `_sync_tools` used to remove+re-add every LocalFunction every turn (costly with large dsh tool sets). It now fingerprints tools/model/system and **skips rebind when unchanged**, emitting `adapter_phase` timings (`ensure_ms`, `tools.skipped`, `set_llm_ms`, …). Remaining multi-turn wall-time gaps vs Gateway are dominated by **model verbosity / prompt assembly**
(agent-core often narrates before the token; gateway returns exact `LATn_OK`), plus rare outliers
(e.g. lat-7 = 28 s), not tool re-registration. Fake-model proof: after fingerprint skip, turns 2+ finish in ≈10 ms.
