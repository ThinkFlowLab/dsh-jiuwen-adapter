/**
 * Stdio NDJSON-RPC transport to the agent-core Python sidecar (M2).
 *
 * Spawns `.venv-sidecar/bin/python -m sidecar`, maps sidecar chunks to DSH
 * StreamChunks (text/reasoning/usage/finish:stop), and routes tool.call events
 * through the host `executeTool` callback (ctx.tools.execute) → tool.result.
 * Never yields DSH tool-call blocks (Jiuwen/agent-core owns the loop).
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { agentcoreChildEnv } from './jiuwen-env.js'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { redactSecrets } from './redact.js'
import { emitTextDelta, finishText } from './stream-emit.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_PYTHON = join(ROOT, '.venv-sidecar', 'bin', 'python')

let _reqSeq = 0
function nextId() {
  _reqSeq += 1
  return `n${_reqSeq}-${randomUUID().slice(0, 8)}`
}

/**
 * @param {object} [opts]
 */
export class AgentCoreTransport {
  constructor(opts = {}) {
    this.pythonPath = opts.pythonPath || process.env.AGENTCORE_PYTHON || DEFAULT_PYTHON
    this.module = opts.module || 'sidecar'
    this.cwd = opts.cwd || ROOT
    this.checkpointDir = opts.checkpointDir
    this.env = opts.env || {}
    this.logger = opts.logger
    this.requestTimeoutMs = Number(opts.requestTimeoutMs || 180_000)
    this.emitUsage = opts.emitUsage !== false
    this.forwardReasoning = opts.forwardReasoning !== false
    this.surfaceToolEvents = opts.surfaceToolEvents !== false
    this.eventDisplay = opts.eventDisplay || 'reasoning'
    /** @type {(name: string, args: object, ctx: object) => Promise<unknown>} */
    this.executeTool = opts.executeTool
    /** Injectable for tests: (cmd, args, opts) => ChildProcess-like */
    this.spawnImpl = opts.spawnImpl || spawn
    /** Optional ready probe override */
    this.readyTimeoutMs = Number(opts.readyTimeoutMs || 30_000)
    /** Optional async () => env extras (credentials resolved from the dsh UI). */
    this.resolveChildEnv = opts.resolveChildEnv
    this._childEnvFp = ''

    this._proc = null
    this._rl = null
    this._pending = new Map()
    this._listeners = new Set()
    this._bufGeneration = 0
    this._starting = null
    this._closed = false
    this._restartCount = 0
  }

  /** Resolve default python; throws a clear error when the venv is missing. */
  resolvePython() {
    if (this.spawnImpl !== spawn) return this.pythonPath
    if (!existsSync(this.pythonPath)) {
      throw new Error(
        `agent-core sidecar python not found at ${this.pythonPath}; run: npm run sidecar:setup`,
      )
    }
    return this.pythonPath
  }

  async _resolvedExtraEnv() {
    if (typeof this.resolveChildEnv !== 'function') return {}
    try { return (await this.resolveChildEnv()) || {} } catch { return {} }
  }

  _fingerprintEnv(extra) {
    const parts = ['JIUWEN_API_KEY', 'API_KEY'].map((k) => {
      const v = extra?.[k]
      return v ? createHash('sha256').update(String(v)).digest('hex').slice(0, 16) : ''
    })
    return parts.join(':')
  }

  _recycleChild() {
    const proc = this._proc
    this._proc = null
    try { this._rl?.close?.() } catch { /* ignore */ }
    this._rl = null
    try { proc?.kill?.('SIGTERM') } catch { /* ignore */ }
  }

  async ensureStarted() {
    if (this._closed) throw new Error('AgentCoreTransport is shut down')
    if (this._proc && !this._proc.killed) {
      const extra = await this._resolvedExtraEnv()
      const fp = this._fingerprintEnv(extra)
      if (fp && this._childEnvFp && fp !== this._childEnvFp) this._recycleChild()
      else return
    }
    if (this._starting) return this._starting
    this._starting = this._spawn()
    try {
      await this._starting
    } finally {
      this._starting = null
    }
  }

