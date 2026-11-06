# Agent-core end-to-end acceptance

## Two lanes

```bash
npm run sidecar:setup
npm run test:e2e:offline
npm run test:e2e                   # SKIP without explicit live opt-in
DSH_BIN=/path/to/dsh npm run test:e2e:live
```

**Offline (CI):** real Python sidecar with a scripted model, tool callbacks,
fork/history/cancel and capability configuration; in-process plugin compatibility
in both load orders. No key, external endpoint, Gateway or browser needed. This
is integration coverage, not a real-dsh/full-model substitute. CI runs it after
installing the pinned Python environment.

**Live:** actual dsh process and isolated profile → adapter → actual Python
DeepAgent → configured model → dsh tools. Model calls cost tokens. Requires Linux
`ss`, Python, a configured model key, and dsh. `DSH_BIN` overrides discovery from
PATH; `DSH_NM` is used by the separate compatibility matrix, not by the live CLI.
Missing opt-in, binary, sidecar or key produces `SKIP` with exit 0. Once started,
failed assertions/timeouts exit nonzero; there is no degraded-as-pass status or
silent model retry.

## Isolation and restoration

- Gateway :19000 must be **down**; the adapter also targets an unreachable URL and
  sets `gatewayFallback: false`. The suite never calls Gateway RPC.
- On a dedicated test box, `E2E_MANAGE_GATEWAY=1` permits stopping just the
  identified `jiuwenswarm-gateway` listener and restarting its original command.
  Do not use this with active clients or a separately credentialed process environment.
- Before live work, `scripts/jiuwen-snap.sh` snapshots Jiuwen `config`, `runtime`
  and the MCP state file into a private directory. `finally`/signal handlers
  restore the exact file set, modes and SHA-256 checksums, including after Gateway
  startup (which can rewrite config). Snapshot contents are never printed.
- dsh HOME, profile, checkpoint DB, sandbox, skills and RAG docs are disposable.
  No real project file is written or deleted. Permission denial targets a sandbox
  fixture, never a system file. :3335's listener must remain unchanged.
- Failed runs retain **private** diagnostics and the snapshot path. Successful
  runs remove temporary data. Do not publish retained artifacts: they can include
  model/tool content. Never commit a real Jiuwen `.env` or runtime database.
- Default test web port: 3489 (`E2E_PORT` to override). Run suites serially on a
  shared box. `E2E_REPORT` selects the JSON result path (default `reports/e2e-live.json`).

## Assertions

- Plain chat, actual `llm/stream` text deltas, multi-turn recall.
- Process restart + headless `--session-id` recall using a random, unprompted code.
- Bash/read/write/edit/grep tool calls; file contents verified on disk.
- Two independent sessions running tool tasks concurrently, with no cross-session
  output or duplicate host callbacks.
- A real host IO call is denied under the dsh read-only preset/policy `never`,
  with an actual tool denial result and unchanged fixture bytes (not model narration).
  A test-owned pre-execute policy also requires approval for direct fixture writes.
- Real dsh plan-mode service and turn; compaction followed by continued chat.
- Native skills load through dsh; native todo creation/modification mirrors to
  dsh `todo_write`.
- Long-term keyword memory across separate sessions (proactive injection disabled;
  exact canonical key, value absent from the recall prompt), plus memory list/search
  commands. This does not claim semantic retrieval without embeddings.
- RAG returns a fixture's indexed token through `knowledge_search`.
- Native `read_file` requests dsh permission and cannot reveal the private fixture
  under the unattended deny policy. Host fallbacks for this native-only fixture
  are separately forbidden by test policy. Subagent calls `task_tool` and uses dsh bash.
- Cancellation waits for a real tool call, cancels via `Agent.cancel`, then checks
  a subsequent turn; no timing-only “cancel succeeded” claim.
- `/jiuwen capabilities`, memory clear refusal without `confirm` and confirmed clear,
  missing-skill soft-fail, deny-then-allow under read-only then workspace-write,
  capabilities under concurrent sessions, archive/unarchive, delete refusal without
  `confirm`, and confirmed deletion. Headless slash text is never mistaken for command execution.
- No `AGENT.md`, memory, coding-memory or RAG junk in the project cwd.
- Trace evidence for each tool family; Gateway remains down; exact Jiuwen restore.

External/vector memory, remote MCP, security/anomaly rails, heartbeat, MoA, OTLP
and provider KV affinity are not full live acceptance claims without their
services. See [capability boundaries](./agentcore-capabilities.md).

The dated [acceptance record](./e2e-results.md) lists both live runs and all checks.

## Other quality gates

```bash
npm test
npm run test:sidecar
node --test test/plugin-compat-matrix.test.js
DSH_NM=/path/to/dsh/node_modules npm run compat
npm run lint
```

The legacy nightly `/jiuwen` command test retries **only** the Gateway's transient
`resource operation is already running` response after archive (at most 3 seconds).
It verifies unarchive by listing sessions. Delete is tested twice: refusal without
`confirm`, then actual deletion and local mapping removal. Other errors are not retried. Fork IDs are parsed from the returned `new session_id`
field, not restricted to legacy Gateway ID prefixes; cloned history is read back.
An agent-core raw fork has a checkpoint but no dsh mapping, so it need not appear
in the mapped-session list. Use dsh Fork to create both a chat and its checkpoint.

## Regressions found by this suite

- Native `SysOperationRail` used to shadow dsh `bash`/`grep`/`glob` callbacks.
  Host LocalFunctions now win, preserving dsh policy and execution.
- One shared sidecar's concurrent stream listeners used to consume foreign-session
  events, duplicating tools and mixing replies. Events are now routed by session id;
  a deterministic interleaving regression checks text, tools and approvals.
- Agent-core archive/unarchive returned a shape the command renderer treated as
  failure. The facade now returns the Gateway-compatible per-item success fields.
- Plugin disposal did not stop its Python child, keeping headless dsh alive after
  the final result. Disposal now shuts down the existing sidecar without starting one.
- Host callbacks re-enter dsh's exact live agent initiator context, matching the
  existing Gateway/MCP path and preserving goal/policy plugin semantics.

The live runner disables HMR so editing a checkout cannot reload a test driver
mid-case. Headless restart tests seed and resume **headless** sessions; web's
`standard` agent preset cannot be adopted by headless and is never rewritten.
