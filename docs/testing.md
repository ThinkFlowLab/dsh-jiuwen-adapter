# Testing

## Current default backend

The default agent-core backend needs no Gateway. Start with the committed
[agent-core E2E guide](./e2e.md): offline CI lane, isolated real-dsh live lane,
preconditions, snapshot/restore and exact assertions. `npm run test:e2e` skips
without explicit live opt-in; failures after prerequisites pass are real failures.

The legacy Gateway/nightly suites below exercise additional integration surfaces,
not a requirement for agent-core. Historical counts are not current acceptance results.

## Legacy suites

## Test guard at a glance

| Where | What runs | Fails when |
|---|---|---|
| GitHub Actions `CI` (push / PR to `main`, manual) — `test` job: Node 22 + 24 on Ubuntu, Node 24 on macOS | `npm ci` → `npm run lint` → `npm test` → `npm run test:coverage` → live suites must print `SKIP` → `npm pack --dry-run` | syntax error, failing test, coverage below the floors, test count below the baseline, a live suite that does not skip without `JIUWEN_LIVE` |
| CI `compat` job (dsh 0.2.1-rc.2 and rc.5 from npm) | full suite against the real dsh runtime (+ baseline) and the full-runtime A/B compat matrix | any test or matrix row differs |
| Box, nightly or before a risky merge | `bash scripts/guard-live.sh` | any live step / plain-dsh check fails, Jiuwen not restored exactly, secret in a log |

CI uploads `reports/` per leg as the `test-report-*` artifact: `junit.xml`, `lcov.info`, `coverage-summary.json`, `summary.json`; the job summary shows counts and coverage.

### Guards against silent test loss

- `test/scenario-catalog.test.js` maps every scenario to a test (file + test name / anchor). It fails if the file is gone or the anchor no longer appears; a self-test proves a missing scenario is reported and the catalog cannot shrink below 50 entries.
- `test/baseline.json` holds the minimum `files` (test files), `tests` and `pass` counts and the coverage floors (`lines`, `branches`, `functions` of `src/**` + `index.js`). `scripts/run-tests.mjs` (behind `npm run test:coverage`) fails if a count drops or coverage falls below a floor.

### Bump the baseline

```bash
npm run test:baseline:update                  # after adding tests: counts → current, floors → current − 1.5 (floored)
npm run test:baseline:update -- --allow-drop  # tests removed or merged on purpose: say why in the PR
git add test/baseline.json
```

