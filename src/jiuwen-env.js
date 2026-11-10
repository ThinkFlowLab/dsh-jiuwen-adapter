/**
 * Load the real Jiuwen install's config/.env even when dsh sets HOME to a temp
 * dir. Never log values (keys / tokens).
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

/** Passwd home for the current user — ignores ephemeral HOME= overrides. */
export function realHomedir() {
  if (process.env.JIUWEN_REAL_HOME) return process.env.JIUWEN_REAL_HOME
  try {
    const user = process.env.USER || process.env.LOGNAME || 'box'
    const line = execFileSync('getent', ['passwd', user], { encoding: 'utf8' }).trim()
    const home = line.split(':')[5]
    if (home) return home
  } catch { /* fall through */ }
  // Last resort: only trust HOME when it does not look like a temp probe.
  const home = process.env.HOME || ''
  if (home && !/\/tmp\/|plain-dsh-|dsh-both-|dsh-ac-|dsh-bare/.test(home)) return home
  return '/home/box'
}

export function jiuwenHome() {
  return process.env.JIUWEN_HOME || join(realHomedir(), '.jiuwenswarm')
}

/** @returns {Record<string, string>} */
export function loadJiuwenDotEnv() {
  const file = join(jiuwenHome(), 'config/.env')
  const out = {}
  if (!existsSync(file)) return out
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
      if (!m) continue
      let v = m[2]
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      out[m[1]] = v
    }
  } catch { /* ignore */ }
  return out
}

function first(...vals) {
  for (const v of vals) {
    if (v != null && String(v).trim() !== '') return String(v)
  }
  return undefined
}

/** Env vars to inject into the agent-core sidecar (never logged). */
export function agentcoreChildEnv(extra = {}) {
  const jw = loadJiuwenDotEnv()
  const env = {}
  const apiKey = first(process.env.JIUWEN_API_KEY, process.env.API_KEY, jw.API_KEY, jw.JIUWEN_API_KEY)
  const apiBase = first(process.env.AGENTCORE_API_BASE, process.env.API_BASE, jw.API_BASE)
  const model = first(process.env.AGENTCORE_MODEL, process.env.MODEL_NAME, jw.MODEL_NAME)
  const provider = first(process.env.AGENTCORE_MODEL_PROVIDER, process.env.MODEL_PROVIDER, jw.MODEL_PROVIDER)
  if (apiKey) {
    env.JIUWEN_API_KEY = apiKey
    env.API_KEY = apiKey
  }
  if (apiBase) {
    env.API_BASE = apiBase
    env.AGENTCORE_API_BASE = apiBase
  }
  if (model) env.MODEL_NAME = model
  if (provider) env.MODEL_PROVIDER = provider
  env.JIUWEN_HOME = jiuwenHome()
  // Host-resolved extras (dsh credentials from Settings → Models) win over env / dotenv.
  return { ...env, ...extra }
}

/**
 * Build the sidecar `model` object for a turn.
 * Prefers process env → jiuwen .env → cfg; skips the openai-compat placeholder baseURL.
 */
export function resolveAgentCoreModel(cfg = {}, options = {}, overrides = {}) {
  const jw = loadJiuwenDotEnv()
  const placeholder = /127\.0\.0\.1:18080|127\.0\.0\.1:9\b/
  const cfgBase = cfg.baseURL && !placeholder.test(String(cfg.baseURL)) ? cfg.baseURL : undefined
  // A baseURL the user saved in dsh Settings → Models (plugin config) wins
  // over env / Jiuwen dotenv. Env remains the fallback when the UI field is empty
  // or still the openai-compat placeholder.
  const apiBase = first(
    cfgBase,
    process.env.AGENTCORE_API_BASE,
    process.env.API_BASE,
    jw.API_BASE,
  ) || 'http://127.0.0.1:9/v1'
  // dsh / cordis often pass catalog aliases like "jiuwen-default".
  const aliasIds = new Set(['jiuwen-default', 'jiuwen-swarm', 'jiuwen', 'default'])
  const isAlias = (name) => name && aliasIds.has(String(name).toLowerCase())
  const catalog = (cfg.models || []).find(m => m && (m.id === overrides.modelName || m.id === options.model || m.id === cfg.defaultModel))
  const catalogName = catalog?.modelName
  const requested = first(overrides.modelName, options.model, cfg.defaultModel)
  // A concrete UI / request / catalog selection wins over AGENTCORE_MODEL and
  // Jiuwen dotenv. Aliases without a catalog modelName still fall back to env.
  let modelName
  if (!isAlias(requested)) {
    modelName = first(overrides.modelName, options.model, catalogName, cfg.defaultModel, process.env.AGENTCORE_MODEL, process.env.MODEL_NAME, jw.MODEL_NAME)
  } else {
    modelName = first(catalogName, process.env.AGENTCORE_MODEL, process.env.MODEL_NAME, jw.MODEL_NAME, requested)
  }
  modelName = modelName || 'jiuwen-default'
  const provider = process.env.AGENTCORE_FAKE_MODEL === '1'
    ? 'fake'
    : first(overrides.modelProvider, jw.MODEL_PROVIDER, 'OpenAI')
  const endpointProfile = first(
    overrides.endpointProfile,
    process.env.AGENTCORE_ENDPOINT_PROFILE,
    process.env.ENDPOINT_PROFILE,
    jw.ENDPOINT_PROFILE,
    cfg.endpointProfile,
  )
  // Match JiuwenSwarm default for chat turns: keep thinking off unless the host
  // asks to forward reasoning (or AGENTCORE_REASONING explicitly enables it).
  // Volcengine seed maps mode=disabled → reasoning_effort=minimal.
  const reasoningMode = first(
    overrides.reasoningMode,
    process.env.AGENTCORE_REASONING,
    (cfg.forwardReasoning === false || process.env.JIUWEN_FORWARD_REASONING === '0')
      ? 'disabled'
      : undefined,
  ) || 'disabled'
  const model = {
    provider,
    api_base: String(apiBase),
    api_key_env: cfg.apiKeyEnv || 'JIUWEN_API_KEY',
    model: modelName,
    reasoning: { mode: String(reasoningMode).toLowerCase() === 'enabled' ? 'enabled' : 'disabled' },
  }
  if (endpointProfile) model.endpoint_profile = endpointProfile
  if (options.temperature != null) model.temperature = options.temperature
  if (options.maxTokens != null) model.max_tokens = options.maxTokens
  if (options.topP != null) model.top_p = options.topP
  return model
}
