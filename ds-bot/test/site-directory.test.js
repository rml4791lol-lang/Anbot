import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { install, normalizeSiteDirectory, probeSite, siteEntry } from '../src/host/site-directory.js'

const temp = async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ds-bot-sites-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

const runtime = (home) => ({
  home,
  warn() {},
  siteFetch: undefined,
})

test('site records accept real web URLs and reject credentials or unsafe protocols', () => {
  const base = { id: 'site', name: 'DS Bot', environment: 'production', groupId: null }
  assert.equal(siteEntry({ ...base, url: 'https://dsbot.example/app#install' })?.url, 'https://dsbot.example/app')
  assert.equal(siteEntry({ ...base, url: 'http://localhost:5173' })?.environment, 'production')
  assert.equal(siteEntry({ ...base, url: 'javascript:alert(1)' }), undefined)
  assert.equal(siteEntry({ ...base, url: 'https://user:pass@example.com' }), undefined)
  assert.equal(siteEntry({ ...base, url: 'not a url' }), undefined)
})

test('site directory normalization repairs corrupt rows and keeps stable ordering', () => {
  const data = normalizeSiteDirectory({
    groups: [{ id: 'g1', name: 'an520.xin', order: 2 }, { id: 'g1', name: 'duplicate' }, { id: 'bad' }],
    sites: [
      { id: 's2', name: 'PPT', url: 'https://ppt.an520.xin', environment: 'production', groupId: 'g1', order: 2 },
      { id: 's1', name: 'Chat', url: 'https://chat.an520.xin', environment: 'production', groupId: 'g1', order: 1 },
      { id: 'bad', name: 'Bad', url: 'file:///tmp/site' },
    ],
  })
  assert.deepEqual(data.groups.map(group => group.name), ['an520.xin'])
  assert.deepEqual(data.sites.map(site => site.name), ['Chat', 'PPT'])
})

test('the site directory persists create, update, archive and groups', async (t) => {
  const home = await temp(t)
  const rt = runtime(home)
  install(rt)
  const group = (await rt.siteGroupSave({ name: 'an520.xin', color: 'blue' })).group
  const created = await rt.siteSave({
    name: 'DS Bot PPT', url: 'https://ppt.an520.xin', environment: 'production',
    groupId: group.id, tags: ['PPT', '公开'], notes: '主入口',
  })
  assert.equal(created.site.name, 'DS Bot PPT')
  assert.equal(created.site.environment, 'production')
  assert.equal(created.site.health.status, 'unknown')
  const updated = await rt.siteSave({ id: created.site.id, name: 'PPT.an520.xin', favorite: true })
  assert.equal(updated.site.name, 'PPT.an520.xin')
  assert.equal(updated.site.favorite, true)
  const renamed = await rt.siteGroupSave({ id: group.id, name: 'Products', color: 'orange' })
  assert.equal(renamed.group.name, 'Products')
  const ungrouped = await rt.siteGroupDelete(group.id)
  assert.equal(ungrouped.groups.length, 0)
  assert.equal(ungrouped.sites.find(site => site.id === created.site.id).groupId, null)
  const archived = await rt.siteArchive(created.site.id, true)
  assert.equal(archived.site.archived, true)
  const view = await rt.siteDirectoryView()
  assert.equal(view.counts.total, 0)
  assert.equal(view.counts.archived, 1)
  const saved = JSON.parse(await readFile(join(home, 'sites.json'), 'utf8'))
  assert.equal(saved.sites[0].archived, true)
  install(rt)
  assert.equal((await rt.siteDirectoryView()).counts.archived, 1)
})

test('page probes classify online, authentication, failure and latency', async () => {
  const online = await probeSite('https://example.com', 500, async () => new Response(null, { status: 204 }))
  assert.deepEqual([online.status, online.httpStatus], ['online', 204])
  const auth = await probeSite('https://example.com', 500, async () => new Response('', { status: 401 }))
  assert.equal(auth.status, 'auth')
  const failed = await probeSite('https://example.com', 500, async () => new Response('', { status: 503 }))
  assert.deepEqual([failed.status, failed.httpStatus], ['error', 503])
  const offline = await probeSite('https://example.com', 5, async () => { throw new Error('network down') })
  assert.equal(offline.status, 'offline')
  assert.match(offline.error, /network down/)
})

test('checking a site writes the latest health result into its record', async (t) => {
  const home = await temp(t)
  const rt = runtime(home)
  rt.siteFetch = async () => new Response('', { status: 200 })
  install(rt)
  const created = await rt.siteSave({ name: 'Chat', url: 'https://chat.an520.xin', environment: 'production' })
  const checked = await rt.siteCheck(created.site.id)
  assert.equal(checked.site.health.status, 'online')
  assert.equal(checked.site.health.httpStatus, 200)
  assert.ok(checked.site.health.checkedAt > 0)
})

test('a check that finishes after an edit keeps the edited record', async (t) => {
  const home = await temp(t)
  const rt = runtime(home)
  let start
  let finish
  const started = new Promise(resolve => { start = resolve })
  const gate = new Promise(resolve => { finish = resolve })
  rt.siteFetch = async () => {
    start()
    await gate
    return new Response('', { status: 200 })
  }
  install(rt)
  const created = await rt.siteSave({ name: 'Chat', url: 'https://chat.an520.xin' })
  const checking = rt.siteCheck(created.site.id)
  await started
  await rt.siteSave({ id: created.site.id, name: 'Chat, renamed' })
  finish()
  const checked = await checking
  assert.equal(checked.site.name, 'Chat, renamed')
  assert.equal(checked.site.health.status, 'online')
})

test('a failed disk write is reported instead of returning an unsaved record', async (t) => {
  const root = await temp(t)
  const home = join(root, 'not-a-directory')
  await writeFile(home, 'occupied', 'utf8')
  const rt = runtime(home)
  install(rt)
  await assert.rejects(rt.siteSave({ name: 'Chat', url: 'https://chat.an520.xin' }), /EEXIST|ENOTDIR/)
  assert.equal((await rt.siteDirectoryView()).sites.length, 0)
})
