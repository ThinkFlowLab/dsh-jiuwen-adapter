# Native agent-core capabilities (`agentcore`)

With `backend: agent-core`, the sidecar can switch on openjiuwen `0.1.20.post1` capabilities
beyond the plain ReAct loop. **Everything is off by default.** Turn capabilities on one at a time
under the `agentcore` plugin key. You can also use env `AGENTCORE_FEATURES='<json>'`, which wins
key by key.

```yaml
- id: llm-jiuwen
  config:
    backend: agent-core
    agentcore:
      skills: true            # SkillUseRail over dsh skills
      planning: true          # TaskPlanningRail, mirrored into dsh todo_write
      memory: { scope: global, coding: false, embedding: { model: text-embedding-3-small, apiBase: https://…/v1, apiKeyEnv: EMB_KEY } }
      subagents: { agents: [{ name: reviewer, description: Reviews diffs }] }
      rag: { paths: [/abs/docs] }
```

dsh stays the source of truth, and no capability bypasses dsh's permissions:

- **Host tools** still run only through `ctx.tools.execute`.
- **Native tools** that are not purely internal (`read_file`/`bash` from `sysOperation`, native MCP tools and the like) are checked by a sidecar gate rail first. The rail asks dsh through `host.request {kind: permission}` and the dsh approval card. A missing answer, a timeout or an error counts as a **deny**.
- **Interrupt rails** (`confirmTools`, `askUser`) are answered through dsh's approval and question cards.
- **Data location.** Agent workspaces live under `<checkpointDir>/ws/<session>`, not the project directory. Memory and RAG indexes live under `<checkpointDir>/{memory,coding_memory,rag}`. Set `AGENTCORE_WORKSPACE_MODE=cwd` to get the old cwd workspace back.
- **Secrets.** Embedding, MoA and external-memory credentials use env var *names* (`apiKeyEnv`), not inline keys. Secret-like external-memory option keys are dropped. Native MCP server settings are passed through; never embed credentials in their arguments, headers or env maps.

## Capabilities

| Key | openjiuwen piece | dsh mapping | Notes |
|---|---|---|---|
| `skills` (`mode: all\|auto_list`, `maxSkills`, `maxTotalChars`) | `SkillUseRail` + `skill_tool` | Reads the same dsh skill bodies the adapter already syncs. `skill_tool` loads `SKILL.md` through the host `skill` tool. The host `skill` tool is hidden from the model, and the query-level skill injection is skipped | `include_tools=false`, so no extra file tools |
| `planning` (`mirror`, `progressReminder`, `interval`) | `TaskPlanningRail` (`todo_create/list/get/modify`) | The todo list is mirrored into dsh `todo_write` (dsh UI and session). The host `todo_write` is hidden, so the model sees one todo tool family | Statuses map to pending/in_progress/completed. `cancelled` is dropped |
| `memory` (`scope: global\|project\|session`, `proactive`, `coding`, `embedding`, `external`) | `MemoryRail`, `CodingMemoryRail`, `ExternalMemoryRail` | `/jiuwen memory list\|show [file]\|search <q>\|clear confirm` | Without `embedding` it runs in keyword mode (`vector: false`). The adapter replaces native `memory_search` with file grep (`search: keyword-file`) so multi-process writers to the shared global store stay searchable. `external.provider`: mem0, openviking, lakebase, agentarts, jiuwen, openjiuwen (needs that service) |
| `subagents` (`agents`, `async`, `taskLoop`, `maxIterations`) | `task_tool` + `SubAgentConfig` | Children get the **same host tools** (so `ctx.tools.execute`), plus their own gate rail. The host `subagent` tool is hidden | Never mounts the built-in general-purpose agent with local IO tools. `AGENTCORE_TASK_LOOP=1` still works |
| `interrupts` (`confirmTools: [..]`, `askUser`) | `ConfirmInterruptRail`, `AskUserRail` | dsh approval and question cards, resumed in the same turn | `askUser` hides dsh `ask_user` (name clash) |
| `sysOperation` (`readOnly` default true, `code`) | `SysOperationRail` | Every call is dsh-gated. `restrict_to_work_dir` is applied | Host callbacks win name collisions (including `bash`, `grep`, `glob`); native tools never shadow them. Prefer dsh's own file and bash tools |
| `mcp` (`servers`, `resources`) | `create_deep_agent(mcps=…)`, `McpRail` | dsh-gated | dsh MCP tools already reach the agent as host tools. Use this only for servers dsh does not run |
| `rag` (`paths`, `maxFiles`, `maxBytes`) | lite memory index (FTS5, plus vectors with `memory.embedding`) | `knowledge_search` tool. It reads only the adapter's own index | `.md .markdown .txt .rst` files |
| `security`, `anomaly` | security rail, model anomaly rail | — | |
| `heartbeat` | `HeartbeatRail` | runs when a request sets `providerOptions.jiuwen.runKind: heartbeat` | `cron`/`goal` run kinds pass through too |
| `progressiveTools` (`limit`) | progressive tool exposure | — | |
| `kvCache` | `KVCacheAffinityConfig` | — | Only helps on providers with KV-cache affinity |
| `moa` (`referenceModels`, `mode`) | Mixture-of-Agents | reference models use the turn's provider and base URL unless set | `verifier_routed` needs a scorer, so it is reported and skipped |
| `otel` (`exporter`, `endpoint`, `tracesDir`, `serviceName`) | `acquire_observability` | file traces default to `<checkpointDir>/traces` | Install the exporter extra: `AGENTCORE_SIDECAR_OTEL=1 scripts/setup-sidecar`. Without it, OTEL is reported as disabled |

