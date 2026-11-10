# Quickstart (Mac / Linux)

You need Node ≥22, Python 3.13, and dsh `>=0.2.1-rc.2 <0.3.0`. No Gateway required.

```bash
npm install -g @deepseek-ai/dsh@next
git clone https://github.com/ThinkFlowLab/dsh-jiuwen-adapter.git
cd dsh-jiuwen-adapter
npm run sidecar:setup
dsh plugin --profile web add "$PWD"

export AGENTCORE_API_BASE=https://api.example.com/v1
export AGENTCORE_MODEL=your-model
# Set API_KEY in the environment; never put it in YAML or the repo.

# Append — do not replace other plugins in this file
printf -- '- id: agent-default-model\n  config:\n    provider: jiuwen\n    model: jiuwen-default\n' >> ~/.dsh/profiles/web/cordis.patch.yml
dsh --profile web
```

`npm run sidecar:setup` installs pinned openjiuwen into `.venv-sidecar`. Keep this checkout and that virtualenv together, or point `AGENTCORE_PYTHON` at another compatible environment.

An existing `~/.jiuwenswarm/config/.env` also works (`API_BASE`, `API_KEY`, `MODEL_NAME`). See [configuration](./configuration.md) for precedence.

Headless: `dsh plugin --profile headless add "$PWD"`, then `dsh --profile headless --json "Say hello and end with QUICKSTART_OK"`. That text is a prompt, not a slash-command runner. In the web UI, try `/jiuwen status` and `/jiuwen help`.

Optional skills, planning, memory and rails are off by default. Enable only what you need: [native capabilities](./agentcore-capabilities.md).

## Tests

```bash
npm test
npm run test:sidecar
npm run test:e2e:offline
```

Live tests need model credentials and a few box-safety steps: [E2E](./e2e.md).

## Optional Gateway path

Start JiuwenSwarm separately, then set:

```yaml
- id: llm-jiuwen
  config:
    backend: gateway
    gatewayURL: ws://127.0.0.1:19000/ws
```

This path is for team/workflow execution, marketplace operations, or existing Gateway history. Switching to agent-core does not import that history. [Migration](./agent-core.md).
