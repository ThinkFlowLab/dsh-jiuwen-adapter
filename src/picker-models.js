/**
 * Model picker catalog for the agent-core backend.
 *
 * dsh's composer / `/model` picker lists exactly what `listModels` returns,
 * grouped under the provider name. With agent-core the adapter calls an
 * OpenAI-compatible endpoint directly, so the selectable entries are the real
 * model names from Settings → Models (`models[].modelName || models[].id`),
 * never the legacy `jiuwen-default` / `jiuwen-swarm` aliases.
 *
 * Legacy aliases still route: they resolve to the configured default model,
 * then the first configured model, then AGENTCORE_MODEL / MODEL_NAME.
 */
import { loadJiuwenDotEnv } from './jiuwen-env.js'

export const MODEL_ALIASES = Object.freeze(['jiuwen-default', 'jiuwen-swarm', 'jiuwen', 'default'])
const ALIAS_SET = new Set(MODEL_ALIASES)
const LEGACY_NAMES = new Set(['jiuwen default', 'jiuwen swarm'])

export function isModelAlias(id) {
  return id != null && ALIAS_SET.has(String(id).trim().toLowerCase())
}

function text(v) {
  return v != null && String(v).trim() !== '' ? String(v).trim() : undefined
}

/** Headless fallback model name: AGENTCORE_MODEL → MODEL_NAME → Jiuwen config/.env MODEL_NAME. */
export function envModelName(env = process.env, dotenv) {
  const jw = dotenv || loadJiuwenDotEnv()
  return text(env.AGENTCORE_MODEL) || text(env.MODEL_NAME) || text(jw.MODEL_NAME)
}

/** Concrete model name an entry sends to the API, or undefined for a bare alias. */
export function realModelName(entry) {
  if (!entry) return undefined
  const explicit = text(entry.modelName)
  if (explicit) return explicit
  const id = text(entry.id)
  return id && !isModelAlias(id) ? id : undefined
}

/** Find a configured entry by picker id: exact id first, then its real model name. */
export function findCatalogModel(cfg, id) {
  const key = text(id)
  if (!key) return undefined
  const list = Array.isArray(cfg?.models) ? cfg.models : []
  return list.find(m => m && m.id === key) || list.find(m => m && text(m.modelName) === key)
}

/** Concrete model a legacy alias (or the plugin default) maps to; undefined when none is known. */
export function resolveAliasModel(cfg = {}, alias, { env = process.env, dotenv } = {}) {
  const own = realModelName(findCatalogModel(cfg, alias))
  if (own) return own
  const def = text(cfg.defaultModel)
  const fromDefault = def && (realModelName(findCatalogModel(cfg, def)) || (isModelAlias(def) ? undefined : def))
  if (fromDefault) return fromDefault
  for (const m of cfg.models || []) {
    const name = realModelName(m)
    if (name) return name
  }
  return envModelName(env, dotenv)
}

/**
 * Selectable picker entries for agent-core: one per real configured model,
 * deduplicated, in Settings order. Falls back to the env model, then to a
 * single placeholder so the provider never shows an empty group.
 * @returns {Array<{id:string,name:string,contextWindow?:number,maxTokens?:number}>}
 */
export function pickerModels(cfg = {}, { env = process.env, dotenv } = {}) {
  const out = []
  const seen = new Set()
  for (const m of cfg.models || []) {
    const id = realModelName(m)
    if (!id || seen.has(id)) continue
    seen.add(id)
    const custom = text(m.name)
    const keepName = custom && !isModelAlias(m.id) && !LEGACY_NAMES.has(custom.toLowerCase())
    out.push({
      id,
      name: keepName ? custom : id,
      ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
      ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
    })
  }
  if (out.length) return out
  const fromEnv = envModelName(env, dotenv)
  if (fromEnv) return [{ id: fromEnv, name: fromEnv }]
  return [{ id: 'jiuwen-default', name: 'Default model (set one in Settings → Models)' }]
}

/** True when the picker should list real model names (agent-core backend). */
export function usesRealModelPicker(cfg = {}) {
  return cfg.mode === 'gateway' && cfg.backend === 'agent-core'
}
