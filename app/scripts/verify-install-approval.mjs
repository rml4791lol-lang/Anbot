// Live check of the installed desktop app's Skill approval flow, on a throwaway Bot.
// Started with --remote-debugging-port, the app must already be running.
//
// The check creates one Bot whose name carries a marker, lets the real model ask to
// create and update a Skill on that Bot, approves both through the same endpoints the
// approval card uses, and then removes the Bot and the Skill. It never writes to a Bot
// that existed before the check: the marker Bot is the only one it changes, and the
// shortlist and attachments of every other Bot are compared before and after.
//
// Usage: node scripts/verify-install-approval.mjs <debugging port> [saved bot/state.json]
// With the saved state, the Bots and groups are also compared with it, as
// verify-install.mjs does. Prints one JSON line of flags; no message text or credential.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { setTimeout as sleep } from 'node:timers/promises'

const [port, savedFile] = process.argv.slice(2)
if (!/^\d+$/u.test(port ?? '')) {
  console.error('usage: node scripts/verify-install-approval.mjs <debugging port> [saved bot/state.json]')
  process.exit(2)
}
const saved = savedFile === undefined ? undefined : JSON.parse(readFileSync(savedFile, 'utf8'))
const require = createRequire(import.meta.url)
const { chromium } = createRequire(require.resolve('ds-bot/package.json'))('playwright-core')

// What a check may not change on a Bot it did not make.
const KEPT = ['name', 'role', 'instructions', 'model', 'effort', 'workDir', 'skillShortlist', 'capabilities']
const fingerprint = bot => JSON.stringify(KEPT.map(field => bot[field] ?? null))

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

async function poll(check, limit, failure) {
  const until = Date.now() + limit
  do {
    const result = await check()
    if (result) return result
    await sleep(1000)
  } while (Date.now() < until)
  throw new Error(failure)
}

const browser = await connect(Date.now() + 60_000)
const report = { temporaryBot: true, otherBotsUntouched: false, skillCreated: false, skillUpdated: false, cleanup: {} }
let api
let roster
let made
let skillName
let before = new Map()
let skillsBefore
try {
  const page = browser.contexts().flatMap(context => context.pages()).find(p => p.url().startsWith('http://127.0.0.1:'))
  assert.ok(page, 'No team page')
  api = async (endpoint, payload = {}) => {
    const result = await page.evaluate(async args => {
      const response = await fetch('/api/bot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args), signal: AbortSignal.timeout(360000) })
      return response.json()
    }, { endpoint, payload })
    return result
  }
  const call = async (endpoint, payload) => {
    const result = await api(endpoint, payload)
    if (!result.ok) throw new Error(`${endpoint}: ${result.error?.code ?? 'unknown'}`)
    return result.value
  }
  roster = await call('state')
  // The team before the check: nothing already present may differ afterwards.
  before = new Map(roster.bots.map(bot => [bot.id, fingerprint(bot)]))
  skillsBefore = JSON.stringify(roster.capabilities?.items ?? {})
  if (saved !== undefined) {
    assert.deepEqual(roster.bots.map(bot => bot.id).sort(), Object.keys(saved.bots ?? {}).sort(), 'The Bot list differs from the saved state')
    assert.deepEqual(roster.rooms.map(room => room.id).sort(), Object.keys(saved.rooms ?? {}).sort(), 'The group list differs from the saved state')
  }

  // The marker is in the name, so a Bot left behind by an interrupted run is recognisable.
  const marker = `install-approval-${randomUUID().slice(0, 8)}`
  skillName = `install-approval-skill-${randomUUID().slice(0, 8)}`
  // The model the Main Bot runs on, so the new Bot needs no model of its own picked.
  const main = roster.bots.find(bot => bot.id === roster.mainBotId)
  made = await call('create-bot', { name: marker, role: 'Check', instructions: 'You check the installed app. Do what the message asks.', skills: [] , ...(main?.model ? { model: main.model } : {}) })
  report.temporaryBot = made.name
  const fresh = (await call('state')).bots.find(bot => bot.id === made.id)
  assert.ok(fresh, 'The marker Bot is not in the team')
  assert.deepEqual(fresh.skillShortlist, [], 'The marker Bot did not start with an empty shortlist')

  const send = text => call('send', { sessionId: fresh.sessionId, text })
  const card = action => poll(async () => (await call('state')).learning?.[fresh.id]?.find(row => row.name === skillName && row.action === action), 360000, `The ${action} approval card did not arrive`)

  let pending = await send(`创建技能 ${skillName}：创建一项安装验收专用技能。描述是用于安装验收。正文只写：检查桌面版能否打开。`)
  assert.equal(pending?.name, skillName, 'The create request did not become an approval card')
  await call('learning-answer', { id: pending.id, approve: true })
  pending = undefined
  const first = (await call('state')).capabilities.items[skillName]
  assert.ok(first, 'The approved Skill was not saved')
  report.skillCreated = true

  // An update goes through the same approval, from the chat's own input as the card does it.
  pending = await send(`更新技能 ${skillName}：正文改为先检查桌面版能否打开，再检查模型能否回复。保留原描述。`)
  assert.equal(pending?.action, 'update', 'The update request did not become an approval card')
  assert.equal(pending.previous?.content, first.content, 'The update card does not show the saved Skill')
  await call('learning-answer', { id: pending.id, approve: true })
  pending = undefined
  const second = (await call('state')).capabilities.items[skillName]
  assert.notEqual(second.content, first.content, 'The approved update was not saved')
  report.skillUpdated = true
  await poll(async () => !(await call('state')).learning?.[fresh.id]?.length, 15000, 'The approval did not settle')
} finally {
  // Runs on success, on a failed assertion and on a refused endpoint alike. Declining an
  // open card first closes it; then the Bot goes, then the Skill it learned. Each step is
  // reported, so an incomplete cleanup is visible instead of silent.
  try {
    if (api !== undefined && made !== undefined) {
      const open = (await api('state')).value?.learning?.[made.id] ?? []
      for (const row of open) await api('learning-answer', { id: row.id, approve: false })
      if (roster !== undefined) {
        // Only the Bot this run made is ever deleted: its id came from create-bot above.
        const own = (await api('state')).value?.bots?.find(bot => bot.id === made.id)
        if (own?.name === report.temporaryBot) await api('delete-bot', { id: made.id })
      }
      report.cleanup.bot = !(await api('state')).value?.bots?.some(bot => bot.id === made.id)
    }
    if (api !== undefined && skillName !== undefined) await api('capability-delete', { name: skillName })
    const after = await api('state')
    report.cleanup.skill = after.value?.capabilities?.items?.[skillName] === undefined
    const now = new Map((after.value?.bots ?? []).map(bot => [bot.id, fingerprint(bot)]))
    // Every Bot that existed before is unchanged, and none was added or removed.
    const untouched = [...before.keys()].every(id => now.get(id) === before.get(id)) && now.size === before.size
    report.otherBotsUntouched = untouched
    report.cleanup.libraryUntouched = JSON.stringify(after.value?.capabilities?.items ?? {}) === skillsBefore
  } catch (error) {
    report.cleanup.error = String(error?.message ?? error).slice(0, 200)
  } finally {
    await browser.close()
  }
}
console.log(JSON.stringify(report))
if (!report.cleanup.bot || !report.cleanup.skill || !report.otherBotsUntouched || !report.cleanup.libraryUntouched) process.exit(1)