Update from a run without `DSH_NM` (CI's `test` job has no dsh packages; with them more host suites run and the counts are higher). The update refuses to lower anything without `--allow-drop`.

### Add a scenario

1. Write the test: unit in `test/<area>.test.js` (mocks only), or a live check in `test/live/*.mjs` / `scripts/live-*.mjs`.
2. Add a row to `SCENARIOS` in `test/scenario-catalog.test.js`: `[name, file, anchor]`, where `file` is the test file stem, `live` (`test/live/run.mjs`) or `live-plain-dsh` (`test/live/plain-dsh.mjs`) and `anchor` is a string from the test's name.
3. `npm run test:coverage`, then `npm run test:baseline:update`; commit both.

### Run locally

```bash
npm ci && npm run lint && npm test     # fast, no network
npm run test:coverage                  # what CI enforces
JIUWEN_LIVE=1 … npm run test:live      # live suites, see below (they SKIP without JIUWEN_LIVE=1 and a Gateway)
```

### Live guard (box)

`scripts/guard-live.sh` runs the whole nightly live guard and needs a running JiuwenSwarm (`ws://127.0.0.1:19000/ws`), `DSH_BIN` / `DSH_NM` (defaults: `/workspace/dsh-rc5/prefix/...`).

1. Snapshot Jiuwen: sha256 of `~/.jiuwenswarm/config/*` and the MCP `state.json`, RPC-visible state, and the running agentserver/gateway command line, env and cwd (in a 0700 temp dir, deleted at exit, never printed).
2. Probe the real model once (HTTP status only). 429, or any other non-2xx status, skips the real-model smoke (`LIVE_SMOKE=1`). The summary records why.
3. Start the stand-in model on `:18999`.
4. `npm run test:live` (real-model smoke if allowed, `/jiuwen` commands, live-deep, compat-runtime, drop recovery). Then `npm run test:plain-dsh` (full plain/ext/busy/mem matrix, adapter-last and adapter-first). The guard switches Jiuwen to the stand-in and back by restarting the captured processes. It only signals the processes listening on the Gateway / agentserver ports.
5. Restore and verify. Checksums and state must be identical, and the Gateway must be back on the real model endpoint. The protected ports (`GUARD_PROTECT_PORTS`, default `3335`, the FlyBot demo) must be untouched. Logs are scanned for secret values, which are redacted, and any hit fails the run.
6. Write `/workspace/guard-logs/<date>.md` with pass/fail counts and failing test names. Full logs go to `/workspace/guard-logs/<date-time>/`. The script exits non-zero on any failure.

Exit codes: `0` pass, `1` failure, `2` preflight (no Gateway / dsh). An interrupted run restores Jiuwen from the snapshot on exit.

`GUARD_ONLY=live` or `GUARD_ONLY=plain-dsh` runs one suite under the same snapshot / stand-in / restore, for iterating on a failure. It writes `<date>-<suite>.md` and reports `PARTIAL PASS`, never a full `PASS`. Use the full run to sign off.

What the live checks expect since be6b36a (#5). These are deliberate contract changes, not regressions:

- Skills Jiuwen lacks reach it as an index by default (`hostSkillInject: index`): name and description, plus the loader tool `mcp_<server>_skill`. The body is sent only in `body` mode. The stand-in logs `skillIndex` / `skillLoader` / `skillLoaderOffered` (test/standin-skill-index.test.js).
- With dsh's goal tools passed through, the goal lives in dsh only. Jiuwen's own goal is never armed, and dsh's round driver keeps bumping the goal revision, so tests act on a fresh `goals.get()` ref.
- Group roster re-injection needs `hostProfile.groupEvents`. There are none by default.
- Passthrough tool calls run through dsh's own pipeline (`toolApproval: 'host'`), so Jiuwen gets what a native dsh session gets.
- With FS routing (the default under MCP passthrough), permission presets do not re-level Jiuwen's routed `bash` / `write_file` / `edit_file`. The adapter owns those global levels, and `subagent_spawn` / `task_tool` too when dsh's subagent is passed through. It releases them with `/jiuwen permissions release confirm`.
- plain-dsh runs several dsh processes against one Jiuwen and one permission ledger. A process keeps its owned denies while routing is on, and re-applies them on the next turn even after a release. So "permissions restored" compares the post-release state with the pre-process state where each ledger-owned entry is put back to its recorded prior (`test/live/perm-baseline.mjs`). The driver no longer writes its own start-of-run levels back after a successful release: with the adapter loaded first those were already the adapter's denies.
- compat-runtime `--sync2` loads `dsh-tool-skill`, the `skill` tool that the index names as the loader. Without it the adapter correctly sends the index only.

Unit tests and mocks bind port 0 (`test/helpers/spawn-mock-gateway.js`; `WebSocketServer({ port: 0 })` exposes `.port`; the stand-in prints its bound port). Never pick a fixed or random port range in a test: test files run in parallel.

## Layout

```
test/*.test.js            npm test: unit + in-process scenarios (mocks only; no network, no real Jiuwen)
test/helpers/mock-host.js mock-gateway on a random port + minimal Cordis-like host
test/fixtures/stand-in.mjs scripted OpenAI-compatible model (TAG/SLOW/REASON/HUGE/ERR500/ERRMID/TOOL:/MCP:)
bin/mock-gateway.mjs      Gateway mock; a query with TAG: emulates Jiuwen in front of the stand-in
test/live/run.mjs         npm run test:live (opt-in, real JiuwenSwarm)
test/live/plain-dsh.mjs   npm run test:plain-dsh (opt-in, real dsh web profiles, no FlyBot)
test/live/commands.mjs    live /jiuwen command pass (run by test:live)
test/live/plain-dsh/driver test-only dsh plugin that drives host services in a real profile
test/live/lib.mjs         guards, stand-in launcher, Jiuwen snapshot + exact restore
```

`test/scenario-catalog.test.js` lists every scenario from the test rounds and fails if its test is missing.

## npm test (fast, deterministic)

| File | Covers |
|---|---|
| deep-pass | A 12-turn history · B reasoning · C tool calls · D 200 KB answer · E model 500 · F mid-stream drop · G cancel · J persona once/resend/full · K 6 concurrent · M bad port/URL/switches · L 200-turn leak · reload 3× |
| memory-plugins | AGENTS.md and session-reference context forwarded with the prompt, not resent; runtime/time context still stripped |
| plugin-compat-matrix | 12 plain-dsh plugin areas × 2 load orders: non-jiuwen untouched, Jiuwen read-back, listeners released |
| plain-dsh-web | the 8 bb9df82 fixes (dispose keep, scoped skills, cwd seed, schedule list, fork wait, scoped plan, single delete); `{{model}}` persona is in persona-generic |
| drop-recovery, gateway-drop-rpc | drop/reconnect, fast-fail RPCs |
| mcp-bridge | MCP verify, tools/call approval + execute, proxy lifecycle |
| edge-cases, host-sync*, persona-generic | edge cases, resume, rename/fork, ask_user (Other strip), persona generic/minimal/`{{model}}` |
| fuzz-gateway | adversarial frames |
| busy-interrupt | onBusyMessage: interrupt, coalesce, deferred on approval, host stop wins, carry of a resend that was never sent |

## Opt-in live suites

Both skip (exit 0) unless `JIUWEN_LIVE=1` is set and the Gateway (`JIUWEN_GATEWAY_URL`, default `ws://127.0.0.1:19000/ws`) is reachable. They snapshot Jiuwen first: config bytes (in memory, never printed), sessions, heartbeat, permissions, skills, MCP, jobs, and the custom MCP records in `~/.jiuwenswarm/agent/workspace/mcp/state.json` (command, args, state, enabled; the dsh-tools proxy path depends on the dsh HOME). They restore it at the end and fail if anything differs.

```bash
JIUWEN_LIVE=1 \
JW_USE_STANDIN_CMD='<point Jiuwen model at http://127.0.0.1:18999/v1 and restart>' \
JW_RESTORE_CMD='<restore the original Jiuwen config and restart>' \
DSH_NM=<dsh node_modules> DSH_BIN=<dsh binary> \
GW_KILL='<kill gateway>' GW_START='<start gateway on the stand-in>' \
npm run test:live
```

| Step | Needs |
|---|---|
| live-gateway-smoke | `LIVE_SMOKE=1` and a working real model (it asks natural-language memory/tool questions) |
| live /jiuwen commands (`test/live/commands.mjs`: rename, pause/resume, goal, workflows, history, btw, recap, supplement, skill-toggle, plan-status, compact, fork, archive/unarchive, delete, read-only listings) | `JW_USE_STANDIN_CMD`/`JW_RESTORE_CMD` |
| live-deep (A–M, L, MCP tool_search invocation, ask_user card) | `JW_USE_STANDIN_CMD`/`JW_RESTORE_CMD` |
| compat-runtime `--sync --sync2 --reload` | + `DSH_NM` |
| live-drop-recovery | + `GW_KILL`/`GW_START` |
| plain-dsh profile matrix + extra plugins + interrupt-on-busy + memory-module plugins (`PLAIN_DSH_ONLY=plain\|ext\|busy\|mem`; `PLAIN_DSH_*_QUICK=1` runs only the adapter-last profile) | + `DSH_BIN` (also standalone: `npm run test:plain-dsh`) |

Each step starts from the snapshot: a step that leaves global Jiuwen state changed (permissions, heartbeat, MCP) prints `NOTE … left Jiuwen state changed` and is reset. The reset writes the snapshot config back (the real model endpoint) and Jiuwen hot-reloads it, so `run.mjs` re-runs `JW_USE_STANDIN_CMD` before the next step. `LIVE_LOG_DIR=<dir>` keeps each step's full output.

The stand-in (`test/fixtures/stand-in.mjs`) is started on `STANDIN_PORT` (18999) unless a server is already listening there. It logs to `STANDIN_LOG`.

## Other tools

| Command | What it covers | Requires |
|---|---|---|
| `npm test` | Unit + generic host + gateway features (count: `test/baseline.json`). Includes plain chat, streaming, gateway tools, openai `tool_calls`, reasoning/structured events/usage/`processing_status` filtering, markers compat, session continuity, cancel → `chat.interrupt`, agent/mode/skills/model selection, multimodal `base64Data`/`attachments`, ask_user, local titles, runtime-context filtering, extended RPCs, Round 1–3 live-fix regressions | Node ≥ 22 |
| `npm run smoke` | mock-openai + mock-gateway end-to-end; session mapping persistence | none |
| `npm run smoke:cordis` | Real Cordis `Context` + `LlmRuntime` loads the plugin and streams (openai mock + gateway mock; checks LlmRuntime stream grammar) | global npm dsh install (or `DSH_NODE_MODULES` / `DSH_LLM_PATH` / `DSH_CORDIS_PATH`) |
| `GW_KILL=… GW_START=… node scripts/live-drop-recovery.mjs` | Kills/restarts a real Gateway mid-turn and idle; checks soft failure, reconnect, mapping and conversation continuity. Use a scripted stand-in model (query `SLOW<ms>` streams slowly) | controllable JiuwenSwarm |
| `node --test test/fuzz-gateway.test.js` | Adversarial frames: malformed/null/binary, events before ack, duplicated finals, unicode/control/surrogates in tool args, 40× send/cancel, slow/missing ack, shared session id, hostile mapping ids | none |
| `node --expose-gc scripts/live-deep.mjs` | Deep live pass with the scripted stand-in (`/workspace/jw-live/stand-in.mjs`-style: markers `TAG`/`SLOW`/`REASON`/`HUGE`/`ERR500`/`ERRMID`/`TOOL:`/`MCP:`): 12-turn history, reasoning, Jiuwen tool events, 200 KB answer, provider 500 / mid-stream drop, abort, ask_user card + no-UI, dsh-tools MCP call round trip, persona once/resend, 6 concurrent sessions, bad URL/port, config variants, `LEAK_TURNS` (default 200) leak check. `ONLY=A,C,…` picks sections | stand-in-backed JiuwenSwarm |
| `node scripts/compat-runtime.mjs --jiuwen --sync --gateway=ws://…` | Real dsh runtime: title, `/jiuwen rename`, plan mode, workdir, goal create/pause/resume/clear, second turn; each read back from Jiuwen. `--reload`: 3× dispose/re-plugin in the live runtime. `--sync2`: skills body, permission baseline (no global flip), dsh fork → Jiuwen fork, delete idle + mid-turn, persona/group reinject, schedule→heartbeat (conf restored), MCP passthrough. `--providers`: also load pi-ai + deepseek-account | `DSH_NM` + JiuwenSwarm |
| `npm run smoke:live` | Minimal generic host against a real Gateway (default `:19000`; `SKIP` if offline): single turn, multi-turn memory, tool-call events, usage, no `processing_status` leak, cancel, session/skills/team/models RPCs | running JiuwenSwarm |
| `npm run bare-dsh` | Install npm dsh and wire headless/web profiles — see [bare-dsh.md](./bare-dsh.md) | npm network |
| `npm run mock:gateway` / `mock:openai` | Standalone mocks (`JIUWEN_GATEWAY_MOCK_PORT`, default 19000) | none |

Evidence lands under `examples/` (gitignored).

The mock gateway mirrors live wire shapes (`tool_call.name` nesting, `rendered_result`, `patch_segment` final, `usage_summary`, `processing_status.is_complete`; `slow` for slow streams, `ask me` for questions, `echo-params` echo, `debug.state` RPC). Set `MOCK_STREAM_END=1` to also emit `stream.end`. Use `JIUWEN_GATEWAY_MOCK_SHAPE=0.2.7` for the 0.2.7 response shape.

## Deep stress (local, Gateway down)

`node scripts/live-agentcore-stress-deep.mjs` — concurrency (12+), interleaved
tool turns, cancel under load, rapid cancel/resume, stream abort, long multi-turn
latency plus RSS via a long-lived sidecar, capability edges, failure recovery,
and memory under load. Set `JW_SNAP` to a `scripts/jiuwen-snap.sh` directory.
`STRESS_ONLY=rss,memload` selects sections.