  async _spawn() {
    const py = this.resolvePython()
    const extra = await this._resolvedExtraEnv()
    this._childEnvFp = this._fingerprintEnv(extra)
    const env = {
      ...process.env,
      ...agentcoreChildEnv(extra),
      ...this.env,
      AGENTCORE_LOG_LEVEL: this.env.AGENTCORE_LOG_LEVEL || process.env.AGENTCORE_LOG_LEVEL || 'WARNING',
      PYTHONUNBUFFERED: '1',
    }
    if (this.checkpointDir) {
      env.DSH_JIUVEN_AC_DIR = String(this.checkpointDir)
    }
    // Never forward inline secrets into child argv; keys come from api_key_env.
    const child = this.spawnImpl(py, ['-m', this.module], {
      cwd: this.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this._proc = child
    this._bufGeneration += 1
    const gen = this._bufGeneration

    child.stderr?.setEncoding?.('utf8')
    child.stderr?.on?.('data', (chunk) => {
      const text = redactSecrets(String(chunk))
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) this.logger?.warn?.(`[agent-core] ${line}`)
      }
    })

    const onLine = (line) => this._onLine(line, gen)
    if (child.stdout && typeof child.stdout.on === 'function') {
      this._rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
      this._rl.on('line', onLine)
    }

    const failPending = (err) => {
      for (const [, p] of this._pending) {
        try { p.reject(err) } catch { /* ignore */ }
      }
      this._pending.clear()
      for (const fn of [...this._listeners]) {
        try { fn({ event: '_process_exit', params: { error: String(err.message || err) } }) } catch { /* ignore */ }
      }
    }

    child.on?.('error', (err) => {
      this.logger?.error?.(`[agent-core] spawn error: ${redactSecrets(String(err?.message || err))}`)
      failPending(err)
      if (this._proc === child) this._proc = null
    })
    child.on?.('exit', (code, signal) => {
      if (this._proc === child) this._proc = null
      try { this._rl?.close?.() } catch { /* ignore */ }
      this._rl = null
      const err = new Error(`agent-core sidecar exited code=${code} signal=${signal || ''}`)
      failPending(err)
      if (!this._closed) this._restartCount += 1
    })

    // Ready check
    const ready = await this._request('ping', {}, { timeoutMs: this.readyTimeoutMs }).catch((e) => {
      try { child.kill?.('SIGTERM') } catch { /* ignore */ }
      throw e
    })
    if (!ready?.pong && !ready?.ok) {
      throw new Error('agent-core sidecar ping failed')
    }
  }

  _onLine(line, gen) {
    if (gen !== this._bufGeneration) return
    const raw = String(line || '').trim()
    if (!raw) return
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      this.logger?.warn?.(`[agent-core] malformed NDJSON: ${redactSecrets(raw.slice(0, 200))}`)
      return
    }
    if (!msg || typeof msg !== 'object') return

