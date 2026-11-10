import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hostToolExec, unwrapToolBatch, stripNullishToolArgs, toolResultText } from '../src/tool-exec.js'

test('stripNullishToolArgs drops null/undefined and leaves the rest', () => {
  assert.deepEqual(stripNullishToolArgs({ command: 'ls', timeout: null, cwd: undefined, extra: 0 }), { command: 'ls', extra: 0 })
  assert.deepEqual(stripNullishToolArgs(null), {})
  assert.deepEqual(stripNullishToolArgs(['x']), ['x'])
})

test('hostToolExec sends the dsh 0.2.2 batch shape and the legacy single-exec keys', () => {
  const agent = { id: 's' }
  const signal = AbortSignal.abort()
  const exec = hostToolExec({ callId: 'c1', name: 'bash', args: { command: 'echo hi', timeout: null }, agent, signal })
  assert.equal(exec.callId, 'c1')
  assert.equal(exec.name, 'bash')
  assert.deepEqual(exec.arguments, { command: 'echo hi' })
  assert.equal(exec.agent, agent)
  assert.equal(exec.signal, signal)
  assert.equal(exec.calls.length, 1)
  assert.equal(exec.calls[0].type, 'tool-call')
  assert.equal(exec.calls[0].id, 'c1')
  assert.equal(exec.calls[0].name, 'bash')
  assert.equal(JSON.parse(exec.calls[0].arguments).command, 'echo hi')
  assert.equal('timeout' in JSON.parse(exec.calls[0].arguments), false)
})

test('unwrapToolBatch returns the matching inner result; other shapes pass through', () => {
  const inner = { content: [{ type: 'text', text: 'ok' }] }
  assert.equal(unwrapToolBatch({ results: [{ callId: 'c1', result: inner }] }, 'c1'), inner)
  assert.equal(unwrapToolBatch({ results: [{ callId: 'other', result: inner }, { callId: 'c1', result: { isError: true } }] }, 'c1').isError, true)
  assert.equal(unwrapToolBatch({ results: [{ callId: 'x', result: inner }] }, 'missing'), inner)
  assert.deepEqual(unwrapToolBatch(inner, 'c1'), inner)
  assert.equal(unwrapToolBatch('plain', 'c1'), 'plain')
  assert.equal(toolResultText(inner), 'ok')
  assert.equal(toolResultText({ isError: true, error: { message: 'denied' } }), 'denied')
})
