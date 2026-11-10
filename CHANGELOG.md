# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [SemVer](https://semver.org/).

## Unreleased — gateway batch tools.execute and Models card hint

- Gateway MCP passthrough (`toolApproval: host`) now sends the same dual-shape `tools.execute` payload as agent-core, so dsh 0.2.2's batch API works and older hosts still accept a single call. Covered by an isolated contract test; the Jiuwen Gateway is not started.
- The Settings → Models JiuwenSwarm card hides dsh's generic "Other fields live in cordis.patch.yml" editor and its Edit / disabled Apply controls (dsh only ships layouts for DeepSeek and pi-ai). The adapter's own form is unchanged; other provider rows and the settings schema are not touched.

## Unreleased — model settings in the dsh UI

- The model picker lists the real model names from **Settings → Models** under JiuwenSwarm (agent-core backend) instead of `jiuwen-default` / `jiuwen-swarm`; selecting one sends exactly that model to agent-core. Legacy alias selections still resolve to the configured (or env) model. The Models card now takes plain model names. `backend: gateway` is unchanged.
- The Jiuwen provider is configured in **Settings → Models** (API key, endpoint, model list). Pick the model in the composer, or set it as the default. You no longer need to edit `cordis.patch.yml` or export `AGENTCORE_MODEL` / `AGENTCORE_API_BASE` just to choose a model.
- A concrete UI selection, and a catalog `modelName` on an alias, win over env / `~/.jiuwenswarm/config/.env`. Env and dotenv remain fallbacks for headless use and for unresolved aliases. The API key is stored write-only in dsh credentials when set in the UI.
- The adapter registers as a dsh configurable provider and ships a small web client card (`lib/client.js`) because the built-in Models editor only has layouts for DeepSeek and pi-ai.
- Fixed in a live dsh 0.2.2-rc.1 web session: the plugin config schema no longer nests volatile fields under `intersect` (dsh rejected it and `llm-jiuwen` never activated); the Models provider/settings registration keeps its service receiver; the client build no longer drops the `react` import (the card crashed with `h is not defined`).
- Agent-core host tool callbacks use dsh 0.2.2's batch `tools.execute` shape (bare single calls failed with `Tool batch execution failed`), still accepted by older hosts. Turn failures always carry a string code, so provider errors such as quota/429 reach the UI instead of `LlmError code must be a non-empty string`.
- Saving a new API key in Settings → Models recycles the sidecar without failing the next turn (the old child's late exit used to close the new child's reader and fail the turn with `sidecar exited ... SIGTERM`).

## Unreleased — generic per-session context dedupe

