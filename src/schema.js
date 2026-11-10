/**
 * Cordis plugin Config schema.
 *
 * When @deepseek-ai/schemastery is available (dsh hosts), the schema exposes
 * volatile Models-page fields (baseURL, apiKeyEnv, models, displayName,
 * defaultModel) so Settings can edit them live. Other adapter keys pass
 * through unchanged. Without schemastery the schema accepts any object, as
 * before, so plain Cordis hosts keep working.
 */
import { createRequire } from 'node:module'

const PASSTHROUGH = {
  '~standard': {
    version: 1,
    vendor: 'dsh-jiuwen-adapter',
    validate(value) {
      const config = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
      return { value: config }
    },
  },
}

function loadSchemastery() {
  try {
    const req = createRequire(import.meta.url)
    const mod = req('@deepseek-ai/schemastery')
    return mod?.default || mod?.Schema || mod
  } catch {
    return undefined
  }
}

/**
 * Build the settings-aware Config schema from a schemastery `Schema` export.
 * Extra keys are preserved (non-strict object validation + intersect merge).
 */
export function createSettingsConfig(Schema) {
  const z = Schema
  const model = z.object({
    id: z.string().required(),
    name: z.string(),
    modelName: z.string(),
    contextWindow: z.number(),
    maxTokens: z.number(),
    chatMode: z.string(),
    agentTemplateName: z.string(),
    agentGroupName: z.string(),
  })
  return z.intersect([
    z.object({
      displayName: z.string().volatile(),
      baseURL: z.string().volatile(),
      apiKeyEnv: z.string().role('credential-ref').default('JIUWEN_API_KEY').volatile(),
      defaultModel: z.string().volatile(),
      models: z.array(model).volatile(),
    }),
  ])
}

function resolveExportedConfig() {
  const Schema = loadSchemastery()
  if (!Schema) return PASSTHROUGH
  try {
    return createSettingsConfig(Schema)
  } catch {
    return PASSTHROUGH
  }
}

export const Config = resolveExportedConfig()
