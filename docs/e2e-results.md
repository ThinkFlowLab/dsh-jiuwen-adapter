# Acceptance record — 2026-11-06 deep pass (Asia/Shanghai)

Local Linux deep acceptance after PR #6 docs/e2e work. Real dsh `0.2.1-rc.5`,
Python 3.13, openjiuwen `0.1.20.post1`. Live runs used Gateway down +
`gatewayFallback: false`. Recorded results only — not a future CI guarantee.

| Gate | Result |
|---|---|
| `npm test` (×2 clean) | 479/479 |
| Sidecar pytest | 84/84; coverage ≈92% |
| Offline E2E | 67/67 |
| Plugin compatibility | 60/60 |
| Compatibility matrix | 154/154 (22 × 7; `DSH_NM` → dsh-rc5 node_modules) |
| Live E2E (extended) run A / run B | 54/54 / 54/54 |
| Stress deep (full) | 23 PASS / 2 DEGRADED / 1 FAIL → after fixes: memload+RSS retests PASS |
| Nightly `guard:live` | see guard log below |

## Live E2E additions (beyond prior 49)

| Check | Run A | Run B |
|---|---|---|
| `memory-clear-requires-confirm` | PASS | PASS |
| `memory-clear-confirm` | PASS | PASS |
| `skill-missing` | PASS | PASS |
| `deny-then-allow` | PASS | PASS |
| `capabilities-under-load` | PASS | PASS |

Prior 49 checks remained PASS on both clean runs (chat, tools, parallel sessions,
permission deny, plan mode, compact, skills, planning, memory cross-session,
RAG, sysOperation deny, subagents, cancel, archive/unarchive, delete confirm,
traces, process restart, Jiuwen restore).

## Stress deep highlights

| Check | Result | Notes |
|---|---|---|
| `concurrent-12-plain` | PASS | 12/12 |
| `interleaved-tool-sessions` | PASS | 4 sessions × 2 tool rounds |
| `cancel-under-load` | PASS | 3/3 cancelled, 3/3 survivors |
| `rapid-cancel-resume-x4` | PASS | 4/4 |
| `stream-abort-mid-tool` | PASS | timeout mid bash |
| `long-25-turns` | PASS | avg ≈6.1–6.3 s |
| `rss-25-turns` | PASS | first≈273MB last≈275MB delta≈+2.0MB / 25 turns (long-lived sidecar) |
| `edge-memory-keyword-fallback` | PASS | no embedding → keyword |
| `edge-sysop-readonly-write` | DEGRADED | model used host write; native gate covered by e2e `sysOperation-deny` |
| `fail-sidecar-crash-next` | PASS | recover after kill |
| `fail-nullish-edit-args` | PASS | stripNullish path |
| `fail-deny-then-allow` | PASS | |
| `memory-still-after-load` | PASS | after keyword-file search fix |
| `plugin-compat-60` | PASS | |

## Bugs fixed this pass

1. **Keyword `memory_search` missed sibling-process writes** — multi-process dsh
   clients sharing global memory left FTS empty while `.md` files existed. Adapter
   now replaces native `memory_search` with file grep in keyword mode
   (`search: keyword-file`). Regression: `test_keyword_memory_search_reads_sibling_files`.
2. **Flaky unit `session.fork` assertion** — test called fork twice inside
   `deepEqual`; fixed to a single call.
3. **E2E `memory-clear-confirm` false FAIL** — "no hits for TEAL_42" still matched
   the query token; assertion now checks list emptiness / no-hits phrasing.
4. **Stress RSS sampling** — CLI child sidecars exit between turns; sample via
   long-lived `AgentCoreTransport` instead.
5. **Post-gateway snapshot** — stress harness restores `JW_SNAP` after Gateway
   restart (startup rewrites config.yaml).

## Scope and restore

`scripts/jiuwen-snap.sh` snapshot (4903 files) verified identical after each live
suite; Gateway :19000 restored; :3335 untouched; main worktree stayed at
`13f760c`. Branch tip updates PR #6 on `refactor/agent-core`.

## Out of scope / remaining

- Vector/external memory, remote MCP, OTEL exporters, MoA — need those services.
- `edge-sysop-readonly-write` in CLI stress remains DEGRADED when the model uses
  host `write` instead of native `write_file` (host path is correct under dsh
  policy; native gate is covered by live e2e).
- One live E2E attempt aborted mid-driver at plan-mode (model/timeout flake);
  two subsequent full runs were 54/54.