    if (msg.event) {
      for (const fn of [...this._listeners]) {
        try { fn(msg) } catch (e) {
          this.logger?.warn?.(`[agent-core] event listener error: ${e?.message || e}`)
        }
      }
      return
    }

    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this._pending.get(msg.id)
      if (!pending) return
      this._pending.delete(msg.id)
      if (msg.error) {
        const err = new Error(redactSecrets(String(msg.error.message || JSON.stringify(msg.error))))
        err.code = msg.error.code
        pending.reject(err)
      } else {
        pending.resolve(msg.result)
      }
    }
  }

  /**
   * @param {string} method
   * @param {object} [params]
   * @param {{ timeoutMs?: number, id?: string }} [opts]
   */
  async _request(method, params = {}, opts = {}) {
    await this.ensureStarted()
    const id = opts.id || nextId()
    const timeoutMs = opts.timeoutMs ?? this.requestTimeoutMs
    const payload = JSON.stringify({ id, method, params }) + '\n'
    return new Promise((resolve, reject) => {
      if (!this._proc?.stdin) {
        reject(new Error('agent-core sidecar stdin unavailable'))
        return
      }
      const timer = setTimeout(() => {
        this._pending.delete(id)
        reject(new Error(`agent-core RPC timeout method=${method}`))
      }, timeoutMs)
      timer.unref?.()
      this._pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      try {
        const ok = this._proc.stdin.write(payload)
        if (!ok) {
          this._proc.stdin.once('drain', () => {})
        }
      } catch (e) {
        this._pending.delete(id)
        clearTimeout(timer)
        reject(e)
      }
    })
  }

  /** Fire-and-forget notify (still awaits ack when id is used). */
  async notify(method, params = {}) {
    return this._request(method, params)
  }

  onEvent(fn) {
    this._listeners.add(fn)
    return () => this._listeners.delete(fn)
  }

  async ping() {
    return this._request('ping', {})
  }

  async shutdown() {
    this._closed = true
    try {
      if (this._proc) await this._request('shutdown', {}, { timeoutMs: 5_000 })
    } catch { /* ignore */ }
    try { this._rl?.close?.() } catch { /* ignore */ }
    try { this._proc?.kill?.('SIGTERM') } catch { /* ignore */ }
    this._proc = null
    for (const [, p] of this._pending) {
      try { p.reject(new Error('shutdown')) } catch { /* ignore */ }
    }
    this._pending.clear()
  }

  async sessionFork(fromSid, toSid, extra = {}) {
    return this._request('session.fork', { from: fromSid, to: toSid, ...extra })
  }

  async sessionDelete(sid) {
    return this._request('session.delete', { sid })
  }

  /** Native capability status for a sidecar session (rails, tools, gate asks). */
  async capabilitiesStatus(sid) {
    await this.ensureStarted()
    return this._request('capabilities.status', { sid: String(sid) })
  }

  /** Adapter-owned agent-core memory: op list|show|search|clear (clear needs confirm: true). */
  async memoryOp(params = {}) {
    await this.ensureStarted()
    return this._request('memory.op', params)
  }

  async sessionHistory(sid) {
    return this._request('session.history', { sid })
  }

  sessionCompact(sid, extra = {}) {
    return this._request('session.compact', { sid, ...extra })
  }

  async cancel(sid) {
    return this._request('turn.cancel', { sid })
  }

  /**
   * Run one agent turn. Yields DSH StreamChunks; always finishes with stop|aborted|error.
   *
   * @param {object} options GenerateOptions-like
   * @param {{ jiuwenSessionId: string }} mapping
   * @param {{
   *   query?: string,
   *   tools?: object[],
   *   system?: string,
   *   images?: string[],
   *   model?: object,
   *   cwd?: string,
   *   overrides?: object,
   *   onEvent?: Function,
   *   onTurnEnd?: Function,
   *   mark?: Function,
   * }} [turn]
   */
  async *stream(options, mapping, turn = {}) {
    const signal = options?.signal
    const sid = String(mapping?.jiuwenSessionId || options?.sessionId || 'anonymous')
    const text = { index: 0, body: '', started: false }
    const reasoning = { index: 1, body: '', started: false }
    // openjiuwen emits streamed llm_output then a final `answer` that duplicates
    // the same text (see agent_teams/monitor/stream_logger.py). Keep one.
    let seenLlmOutput = false
    let usage
    let finished = false
    let aborted = Boolean(signal?.aborted)
    let pendingQuestion

    const queue = []
    let wake
    const waiters = []
    const push = (item) => {
      queue.push(item)
      if (wake) { const w = wake; wake = null; w() }
    }
    const take = () => new Promise((resolve) => {
      if (queue.length) resolve(queue.shift())
      else wake = () => resolve(queue.shift())
    })

    const hostToolNames = new Set(normalizeTools(turn.tools ?? options?.tools).map(t => t.name))
    const emitEvent = (e) => {
      try { turn.onEvent?.(e) } catch { /* ignore */ }
    }

    const handleToolCall = async (params) => {
      const callId = params.callId
      const name = params.name
      const args = stripNullishArgs(params.args || {})
      // mirror: native planning syncing dsh todo_write — runs through dsh, but is not a model step.
      const mirror = params.mirror === true
      emitEvent({ type: 'tool_call', name, id: callId, arguments: args, raw: params, ...(mirror ? { mirror: true } : {}) })
      if (!mirror && this.surfaceToolEvents && this.eventDisplay === 'reasoning' && this.forwardReasoning) {
        const label = `🔧 ${name}(${safeArgs(args)})\n`
        if (!reasoning.started) {
          reasoning.started = true
          push({ chunk: { type: 'block-start', index: reasoning.index, blockType: 'reasoning' } })
        }
        reasoning.body += label
        push({ chunk: { type: 'reasoning-delta', index: reasoning.index, text: label } })
      }
      let ok = true
      let content
      try {
        if (typeof this.executeTool !== 'function') {
          ok = false
          content = `executeTool unavailable for ${name}`
        } else {
          content = await this.executeTool(name, args, {
            callId,
            sessionId: sid,
            signal,
            dshSessionId: options?.sessionId,
          })
        }
      } catch (e) {
        ok = false
        content = e?.message || String(e)
      }
      emitEvent({
        type: 'tool_result',
        name,
        id: callId,
        success: ok,
        result: typeof content === 'string' ? content : JSON.stringify(content),
        raw: { ok, content },
      })
      try {
        await this._request('tool.result', { callId, ok, content })
      } catch (e) {
        this.logger?.warn?.(`[agent-core] tool.result failed: ${e?.message || e}`)
      }
    }

    // Native agent-core capabilities ask dsh: permission (gate rail) / interaction (interrupt rails).
    // Fail closed: no interactive host → deny.
    const handleHostRequest = async (params) => {
      const callId = params.callId
      let content
      try {
        content = await answerHostRequest(params, turn.interact, signal)
      } catch (e) {
        content = { allow: false, outcome: `error: ${String(e?.message || e).slice(0, 200)}` }
      }
      emitEvent({ type: 'host_request', kind: params.kind, id: callId, outcome: content?.outcome ?? (content?.answer ? 'answered' : undefined) })
      try {
        await this._request('tool.result', { callId, ok: true, content })
      } catch (e) {
        this.logger?.warn?.(`[agent-core] host.request reply failed: ${e?.message || e}`)
      }
    }

    const onEvt = (msg) => {
      if (msg.event === '_process_exit') {
        push({ error: new Error(msg.params?.error || 'sidecar exited') })
        return
      }
      // One sidecar serves concurrent sessions; never consume another turn's
      // chunks, approvals or host callbacks (which would execute tools twice).
      if (msg.params?.sid && msg.params.sid !== sid) return
      if (msg.event === 'host.request') {
        Promise.resolve()
          .then(() => handleHostRequest(msg.params || {}))
          .catch((e) => this.logger?.warn?.(`[agent-core] host.request handler: ${e?.message || e}`))
        return
      }
      if (msg.event === 'tool.call') {
        // Do not await inside the listener; schedule.
        Promise.resolve()
          .then(() => handleToolCall(msg.params || {}))
          .catch((e) => this.logger?.warn?.(`[agent-core] tool handler: ${e?.message || e}`))
        return
      }
      if (msg.event !== 'chunk') return
      const { type, payload } = msg.params || {}
      if (!type) return
      emitEvent({ type: 'chunk', chunkType: type, payload, raw: msg.params })
      if (type === 'adapter_phase') {
        emitEvent({ type: 'adapter_phase', phases: payload, sid: msg.params?.sid })
        return
      }

      if ((type === 'tool_call' || type === 'tool_result') && payload?.tool_name && !hostToolNames.has(String(payload.tool_name))) {
        // Native agent-core tool (skill_tool, todo_*, memory_*, task_tool, …): runs in the sidecar.
        emitEvent({ type: type === 'tool_call' ? 'native_tool_call' : 'native_tool_result', name: String(payload.tool_name) })
      }
      if (type === 'llm_output') {
        const delta = extractText(payload)
        if (delta) {
          seenLlmOutput = true
          for (const c of emitTextDelta(text.index, delta, text)) push({ chunk: c })
          text.body += delta
        }
      } else if (type === 'answer') {
        // Final answer chunk: only use when no streamed llm_output arrived
        // (non-streaming providers). Otherwise it duplicates the stream.
        if (!seenLlmOutput) {
          const delta = extractText(payload)
          if (delta) {
            for (const c of emitTextDelta(text.index, delta, text)) push({ chunk: c })
            text.body += delta
          }
        }
      } else if (type === 'llm_reasoning') {
        const delta = extractText(payload) || extractReasoning(payload)
        if (delta) {
          // Always surface as a structured reasoning event (parity with Gateway EVENTS.REASONING).
          emitEvent({ type: 'reasoning', text: delta })
          if (this.forwardReasoning && this.eventDisplay !== 'markers') {
            if (!reasoning.started) {
              reasoning.started = true
              push({ chunk: { type: 'block-start', index: reasoning.index, blockType: 'reasoning' } })
            }
            reasoning.body += delta
            push({ chunk: { type: 'reasoning-delta', index: reasoning.index, text: delta } })
          }
        }
      } else if (type === 'llm_usage' || type === 'context.usage') {
        const u = normalizeUsage(payload)
        if (u) {
          usage = u
          emitEvent({ type: 'usage', usage: u, raw: payload })
        }
      } else if (type === 'tool_call' && this.surfaceToolEvents && this.eventDisplay === 'markers') {
        const name = payload?.tool_name || payload?.name || 'tool'
        const label = `[jiuwen-tool:${name}]`
        for (const c of emitTextDelta(text.index, label, text)) push({ chunk: c })
        text.body += label
      } else if (type === 'tool_result' && this.surfaceToolEvents && this.eventDisplay === 'markers') {
        const label = `[jiuwen-tool-result]`
        for (const c of emitTextDelta(text.index, label, text)) push({ chunk: c })
        text.body += label
      }
    }

    const unsub = this.onEvent(onEvt)
    const onAbort = () => {
      aborted = true
      this.cancel(sid).catch(() => {})
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })

    let turnError
    const startPromise = (async () => {
      try {
        await this.ensureStarted()
        turn.mark?.('agentcore-start')
        const tools = normalizeTools(turn.tools ?? options?.tools)
        const model = turn.model || buildModelSpec(options, turn.overrides)
        const images = turn.images || extractImageUrls(options)
        const query = turn.query != null ? String(turn.query) : lastUserText(options)
        const system = turn.system ?? options?.system
        const cwd = turn.cwd || turn.overrides?.projectDir || options?.cwd
        await this._request('turn.start', {
          sid,
          query,
          ...(system ? { system: String(system) } : {}),
          tools,
          model,
          ...(images.length ? { images } : {}),
          ...(cwd ? { cwd: String(cwd) } : {}),
          ...(turn.plan ? { plan: turn.plan } : {}),
          ...(turn.features ? { features: turn.features } : {}),
          ...(turn.runKind ? { runKind: turn.runKind } : {}),
        })
      } catch (e) {
        turnError = e
        push({ error: e })
      } finally {
        push({ done: true })
      }
    })()

    try {
      while (true) {
        const item = await take()
        if (item?.chunk) {
          yield item.chunk
          continue
        }
        if (item?.error && !finished) {
          turnError = item.error
        }
        if (item?.done || item?.error) break
      }
      await startPromise.catch(() => {})

      if (reasoning.started) {
        yield { type: 'block-end', index: reasoning.index, block: { type: 'reasoning', text: reasoning.body } }
      }
      const reason = aborted || signal?.aborted
        ? { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } }
        : turnError
          ? { kind: 'error', failure: { message: redactSecrets(String(turnError.message || turnError)), code: turnError.code || 'AGENTCORE' } }
          : { kind: 'stop' }
      if (usage && this.emitUsage && reason.kind === 'stop') {
        yield { type: 'usage', usage }
      }
      for (const c of finishText(text.index, text.body, text, reason)) yield c
      finished = true
      try {
        turn.onTurnEnd?.({ reason, requestId: sid, text: text.body, pendingQuestion })
      } catch { /* ignore */ }
    } finally {
      unsub()
      signal?.removeEventListener?.('abort', onAbort)
    }
  }
}


