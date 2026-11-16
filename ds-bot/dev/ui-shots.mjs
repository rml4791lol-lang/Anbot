// Screenshot the main Bot team screens, the same on both ends: the team as it stands, a
// fresh Main Bot's model dock and its greeting, the sidebar with Writer and Coder, a
// private chat with the model picker in its details panel, the Bot's memory (saved from
// the chat, its row in the details panel, and the memory dialog), a group chat and its settings
// in the details panel, Bot settings, the Bots and Group chats pages with one group's
// settings, and the Usage page by Bot, by model, over picked days, and for one Bot.
// Writer is pinned, so the sidebar shows its pin. Missing Bots and the group are created
// through POST api/bot, and each chat gets one message for the mock model to answer.
//
//   node dev/ui-shots.mjs desktop <dsh-repo> <out-dir> <renderer-port>
//   node dev/ui-shots.mjs web <dsh-repo> <out-dir> <bench-name> <web-port>
//
// Desktop attaches to a running window (desktop.sh); set SHOT_DISPLAY and XAUTHORITY to
// grab the screen instead of a CDP screenshot. Web starts a headless Chrome or Chromium
// through dsh's playwright-core: CHROME_BIN, else google-chrome, chromium or
// chromium-browser on PATH, else playwright's own download, and logs in with the token
// URL in the bench's web.log (dev/bench.sh), which it never prints.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { capture, connectApp, playwright, waitTeam } from './desktop-linux/lib.mjs'

const [mode, repo, outDir, target, webPort] = process.argv.slice(2)
if (!['desktop', 'web'].includes(mode) || !repo || !outDir || !target || (mode === 'web' && !webPort)) {
  console.error('usage: node dev/ui-shots.mjs desktop <dsh-repo> <out-dir> <renderer-port>\n       node dev/ui-shots.mjs web <dsh-repo> <out-dir> <bench-name> <web-port>')
  process.exit(2)
}
mkdirSync(outDir, { recursive: true })

const findChrome = () => {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN
  for (const name of ['google-chrome', 'chromium', 'chromium-browser']) {
    try { return execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim() } catch {}
  }
  return undefined
}

let browser
let page
if (mode === 'desktop') {
  ({ browser, page } = await connectApp(repo, target, 30_000))
} else {
  const { chromium } = playwright(repo)
  browser = await chromium.launch({ executablePath: findChrome(), headless: true })
  page = await browser.newPage({ viewport: { width: 1400, height: 860 }, locale: 'en-US' })
  const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
  const log = readFileSync(join(root, `.dsh-test-${target}`, 'web.log'), 'utf8')
  const login = log.match(new RegExp(`http://127\\.0\\.0\\.1:${webPort}/\\?token=[^\\s]+`))?.[0]
  if (!login) throw new Error(`no login URL in .dsh-test-${target}/web.log`)
  await page.goto(login)
}
// dsh shows a preview notice until it is dismissed once per profile, and it can open a
// little after the page; the handler clears it before any click, `shot` before a capture.
const notice = page.getByRole('dialog').getByRole('button', { name: 'Continue' })
await page.addLocatorHandler(notice, () => notice.click())
const dismissNotice = async () => {
  if (await notice.isVisible()) {
    await notice.click()
    await page.waitForTimeout(600)
  }
}
await waitTeam(page)
await page.waitForTimeout(1500)