- **Host skills as an index** (`hostSkillInject: index`, default): name + description once per Jiuwen session, bodies on demand via the passthrough `skill` tool (always allowlisted / force-included under index mode); hash persisted across restarts; generic secret redaction for any forwarded skill text. If the loader is still missing, stays **index-only** and logs — never silently dumps full bodies. `body` is the explicit inline-bodies mode.
- **Passthrough allowlist**: default stays `toolAllowlist: ['*']` (all host tools); new opt-in `toolAllowlist: 'core'` restricted set, with `toolAllowlistExtra` and host-declared `passthrough: true` tools. Progressive discovery stays enabled.
- **No host-specific profiles**: the built-in host-specific persona markers and group-event names are removed. `injectSystem: persona` uses the generic dsh persona source, or the sections named in an optional user-supplied `hostProfile` object (which also lists group-change event types for `syncGroup`; none by default). Hosts that need the full orchestrator/role prompt keep `injectSystem: full`; ordinary dsh chats may use `persona`/`off`.
- **Incremental system prompt updates** (`injectSystemUpdate: diff`, **default**; `full` still available): section-level delta on change when safe (preamble/reorder/size gates → full); section hashes persisted on the mapping (no prompt text stored).
- **Host system section filter** (`hostSystemSectionsAllow` / `hostSystemSectionsDeny`): optional regex filters by markdown heading when building `[System instructions from host]`, applied before hash/diff. Empty allow + empty deny = all sections; no built-in denylist.
- **`sessionOverrides`**: per-session-id glob knobs (model / chat mode / template), empty by default.
- **`toolApproval: host` (new default)**: Jiuwen passthrough calls run through dsh's own tool pipeline (`tools.execute`: pre-execute policy, sandbox guards, approval policy, execute wrappers incl. per-tool timeout, post-execute, finalizers, `tools/result`), so approval policy `never` no longer denies calls dsh itself would run (`dsh denied write (rejected)`). `dsh` (legacy per-call gate) and `none` stay as explicit options; falls back to `dsh` without a tools runtime `execute()` / live agent.
- Plan review and SwarmFlow human turns are asked via `ctx.userQuestions` (like dsh's `exit_plan_mode`), not `ctx.approval` (which rejects everything under `never`); tool permission asks still use `ctx.approval`.
- `prepare([])` keeps admitted schemas; Jiuwen MCP `timeout_s` covers approval wait + run; passthrough calls are cancelled when the proxy connection drops.
- Native parity: `approvalTimeoutMs` and `toolCallTimeoutMs` default to 0 (no adapter-own deadline; dsh's per-tool timeout policy and the turn's abort apply); new `mcpCallTimeoutMs` transport deadline (default 1 h) advertised to the proxy, and stale Jiuwen records with another `timeout_s` are re-registered; the dsh turn signal cancels passthrough calls; admission is the session's admitted union (not only the latest request); Jiuwen permission asks about dsh passthrough tools are delegated to dsh's pipeline; permission-preset sync no longer re-allows Jiuwen builtins that `mapJiuwenFsToDsh` routes through dsh.
- **Duplicate Jiuwen built-ins under dsh tool routing** (`hideJiuwenBuiltins: deny|prompt|off`, default `deny`): Jiuwen permission asks for builtins that duplicate a passed-through dsh tool (`read_file`, `glob`, `grep`, `list_files`, `skill_tool`, `subagent_spawn`, `task_tool`, `fetch_webpage`, `free_search`/`paid_search`, goal tools, `bash`/`write_file`/`edit_file`) are decided by the adapter instead of becoming dsh approval cards that hung forever (`approvalTimeoutMs: 0`). Reads of Jiuwen's own data dir (plan-mode `.plans/*.md`) are allowed once. Other asks are declined with feedback naming `mcp_<server>_<dsh tool>`. The routing hint lists every builtin → dsh mapping.
- **Owned, reversible Jiuwen global permissions**: every adapter write (routing denies, preset mirror) is recorded in `jiuwen-permissions.json` next to the session map with its prior value. Writes are restored when routing is off or on `/jiuwen permissions release confirm`, and values the user changed are never stomped. Legacy `bash`/`write_file`/`edit_file=deny` are adopted on upgrade. `subagent_spawn`/`task_tool` are denied (owned) while dsh `subagent` is passed through.
- **Goals**: with dsh `update_goal` passed through, a dsh goal no longer arms Jiuwen's own goal. Jiuwen `submit_goal_report complete|blocked` (direct or via `tool_call`) is mirrored onto dsh `update_goal` before the turn finishes, so goal rounds no longer run to round-limit → `blocked`.
- **Turn end**: AgentServer's `processing_status {is_processing:false}` (no `payload.is_complete`) now ends the turn after `terminalFinalGraceMs`. Turns without a closing `chat.final` (e.g. after `schedule_create`) no longer hang until `requestTimeoutMs`.

## Unreleased

- Fix (interrupt on busy): a message that arrived while the resend was still waiting out the post-cancel settle made the adapter send the resend and cancel it at once; Jiuwen dropped that query unrecorded, so the earlier message was lost. The resend is now not sent; its text is carried into the next resend (one note, `N new messages`). Found by the live plain-dsh busy phase (`PLAIN_DSH_ONLY=busy`).
- Fix: `/jiuwen mcp` (and `jiuwenAdapter.mcpVerify(sessionId)`) checked the base server name `dsh-tools`, which per-session registration never creates, so it always said "not registered". It now reports the session's `dsh-tools-<sha16>` server. Live `compat-runtime --sync2` updated (per-session name; `injectSystem=full` forwards the whole host prompt by design).
- Tests: `full-runtime.test.js` with `JIUWEN_LIVE=1` + `DSH_NM` (`compat-matrix --live`) left Jiuwen's global bash/write/edit at `deny`; it now snapshots and restores Jiuwen state.
- Fix: MCP passthrough tools added or changed after Jiuwen started are now found by Jiuwen `tool_search`. The registration carries a schema revision, so Jiuwen spawns a fresh proxy instead of reusing its cached one.
- Fix: the dsh Auto preset (auto-review) now maps to Jiuwen `ask`. Before, Jiuwen stayed at the previous level, e.g. deny after read-only.
- Tests: live `/jiuwen` command pass (`test/live/commands.mjs`); plain-dsh extra-plugin phase (compaction, turn-outline, mcp-client, time-context, ralph, terminal, worktree, auto-review).
- Interrupt on busy (`onBusyMessage: 'interrupt' | 'queue'`, default `interrupt`, env `JIUWEN_ON_BUSY_MESSAGE`; `interruptSettleMs`): a user message arriving while a Jiuwen turn runs interrupts it via `chat.interrupt`, coalesces all messages that arrived meanwhile into one step, and resends with a note that the previous turn was interrupted (side effects not rolled back). Deferred while an approval card is pending; host stop wins. New trace event `turn-interrupt`.
- Memory-module plugins (agent-instructions, session-reference, session-search) verified with Jiuwen sessions.
  - Fix: read-only dsh session-query tools skip the passthrough approval gate (`toolApprovalExempt`); before, they hung Jiuwen turns until approval timed out.
- Tests:
  - Every scenario from the 2026-10-31 rounds is now automated: deep-pass, plugin-compat-matrix, reload, and scenario-catalog in `npm test`.
  - Added opt-in `npm run test:live` and `npm run test:plain-dsh`, which snapshot and restore Jiuwen exactly, including the dsh-tools MCP registration.
  - mock-gateway emulates the stand-in model; the stand-in fixture now lives in the repo.
- Plain dsh web profile fixes (see docs/plugin-compat.md):
  - Dispose/archive no longer deletes Jiuwen sessions that dsh still persists.
  - Skill sync uses the preset-scoped registry and runs on the first jiuwen turn.
  - Workdir is seeded from the first request header.
  - Payload-less `schedule/changed` is mirrored via `schedule.list`.
  - A fork turn waits for the fork remap.
  - The plan bridge is preset-scoped.
  - `{{var}}` personas are matched; the shipped default persona is skipped.
  - Fixed a double `session.delete`.

## [Unreleased]

### Added
- `injectSystem: persona` also forwards plain dsh personas: the `deployment:persona-prefix/suffix` sections (dsh-system-prompt `personaPrefix/Suffix`, dsh-persona rows), observed read-only on the public `system-prompt/assemble` waterfall. dsh boilerplate is never sent. Off with `hostSync: false` or `injectSystem` ≠ `persona`.
- `compat-runtime.mjs --sync2` (skills body, permission baseline, fork, delete idle/mid-turn, persona/group reinject, schedule→heartbeat with restore, MCP passthrough; read back from Jiuwen) and `--providers` (pi-ai + deepseek-account in the compat matrix).
- `test/fuzz-gateway.test.js`: malformed/out-of-order/duplicate frames, unicode in tool args, rapid send/cancel, slow ack, id collisions.
- **Host → Jiuwen sync** (`hostSync`, default on): forwards dsh frontend changes (skills, MCP, model, plan mode, workDir, title, session delete, goal, pause/resume, safe permission presets, fork remap, schedule→heartbeat, group persona reinject) to Jiuwen for jiuwen-provider sessions only. See `docs/host-sync.md`.
- dsh goal `resume` → Jiuwen `command.goal resume` (keeps the Jiuwen goal) when we paused it; else `set`.
- `mcpVerify()` helper and `/jiuwen mcp` line for the dsh-tools passthrough (`mcp.show`; 0.2.7 `mcp.list` omits custom servers).
- `scripts/live-deep.mjs` and `compat-runtime.mjs --sync/--reload` (live deep + real-runtime sync read-back).
- `scripts/live-drop-recovery.mjs`: live Gateway kill/restart check.
- Per-path `sync*` flags; skill body soft-inject when Jiuwen cannot install the equivalent (`syncSkillInstall`).

### Changed
- **Default change:** `hostSync` / `sessionSync` / `planBridge` default **on**. `toolPassthrough` defaults to `mcp` with allowlist `*` when `hostSync` is on (approval still `dsh`). Set `hostSync: false` or `JIUWEN_HOST_SYNC=0` for the previous opt-in-off behaviour.
- **Default change:** `injectSystem` now defaults to `persona` (was `off`) and `trajectoryDetail` to `full` (was `summary`). Set `injectSystem: off` / `trajectoryDetail: summary` (or `JIUWEN_INJECT_SYSTEM=off` / `JIUWEN_TRAJECTORY_DETAIL=summary`) to restore the old behavior. Injection remains Jiuwen-session-only and fail-soft.

### Fixed
- A malformed or non-object Gateway frame (bad JSON, `null`, a number) no longer ends the turn with an error; it is dropped and reported as a `malformed-frame` raw event. `null` frames in RPC/ack replies no longer throw in the socket listener.
- `eventDisplay: markers`: a final-only answer after tool markers is no longer dropped.
- Activity/trajectory truncation never splits a surrogate pair (emoji in tool args).
- ask_user cards no longer show Jiuwen's synthetic trailing "Other / Custom input" option (the dsh card has its own free-text row).
- `/jiuwen rename` also sets the dsh title (public `sessionTitle.rename`) so the sidebar updates; no duplicate Jiuwen rename.
- `/jiuwen fork` says plainly that only Jiuwen was forked and points to the dsh Fork action (which forks and maps both).
- Gateway drop mid-RPC / before `connection.ack` now fails at once (was: waited the full RPC timeout); WebSocket connect has a timeout (half-open Gateway no longer hangs a turn); a dropped RPC is not cached by feature detection.
- Rapid skill / permission-preset toggles are serialized (latest wins); concurrent RPCs could land out of order.
- Session delete during an active turn interrupts the turn, waits for it, then deletes the Jiuwen session (the first turn's session was orphaned).
- Plugin dispose (both Cordis `effect` and `dispose` paths) releases host-sync queues, MCP bridge and event listeners; idempotent.
- Skill sync makes no Gateway call when no jiuwen session exists.
- Card answer text no longer doubles when Jiuwen re-streams the pre-question text after an `ask_user` resume; a resumed final with no deltas is no longer dropped.


## [0.2.0] - 2026-10-30

### Added
- **Mid-stream drop recovery.** When the Gateway socket drops mid-turn, the adapter looks for the turn's answer in Jiuwen history (`history.get`). If it finds it, it emits the answer marked `[Recovered from Jiuwen history after the Gateway connection dropped]`; otherwise it keeps the clear error. Configured with `recoverOnDrop` (default `true`) and `recoverWindowMs` (default `15000`).
- **Config validation at load.** Unknown keys (with a "did you mean" suggestion), deprecated keys and values (`apiKey`, `compactionMode: jiuwen`), and wrong types produce warnings through the host logger. Validation never throws.
- `JiuwenAdapterConfig` type in `index.d.ts`, covering every accepted key.
- **Compatibility test suites**:
  - Real-host A/B probe with 21 dsh plugins (`scripts/compat-host.mjs`).
  - Full agent-runtime A/B matrix (`scripts/compat-runtime.mjs`, `scripts/compat-matrix.mjs`). It covers approvals, tools, MCP, ask-user, retry, `/goal`, goal rounds, `/plan` and `exit_plan_mode`, `/compact`, automatic compaction, subagents, bash in a sandbox, title and token meter.
  - Stress probe (`scripts/stress.mjs`).
- **CI** (GitHub Actions): unit tests on Node 22 and 24; full suite and compat matrix against dsh `0.2.1-rc.2` and `0.2.1-rc.5`.
- Marketplace metadata: `dsh.manifestVersion`, `engines.dsh`, an icon, and `market/index.json`, a ready-to-host plugin market index.
- About 60 new `/jiuwen` subcommands (rounds 4–5). See `docs/coverage.md`.

### Fixed
- In the real dsh agent loop, user messages arrive without `role`. The adapter now infers roles, so Jiuwen receives the user's text instead of the system prompt.
- The opt-in MCP bridge leaked one `process` `exit` listener per prepare/dispose cycle.
- `permissions.tools.set` replaces the user overlay, so `/jiuwen permissions set-all` now requires `confirm`.

### Changed
- `peerDependencies` narrowed to the tested range: `@deepseek-ai/cordis ^4.0.5` and `@deepseek-ai/dsh-llm >=0.2.1-rc.2 <0.3.0`. Both stay optional, so generic Cordis hosts still load the adapter.

## [0.1.0] - 2026-10-29

### Added
- Initial release: the `jiuwen` provider for `ctx.llm` (Gateway and OpenAI-compatible modes), the `/jiuwen` command, session mapping, typed `jiuwen/*` events, and opt-in plan, approval and MCP bridges.
