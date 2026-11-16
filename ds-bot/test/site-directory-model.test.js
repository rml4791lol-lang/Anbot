import test from 'node:test'
import assert from 'node:assert/strict'
import { siteCatalogModel } from '../src/client/site-directory-model.js'

const site = (id, name, patch = {}) => ({
  id, name, url: `https://${id}.example`, environment: 'production', groupId: null,
  tags: [], notes: '', favorite: false, order: 0, archived: false,
  health: { status: 'unknown', httpStatus: null, latencyMs: null, checkedAt: null, error: null },
  createdAt: 1, updatedAt: 1, ...patch,
})

const directory = {
  groups: [
    { id: 'g2', name: 'Labs', order: 2, color: null, createdAt: 1, updatedAt: 1 },
    { id: 'g1', name: 'an520.xin', order: 1, color: 'blue', createdAt: 1, updatedAt: 1 },
  ],
  sites: [
    site('chat', 'Chat', { groupId: 'g1', favorite: true, environment: 'production' }),
    site('ppt', 'PPT', { groupId: 'g1', environment: 'production', health: { status: 'offline', checkedAt: 2 } }),
    site('lab', 'Experiment', { groupId: 'g2', environment: 'preview' }),
    site('docs', 'Guide', { environment: 'docs', tags: ['help'] }),
    site('old', 'Old site', { archived: true }),
  ],
  counts: { total: 4, attention: 1 },
}

test('the site catalog groups records by their configured groups and keeps ungrouped last', () => {
  const model = siteCatalogModel(directory)
  assert.deepEqual(model.groups.map(group => group.name), ['an520.xin', 'Labs', 'Ungrouped'])
  assert.deepEqual(model.groups[0].sites.map(row => row.name), ['Chat', 'PPT'])
  assert.deepEqual(model.groups[2].sites.map(row => row.name), ['Guide'])
  assert.equal(model.total, 4)
})

test('the site catalog filters by environment and text across names, URLs, tags and notes', () => {
  const byEnvironment = siteCatalogModel(directory, { environment: 'preview' })
  assert.deepEqual(byEnvironment.sites.map(row => row.name), ['Experiment'])
  const byText = siteCatalogModel(directory, { query: 'help' })
  assert.deepEqual(byText.sites.map(row => row.name), ['Guide'])
  const byUrl = siteCatalogModel(directory, { query: 'ppt.example' })
  assert.deepEqual(byUrl.sites.map(row => row.name), ['PPT'])
  assert.equal(siteCatalogModel(directory, { query: 'missing' }).groups.length, 0)
})

test('archived records stay out of the main catalog and can be reviewed separately', () => {
  const model = siteCatalogModel(directory, { includeArchived: true })
  assert.equal(model.total, 5)
  assert.ok(model.sites.some(row => row.name === 'Old site' && row.archived))
  assert.equal(siteCatalogModel(directory).sites.some(row => row.name === 'Old site'), false)
})
