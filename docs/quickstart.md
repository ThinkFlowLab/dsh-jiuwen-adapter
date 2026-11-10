# Quickstart (Mac / Linux)

You need Node ≥22, Python 3.13, and dsh `>=0.2.1-rc.2 <0.3.0`. No Gateway required.

```bash
npm install -g @deepseek-ai/dsh@next
git clone https://github.com/ThinkFlowLab/dsh-jiuwen-adapter.git
cd dsh-jiuwen-adapter
npm run sidecar:setup
dsh plugin --profile web add "$PWD"
dsh --profile web
```

`npm run sidecar:setup` installs pinned openjiuwen into `.venv-sidecar`. Keep this checkout and that virtualenv together, or point `AGENTCORE_PYTHON` at another compatible environment.

## Configure the model in the dsh UI

1. Open **Settings → Models**.
2. Find **JiuwenSwarm** and enter the API key, the OpenAI-compatible endpoint (for example `https://api.example.com/v1`), and the model ids you want in the picker. The id is what agent-core sends to the endpoint; if you keep a catalog alias such as `jiuwen-default`, fill in its API name too.
3. In the composer, pick that Jiuwen model, or set it as the default. New turns use the selection; a turn already in flight keeps the model it started with.

The key is stored write-only by dsh credentials — not in `cordis.patch.yml`. Switching the model or endpoint in the UI takes effect on the next turn.

## Optional fallbacks (headless, or no Models page)

Headless: `dsh plugin --profile headless add "$PWD"`, then `dsh --profile headless --json "Say hello and end with QUICKSTART_OK"`. That text is a prompt, not a slash-command runner.

Without the web Models page, you can still set the endpoint, key and model via `AGENTCORE_API_BASE`, `JIUWEN_API_KEY` / `API_KEY`, and `AGENTCORE_MODEL`, or an existing `~/.jiuwenswarm/config/.env` (`API_BASE`, `API_KEY`, `MODEL_NAME`). These are fallbacks: a value saved in **Settings → Models** wins over env for the endpoint and for a concrete UI-selected model. See [configuration](./configuration.md).

In the web UI, try `/jiuwen status` and `/jiuwen help`.

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
