// Check an installed desktop app that was started with --remote-debugging-port against the
// Bot state saved before the swap: the same Bots with the same settings, the same groups, the
// Main Bot's old chat, diagnostics, the update repository, and the GenUI client.
// Usage: node scripts/verify-install.mjs <debugging port> <saved bot/state.json> [update repository URL]
// Prints one JSON line of counts and flags; no message text, path or credential.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { setTimeout as sleep } from 'node:timers/promises'

const SETTINGS = ['name', 'role', 'avatar', 'instructions', 'model', 'effort', 'workDir', 'directWorkDir', 'skillShortlist', 'capabilities']
const [port, savedFile, repository = 'https://github.com/rml4791lol-lang/Anbot'] = process.argv.slice(2)
if (!/^\d+$/u.test(port ?? '') || savedFile === undefined) {
  console.error('usage: node scripts/verify-install.mjs <debugging port> <saved bot/state.json> [update repository URL]')
  process.exit(2)
}
const saved = JSON.parse(readFileSync(savedFile, 'utf8'))
const require = createRequire(import.meta.url)
const { chromium } = createRequire(require.resolve('ds-bot/package.json'))('playwright-core')

async function connect(deadline) {
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) }).then(r => r.json())
      if (targets.some(target => target.type === 'page' && target.url.startsWith('http://127.0.0.1:'))) {
        return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 2500 })
      }
    } catch {
      // The app is still starting.
    }
    await sleep(250)
  }
  throw new Error('The team window did not start')
}

const browser = await connect(Date.now() + 60_000)
try {
  const page = browser.contexts().flatMap(context => context.pages()).find(p => p.url().startsWith('http://127.0.0.1:'))
  assert.ok(page, 'No team page')
  const api = (endpoint, payload = {}) => page.evaluate(async args => {
    const response = await fetch('/api/bot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) })
    return response.json()
  }, { endpoint, payload })
  const expectedBots = Object.keys(saved.bots ?? {}).sort()
  let state
  for (let i = 0; i < 60; i++) {
    state = (await api('state')).value
    if (state?.bots?.length === expectedBots.length) break
    await sleep(300)
  }
  assert.ok(state, 'The Host did not answer')
  const live = new Map(state.bots.map(bot => [bot.id, bot]))
  assert.deepEqual([...live.keys()].sort(), expectedBots, 'The Bot list changed')
  assert.deepEqual(state.rooms.map(room => room.id).sort(), Object.keys(saved.rooms ?? {}).sort(), 'The group list changed')
  for (const [id, bot] of Object.entries(saved.bots)) {
    for (const field of SETTINGS) {
      assert.ok(JSON.stringify(live.get(id)[field]) === JSON.stringify(bot[field]), `A Bot's ${field} did not survive the update`)
    }
  }
  const history = (await api('chat', { botId: state.mainBotId })).value?.items ?? []
  assert.ok(history.some(row => row.kind === 'user'), 'The Main Bot chat did not open')
  assert.ok((await api('diagnostics')).ok, 'Diagnostics did not answer')
  const update = (await api('update-check')).value
  assert.equal(update?.repoUrl, repository, 'The update repository changed')
  const genui = await page.evaluate(() => performance.getEntriesByType('resource').some(entry => entry.name.includes('genui')))
  console.log(JSON.stringify({
    bots: state.bots.length, groups: state.rooms.length, settingsKept: true, historyOpened: true,
    diagnostics: true, updateRepository: update.repoUrl, genuiLoaded: genui, activeTurns: Object.keys(state.work?.turns ?? {}).length,
  }))
} finally {
  await browser.close()
}
