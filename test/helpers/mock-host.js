/** Shared harness: spawn bin/mock-gateway.mjs on an OS-assigned port (port 0) and build a minimal Cordis-like host. */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as plugin from '../../index.js'
import { GatewayTransport } from '../../src/gateway-transport.js'
import { spawnMockGateway } from './spawn-mock-gateway.js'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

export async function startMock() {
  const dir = mkdtempSync(join(tmpdir(), 'jw-ext-'))
  const gw = await spawnMockGateway({ JIUWEN_GATEWAY_MOCK_SHAPE: '0.2.7' })
  const { url } = gw
  return {
    url, dir,
    rpc: (m, p = {}) => new GatewayTransport({ gatewayURL: url }).rpc(m, p),
    stop() { rmSync(dir, { recursive: true, force: true }); return gw.stop() },
  }
}

export const quiet = { info() {}, warn() {}, error() {}, debug() {} }

/** Build a host ctx; `services` are returned by ctx.get(name). */
export function makeHost(mock, config = {}, { services = {}, commands = [], listeners = {}, emitted = [] } = {}) {
  const adapters = new Map()
  const ctx = {
    llm: { registerAdapter(ids, a) { ids.forEach(i => adapters.set(i, a)); return () => {} }, ...(services.llm || {}) },
    logger: quiet,
    provide(n, v) { if (this[n] !== undefined && n !== 'llm') throw new Error(`service ${n} already provided`); this[n] = v },
    get(n) { return services[n] },
    on(name, fn) { (listeners[name] ||= []).push(fn); return () => {} },
    emit(name, ...args) { emitted.push([name, ...args]) },
    inject(_deps, cb) { cb({ commands: { register(d) { if (commands.some(c => c.name === d.name)) throw new Error(`duplicate command ${d.name}`); commands.push(d); return () => {} } }, on() {} }) },
  }
  plugin.apply(ctx, { gatewayURL: mock.url, mappingPath: join(mock.dir, `m-${Math.random()}.json`), finalGraceMs: 200, backend: 'gateway', ...config })
  const def = commands.find(c => c.name === (config.commandName || 'jiuwen'))
  return {
    ctx, api: ctx[config.serviceName || 'jiuwenAdapter'], adapter: adapters.get(config.provider || 'jiuwen'), listeners, emitted, commands,
    cmd: async (raw, sid = 'ext-s') => (await def.handler({ agent: { id: sid }, rawInput: raw })),
    async run(o) { const cs = []; for await (const c of adapters.get(config.provider || 'jiuwen').stream({ provider: 'jiuwen', model: 'jiuwen-default', sessionId: 's', ...o })) cs.push(c); return cs },
  }
}
