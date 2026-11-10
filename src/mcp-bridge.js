/**
 * Opt-in dsh → Jiuwen tool passthrough over MCP (toolPassthrough: 'mcp').
 *
 * Per-dsh-session MCP servers: each dsh session gets its own Jiuwen registration
 * (`mcpServerName-<sha16>`) and its own proxy stateDir, so tools/call is attributed
 * to the calling session (Bug 5: no cross-session ownerOf guessing).
 *
 * Serves allowlisted dsh tool schemas on a private 127.0.0.1 HTTP endpoint (path
 * /mcp/<sessionKey>, random bearer token) and executes tools/call inside dsh via
 * dsh's own tool execution pipeline (ToolRuntime.execute: pre-execute policy, sandbox guards,
 * approval policy, execute wrappers, post-execute, finalizers) when toolApproval: 'host' (default),
 * so a Jiuwen-issued call behaves like a native dsh call. 'dsh' keeps the legacy per-call
 * ctx.approval gate + direct def.execute; 'none' runs the definition directly.
 *
 * Jiuwen never connects to that endpoint directly. One stable stdio MCP proxy
 * (bin/jiuwen-mcp-proxy.mjs) is registered per dsh session under a unique name
 * and owned by Jiuwen; each dsh process drops an endpoint file into that
 * session's state dir. releaseSession() cleans up on session end, after
 * `mcpSessionIdleMs` without a turn or tool call, and (only for registrations no
 * live process still serves) at startup via a one-shot garbage collection of
 * stale `<mcpServerName>-<sha16>` custom servers.
 */
import { createServer } from 'node:http'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, renameSync, unlinkSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { redactSecrets } from './redact.js'
import { hostToolExec, unwrapToolBatch } from './tool-exec.js'

export const PROXY_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'jiuwen-mcp-proxy.mjs')
const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return d } }
const writeAtomic = (f, data, mode = 0o600) => { const t = `${f}.${process.pid}.tmp`; writeFileSync(t, data, { mode }); renameSync(t, f) }

/** Stable short MCP server name for one dsh session. */
export function sessionMcpName(base, sessionId) {
  const h = createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 16)
  return `${base}-${h}`
}

/** Content revision of a published schema union (order-independent). */
export function schemasRev(list) {
  const sorted = [...(list || [])].sort((a, b) => String(a.name).localeCompare(String(b.name)))
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 12)
}

/**
 * Desired Jiuwen registration for the stable proxy. `rev` (the schema-union revision) is part of
 * the args on purpose: Jiuwen derives the MCP server_id from the registration payload and keeps a
 * spawned stdio server cached per server_id (also across mcp.disconnect/connect), so its tool
 * index only re-lists when the payload changes. The proxy ignores the extra arg.
 */
export function proxyRegistration(name, stateDir, callTimeoutMs, rev) {
  return { name, transport: 'stdio', command: process.execPath, args: rev ? [PROXY_PATH, stateDir, `--rev=${rev}`] : [PROXY_PATH, stateDir], timeout_s: Math.ceil(callTimeoutMs / 1000) }
}

/**
 * Is Jiuwen's persisted record already our connected proxy (same command/args and, when Jiuwen
 * recorded one, the same timeout_s)? A changed call budget must reach Jiuwen: an old record kept
 * `timeout_s: 120` and Jiuwen abandoned calls dsh was still running (or still asking about).
 */
export function isProxyConnected(record, reg) {
  return Boolean(record && record.state === 'connected' && record.transport === 'stdio'
    && record.command === reg.command && JSON.stringify(record.args || []) === JSON.stringify(reg.args)
    && (record.timeout_s === undefined || reg.timeout_s === undefined || Number(record.timeout_s) === Number(reg.timeout_s)))
}

/**
 * Transport deadline of one Jiuwen → dsh call (Jiuwen's MCP `timeout_s` and the stdio proxy's HTTP
 * wait). It only has to outlast dsh's own handling, which has no blanket cap natively (approval
 * waits for the user; dsh's per-tool timeout policy bounds the run), so: explicit
 * `mcpCallTimeoutMs`, else the adapter's own optional caps + 5 s, else 1 h.
 */
