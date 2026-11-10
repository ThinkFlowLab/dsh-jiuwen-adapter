/**
 * Pure helpers for the Settings → Models Jiuwen card.
 * Safe to import from Node tests (no DOM).
 */

export const SETTINGS_NS = 'llm-jiuwen'
export const DEFAULT_API_KEY_ENV = 'JIUWEN_API_KEY'
/** Legacy catalog aliases from earlier versions; never shown as picker entries. */
export const LEGACY_MODEL_IDS = ['jiuwen-default', 'jiuwen-swarm', 'jiuwen', 'default']
export const DEFAULT_MODELS = []

function isLegacyId(id) {
  return LEGACY_MODEL_IDS.includes(String(id || '').trim().toLowerCase())
}

/**
 * Rows for the card: each row's `id` is the real model name sent to the API
 * and shown in the model picker. Legacy alias rows are rewritten to their
 * `modelName`, or dropped when they have none.
 */
export function modelsFromValue(value) {
  const list = value && Array.isArray(value.models) ? value.models : []
  const out = []
  for (const m of list) {
    const id = String(m?.id || '').trim()
    const real = String(m?.modelName || '').trim() || (isLegacyId(id) ? '' : id)
    if (!real || out.some(x => x.id === real)) continue
    const name = String(m?.name || '').trim()
    const keepName = name && name !== real && name !== id && !isLegacyId(id)
    out.push({
      id: real,
      name: keepName ? name : '',
      ...(Number(m?.contextWindow) > 0 ? { contextWindow: Number(m.contextWindow) } : {}),
      ...(Number(m?.maxTokens) > 0 ? { maxTokens: Number(m.maxTokens) } : {}),
    })
  }
  return out
}

/** Map a stored defaultModel (maybe a legacy alias) onto the rewritten rows. */
export function defaultFromValue(value, rows) {
  const stored = String(value?.defaultModel || '').trim()
  const list = value && Array.isArray(value.models) ? value.models : []
  const hit = list.find(m => m && String(m.id || '').trim() === stored)
  const real = String(hit?.modelName || '').trim() || (isLegacyId(stored) ? '' : stored)
  if (real && rows.some(r => r.id === real)) return real
  return rows[0]?.id || ''
}

/** Rows ready to save: blank rows dropped, display name only when it differs. */
export function modelsForSave(rows) {
  return rows
    .map(m => ({ ...m, id: String(m.id || '').trim(), name: String(m.name || '').trim() }))
    .filter(m => m.id)
    .map(m => ({
      id: m.id,
      name: m.name || m.id,
      ...(Number(m.contextWindow) > 0 ? { contextWindow: Number(m.contextWindow) } : {}),
      ...(Number(m.maxTokens) > 0 ? { maxTokens: Number(m.maxTokens) } : {}),
    }))
}

export function validateModels(models) {
  const seen = new Set()
  for (let i = 0; i < models.length; i++) {
    const id = String(models[i]?.id || '').trim()
    if (!id) continue
    if (isLegacyId(id)) return { index: i, message: `"${id}" is not a model name; enter the model your endpoint expects.` }
    if (seen.has(id)) return { index: i, message: `Model "${id}" is listed twice.` }
    seen.add(id)
  }
  if (seen.size === 0) return { index: 0, message: 'Add at least one model name.' }
  return undefined
}

export function pathOpsForDraft(before, after) {
  const ops = []
  for (const key of ['baseURL', 'displayName', 'defaultModel', 'apiKeyEnv', 'models']) {
    const prev = before?.[key]
    const next = after?.[key]
    const same = JSON.stringify(prev ?? null) === JSON.stringify(next ?? null)
    if (same) continue
    if (next === undefined || next === '') ops.push({ op: 'unset', path: [key] })
    else ops.push({ op: 'set', path: [key], value: next })
  }
  return ops
}

export function namespaceValue(describeResult, ns = SETTINGS_NS) {
  const doc = describeResult?.value || describeResult
  const list = doc?.namespaces || []
  return list.find(n => n?.ns === ns)
}
