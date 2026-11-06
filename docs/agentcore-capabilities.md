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
- **Secrets.** Secrets are never inline. Only env var *names* (`apiKeyEnv`) reach the sidecar. Inline `*key*`/`*token*`/`*secret*` options are dropped.

## Capabilities

| Key | openjiuwen piece | dsh mapping | Notes |
|---|---|---|---|
| `skills` (`mode: all\|auto_list`, `maxSkills`, `maxTotalChars`) | `SkillUseRail` + `skill_tool` | Reads the same dsh skill bodies the adapter already syncs. `skill_tool` loads `SKILL.md` through the host `skill` tool. The host `skill` tool is hidden from the model, and the query-level skill injection is skipped | `include_tools=false`, so no extra file tools |
| `planning` (`mirror`, `progressReminder`, `interval`) | `TaskPlanningRail` (`todo_create/list/get/modify`) | The todo list is mirrored into dsh `todo_write` (dsh UI and session). The host `todo_write` is hidden, so the model sees one todo tool family | Statuses map to pending/in_progress/completed. `cancelled` is dropped |
| `memory` (`scope: global\|project\|session`, `proactive`, `coding`, `embedding`, `external`) | `MemoryRail`, `CodingMemoryRail`, `ExternalMemoryRail` | `/jiuwen memory list\|show [file]\|search <q>\|clear confirm` | Without `embedding` it runs in FTS5 keyword mode, shown as `vector: false` in `/jiuwen capabilities`. `external.provider`: mem0, openviking, lakebase, agentarts, jiuwen, openjiuwen (needs that service) |
| `subagents` (`agents`, `async`, `taskLoop`, `maxIterations`) | `task_tool` + `SubAgentConfig` | Children get the **same host tools** (so `ctx.tools.execute`), plus their own gate rail. The host `subagent` tool is hidden | Never mounts the built-in general-purpose agent with local IO tools. `AGENTCORE_TASK_LOOP=1` still works |
| `interrupts` (`confirmTools: [..]`, `askUser`) | `ConfirmInterruptRail`, `AskUserRail` | dsh approval and question cards, resumed in the same turn | `askUser` hides dsh `ask_user` (name clash) |
| `sysOperation` (`readOnly` default true, `code`) | `SysOperationRail` | Every call is dsh-gated. `restrict_to_work_dir` is applied | Prefer dsh's own file and bash tools |
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