export function mcpCallTimeoutMs(c = {}) {
  const explicit = Number(c.mcpCallTimeoutMs)
  if (Number.isFinite(explicit) && explicit > 0) return explicit
  const run = Math.max(0, Number(c.toolCallTimeoutMs) || 0)
  const ask = c.toolApproval === 'none' ? 0 : Math.max(0, Number(c.approvalTimeoutMs) || 0)
  return run > 0 ? run + ask + 5_000 : 3_600_000
}

/** One signal aborted when any of `signals` (falsy entries ignored) aborts. */
function anySignal(signals) {
  const ac = new AbortController()
  const list = signals.filter(Boolean)
  const on = () => ac.abort()
  for (const s of list) { if (s.aborted) { ac.abort(); break } s.addEventListener?.('abort', on, { once: true }) }
  return { signal: ac.signal, abort: () => ac.abort(), dispose() { for (const s of list) s.removeEventListener?.('abort', on) } }
}

const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e?.code === 'EPERM' } }
/** Tool names advertised by live ep-<pid>.json endpoint files (dead pids ignored). */
export function liveToolNames(dir) {
  const out = new Set()
  let files = []
  try { files = readdirSync(dir).filter(n => /^ep-\d+\.json$/.test(n)) } catch { return out }
  for (const n of files) {
    const e = readJson(join(dir, n), null)
    if (e && Number(e.pid) && alive(Number(e.pid))) for (const t of e.tools || []) out.add(t)
  }
  return out
}

/** Live endpoint files in `dir` other than `selfFile` (dead pids ignored). */
export function otherLiveEndpoints(dir, selfFile) {
  let files = []
  try { files = readdirSync(dir).filter(n => /^ep-\d+\.json$/.test(n)) } catch { return 0 }
  let n = 0
  for (const f of files) {
    const p = join(dir, f)
    if (selfFile && p === selfFile) continue
    const e = readJson(p, null)
    if (e && Number(e.pid) && Number(e.pid) !== process.pid && alive(Number(e.pid))) n++
  }
  return n
}

/** Did the host mark this tool schema for Jiuwen passthrough? */
export function hostDeclaredPassthrough(t) {
  return Boolean(t && (t.passthrough === true || t.meta?.jiuwenPassthrough === true || t.metadata?.jiuwenPassthrough === true))
}

export function matchesAllowlist(name, list) {
  return (list || []).some((p) => {
    if (p === '*') return true
    if (p.endsWith('*')) return name.startsWith(p.slice(0, -1))
    return p === name
  })
}

const FS_HINT = new Set(['bash', 'write', 'edit', 'read', 'glob', 'grep'])
const describeTool = (s) => {
  let d = String(s.description || s.name)
  if (FS_HINT.has(s.name)) d = `[PREFERRED sandboxed dsh path — use instead of Jiuwen built-in] ${d}`
  return d.slice(0, 4000)
}