Use `/jiuwen capabilities` to see the configured features, the live rails and tools, and which native tools asked dsh for permission.

## Not wired, and why

| openjiuwen area | Why it is not exposed |
|---|---|
| `agent_teams` / `core/multi_agent` team runtime | Needs its own member processes, messaging and team store. dsh ships its own agent-team plugin and the adapter keeps the Gateway team surfaces. Running two team runtimes would double-own sessions |
| `core/workflow` / graph | 0.1.20.post1 has no declarative loader. Workflows are Python programs, so exposing them means running arbitrary code from config |
| Retrieval `SimpleKnowledgeBase` | Needs a vector store (chromadb is not installed) and embeddings. `rag` uses the lite index instead |
| LSP rail, evolving / RSI / auto-harness | Offline or IDE-specific, with no dsh surface |

## Nested option reference

Boolean-capable entries accept `true`, `false`, or `{ enabled: true, ... }`.
`security`, `anomaly`, `heartbeat`, and `kvCache` are booleans. In addition to the
options in the table above:

- `memory.embedding`: `model`, `apiBase`, `apiKeyEnv` (variable name only).
- `memory.external`: `provider`, `apiKeyEnv`, `userId`, `scopeId`, `options`.
  Secret-like option keys are removed; the external provider must be installed and reachable.
- `subagents.agents[]`: `name`, `description`, `systemPrompt`, `maxIterations`.
- `mcp.servers[]`: native openjiuwen MCP server configuration; configure only
  trusted servers. Their tool calls are still gated by dsh.
- `moa.referenceModels[]`: model-name strings or objects with `model`, `apiBase`,
  `apiKeyEnv`, `provider`. `mode` selects the native routing mode.
- `otel`: `exporter`, `endpoint`, `tracesDir`, `serviceName`. Trace files may
  contain model/tool content; keep them private.

## Defaults while enabled

- Skills: `mode: all`; limits are optional (native defaults apply).
- Planning: `mirror: true`, `progressReminder: false`, `interval: 20`.
- Memory: `scope: global`, `proactive: true`, `coding: false`; embedding and
  external providers are absent until configured.
- Subagents: one `general-purpose` agent if `agents` is omitted; `async: false`,
  `taskLoop: false`; `maxIterations` is optional. `AGENTCORE_TASK_LOOP=1` is the
  legacy explicit opt-in for subagents/task-loop.
- Interrupts: `confirmTools: []`, `askUser: false`; a bare `true` has no effect
  without at least one of those settings.
- Sys operation: `readOnly: true`, `code: false`. **Read-only is tool selection,
  not a shell sandbox:** native bash remains available and requires approval if
  dsh has no host bash. Restriction to workDir does not replace dsh policy.
- MCP: `servers: []`, `resources: false`; no connection without servers.
- Progressive tools: `limit: 5` (clamped to 1–20).
- RAG: `paths: []`, `maxFiles: 500`, `maxBytes: 2000000`; inactive without paths.
- MoA: `referenceModels: []`, `mode: aggregator_on_demand`; inactive without refs.
- OTEL: `exporter: file`, `serviceName: dsh-jiuwen-agent-core`, default traces
  under the checkpoint directory; endpoint and tracesDir are optional.

## Verification boundaries

The committed [live E2E suite](./e2e.md) checks skills, todo mirroring, persistent
keyword memory across independent sessions, subagent host tools, RAG and denied
native IO with the Gateway down. Offline integration tests use the real Python
sidecar and a scripted model. Unit-tested configuration is not evidence that an
external service works: vector embeddings, external memory, remote MCP, OTLP and
provider-specific KV affinity require their own configured services. Team runtime,
workflow execution and the other items under “Not wired” remain unavailable here.
