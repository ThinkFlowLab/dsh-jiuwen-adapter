# Quickstart (Mac / Linux)

## 1. Install

Use Node ≥22, Python 3.13 and dsh `>=0.2.1-rc.2 <0.3.0`. `uv` is recommended;
otherwise `scripts/setup-sidecar` uses Python's venv/pip. No Gateway is required.

```bash
npm install -g @deepseek-ai/dsh@next
git clone https://github.com/ThinkFlowLab/dsh-jiuwen-adapter.git
cd dsh-jiuwen-adapter
npm run sidecar:setup
# Installs pinned openjiuwen 0.1.20.post1 into .venv-sidecar.
dsh plugin --profile web add "$PWD"
dsh plugin --profile headless add "$PWD"
```

Keep this checkout and its virtualenv together. For an installed package, run
`scripts/setup-sidecar` from that package directory; alternatively configure
`agentcorePython` / `AGENTCORE_PYTHON` with an existing compatible environment.

## 2. Configure a model

Set `API_KEY` securely in the launching environment. Do not put secrets in YAML,
source control, shell command arguments, or diagnostic output.

```bash
export AGENTCORE_API_BASE=https://api.example.com/v1
export AGENTCORE_MODEL=your-model
# Optional dialect, e.g. deepseek / openai_compatible:
export AGENTCORE_ENDPOINT_PROFILE=openai_compatible
```

An existing `~/.jiuwenswarm/config/.env` is also supported (`API_BASE`, `API_KEY`,
`MODEL_NAME`, `MODEL_PROVIDER`, `ENDPOINT_PROFILE`); installing JiuwenSwarm is not
necessary. See [configuration](./configuration.md) for precedence.

Append to each profile's **existing** `~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- id: llm-jiuwen
  config:
    backend: agent-core
    gatewayFallback: false
- id: agent-default-model
  config: { provider: jiuwen, model: jiuwen-default }
```

## 3. Chat

```bash
dsh --profile headless --json "Say hello and end with QUICKSTART_OK"
dsh --profile web
```

In the web UI use `/jiuwen status`, `/jiuwen capabilities`, `/jiuwen help`.
Headless tasks are plain prompts; slash-command text there is not dispatched.

Optional skills, planning, memory, subagents and rails are **off by default**.
Enable only what you need: [native capabilities](./agentcore-capabilities.md).

## 4. Verify

```bash
npm test
npm run test:sidecar
npm run test:e2e:offline
DSH_BIN=/path/to/dsh npm run test:e2e:live
```

The live suite needs model credentials, Linux `ss`, Python, and Gateway :19000 down.
It uses isolated dsh profiles and restores a checksum-verified Jiuwen snapshot.
See [E2E instructions](./e2e.md) before testing on a shared box.

## Optional legacy Gateway backend

Install and start your JiuwenSwarm Gateway/AgentServer separately, then set:

```yaml
- id: llm-jiuwen
  config:
    backend: gateway
    gatewayURL: ws://127.0.0.1:19000/ws
```

Gateway is needed for team/workflow execution and marketplace operations, not normal
agent-core chat. Existing Gateway history stays there; switching to agent-core does
not import it. [Migration and capability boundaries](./agent-core.md).
