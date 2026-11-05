/**
 * Durable adapter-side state for agent-core parity with Gateway RPCs that have
 * no sidecar equivalent (heartbeat, permissions overlay, plugins, skill toggles).
 * File-backed JSON next to the session map.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const DEFAULT = () => ({
  version: 1,
  heartbeat: { every: 3600, target: 'web' },
  permissions: { tools: {} }, // name → level
  plugins: {}, // name → enabled bool
  skills: {}, // name → enabled bool (host skill toggles mirrored)
  updatedAt: new Date().toISOString(),
})

export function createAgentCoreState(filePath) {
  let data = DEFAULT()
  const path = filePath
  const load = () => {
    if (!path || !existsSync(path)) return
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'))
      data = { ...DEFAULT(), ...raw, permissions: { tools: { ...(raw?.permissions?.tools || {}) } }, plugins: { ...(raw?.plugins || {}) }, skills: { ...(raw?.skills || {}) } }
    } catch { /* keep default */ }
  }
  const save = () => {
    if (!path) return
    mkdirSync(dirname(path), { recursive: true })
    data.updatedAt = new Date().toISOString()
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    renameSync(tmp, path)
  }
  load()
  return {
    path,
    getHeartbeat() { return { ...data.heartbeat } },
    setHeartbeat(conf = {}) {
      data.heartbeat = { ...data.heartbeat, ...conf }
      save()
      return { ...data.heartbeat }
    },
    getPermissions() { return { tools: { ...data.permissions.tools } } },
    updatePermission(tool, level) {
      if (level == null || level === '') delete data.permissions.tools[tool]
      else data.permissions.tools[tool] = String(level)
      save()
      return { tool, level: data.permissions.tools[tool] }
    },
    deletePermission(tool) {
      delete data.permissions.tools[tool]
      save()
      return { ok: true }
    },
    listPlugins() {
      return { plugins: Object.entries(data.plugins).map(([name, enabled]) => ({ name, enabled: Boolean(enabled) })) }
    },
    setPlugin(name, enabled) {
      data.plugins[String(name)] = Boolean(enabled)
      save()
      return { name, enabled: Boolean(enabled) }
    },
    listSkills() {
      return { skills: Object.entries(data.skills).map(([name, enabled]) => ({ name, enabled: Boolean(enabled) })) }
    },
    setSkill(name, enabled) {
      data.skills[String(name)] = Boolean(enabled)
      save()
      return { name, enabled: Boolean(enabled) }
    },
    /** Snapshot for tests. */
    _dump() { return JSON.parse(JSON.stringify(data)) },
  }
}

export function statePathFromMapping(mappingPath) {
  if (!mappingPath) return null
  return join(dirname(String(mappingPath)), 'agentcore-state.json')
}
