/**
 * Wire the Jiuwen provider into dsh Settings → Models and resolve
 * UI-stored credentials for the agent-core sidecar.
 *
 * Fail-soft on hosts without settings, credentials, or
 * registerConfigurableProviders (plain Cordis, older dsh, unit mocks).
 * Never logs secret values.
 */
import { createHash } from 'node:crypto'

export const SETTINGS_NS = 'llm-jiuwen'
export const DEFAULT_API_KEY_ENV = 'JIUWEN_API_KEY'

/** Unwrap Cordis/schemastery Volatile fields into a plain object. */
export function unwrapConfig(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const [key, value] of Object.entries(raw)) out[key] = unwrapValue(value)
  return out
}

function unwrapValue(value) {
  if (value && typeof value === 'object' && typeof value.get === 'function' && value.get.length === 0 && !Array.isArray(value)) {
    try { return value.get() } catch { /* not a Volatile */ }
  }
  return value
}

/**
 * Resolve the API key the sidecar should use.
 * Precedence: dsh credentials store → already-resolved cfg.apiKey (env / deprecated inline).
 */
export async function resolveHostApiKey(ctx, cfg = {}) {
  const ref = String(cfg.apiKeyEnv || DEFAULT_API_KEY_ENV)
  const credentials = typeof ctx?.get === 'function' ? ctx.get('credentials') : ctx?.credentials
  if (credentials && typeof credentials.resolve === 'function') {
    try {
      const hit = await credentials.resolve(ref)
      const value = hit?.value
      if (value != null && String(value).length > 0) return String(value)
    } catch { /* fall through to env */ }
  }
  if (cfg.apiKey) return String(cfg.apiKey)
  return undefined
}

export function fingerprintSecret(value) {
  if (!value) return ''
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16)
}

/** Env bag for the sidecar child; never includes the key in argv. */
export function childEnvFromKey(apiKey, apiKeyEnv = DEFAULT_API_KEY_ENV) {
  if (!apiKey) return {}
  const env = { JIUWEN_API_KEY: apiKey, API_KEY: apiKey }
  if (apiKeyEnv && apiKeyEnv !== 'JIUWEN_API_KEY' && apiKeyEnv !== 'API_KEY') env[apiKeyEnv] = apiKey
  return env
}

function settingsNamespace(ctx, cfg) {
  return ctx?.fiber?.entry?.options?.id || SETTINGS_NS
}

/**
 * Install Settings → Models directory entry + live credential resolution.
 * @returns {{ dispose: Function, resolveChildEnv: Function, settingsNs: string }}
 */
export function installHostModelSettings({ ctx, readConfig, logger } = {}) {
  const disposers = []
  const cfg0 = typeof readConfig === 'function' ? readConfig() : {}
  const settingsNs = settingsNamespace(ctx, cfg0)

  // Present volatile fields to the settings document (fail-soft).
  try {
    if (typeof ctx?.inject === 'function') {
      ctx.inject(['settings'], (child) => {
        const settings = child?.settings
        if (typeof settings?.configure !== 'function') return
        // Keep the service receiver: dsh's settings/llm methods use `this`.
        const configure = (...args) => settings.configure(...args)
        const fiber = ctx.fiber
        if (typeof child.effect === 'function') {
          child.effect(() => configure({ auto: false }, fiber), 'llm-jiuwen settings')
        } else {
          const off = configure({ auto: false }, fiber)
          if (typeof off === 'function') disposers.push(off)
        }
      })
    }
  } catch (error) {
    logger?.debug?.(`[dsh-jiuwen] settings.configure skipped: ${error?.message || error}`)
  }

  // Appear as a configurable provider on Settings → Models.
  try {
    const llm = ctx?.llm
    if (typeof llm?.registerConfigurableProviders === 'function') {
      const register = (entries) => llm.registerConfigurableProviders(entries)
      const entry = () => {
        const c = typeof readConfig === 'function' ? readConfig() : cfg0
        return {
          provider: c.provider || 'jiuwen',
          displayName: c.displayName || 'JiuwenSwarm',
          settingsNs,
          settingsPath: [],
          declared: false,
          nativeAuth: { env: [c.apiKeyEnv || DEFAULT_API_KEY_ENV, 'API_KEY', 'JIUWEN_API_KEY'], oauth: false },
        }
      }
      const handle = register([entry()])
      if (handle && typeof handle.replace === 'function' && typeof ctx?.on === 'function') {
        const off = ctx.on('loader/volatile-update', () => {
          try { handle.replace([entry()]) } catch { /* ignore */ }
        })
        if (typeof off === 'function') disposers.push(off)
      }
      if (typeof handle === 'function') disposers.push(handle)
      else if (handle && typeof handle.dispose === 'function') disposers.push(() => handle.dispose())
    }
  } catch (error) {
    logger?.debug?.(`[dsh-jiuwen] registerConfigurableProviders skipped: ${error?.message || error}`)
  }

  const resolveChildEnv = async () => {
    const cfg = typeof readConfig === 'function' ? readConfig() : {}
    const apiKey = await resolveHostApiKey(ctx, cfg)
    return childEnvFromKey(apiKey, cfg.apiKeyEnv)
  }

  return {
    settingsNs,
    resolveChildEnv,
    dispose() {
      for (const d of disposers) { try { d() } catch { /* ignore */ } }
      disposers.length = 0
    },
  }
}
