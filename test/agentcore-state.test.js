import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentCoreState, statePathFromMapping } from '../src/agentcore-state.js'

test('agentcore-state heartbeat/permissions/plugins/skills/teams/workflows/marketplaces round-trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-state-'))
  const file = join(dir, 'agentcore-state.json')
  try {
    const s = createAgentCoreState(file)
    assert.equal(s.getHeartbeat().every, 3600)
    s.setHeartbeat({ every: 120, target: 'cli' })
    assert.equal(s.getHeartbeat().every, 120)
    s.updatePermission('bash', 'deny')
    assert.equal(s.getPermissions().tools.bash, 'deny')
    s.deletePermission('bash')
    assert.equal(s.getPermissions().tools.bash, undefined)
    s.setPlugin('p', true)
    assert.equal(s.listPlugins().plugins[0].enabled, true)
    s.setSkill('sk', false)
    assert.equal(s.listSkills().skills.find(x => x.name === 'sk').enabled, false)
    s.upsertTeam({ team_name: 't1', agents: ['a'] })
    assert.equal(s.listTeams().teams[0].team_name, 't1')
    s.setWorkflows([{ id: 'w1', name: 'demo' }])
    assert.equal(s.listWorkflows().workflows[0].id, 'w1')
    s.setMarketplaces([{ name: 'hub', enabled: true }])
    assert.equal(s.listMarketplaces().marketplaces[0].name, 'hub')
    const s2 = createAgentCoreState(file)
    assert.equal(s2.getHeartbeat().target, 'cli')
    assert.equal(s2.listTeams().teams[0].team_name, 't1')
    assert.equal(s2.listWorkflows().workflows[0].id, 'w1')
    assert.equal(s2.listMarketplaces().marketplaces[0].name, 'hub')
    assert.equal(statePathFromMapping('/x/session-map.json'), join('/x', 'agentcore-state.json'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