const failures = []
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`)
  if (!ok) failures.push(message)
}
let index = 0
const display = mode === 'desktop' ? process.env.SHOT_DISPLAY : undefined
const shot = name => dismissNotice().then(() => capture(page, join(outDir, `${mode}-${String(++index).padStart(2, '0')}-${name}.png`), display))
const api = async (endpoint, payload) => {
  const result = await page.evaluate(([e, p]) => fetch('api/bot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: e, payload: p }) }).then(r => r.json()), [endpoint, payload])
  if (!result.ok) throw new Error(`${endpoint}: ${result.error?.message}`)
  return result.value
}
const send = async (text) => {
  const box = page.locator('[contenteditable="true"], textarea').last()
  await box.click()
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}
const openRow = selector => page.locator(selector).first().click().then(() => page.waitForTimeout(1200))

await shot('team')

let state = await api('state', {})
// A fresh team's Main Bot opens on the model dock and greets once a model is picked.
const main = state.bots.find(bot => bot.id === state.mainBotId)
if (main && !main.model) {
  await openRow(`.bt-tile[data-bot-id="${main.id}"]`)
  const card = page.locator('.bt-model-dock')
  check(await card.waitFor({ timeout: 30_000 }).then(() => true, () => false), `${main.name} opens on a model dock`)
  await page.waitForTimeout(600)
  await shot('model-card')
  await card.locator('.bt-model-choice-chips .bt-model-chip').first().click()
  check(await card.waitFor({ state: 'detached', timeout: 30_000 }).then(() => true, () => false), 'the model dock goes once a model is picked')
  check(await page.getByText('先让团队帮你做哪块', { exact: false }).last().waitFor({ timeout: 60_000 }).then(() => true, () => false), `${main.name} greets and asks after the pick`)
  await page.waitForTimeout(1500)
  await shot('main-greets')
  state = await api('state', {})
}
for (const name of ['Writer', 'Coder']) {
  if (!state.bots.some(bot => bot.name === name)) await api('create-bot', { name, role: name === 'Writer' ? 'Writer' : 'Engineer' })
}
state = await api('state', {})
const writer = state.bots.find(bot => bot.name === 'Writer')
const coder = state.bots.find(bot => bot.name === 'Coder')
let room = state.rooms.find(candidate => candidate.members.includes(writer.id) && candidate.members.includes(coder.id))
room ??= await api('create-room', { members: [writer.id, coder.id] })
const writerRow = `.bt-row[data-bot-id="${writer.id}"]`
await page.locator(writerRow).first().waitFor({ timeout: 30_000 })
await page.locator(`.bt-row[data-room-id="${room.id}"]`).first().waitFor({ timeout: 30_000 })
await api('set-flags', { id: writer.id, pinned: true })
check(await page.locator(`${writerRow} .bt-pin`).waitFor({ timeout: 10_000 }).then(() => true, () => false), 'a pinned Bot shows a pin beside its name')
await page.waitForTimeout(600)
await shot('sidebar')

await openRow(writerRow)
await send('你好，介绍一下你自己')
check(await page.getByText('收到：你好', { exact: false }).last().waitFor({ timeout: 30_000 }).then(() => true, () => false), 'Writer answers in its private chat')
await page.waitForTimeout(1500)
await shot('private-chat')

await page.locator('.bt-head .bt-pill').first().click()
const trigger = page.locator('.bt-panel button[aria-label^="Model:"]').first()
check(await trigger.waitFor({ timeout: 10_000 }).then(() => true, () => false), 'the details panel shows the model picker')
await page.waitForTimeout(600)
await trigger.click()
check(await page.locator('.bt-model-menu').waitFor({ timeout: 5_000 }).then(() => true, () => false), 'the model picker opens a menu')
await page.waitForTimeout(400)
await shot('details-model')
await page.keyboard.press('Escape')
await page.locator('.bt-panel [data-info-row="settings"]').click()
check(await page.locator('.bt-panel .bt-bs').waitFor({ timeout: 5_000 }).then(() => true, () => false), 'the details panel opens Bot settings in place')
await page.waitForTimeout(600)
await shot('details-settings')
await page.locator('.bt-panel .bt-subhead .bt-icon-btn').last().click()
await page.waitForTimeout(600)

// Memory: Writer saves one entry and may not write the team memory, which the Main Bot
// does. Then the details panel's Memory row and the memory dialog with its summary, every
// entry, and one change made through "Ask or update".
const waits = (locator, timeout = 30_000) => locator.waitFor({ timeout }).then(() => true, () => false)
await send('记住 我喜欢简短的回答，先给结论')
check(await waits(page.locator('.bt-event button', { hasText: 'Memory updated' }).last()), 'remember shows a "Memory updated" line')
await send('团队记住 周报在周五下午五点前交')
check(await waits(page.getByText(/Only Main Bots and group admins write the team memory/, { exact: false }).last()), 'a Bot that is neither a Main Bot nor a group admin cannot write the team memory')
await page.waitForTimeout(1200)
await shot('memory-saved')
await openRow(`.bt-tile[data-bot-id="${state.mainBotId}"]`)
await send('团队记住 周报在周五下午五点前交')
check(await waits(page.locator('.bt-event button', { hasText: 'Team memory updated' }).last()), 'the Main Bot writes the team memory, and the chat says so')
await page.waitForTimeout(1200)
await shot('memory-team')
await openRow(writerRow)
await page.locator('.bt-head .bt-pill').first().click()
const memoryRow = page.locator('.bt-panel .bt-mem-row')
check(await waits(memoryRow.filter({ hasText: '2 entries' }), 10_000), 'the details panel counts 2 memory entries')
await page.waitForTimeout(400)
await shot('details-memory')
await memoryRow.click()
const memory = page.locator('.bt-mem')
check(await waits(memory.locator('.bt-mem-summary h3').first()), 'the memory dialog writes a summary')
check(await waits(memory.locator('.bt-mem-status', { hasText: /Updated/ }), 10_000), 'the memory dialog says when the summary was written')
await page.waitForTimeout(800)
await shot('memory-summary')
await memory.getByRole('button', { name: 'Memory options' }).click()
await page.locator('.bt-mem-menu').getByRole('menuitem', { name: /All entries/ }).click()
check(await waits(memory.locator('.bt-mem-entry').nth(1), 5_000) && await memory.locator('.bt-mem-entry').count() === 2, 'All entries lists both entries')
await page.waitForTimeout(600)
await shot('memory-entries')
await memory.getByRole('button', { name: 'Back to the summary' }).click()
await memory.locator('.bt-mem-input').fill('记住 我写代码用 Vim')
await page.keyboard.press('Enter')
check(await waits(memory.locator('.bt-mem-changes li[data-ok]')), 'Ask or update adds an entry')
check(await waits(memory.locator('.bt-mem-summary p', { hasText: 'Vim' })), 'the summary is written again with the new entry')
await page.waitForTimeout(800)
await shot('memory-ask')
await memory.getByRole('button', { name: 'Close memory' }).click()
check(await memory.waitFor({ state: 'detached', timeout: 5_000 }).then(() => true, () => false), 'the memory dialog closes')
check(await waits(memoryRow.filter({ hasText: '3 entries' }), 5_000), 'the Memory row counts the new entry')
await page.locator('.bt-panel .bt-drawer-top button.bt-round').last().click()
await page.waitForTimeout(600)

// A lasting preference said in passing is kept by the memory review in the
// background, and the header pill stretches to say so; clicking it opens the memory.
const pill = page.locator('.bt-pill[data-memory=updated]')
const beforeReply = await page.locator('.bt-bubble').count()
await send('以后给我的文档都用 Markdown 表格总结要点')
const [answered, noticed] = await Promise.all([
  page.waitForFunction(count => document.querySelectorAll('.bt-bubble').length > count, beforeReply, { timeout: 30_000 }).then(() => true, () => false),
  waits(pill, 20_000),
])
check(answered, 'Writer answers again')
check(noticed, 'the header pill stretches to say memory was updated')
await shot('memory-pill')
await pill.click()
check(await waits(memory.locator('.bt-mem-summary')), 'the pill opens the memory dialog')
await memory.getByRole('button', { name: 'Memory options' }).click()
await page.locator('.bt-mem-menu').getByRole('menuitem', { name: /All entries/ }).click()
check(await waits(memory.locator('.bt-mem-entry', { hasText: 'Markdown 表格' }), 10_000), 'the memory review kept the preference')
await memory.getByRole('button', { name: 'Close memory' }).click()
await page.waitForTimeout(600)

await openRow(`.bt-row[data-room-id="${room.id}"]`)
const before = await page.locator('.bt-group-msg').count()
await send('大家好，各自说一句')
const replied = await page.waitForFunction(count => document.querySelectorAll('.bt-group-msg').length > count, before, { timeout: 60_000 }).then(() => true, () => false)
check(replied, 'the group chat gets a reply')
await page.waitForTimeout(4000)
await shot('group-chat')
await page.locator('.bt-head .bt-pill').first().click()
await page.locator('.bt-panel [data-info-row="settings"]').click()
check(await page.locator('.bt-panel .bt-bs .bt-seg').waitFor({ timeout: 5_000 }).then(() => true, () => false), 'the details panel opens group settings in place')
await page.waitForTimeout(600)
await shot('group-details-settings')
await page.locator('.bt-panel .bt-subhead .bt-icon-btn').last().click()
await page.waitForTimeout(600)

await page.locator(writerRow).first().click({ button: 'right' })
await page.getByRole('menuitem', { name: 'Edit Bot' }).click()
await page.locator('.bt-settings').waitFor({ timeout: 10_000 })
await page.waitForTimeout(800)
await shot('bot-settings')
check(await page.locator('.bt-settings button[aria-label^="Model:"]').count() === 1, 'Bot settings show the model picker')
await page.locator('.bt-settings-scroll').evaluate(node => { node.scrollTop = node.scrollHeight })
await page.waitForTimeout(400)
await shot('bot-settings-end')
await page.locator('.bt-settings-nav .bt-settings-item', { hasText: /^Bots$/ }).click()
await page.waitForTimeout(800)
check(await page.locator('.bt-settings select[aria-label="Main Bot"]').count() === 1, 'the Bots page can change the Main Bot')
await shot('bots-page')
await page.locator('.bt-settings-nav .bt-settings-item', { hasText: /^Group chats$/ }).click()
await page.waitForTimeout(800)
await shot('groups-page')
await page.locator('.bt-settings-scroll button.bt-set-row').first().click()
check(await page.locator('.bt-settings .bt-bs .bt-seg').waitFor({ timeout: 5_000 }).then(() => true, () => false), 'a group chat opens its own settings')
await page.waitForTimeout(600)
await shot('group-settings')
const settingsBox = await page.locator('.bt-settings').boundingBox()
await page.locator('.bt-settings-nav .bt-settings-item', { hasText: /^Usage$/ }).click()
check(await page.locator('.bt-us-stats').waitFor({ timeout: 15_000 }).then(() => true, () => false), 'the Usage page shows the totals')
const usageBox = await page.locator('.bt-settings').boundingBox()
check(Boolean(settingsBox && usageBox) && Math.abs(usageBox.width - settingsBox.width) < 1 && Math.abs(usageBox.height - settingsBox.height) < 1, 'the settings dialog keeps its size on Usage')
check(await page.locator('.bt-us-row[data-kind="bot"]').first().waitFor({ timeout: 15_000 }).then(() => true, () => false), 'the Usage page ranks the Bots that used tokens')
check(await page.locator('.bt-us-row[data-kind="model"]').first().waitFor({ timeout: 5_000 }).then(() => true, () => false), 'the Usage page ranks the models')
await page.waitForTimeout(1200)
await shot('usage')
await page.locator('.bt-settings-scroll').evaluate(node => { node.scrollTop = node.scrollHeight })
await page.waitForTimeout(500)
await shot('usage-end')
await page.locator('.bt-us-chart').getByRole('button', { name: 'By model' }).click()
check(await page.locator('.bt-us-chart button.bt-us-key').first().waitFor({ timeout: 5_000 }).then(() => true, () => false), 'the chart stacks by model')
await page.waitForTimeout(800)
await shot('usage-models')
await page.locator('.bt-settings-scroll').evaluate(node => { node.scrollTop = 0 })
await page.locator('.bt-us-top').getByRole('button', { name: 'Custom' }).click()
check(await page.locator('.bt-us-pick').waitFor({ timeout: 5_000 }).then(() => true, () => false), 'Custom opens a calendar')
// The last three days of this month up to today, or as many as it has so far.
const days = page.locator('.bt-us-month').nth(1).locator('.bt-us-day:not([disabled])')
const open = await days.count()
const picked = Math.min(3, open)
await days.nth(open - picked).click()
await page.locator('.bt-settings-scroll').evaluate(node => { node.scrollTop = 0 })
await days.nth(open - 1).hover()
await page.waitForTimeout(300)
check(await page.locator('.bt-us-pick .bt-us-day[data-in]').count() === picked, 'the calendar previews the span under the mouse')
await page.locator('.bt-settings').screenshot({ path: join(outDir, `${mode}-${String(++index).padStart(2, '0')}-usage-calendar.png`) })
await days.nth(open - 1).click()
check(await page.locator('.bt-us-pick').waitFor({ state: 'detached', timeout: 5_000 }).then(() => true, () => false), 'the second day closes the calendar')
check(await page.locator('.bt-us-col').count() === (picked >= 3 ? picked : picked * 24), 'the chart shows the picked days')
check(!(await page.locator('.bt-us-top .bt-us-tabs button[aria-pressed="true"]').innerText()).includes('Custom'), 'the Custom tab names the picked days')
// Playwright may scroll while it retries a click on the calendar; a person's click does not.
await page.locator('.bt-settings-scroll').evaluate(node => { node.scrollTop = 0 })
await page.waitForTimeout(800)
await shot('usage-custom')
await page.locator('.bt-us-top').getByRole('button', { name: '7 days' }).click()
await page.locator('.bt-us-chart').getByRole('button', { name: 'By Bot' }).click()
await page.locator('.bt-us-row[data-kind="bot"]').first().click()
check(await page.locator('.bt-us-profile').waitFor({ timeout: 5_000 }).then(() => true, () => false), 'a Bot opens its own usage')
check(await page.locator('.bt-us-heat').count() === 1, 'a Bot\'s usage shows its activity')
await page.waitForTimeout(1200)
await shot('usage-bot')
await page.locator('.bt-us-col').last().hover()
await page.waitForTimeout(400)
check(await page.locator('.bt-us-tip').count() === 1, 'hovering a bar shows its tokens')
// `shot` moves the mouse away first, which would close the tip.
await page.locator('.bt-us-chart').screenshot({ path: join(outDir, `${mode}-${String(++index).padStart(2, '0')}-usage-bot-tip.png`) })
await page.locator('.bt-settings-head .bt-icon-btn').click()
check(await page.locator('.bt-us-profile').waitFor({ state: 'detached', timeout: 5_000 }).then(() => true, () => false), 'the back button returns to all usage')
// The settings shell lists DSH's own pages beside DS Bot's pages.
const dshNav = page.locator('.bt-settings-nav').getByRole('button', { name: 'Agent presets', exact: true })
check(await waits(dshNav, 10_000), 'Settings lists a DeepSeek Harness page')
await dshNav.click()
const dshSection = page.locator('.bt-settings .bt-dsh-section')
check(await waits(dshSection, 10_000), 'a DeepSeek Harness page opens inside Settings')
await page.waitForTimeout(800)
await shot('harness-settings')
await page.keyboard.press('Escape')
await page.locator('.bt-settings').waitFor({ state: 'detached', timeout: 5_000 }).catch(() => {})
await page.waitForTimeout(400)

await openRow(writerRow)
await page.locator('.bt-head .bt-pill').first().click()
await page.locator('.bt-panel button[aria-label^="Model:"]').first().click()
await page.locator('.bt-model-menu').getByRole('menuitem', { name: 'Models and providers…' }).click()
check(await waits(page.locator('.bt-settings .bt-settings-head h2', { hasText: 'Models' }), 10_000), 'Models and providers… opens Models settings')
await page.keyboard.press('Escape')

await browser.close()
console.log(failures.length ? `ui shots (${mode}): ${failures.length} failed` : `ui shots (${mode}): all passed`)
process.exitCode = failures.length ? 1 : 0
