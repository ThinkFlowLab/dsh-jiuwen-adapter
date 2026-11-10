/**
 * Dual-shape host tool execution for dsh `ctx.tools.execute`.
 *
 * dsh >=0.2.2 (`executeToolBatch`) reads `{ calls, agent, signal }` and
 * returns `{ results: [{ callId, result }] }`. A bare single exec throws
 * `Tool batch execution failed`. Older hosts take one `{ callId, name,
 * arguments, agent, signal }` and return that result directly. Send both
 * shapes; each host reads only its own keys.
 */

/** Drop null/undefined tool args (openjiuwen fills optionals with null; dsh rejects). */
export function stripNullishToolArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args && typeof args === 'object' ? args : {}
  const out = {}
  for (const [k, v] of Object.entries(args)) {
    if (v === null || v === undefined) continue
    out[k] = v
  }
  return out
}

/** dsh tool results use content[].text (and sometimes error.message), not top-level .text. */
export function toolResultText(result) {
  if (!result || typeof result !== 'object') return undefined
  if (typeof result.text === 'string' && result.text) return result.text
  if (typeof result.error?.message === 'string' && result.error.message) return result.error.message
  if (Array.isArray(result.content)) {
    const parts = result.content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
    if (parts.length) return parts.join('\n')
  }
  return undefined
}

/** Single result from a dsh batch settlement ({ results: [{ callId, result }] }); other shapes pass through. */
export function unwrapToolBatch(out, callId) {
  if (!out || typeof out !== 'object' || !Array.isArray(out.results)) return out
  const hit = out.results.find(r => r && r.callId === callId) || out.results[0]
  return hit && typeof hit === 'object' && 'result' in hit ? hit.result : hit
}

/**
 * Build the exec payload accepted by both dsh 0.2.2 and older ToolRuntime.execute.
 * @param {{ callId: string, name: string, args?: object, agent?: object, signal?: AbortSignal }} input
 */
export function hostToolExec({ callId, name, args, agent, signal } = {}) {
  const cleanArgs = stripNullishToolArgs(args)
  return {
    calls: [{
      type: 'tool-call',
      id: callId,
      name,
      arguments: JSON.stringify(cleanArgs ?? {}),
    }],
    callId,
    name,
    arguments: cleanArgs,
    agent,
    signal,
  }
}
