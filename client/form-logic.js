/**
 * Pure helpers for the Settings → Models Jiuwen card.
 * Safe to import from Node tests (no DOM).
 */

export const SETTINGS_NS = 'llm-jiuwen'
export const DEFAULT_API_KEY_ENV = 'JIUWEN_API_KEY'
export const DEFAULT_MODELS = [
  { id: 'jiuwen-default', name: 'Jiuwen Default', contextWindow: 128000, maxTokens: 8192 },
  { id: 'jiuwen-swarm', name: 'Jiuwen Swarm', contextWindow: 128000, maxTokens: 8192 },
]

export function modelsFromValue(value) {
  const list = value && Array.isArray(value.models) ? value.models : null
  if (!list || list.length === 0) return DEFAULT_MODELS.map(m => ({ ...m }))
  return list.map((m) => ({
    id: String(m?.id || '').trim(),
    name: String(m?.name || m?.id || '').trim(),
    ...(m?.modelName ? { modelName: String(m.modelName).trim() } : {}),
    ...(Number(m?.contextWindow) > 0 ? { contextWindow: Number(m.contextWindow) } : {}),
    ...(Number(m?.maxTokens) > 0 ? { maxTokens: Number(m.maxTokens) } : {}),
  }))
}

export function validateModels(models) {
  const seen = new Set()
  for (let i = 0; i < models.length; i++) {
    const id = models[i]?.id
    if (!id) return { index: i, message: 'Each model needs an id.' }
    if (seen.has(id)) return { index: i, message: `Model id "${id}" is used twice.` }
    seen.add(id)
  }
  if (models.length === 0) return { index: 0, message: 'Add at least one model.' }
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