export function createMcpBridge({ config, services, rpc, logger }) {
  let server, listenReady, token
  /** sessionId → { key, name, stateDir, schemas: Map, epFile, needsRegister } */
  const sessions = new Map()
  /** sessionKey → sessionId (path routing) */
  const byKey = new Map()

  const cfg = () => config()
  const rootStateDir = () => cfg().mcpStateDir || join(homedir(), '.cache', 'dsh-jiuwen', 'mcp', cfg().mcpServerName)
  const jiuwenState = () => cfg().jiuwenMcpStateFile || join(process.env.JIUWEN_HOME || join(homedir(), '.jiuwenswarm'), 'agent', 'workspace', 'mcp', 'state.json')

  const toText = (v) => {
    if (typeof v === 'string') return v
    if (v && Array.isArray(v.content)) return v.content.map(b => (b?.type === 'text' ? b.text : JSON.stringify(b))).join('\n')
    try { return JSON.stringify(v) } catch { return String(v) }
  }

  function ensureEntry(sessionId) {
    let e = sessions.get(sessionId)
    if (e) return e
    const key = createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 16)
    const name = sessionMcpName(cfg().mcpServerName, sessionId)
    const stateDir = join(rootStateDir(), 's', key)
    e = { key, name, stateDir, schemas: new Map(), admitted: new Set(), turnSignal: undefined, epFile: undefined, needsRegister: false, registered: false, sessionId, lastUsed: Date.now(), inflight: 0 }
    sessions.set(sessionId, e)
    byKey.set(key, sessionId)
    return e
  }

  /**
   * Pick the dsh ToolRuntime that runs a passthrough call through dsh's own execution pipeline
   * (tools/pre-execute policy + guards + ask→ctx.approval, tools/execute wrappers such as the
   * per-tool timeout policy, tools/post-execute, content finalizers, tools/result observers).
   * Only a runtime with `execute(exec)` and a live calling agent qualifies; anything else falls
   * back to the legacy per-call gate (see `toolApproval`).
   */
  function hostRuntime(tools, agent, name) {
    if (!agent) return undefined
    const candidates = [tools, agent.ctx?.tools].filter((r) => r && typeof r.execute === 'function')
    for (const r of candidates) {
      try { if (typeof r.get !== 'function' || r.get(name, agent)) return r } catch { /* try next */ }
    }
    // No runtime sees the tool for this agent: still let the root runtime answer (it reports UNKNOWN_TOOL
    // exactly like a native call would) instead of resolving an unscoped definition.
    return candidates[0]
  }

  /**
   * Optional adapter-side cap on one passthrough call (0 = none, the default: as for a native call,
   * dsh's per-tool timeout policy bounds the run and an approval waits for the user or the turn).
   */
  const callCapMs = (c) => {
    const run = Math.max(0, Number(c.toolCallTimeoutMs) || 0)
    if (!run) return 0
    return run + (c.toolApproval === 'none' ? 0 : Math.max(0, Number(c.approvalTimeoutMs) || 0))
  }

  /**
   * Admission: callable when this session admitted it at any prepare() (allowlist or host-declared),
   * not only in the latest request, or when it is in the published schemas.json (the union Jiuwen
   * was shown) and matches the current allowlist. dsh's registry then decides visibility for the
   * agent exactly as for a native call (UNKNOWN_TOOL otherwise).
   */
  function admitted(e, name) {
    if (!e) return false
    if (e.schemas.has(name) || e.admitted.has(name)) return true
    const onDisk = readJson(join(e.stateDir, 'schemas.json'), [])
    if (Array.isArray(onDisk) && onDisk.some(t => t?.name === name) && matchesAllowlist(name, cfg().toolAllowlist)) { e.admitted.add(name); return true }
    return false
  }

  async function callTool(sessionId, name, args, callerSignal) {
    const c = cfg()
    const e = sessions.get(sessionId)
    if (!admitted(e, name)) {
      return { isError: true, text: `tool ${name} is not exposed by dsh (session=${sessionId})` }
    }
    const { tools, approval, agents } = services()
    let agent
    try { agent = agents?.get?.(sessionId) } catch { agent = undefined }
    const mode = c.toolApproval || 'host'
    const finish = (text) => (c.skillLoaderTool && name === c.skillLoaderTool && c.redactSkillOutput !== false ? redactSecrets(text) : text)

    const runtime = mode === 'host' ? hostRuntime(tools, agent, name) : undefined
    if (runtime) {
      // 'host': dsh decides, exactly as for a native call. Approval policy `never` + a pre-execute
      // `allow` runs the tool; a real `ask` goes to ctx.approval (and `never` rejects it, as natively).
      // Cancellation as for a native call: the dsh turn's signal (and a dropped proxy connection).
      e.lastUsed = Date.now(); e.inflight++
      const fused = anySignal([callerSignal, e.turnSignal])
      const cap = callCapMs(c)
      const t = cap ? setTimeout(fused.abort, cap) : undefined
      try {
        // dsh >=0.2.2 batch + older single-exec (same payload as agent-core).
        const callId = `jiuwen-${randomUUID()}`
        const exec = hostToolExec({ callId, name, args: args ?? {}, agent, signal: fused.signal })
        // The call arrives on the proxy socket, outside the agent driver's async context. Re-enter that
        // context for the exact live agent (as a native call runs), so tools that authenticate their
        // caller through ctx.agents.currentInitiator() (dsh-tool-goal's create_goal / update_goal /
        // get_goal: GOAL_TOOL_DRIVER_REQUIRED) see the same agent a native call would.
        const run = () => runtime.execute(exec)
        const live = typeof agents?.withInitiator === 'function' && agents.get?.(sessionId) === agent
        const result = unwrapToolBatch(await (live ? agents.withInitiator(agent, run) : run()), callId)
        return { isError: Boolean(result?.isError), text: finish(toText(result)) }
      } catch (error) {
        return { isError: true, text: `dsh tool ${name} failed: ${error?.message || error}` }
      } finally {
        clearTimeout(t); fused.dispose()
        e.inflight--; e.lastUsed = Date.now()
      }
    }

    // Legacy path: 'dsh' (explicit), 'host' without a usable runtime, or 'none'.
    if (mode === 'host') logger?.debug?.(`[dsh-jiuwen] toolApproval=host: no dsh tools runtime/agent for ${name}; using the per-call approval gate`)
    let def
    try { def = agent ? tools?.get?.(name, agent) ?? agent.ctx?.tools?.get?.(name, agent) : undefined } catch { def = undefined }
    if (!def?.execute) def = tools?.get?.(name)
    if (!def?.execute) return { isError: true, text: `dsh tool ${name} not found (session=${sessionId})` }
    if (mode !== 'none' && !matchesAllowlist(name, c.toolApprovalExempt || [])) {
      let outcome = 'unavailable'
      if (approval?.request && agent) {
        let timer
        try {
          const races = [Promise.resolve(approval.request({ agent, toolName: name, reason: `JiuwenSwarm wants to run dsh tool ${name}`, ...(callerSignal ? { signal: callerSignal } : {}) }))]
          if (Number(c.approvalTimeoutMs) > 0) races.push(new Promise(r => { timer = setTimeout(() => r('timeout'), c.approvalTimeoutMs); timer.unref?.() }))
          outcome = await Promise.race(races)
        } catch { outcome = 'unavailable' } finally { clearTimeout(timer) }
      }
      if (outcome !== 'allowed-once') return { isError: true, text: `dsh denied ${name} (${outcome})` }
    }
    e.lastUsed = Date.now(); e.inflight++
    const fused = anySignal([callerSignal, e.turnSignal])
    const run = Math.max(0, Number(c.toolCallTimeoutMs) || 0)
    const t = run ? setTimeout(fused.abort, run) : undefined
    try {
      const result = await def.execute(args ?? {}, {
        callId: `jiuwen-${randomUUID()}`, name, arguments: args ?? {}, agent, signal: fused.signal,
        deferContext() {}, concludeTurn() {},
      })
      // The skill loader returns host skill bodies (prompt text, like the index-mode injection): mask secrets.
      return { isError: false, text: finish(toText(result)) }
    } catch (error) {
      return { isError: true, text: `dsh tool ${name} failed: ${error?.message || error}` }
    } finally { clearTimeout(t); fused.dispose(); e.inflight--; e.lastUsed = Date.now() }
  }

  async function handle(sessionId, msg, signal) {
    const e = sessions.get(sessionId)
    const { id, method, params } = msg || {}
    const ok = (result) => ({ jsonrpc: '2.0', id, result })
    if (method === 'initialize') {
      return ok({ protocolVersion: params?.protocolVersion || '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: e?.name || cfg().mcpServerName, version: '0.1.0' } })
    }
    if (method === 'ping') return ok({})
    if (method === 'tools/list') {
      const list = [...(e?.schemas.values() || [])]
        .map(s => ({ name: s.name, description: describeTool(s), inputSchema: s.parameters || s.inputSchema || { type: 'object', properties: {} } }))
      return ok({ tools: list })
    }
    if (method === 'tools/call') {
      const r = await callTool(sessionId, String(params?.name || ''), params?.arguments, signal)
      return ok({ content: [{ type: 'text', text: r.text.slice(0, 200_000) }], isError: r.isError })
    }
    if (id === undefined) return null
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } }
  }

  /** Merge this session's schemas into its union; returns the union's revision. */
  function publishSchemas(e) {
    mkdirSync(e.stateDir, { recursive: true, mode: 0o700 })
    const f = join(e.stateDir, 'schemas.json')
    const prev = readJson(f, [])
    // Never shrink: pruning made the union shrink and regrow, and each regrowth forced a reconnect
    // that dropped the server from every live Jiuwen session. Stale names just error on call.
    const byName = new Map(prev.map(t => [t.name, t]))
    for (const sch of e.schemas.values()) {
      byName.set(sch.name, { name: sch.name, description: describeTool(sch), inputSchema: sch.parameters || sch.inputSchema || { type: 'object', properties: {} } })
    }
    const union = [...byName.values()]
    writeAtomic(f, JSON.stringify(union), 0o644)
    return schemasRev(union)
  }

  async function ensureRegistered(e, rev) {
    // Same process, same revision, already registered: skip RPC (unit tests' mock rpc does not
    // write jiuwen state.json; live Gateway keeps the record between prepares).
    if (e.registered && e.lastRev === rev && !e.needsRegister) return { reused: true, rev }
    const c = cfg()
    // Jiuwen's MCP call timeout covers the whole call (approval wait + run) plus a margin, so the
    // adapter's own deadline answers first and Jiuwen never abandons a call that is still running.
    const reg = proxyRegistration(e.name, e.stateDir, mcpCallTimeoutMs(c), rev)
    const record = readJson(jiuwenState(), {})?.mcp?.[e.name]
    const timeoutMs = c.mcpRpcTimeoutMs ?? 30_000
    if (isProxyConnected(record, reg)) { e.lastRev = rev; return { reused: true, rev } }
    // Our proxy at an older schema revision: a plain disconnect/connect would reuse Jiuwen's cached
    // stdio server (stale tools/list, so tool_search never finds the new tools). Re-register with
    // the new revision so Jiuwen spawns a fresh proxy and re-indexes.
    const stale = record?.state === 'connected' && record.transport === 'stdio' && record.command === reg.command
      && (record.args || [])[0] === PROXY_PATH && (record.args || [])[1] === reg.args[1]
    if (stale) await rpc('mcp.disconnect', { name: reg.name }, { timeoutMs })
    await rpc('mcp.register_custom', reg, { timeoutMs })
    const r = await rpc('mcp.connect', { name: reg.name }, { timeoutMs })
    e.lastRev = rev
    return stale ? { reconnected: true, rev, connect: r } : { registered: true, rev, connect: r }
  }

  function writeEp(e) {
    if (!token || !server) return
    const port = server.address()?.port
    if (!port) return
    const url = `http://127.0.0.1:${port}/mcp/${e.key}`
    e.epFile = join(e.stateDir, `ep-${process.pid}.json`)
    mkdirSync(e.stateDir, { recursive: true, mode: 0o700 })
    writeAtomic(e.epFile, JSON.stringify({ pid: process.pid, url, token, ts: Date.now(), tools: [...new Set([...e.schemas.keys(), ...e.admitted])], sessionId: e.sessionId, callTimeoutMs: mcpCallTimeoutMs(cfg()) }))
    return url
  }

  function removeEp(e) {
    if (e?.epFile) { try { unlinkSync(e.epFile) } catch { /* gone */ } e.epFile = undefined }
  }

  const removeAllEps = () => { for (const e of sessions.values()) removeEp(e) }

  /**
   * Release one session: drop our endpoint; delete the Jiuwen registration + state dir unless
   * another live dsh process still serves this session (then only our endpoint goes).
   */
  async function release(sessionId, reason = 'release') {
    const e = sessions.get(sessionId)
    if (!e) return null
    sessions.delete(sessionId)
    byKey.delete(e.key)
    const self = e.epFile
    removeEp(e)
    const out = { name: e.name, reason }
    if (otherLiveEndpoints(e.stateDir, self) > 0) { out.shared = true; return out }
    const timeoutMs = cfg().mcpRpcTimeoutMs ?? 30_000
    try { out.disconnect = await rpc('mcp.disconnect', { name: e.name }, { timeoutMs }) } catch (err) { out.disconnect = String(err?.message || err) }
    try { out.delete = await rpc('mcp.delete_custom', { name: e.name }, { timeoutMs }) } catch (err) { out.delete = String(err?.message || err) }
    try { rmSync(e.stateDir, { recursive: true, force: true }) } catch { /* ignore */ }
    return out
  }

  // ── idle TTL: release sessions with no turn/tool call for mcpSessionIdleMs (0 = off) ──
  let sweeper
  const idleMs = () => { const v = Number(cfg().mcpSessionIdleMs ?? 30 * 60_000); return Number.isFinite(v) && v > 0 ? v : 0 }
  async function sweepIdle(now = Date.now()) {
    const ttl = idleMs()
    if (!ttl) return []
    const out = []
    for (const [id, e] of [...sessions]) {
      if (e.inflight > 0 || e.preparing > 0 || now - e.lastUsed < ttl) continue
      try { out.push(await release(id, 'idle')) } catch (err) { logger?.debug?.(`[dsh-jiuwen] idle MCP release failed: ${err?.message || err}`) }
    }
    if (out.length) logger?.info?.(`[dsh-jiuwen] released ${out.length} idle per-session MCP proxy registration(s)`)
    return out
  }
  function startSweeper() {
    const ttl = idleMs()
    if (sweeper || !ttl) return
    sweeper = setInterval(() => { sweepIdle().catch(() => {}) }, Math.max(1000, Math.min(60_000, Math.floor(ttl / 4))))
    sweeper.unref?.()
  }

  // ── startup GC of stale per-session registrations (once per bridge, fail-soft) ──
  let gcDone
  /**
   * Delete `<mcpServerName>-<sha16>` custom servers that no live process owns. Only touches names
   * whose state dir exists under this adapter's mcpStateDir (so registrations made by another host
   * or another state dir are never removed), has no live endpoint file, and has not been modified
   * for `mcpGcGraceMs` (so a process that is registering right now is left alone).
   */
  async function gcStale(now = Date.now()) {
    const c = cfg()
    if (c.mcpGcOnStart === false) return { skipped: true }
    const timeoutMs = c.mcpRpcTimeoutMs ?? 30_000
    const grace = Number(c.mcpGcGraceMs ?? 120_000)
    // Custom MCPs are only listed under filter 'local' (Jiuwen treats unknown filters, e.g. 'all',
    // as 'builtin' = marketplace packages only, which never contains our registrations). Union with
    // Jiuwen's persisted state.json so GC still works if the RPC shape differs or fails.
    const names = new Set()
    let rpcErr
    try {
      const listed = await rpc('mcp.list', { filter: 'local' }, { timeoutMs })
      for (const it of (Array.isArray(listed) ? listed : (listed?.items || listed?.servers || []))) names.add(String(it?.name || it?.id || it || ''))
    } catch (err) { rpcErr = String(err?.message || err) }
    for (const n of Object.keys(readJson(jiuwenState(), {})?.mcp || {})) names.add(n)
    if (!names.size && rpcErr) return { error: rpcErr }
    const items = [...names]
    const esc = String(c.mcpServerName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`^${esc}-([a-f0-9]{16})$`)
    const own = new Set([...sessions.values()].map(e => e.name))
    const removed = []
    const victims = []
    for (const it of items) {
      const name = String(it || '')
      const m = re.exec(name)
      if (!m || own.has(name)) continue
      const dir = join(rootStateDir(), 's', m[1])
      let st
      try { st = statSync(dir) } catch { continue } // not ours (or already cleaned): never touch
      if (now - st.mtimeMs < grace) continue
      if (otherLiveEndpoints(dir) > 0) continue
      victims.push({ name, dir })
    }
    // mcp.delete_custom already tears down a connected server (apply_mcp_change remove), so no
    // separate mcp.disconnect; run a few deletes concurrently (each costs Jiuwen ~2s).
    const conc = Math.max(1, Number(c.mcpGcConcurrency ?? 6))
    let i = 0
    await Promise.all(Array.from({ length: Math.min(conc, victims.length) }, async () => {
      while (i < victims.length) {
        const { name, dir } = victims[i++]
        try { await rpc('mcp.delete_custom', { name }, { timeoutMs }) } catch (err) { logger?.debug?.(`[dsh-jiuwen] MCP GC delete ${name}: ${err?.message || err}`); continue }
        try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
        removed.push(name)
      }
    }))
    if (removed.length) logger?.info?.(`[dsh-jiuwen] removed ${removed.length} stale per-session MCP registration(s)`)
    return { removed }
  }

  function startListen() {
    if (listenReady) return listenReady
    token = randomBytes(24).toString('hex')
    server = createServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return }
      if (req.method !== 'POST') { res.writeHead(405).end(); return }
      const m = /^\/mcp\/([a-f0-9]{16})\/?$/.exec(req.url || '')
      if (!m) { res.writeHead(404).end(); return }
      const sessionId = byKey.get(m[1])
      if (!sessionId) { res.writeHead(404).end(); return }
      let body = ''
      req.on('data', (d) => { body += d; if (body.length > 10_000_000) req.destroy() })
      // Caller gone (proxy killed / Jiuwen cancelled) before we answered: cancel the dsh call.
      const ac = new AbortController()
      res.on('close', () => { if (!res.writableEnded) ac.abort() })
      req.on('end', async () => {
        let msg
        try { msg = JSON.parse(body) } catch { res.writeHead(400).end(); return }
        const out = Array.isArray(msg)
          ? (await Promise.all(msg.map(x => handle(sessionId, x, ac.signal)))).filter(Boolean)
          : await handle(sessionId, msg, ac.signal)
        if (res.destroyed) return
        if (!out || (Array.isArray(out) && !out.length)) { res.writeHead(202).end(); return }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out))
      })
    })
    server.unref?.()
    server.keepAliveTimeout = 1000
    server.on('connection', (sock) => sock.unref?.())
    listenReady = new Promise((resolve) => {
      server.once('error', (error) => resolve({ error: String(error?.message || error) }))
      server.listen(0, '127.0.0.1', () => {
        process.off('exit', removeAllEps); process.once('exit', removeAllEps) // compat-allow: ep-file cleanup, detached in stop()
        resolve({ ok: true })
      })
    })
    return listenReady
  }

  return {
    /**
     * Refresh exposed schemas for this dsh session; register a per-session MCP server.
     * Returns { url, mcpServerName, ... } — caller must put mcpServerName into chat.send mcp[].
     */
    async prepare(tools, sessionId, opts = {}) {
      const e = ensureEntry(sessionId)
      e.lastUsed = Date.now()
      // The dsh turn's abort signal: a cancelled turn cancels its in-flight passthrough calls.
      if (opts?.signal) e.turnSignal = opts.signal
      const c0 = cfg()
      // An empty tool list (e.g. host-sync's "make sure the proxy exists" call) is not a new turn's
      // tool set: keep the admitted schemas, or tools/call for them would fail as "not exposed".
      if (tools?.length || !e.schemas.size) e.schemas.clear()
      for (const t of tools || []) if (t?.name && (matchesAllowlist(t.name, c0.toolAllowlist) || (c0.toolHostDeclared !== false && hostDeclaredPassthrough(t)))) e.schemas.set(t.name, t)
      // hostSkillInject:index must keep skillLoaderTool reachable even under a restrictive allowlist.
      if (c0.hostSkillInject === 'index') {
        const loader = c0.skillLoaderTool || 'skill'
        const t = (tools || []).find((x) => x?.name === loader)
        if (t) e.schemas.set(t.name, t)
      }
      for (const n of e.schemas.keys()) e.admitted.add(n)
      if (!e.schemas.size) return null

      const lr = await startListen()
      if (lr?.error) return { error: lr.error, mcpServerName: e.name }
      startSweeper()
      // Normally already kicked off at plugin start (startGc); background, never delays the turn.
      if (!gcDone) { gcDone = gcStale().catch(() => ({})) }
      e.preparing = (e.preparing || 0) + 1

      const url = writeEp(e)
      try {
        const rev = publishSchemas(e)
        writeEp(e)
        const out = { url, mcpServerName: e.name, ...(await ensureRegistered(e, rev)) }
        e.needsRegister = false
        if (!out.error) e.registered = true
        logger?.info?.(`[dsh-jiuwen] dsh tools exposed via per-session MCP "${e.name}" (${e.schemas.size} schema(s), session=${sessionId})`)
        return out
      } catch (error) {
        logger?.warn?.(`[dsh-jiuwen] MCP passthrough registration failed: ${error?.message || error}`)
        return { url, mcpServerName: e.name, error: String(error?.message || error) }
      } finally { e.preparing--; e.lastUsed = Date.now() }
    },

    /** Drop one session's registration + endpoint (session end / dispose). */
    async releaseSession(sessionId) { return release(sessionId, 'session-end') },

    /** Release sessions idle for >= mcpSessionIdleMs (also runs on an unref'd timer). */
    sweepIdle,
    /** Startup GC of stale per-session registrations (runs once, in the background, on first prepare). */
    gcStale,
    /** Kick the one-shot GC early (plugin start), so stale proxies are gone before the first agent
     * is created: Jiuwen prewarms every connected MCP per new agent and indexes their tools. */
    startGc() { if (!gcDone) gcDone = gcStale().catch(() => ({})); return gcDone },

    exposed: (sessionId) => {
      if (sessionId) return [...(sessions.get(sessionId)?.schemas.keys() || [])]
      const all = new Set()
      for (const e of sessions.values()) for (const n of e.schemas.keys()) all.add(n)
      return [...all]
    },

    /**
     * Run one admitted dsh tool for a session exactly as a passthrough call would (dsh's pipeline,
     * the live agent's initiator context). Used by the goal bridge. Never throws: { isError, text }.
     */
    callTool: (sessionId, name, args, signal) => callTool(sessionId, name, args, signal),

    sessionServerName: (sessionId) => sessions.get(sessionId)?.name || sessionMcpName(cfg().mcpServerName, sessionId),

    async verify(sessionId) {
      const name = sessionId ? (sessions.get(sessionId)?.name || sessionMcpName(cfg().mcpServerName, sessionId)) : cfg().mcpServerName
      try {
        const r = await rpc('mcp.show', { name }, { timeoutMs: cfg().mcpRpcTimeoutMs ?? 30_000 })
        const it = r?.item || r || {}
        const tools = (Array.isArray(it.tools) ? it.tools : []).map(t => t?.name || t).filter(Boolean).map(String)
        return { name, registered: true, state: it.connection_state || it.state || 'unknown', category: it.category, tools, exposed: this.exposed(sessionId) }
      } catch (err) {
        const msg = String(err?.message || err)
        return { name, registered: /not found/i.test(msg) ? false : undefined, error: msg.slice(0, 200), tools: [], exposed: this.exposed(sessionId) }
      }
    },

    async dispose() {
      for (const e of sessions.values()) removeEp(e)
      process.off('exit', removeAllEps)
      if (sweeper) { clearInterval(sweeper); sweeper = undefined }
      if (server) { server.close(); server = undefined; listenReady = undefined }
      sessions.clear(); byKey.clear()
    },

    /** Explicit teardown of all session registrations (e.g. /jiuwen mcp-reset). */
    async unregister() {
      const timeoutMs = cfg().mcpRpcTimeoutMs ?? 30_000
      const out = { sessions: [] }
      for (const e of sessions.values()) {
        const one = { name: e.name }
        try { one.disconnect = await rpc('mcp.disconnect', { name: e.name }, { timeoutMs }) } catch (err) { one.disconnect = String(err?.message || err) }
        try { one.delete = await rpc('mcp.delete_custom', { name: e.name }, { timeoutMs }) } catch (err) { one.delete = String(err?.message || err) }
        e.needsRegister = true; e.registered = false
        out.sessions.push(one)
      }
      // Also try base name (legacy single-server registrations).
      const base = cfg().mcpServerName
      try { out.disconnect = await rpc('mcp.disconnect', { name: base }, { timeoutMs }) } catch (err) { out.disconnect = String(err?.message || err) }
      try { out.delete = await rpc('mcp.delete_custom', { name: base }, { timeoutMs }) } catch (err) { out.delete = String(err?.message || err) }
      return out
    },

    /** Test helper: handle as a given session (no HTTP). */
    _handle: (msg, sessionId = [...sessions.keys()][0]) => handle(sessionId, msg),
    _sessions: sessions,
  }
}
