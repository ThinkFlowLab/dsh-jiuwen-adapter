/** Drive one adapter.stream() turn against a fake Gateway transport; returns what reached chat.send. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJiuwenAdapter } from '../../src/adapter.js'
import { SessionStore } from '../../src/session-store.js'
import { resolveConfig } from '../../src/config.js'

export function makeRig(raw = {}, deps = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jw-fake-'))
  const mappingPath = join(dir, 'map.json')
  let cfg = resolveConfig({ mode: 'gateway', backend: 'gateway', gatewayURL: 'ws://127.0.0.1:1/ws', mappingPath, titleMode: 'local', ...raw }, { env: {} })
  let sessions = new SessionStore(mappingPath)
  const sent = []
  let script = () => [{ event: { type: 'text' } }, { end: { reason: { kind: 'stop' } } }]
  const build = () => {
    const Adapter = createJiuwenAdapter(null, { config: () => cfg, sessions, ...deps })
    const a = new Adapter()
    a._gatewayTransport = () => ({
      async *stream(request, mapping, o) {
        sent.push({ request, mapping: { ...mapping }, query: o.query, overrides: { ...o.overrides } })
        for (const step of script(sent.length)) {
          if (step.event) o.onEvent?.(step.event)
          if (step.throw) throw new Error(step.throw)
          if (step.end) o.onTurnEnd?.({ reason: step.end.reason, requestId: 'r', text: '' })
        }
        yield { type: 'finish', finishReason: 'stop' }
      },
      rpc: async () => ({}),
      sessionRename: async () => ({}),
    })
    return a
  }
  let adapter = build()
  return {
    dir, sent, get sessions() { return sessions },
    setScript(fn) { script = fn },
    setConfig(patch) { cfg = resolveConfig({ mode: 'gateway', backend: 'gateway', gatewayURL: 'ws://127.0.0.1:1/ws', mappingPath, titleMode: 'local', ...raw, ...patch }, { env: {} }); adapter = build() },
    /** Simulate an adapter restart: reload the mapping file from disk. */
    restart() { sessions = new SessionStore(mappingPath); adapter = build() },
    async turn(sessionId, options = {}) {
      const out = []
      for await (const c of adapter.stream({ provider: 'jiuwen', model: options.model || 'jiuwen-default', sessionId, messages: options.messages || [{ role: 'user', content: 'hi' }], ...options })) out.push(c)
      return out
    },
  }
}
