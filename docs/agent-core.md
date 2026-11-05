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
backend: agent-core   # default: gateway
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