/** Drop null/undefined values so dsh JSON-schema validation accepts optional fields.
 * openjiuwen LocalFunction/SchemaUtils fills omitted optionals with null; dsh rejects null for boolean/number/string.
 */
export function stripNullishArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args || {}
  const out = {}
  for (const [k, v] of Object.entries(args)) {
    if (v === null || v === undefined) continue
    out[k] = v
  }
  return out
}

function safeArgs(args) {
  try {
    const s = JSON.stringify(args)
    return s.length > 120 ? `${s.slice(0, 117)}...` : s
  } catch {
    return ''
  }
}

function extractText(payload) {
  if (payload == null) return ''
  if (typeof payload === 'string') return payload
  if (typeof payload.output === 'string') return payload.output
  if (typeof payload.content === 'string') return payload.content
  if (typeof payload.text === 'string') return payload.text
  if (typeof payload.delta === 'string') return payload.delta
  return ''
}

function extractReasoning(payload) {
  if (!payload || typeof payload !== 'object') return ''
  return payload.reasoning_content || payload.reasoning || ''
}

function normalizeUsage(payload) {
  const u = payload?.usage || payload?.usage_metadata || payload
  if (!u || typeof u !== 'object') return undefined
  const input = Number(u.input_tokens ?? u.prompt_tokens ?? u.inputTokens ?? 0)
  const output = Number(u.output_tokens ?? u.completion_tokens ?? u.outputTokens ?? 0)
  const total = Number(u.total_tokens ?? u.totalTokens ?? (input + output))
  return { inputTokens: input, outputTokens: output, totalTokens: total }
}

