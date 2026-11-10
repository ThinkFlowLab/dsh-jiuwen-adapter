import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, symlinkSync, statSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test('Jiuwen snapshot restores byte content, modes, deleted files and removes extras', () => {
  const root = mkdtempSync(join(tmpdir(), 'jw-snapshot-test-'))
  const home = join(root, 'jiuwen'), snap = join(root, 'private snapshot')
  mkdirSync(join(home, 'config'), { recursive: true }); mkdirSync(join(home, 'runtime'))
  const file = join(home, 'config', 'fixture.txt')
  writeFileSync(file, 'ORIGINAL\n'); chmodSync(file, 0o600)
  writeFileSync(join(home, 'runtime', 'deleted.txt'), 'restore me')
  symlinkSync('fixture.txt', join(home, 'config', 'link'))
  const run = cmd => spawnSync('bash', ['scripts/jiuwen-snap.sh', cmd, snap], { env: { ...process.env, JIUWEN_HOME: home }, encoding: 'utf8' })
  try {
    assert.equal(run('snap').status, 0)
    assert.equal(statSync(snap).mode & 0o777, 0o700)
    writeFileSync(file, 'CHANGED'); chmodSync(file, 0o644)
    rmSync(join(home, 'runtime', 'deleted.txt'))
    writeFileSync(join(home, 'runtime', 'extra.txt'), 'extra')
    assert.notEqual(run('verify').status, 0)
    assert.equal(run('restore').status, 0)
    assert.equal(readFileSync(file, 'utf8'), 'ORIGINAL\n')
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.equal(existsSync(join(home, 'runtime', 'extra.txt')), false)
    assert.equal(readFileSync(join(home, 'runtime', 'deleted.txt'), 'utf8'), 'restore me')
    assert.equal(run('verify').status, 0)
    // Corrupt snapshots must never overwrite the live install.
    writeFileSync(join(snap, 'files/config/fixture.txt'), 'corrupt')
    assert.notEqual(run('restore').status, 0)
    assert.equal(readFileSync(file, 'utf8'), 'ORIGINAL\n')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
