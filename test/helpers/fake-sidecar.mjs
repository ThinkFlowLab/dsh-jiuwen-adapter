#!/usr/bin/env node
/**
 * Minimal NDJSON sidecar stand-in for transport unit tests (no Python).
 * Speaks the same protocol as sidecar/: ping, turn.start/cancel, tool.*, session.*.
 *
 * Env:
 *   FAKE_SIDECAR_SCRIPT — JSON array of model steps:
 *     {type:'text', text:'hi'} | {type:'tool', name, args} | {type:'slow', ms}
 *     | {type:'error', message} | {type:'crash'}
 */
import readline from 'node:readline'

const sessions = new Map() // sid -> messages[]
const inflight = new Map() // sid -> { cancelled: boolean }
let script = []
try {
  if (process.env.FAKE_SIDECAR_SCRIPT) script = JSON.parse(process.env.FAKE_SIDECAR_SCRIPT)
} catch { script = [] }
let scriptIdx = 0

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function nextStep() {
  if (scriptIdx < script.length) return script[scriptIdx++]
  return { type: 'text', text: 'ok' }
}

async function handleTurn(id, params) {
  const sid = params.sid
  const state = { cancelled: false }
  inflight.set(sid, state)
  const msgs = sessions.get(sid) || []
  msgs.push({ role: 'user', content: params.query })
  try {
    while (!state.cancelled) {
      const step = nextStep()
      if (step.type === 'crash') {
        process.exit(2)
      }
      if (step.type === 'error') {
        write({ id, error: { code: -32000, message: step.message || 'boom' } })
        return
      }
      if (step.type === 'slow') {
        write({ event: 'chunk', params: { type: 'llm_output', payload: { content: 'part ' }, sid } })
        await new Promise((r) => {
          const t = setTimeout(r, step.ms || 30_000)
          const iv = setInterval(() => {
            if (state.cancelled) { clearTimeout(t); clearInterval(iv); r() }
          }, 20)
        })
        if (state.cancelled) break
        write({ event: 'chunk', params: { type: 'llm_output', payload: { content: 'done' }, sid } })
        write({ event: 'chunk', params: { type: 'answer', payload: { output: 'done' }, sid } })
        msgs.push({ role: 'assistant', content: 'done' })
        break
      }
      if (step.type === 'tool') {
        write({
          event: 'chunk',
          params: { type: 'tool_call', payload: { tool_name: step.name, tool_args: step.args || {} }, sid },
        })
        const callId = `c-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
        write({ event: 'tool.call', params: { callId, name: step.name, args: step.args || {}, sid } })
        const result = await waitToolResult(callId, state)
        write({
          event: 'chunk',
          params: {
            type: 'tool_result',
            payload: { tool_name: step.name, tool_result: JSON.stringify(result) },
            sid,
          },
        })
        continue
      }
      // text
      if (step.reasoning) {
        write({ event: 'chunk', params: { type: 'llm_reasoning', payload: { content: step.reasoning }, sid } })
      }
      write({ event: 'chunk', params: { type: 'llm_output', payload: { content: step.text || 'ok' }, sid } })
      write({
        event: 'chunk',
        params: {
          type: 'llm_usage',
          payload: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          sid,
        },
      })
      write({ event: 'chunk', params: { type: 'answer', payload: { output: step.text || 'ok' }, sid } })
      msgs.push({ role: 'assistant', content: step.text || 'ok' })
      break
    }
    sessions.set(sid, msgs)
    if (state.cancelled) {
      write({ id, error: { code: -32001, message: 'cancelled' } })
    } else {
      write({ id, result: { ok: true } })
    }
  } finally {
    inflight.delete(sid)
  }
}

const toolWaiters = new Map()
function waitToolResult(callId, state) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      toolWaiters.delete(callId)
      reject(new Error('tool timeout'))
    }, 60_000)
    toolWaiters.set(callId, {
      resolve: (v) => { clearTimeout(t); resolve(v) },
      reject: (e) => { clearTimeout(t); reject(e) },
      state,
    })
  })
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', async (line) => {
  const raw = String(line || '').trim()
  if (!raw) return
  let msg
  try { msg = JSON.parse(raw) } catch { return }
  const { id, method, params = {} } = msg
  try {
    if (method === 'ping') {
      write({ id, result: { ok: true, pong: true } })
      return
    }
    if (method === 'shutdown') {
      write({ id, result: { ok: true } })
      process.exit(0)
    }
    if (method === 'turn.cancel') {
      const s = inflight.get(params.sid)
      if (s) s.cancelled = true
      write({ id, result: { ok: true, cancelled: Boolean(s) } })
      return
    }
    if (method === 'tool.result') {
      const w = toolWaiters.get(params.callId)
      if (w) {
        toolWaiters.delete(params.callId)
        w.resolve({ ok: params.ok !== false, content: params.content })
      }
      if (id !== undefined) write({ id, result: { ok: true } })
      return
    }
    if (method === 'turn.start') {
      await handleTurn(id, params)
      return
    }
    if (method === 'session.fork') {
      const from = sessions.get(params.from) || []
      sessions.set(params.to, from.map((m) => ({ ...m })))
      write({ id, result: { ok: true, sid: params.to, seeded: from.length } })
      return
    }
    if (method === 'session.delete') {
      sessions.delete(params.sid)
      write({ id, result: { ok: true } })
      return
    }
    if (method === 'session.history') {
      write({ id, result: { ok: true, messages: sessions.get(params.sid) || [] } })
      return
    }
    if (method === 'session.compact') {
      const msgs = sessions.get(params.sid)
      if (!msgs) {
        write({ id, result: { ok: true, compacted: false, reason: 'no-agent' } })
        return
      }
      sessions.set(params.sid, [])
      write({ id, result: { ok: true, compacted: true, kept: 0 } })
      return
    }
    write({ id, error: { code: -32601, message: `unknown method: ${method}` } })
  } catch (e) {
    if (id !== undefined) write({ id, error: { code: -32000, message: String(e.message || e) } })
  }
})
