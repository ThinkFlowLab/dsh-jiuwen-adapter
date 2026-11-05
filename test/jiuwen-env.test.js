import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  realHomedir, jiuwenHome, loadJiuwenDotEnv, agentcoreChildEnv, resolveAgentCoreModel,
} from '../src/jiuwen-env.js'

test('realHomedir ignores ephemeral HOME', () => {
  const prev = process.env.HOME
  process.env.HOME = '/tmp/dsh-both-agent-core-XXXX'
  try {
    const h = realHomedir()
    assert.ok(!h.includes('dsh-both'), h)
    assert.ok(h.startsWith('/home/') || process.env.JIUWEN_REAL_HOME, h)
  } finally {
    process.env.HOME = prev
  }
})

test('loadJiuwenDotEnv + agentcoreChildEnv + alias remap', () => {
  const prevHome = process.env.JIUWEN_HOME
  const dir = mkdtempSync(join(tmpdir(), 'jw-env-'))
  mkdirSync(join(dir, 'config'), { recursive: true })
  writeFileSync(join(dir, 'config/.env'), 'API_KEY=sk-testkey123\nAPI_BASE=https://example.test/v1\nMODEL_NAME=real-model\nMODEL_PROVIDER=OpenAI\n')
  process.env.JIUWEN_HOME = dir
  delete process.env.JIUWEN_API_KEY
  delete process.env.API_KEY
  delete process.env.API_BASE
  try {
    const jw = loadJiuwenDotEnv()
    assert.equal(jw.MODEL_NAME, 'real-model')
    assert.equal(jw.API_KEY, 'sk-testkey123')
    const child = agentcoreChildEnv()
    assert.equal(child.JIUWEN_API_KEY, 'sk-testkey123')
    assert.equal(child.AGENTCORE_API_BASE, 'https://example.test/v1')
    const m = resolveAgentCoreModel(
      { defaultModel: 'jiuwen-default', apiKeyEnv: 'JIUWEN_API_KEY', baseURL: 'http://127.0.0.1:18080/v1' },
      { model: 'jiuwen-default' },
      {},
    )
    assert.equal(m.model, 'real-model')
    assert.equal(m.api_base, 'https://example.test/v1')
    assert.equal(m.api_key_env, 'JIUWEN_API_KEY')
  } finally {
    if (prevHome == null) delete process.env.JIUWEN_HOME
    else process.env.JIUWEN_HOME = prevHome
    rmSync(dir, { recursive: true, force: true })
  }
})

test('jiuwenHome uses JIUWEN_HOME override', () => {
  const prev = process.env.JIUWEN_HOME
  process.env.JIUWEN_HOME = '/tmp/custom-jw'
  try { assert.equal(jiuwenHome(), '/tmp/custom-jw') }
  finally {
    if (prev == null) delete process.env.JIUWEN_HOME
    else process.env.JIUWEN_HOME = prev
  }
})

test('realHomedir JIUWEN_REAL_HOME override wins over getent/HOME', () => {
  const prevR = process.env.JIUWEN_REAL_HOME
  process.env.JIUWEN_REAL_HOME = '/custom/real/home'
  try {
    assert.equal(realHomedir(), '/custom/real/home')
  } finally {
    if (prevR == null) delete process.env.JIUWEN_REAL_HOME
    else process.env.JIUWEN_REAL_HOME = prevR
  }
})

test('first() empty vals and resolveAgentCoreModel temperature/topP/fake', () => {
  const prev = process.env.AGENTCORE_FAKE_MODEL
  process.env.AGENTCORE_FAKE_MODEL = '1'
  try {
    const m = resolveAgentCoreModel(
      { defaultModel: 'm1', baseURL: 'http://127.0.0.1:9/v1' },
      { temperature: 0.2, maxTokens: 10, topP: 0.9 },
      { modelName: 'explicit-model' },
    )
    assert.equal(m.provider, 'fake')
    assert.equal(m.model, 'explicit-model')
    assert.equal(m.temperature, 0.2)
    assert.equal(m.max_tokens, 10)
    assert.equal(m.top_p, 0.9)
  } finally {
    if (prev == null) delete process.env.AGENTCORE_FAKE_MODEL
    else process.env.AGENTCORE_FAKE_MODEL = prev
  }
})
