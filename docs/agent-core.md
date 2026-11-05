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

### Genuinely out of scope (needs Gateway product / not adapter-replicable)

| Item | Reason | Workaround |
|---|---|---|
| Jiuwen Swarm workflows / team runtime | Requires Gateway agentserver graph runner | `backend: gateway` for swarm turns |
| Jiuwen hub skill marketplace install | Remote hub APIs on Gateway only | Use host dsh skills (bodies injected) |
| Jiuwen session assets browser (`session.assets.list`) | Gateway FS index; sidecar workspace is local | Host file tools / workspace path |
| Cross-process Jiuwen memory engine (mem0/lakebase server) | External memory service wired through Gateway | Host memory plugins (agent-instructions, session-reference, session-search) |