/**
 * Answer a sidecar `host.request` through the dsh interactor (approval cards / question cards).
 * @returns {Promise<object>} permission → `{ allow, outcome }`; interaction → `{ answer, outcome }`
 */
export async function answerHostRequest(params = {}, interact, signal) {
  const kind = params.kind
  if (kind === 'permission') {
    const tool = String(params.tool || 'agent-core-tool')
    if (typeof interact !== 'function') return { allow: false, outcome: 'no-interactive-host' }
    const q = { header: `Permission: ${tool}`, question: `agent-core wants to run its native tool \`${tool}\`${params.args && Object.keys(params.args).length ? ` with ${safeArgs(params.args)}` : ''}. Allow once?`, tool_name: tool, tool_payload: params.args || {} }
    const r = await interact({ eventType: 'chat.ask_user_question', payload: { source: 'permission_interrupt', tool_name: tool, questions: [q] }, signal })
    const outcome = r?.outcome || 'unavailable'
    return { allow: outcome === 'allowed-once' || outcome === 'auto-allowed', outcome }
  }
  if (kind === 'interaction') {
    const req = params.request && typeof params.request === 'object' ? params.request : {}
    if (typeof interact !== 'function') return { answer: { approved: false, feedback: 'No interactive dsh host', answers: {} }, outcome: 'no-interactive-host' }
    const questions = Array.isArray(req.questions) ? req.questions : []
    if (questions.length) {
      // AskUserRail: answers keyed by question text.
      const r = await interact({ eventType: 'chat.ask_user_question', payload: { source: 'agentcore_ask_user', questions }, signal, told: true })
      const answers = {}
      const got = Array.isArray(r?.answers) ? r.answers : []
      questions.forEach((qq, i) => {
        const a = got[i] || {}
        const sel = Array.isArray(a.selected_options) ? a.selected_options.filter(Boolean) : []
        const text = a.custom_input ? String(a.custom_input) : sel.join(', ')
        if (text) answers[String(qq.question || qq.header || `q${i + 1}`)] = text
      })
      return { answer: { answers }, outcome: Object.keys(answers).length ? 'answered' : (r?.outcome || 'unanswered') }
    }
    // ConfirmInterruptRail (or any tool-level confirm): one approval.
    const tool = String(req.tool_name || 'agent-core-tool')
    const q = { header: `Permission: ${tool}`, question: String(req.message || `Run \`${tool}\`?`).slice(0, 2000), tool_name: tool, tool_payload: req.tool_args && typeof req.tool_args === 'object' ? req.tool_args : {} }
    const r = await interact({ eventType: 'chat.ask_user_question', payload: { source: 'confirm_interrupt', tool_name: tool, questions: [q] }, signal })
    const outcome = r?.outcome || 'unavailable'
    const approved = outcome === 'allowed-once' || outcome === 'auto-allowed'
    return { answer: { approved, feedback: approved ? '' : `denied by dsh (${outcome})` }, outcome }
  }
  return { allow: false, outcome: `unsupported host request: ${String(kind)}` }
}

