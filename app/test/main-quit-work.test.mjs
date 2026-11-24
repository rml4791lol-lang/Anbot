import assert from 'node:assert/strict'
import { test } from 'node:test'
import { answerCard, handOff, startApp, trayMenu, waitFor, window, windowCards } from './helpers/app-harness.mjs'
import { app } from './helpers/fake-electron.mjs'
import { state as host } from './helpers/fake-host-process.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

test('closing hides active work, while quitting asks once and leaves work running if declined', async () => {
  await startApp({ packaged: false })
  await waitFor(() => window() !== undefined, 'create the team window')
  host.release()
  await handOff()
  host.activity = 'active'
  window().close()
  assert.equal(window().visible, false)
  assert.equal(host.stops, 0)

  trayMenu().at(-1).click()
  app.quit()
  await waitFor(() => windowCards().length > 0, 'ask before interrupting active work')
  assert.equal(windowCards().length, 1)
  assert.equal(window().visible, true)
  assert.equal(answerCard(1).message, 'Work is still running. Quit Anbot and interrupt it?')
  assert.equal(host.stops, 0)
  assert.equal(window().destroyed, false)

  await new Promise(resolve => setImmediate(resolve))
  trayMenu().at(-1).click()
  await waitFor(() => windowCards().length === 2, 'allow quitting again')
  answerCard(0)
  await waitFor(() => window().destroyed, 'finish quitting after confirmation')
  assert.equal(host.stops, 1)
})
