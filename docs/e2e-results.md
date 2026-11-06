# Acceptance record — 2026-11-06 (Asia/Shanghai)

Local Linux acceptance with real dsh `0.2.1-rc.5`, Python 3.13 and pinned
openjiuwen `0.1.20.post1`. The two live runs were serial, with Gateway down and
fallback disabled. These are recorded results, not a claim about future CI runs.

| Gate | Result |
|---|---|
| `npm test` with real dsh packages | 479/479, no skips |
| Sidecar pytest | 83/83; coverage 92.36% |
| Offline E2E | 67/67 |
| Agent-core Node suite | 40/40 |
| Plugin compatibility | 60/60 |
| Compatibility matrix | 154/154 (22 rows × 7 variants) |
| Node coverage | lines 96.82%, branches 76.00%, functions 85.07% |
| Live E2E run 1 / run 2 | 49/49 / 49/49 |
| Nightly command regression (agent-core + scripted model) | 39/39 |
| Syntax checks | 151 files |

## Live checks

| Check | Run 1 | Run 2 |
|---|---|---|
| `gateway-down` | PASS | PASS |
| `plain-chat` | PASS | PASS |
| `streaming-deltas` | PASS | PASS |
| `multi-turn-recall` | PASS | PASS |
| `capabilities-command` | PASS | PASS |
| `bash` | PASS | PASS |
| `read` | PASS | PASS |
| `write` | PASS | PASS |
| `edit` | PASS | PASS |
| `grep` | PASS | PASS |
| `parallel-sessions` | PASS | PASS |
| `permission-deny` | PASS | PASS |
| `plan-mode-service` | PASS | PASS |
| `plan-mode-turn` | PASS | PASS |
| `compact-command` | PASS | PASS |
| `compact-continue` | PASS | PASS |
| `skills` | PASS | PASS |
| `planning` | PASS | PASS |
| `memory-cross-session` | PASS | PASS |
| `memory-list-command` | PASS | PASS |
| `memory-search-command` | PASS | PASS |
| `rag` | PASS | PASS |
| `sysOperation-deny` | PASS | PASS |
| `subagents` | PASS | PASS |
| `cancel` | PASS | PASS |
| `after-cancel` | PASS | PASS |
| `archive-unarchive` | PASS | PASS |
| `delete-requires-confirm` | PASS | PASS |
| `delete-confirm` | PASS | PASS |
| `no-cwd-junk` | PASS | PASS |
| `trace-tool-bash` | PASS | PASS |
| `trace-tool-read` | PASS | PASS |
| `trace-tool-write` | PASS | PASS |
| `trace-tool-edit` | PASS | PASS |
| `trace-tool-grep` | PASS | PASS |
| `trace-tool-skill` | PASS | PASS |
| `trace-tool-todo_create` | PASS | PASS |
| `trace-tool-todo_modify` | PASS | PASS |
| `trace-tool-todo_write` | PASS | PASS |
| `trace-tool-write_memory` | PASS | PASS |
| `trace-tool-memory_search` | PASS | PASS |
| `trace-tool-knowledge_search` | PASS | PASS |
| `trace-tool-task_tool` | PASS | PASS |
| `trace-tool-read_file` | PASS | PASS |
| `native-permission-request` | PASS | PASS |
| `gateway-remained-down` | PASS | PASS |
| `process-restart-seed` | PASS | PASS |
| `process-restart-resume` | PASS | PASS |
| `jiuwen-restored` | PASS | PASS |

## Scope and reproducibility

See [E2E instructions](./e2e.md) for isolation, snapshot restoration, exact
assertions and external-service limits. Each run verified the 4,903-file Jiuwen
snapshot, restored identical checksums/file sets/modes, returned Gateway :19000
to service, and left :3335 unchanged. The main worktree remained at `13f760c`.

Memory uses an exact canonical keyword, not unconfigured semantic embeddings.
Native IO denial uses a native-only fixture whose host fallbacks are separately
denied: permitted host reads must not be confused with a native approval bypass.
Exploratory runs exposed both harness assumptions; the recorded runs use the
corrected fixtures, without automatic model retries.

One exploratory offline run under overlapping test processes hit the native todo
mirror assertion. The official offline lane is serial; three repeat runs and the
final run passed 67/67. Failure diagnostics remain enabled. This is not evidence
for untested external services or a claim that timing-sensitive suites should run
concurrently on one box.

The targeted nightly command suite verified archive/unarchive, confirm-required
delete and forked checkpoint history on the real sidecar with a local scripted
model. The Gateway-only transient-busy retry is bounded but was not induced in
that run; the entire legacy nightly guard was not rerun.