export function normalizeTools(tools) {
  if (!Array.isArray(tools)) return []
  return tools.map((t) => {
    const name = t?.name || t?.function?.name
    if (!name) return null
    const description = t.description || t.function?.description || ''
    const parameters = t.parameters || t.inputSchema || t.function?.parameters || {
      type: 'object',
      properties: {},
    }
    return { name: String(name), description: String(description), parameters }
  }).filter(Boolean)
}

export function buildModelSpec(options = {}, overrides = {}) {
  const modelName = overrides.modelName || options.model || 'jiuwen-default'
  const provider = overrides.modelProvider || options.modelProvider || process.env.AGENTCORE_MODEL_PROVIDER || 'OpenAI'
  const apiBase = overrides.apiBase || options.apiBase || process.env.AGENTCORE_API_BASE || 'http://127.0.0.1:9/v1'
  const apiKeyEnv = overrides.apiKeyEnv || options.apiKeyEnv || process.env.AGENTCORE_API_KEY_ENV || 'JIUWEN_API_KEY'
  // Fake model when explicitly requested or provider is fake.
  if (process.env.AGENTCORE_FAKE_MODEL === '1' || String(provider).toLowerCase() === 'fake') {
    return { provider: 'fake', api_base: apiBase, api_key_env: apiKeyEnv, model: String(modelName) }
  }
  const spec = {
    provider: String(provider),
    api_base: String(apiBase),
    api_key_env: String(apiKeyEnv),
    model: String(modelName),
  }
  const temp = overrides.temperature ?? options.temperature
  const maxTok = overrides.max_tokens ?? overrides.maxTokens ?? options.maxTokens
  const topP = overrides.top_p ?? overrides.topP ?? options.topP
  if (temp != null) spec.temperature = temp
  if (maxTok != null) spec.max_tokens = maxTok
  if (topP != null) spec.top_p = topP
  return spec
}

export function extractImageUrls(options) {
  const urls = []
  for (const message of options?.messages || []) {
    const content = message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type === 'image') {
        const att = block.attachment || {}
        const dataUrl = att.dataUrl || att.dataURL || block.dataUrl
        const base64 = att.base64 || block.base64
        const mime = att.mimeType || 'image/png'
        if (typeof dataUrl === 'string' && dataUrl.startsWith('data:')) urls.push(dataUrl)
        else if (typeof base64 === 'string' && base64) urls.push(`data:${mime};base64,${base64}`)
      }
    }
  }
  return urls
}

function lastUserText(options) {
  const msgs = options?.messages || []
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role === 'user') {
      const c = msgs[i].content
      if (typeof c === 'string') return c
      if (Array.isArray(c)) {
        return c.filter((b) => b?.type === 'text').map((b) => b.text || '').join('\n')
      }
    }
  }
  return ''
}

export default AgentCoreTransport
