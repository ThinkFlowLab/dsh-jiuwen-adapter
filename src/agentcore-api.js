/**
 * agent-core backend surface for ctx.jiuwenAdapter.gateway / /jiuwen.
 * Keeps API shapes identical to the Gateway facade; unsupported methods throw
 * UNSUPPORTED with a clear agent-core reason (never silently hits a missing Gateway).
 */

export function isAgentCoreBackend(cfg) {
  return String(cfg?.backend || '').toLowerCase() === 'agent-core'
}

/** Unary API method names that agent-core implements (or synthesizes). */
export const AGENTCORE_API_METHODS = Object.freeze(new Set([
  'historyGet',
  'sessionDelete',
  'sessionFork',
  'interrupt',
  'chatCancel',
  'modelsList',
  'rpc',
  'supports',
  'unsupported',
]))

/** Gateway RPC method names the sidecar can answer. */
export const AGENTCORE_RPC_METHODS = Object.freeze(new Set([
  'history.get',
  'session.delete',
  'session.fork',
  'chat.interrupt',
  'models.list',
]))

export function agentcoreUnsupportedError(method) {
  const m = String(method || '')
  return Object.assign(
    new Error(
      `unsupported on agent-core backend: ${m} (Gateway-only; set backend: gateway or omit backend)`,
    ),
    { code: 'UNSUPPORTED', method: m, backend: 'agent-core' },
  )
}

/**
 * Wrap a gateway API object so Gateway-only methods degrade clearly when
 * `backend === 'agent-core'`. Supported methods keep calling through.
 *
 * @param {object} base
 * @param {{ getConfig: () => object, getAgentcore?: () => object, modelsFromConfig?: () => object }} deps
 */
export function wrapGatewayApiForBackend(base, deps) {
  const getConfig = deps.getConfig
  const getAc = deps.getAgentcore
  const modelsFromConfig = deps.modelsFromConfig

  const acRpc = async (method, params = {}) => {
    const ac = getAc?.()
    if (!ac) throw agentcoreUnsupportedError(method)
    const m = String(method)
    if (m === 'history.get') {
      return ac.sessionHistory(params.session_id || params.sid)
    }
    if (m === 'session.delete') {
      return ac.sessionDelete(params.session_id || params.sid)
    }
    if (m === 'session.fork') {
      const from = params.session_id || params.source_session_id
      const to = params.new_session_id || params.to || `fork-${Date.now().toString(36)}`
      return ac.sessionFork(from, to, params)
    }
    if (m === 'chat.interrupt') {
      return ac.cancel(params.session_id || params.sid)
    }
    if (m === 'models.list') {
      return modelsFromConfig?.() || { models: [], active_model: null }
    }
    throw agentcoreUnsupportedError(m)
  }

  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'supports') {
        return async (method) => {
          if (!isAgentCoreBackend(getConfig())) {
            return Reflect.get(target, prop, receiver).call(target, method)
          }
          return AGENTCORE_RPC_METHODS.has(String(method))
            || AGENTCORE_API_METHODS.has(String(method))
        }
      }
      if (prop === 'unsupported') {
        return () => {
          if (!isAgentCoreBackend(getConfig())) {
            return Reflect.get(target, prop, receiver).call(target)
          }
          return ['* (Gateway-only methods; agent-core supports history/session delete|fork|interrupt|models.list)']
        }
      }
      if (prop === 'rpc') {
        return async (method, params, opts) => {
          if (!isAgentCoreBackend(getConfig())) {
            return Reflect.get(target, prop, receiver).call(target, method, params, opts)
          }
          return acRpc(method, params || {})
        }
      }
      if (prop === 'modelsList') {
        return async (extra) => {
          if (!isAgentCoreBackend(getConfig())) {
            return Reflect.get(target, prop, receiver).call(target, extra)
          }
          return modelsFromConfig?.() || { models: [], active_model: null }
        }
      }
      if (prop === 'interrupt' || prop === 'chatCancel') {
        return async (sid, intentOrExtra, extra) => {
          if (!isAgentCoreBackend(getConfig())) {
            return Reflect.get(target, prop, receiver).call(target, sid, intentOrExtra, extra)
          }
          const ac = getAc?.()
          if (!ac) throw agentcoreUnsupportedError(prop)
          return ac.cancel(sid)
        }
      }
      const v = Reflect.get(target, prop, receiver)
      if (typeof v !== 'function') return v
      if (AGENTCORE_API_METHODS.has(prop)) {
        return (...args) => v.apply(target, args)
      }
      return async (...args) => {
        if (!isAgentCoreBackend(getConfig())) return v.apply(target, args)
        throw agentcoreUnsupportedError(prop)
      }
    },
  })
}
