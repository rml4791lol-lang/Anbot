import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import { createRuntime } from '../index.js'
import { install as installWebSearchGuard } from '../src/host/web-search-guard.js'
import { fakeContext } from './fake-ctx.js'
import * as webSearchAuto from '../web-search.js'

const flushMicrotasks = async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve() }

// The guard parks its notice provider from an inject scope that activates
// asynchronously; settle before asserting on the registry.
const untilParked = async web => {
  for (let index = 0; index < 200 && web.searchProviders.get('auto') === undefined; index += 1) {
    await new Promise(resolve => setImmediate(resolve))
  }
}

test('a configured but missing search provider still fails with the documented error when nothing repairs it', async t => {
  const ctx = new Context()
  await ctx.plugin(WebRuntime, { searchProvider: 'auto' })
  t.after(async () => ctx.fiber.dispose())

  await assert.rejects(() => ctx.web.search({ query: 'example' }), error => {
    assert.equal(error.code, 'WEB_PROVIDER_CONFIGURED_MISSING')
    return true
  })
})

test('with web-search-auto off, the Bot guard degrades search to a plain-language notice (#128)', async t => {
  const ctx = new Context()
  await ctx.plugin(WebRuntime, { searchProvider: 'auto' })
  t.after(async () => ctx.fiber.dispose())

  installWebSearchGuard({ ctx })

  await assert.rejects(() => ctx.web.search({ query: 'example' }), error => {
    assert.equal(error.code, 'WEB_SEARCH_DISABLED')
    assert.match(String(error), /web-search-auto/)
    assert.match(String(error), /re-enabled/)
    return true
  })
})

test('the notice provider delegates to another usable registered search provider', async t => {
  const ctx = new Context()
  await ctx.plugin(WebRuntime, { searchProvider: 'auto' })
  t.after(async () => ctx.fiber.dispose())
  const sources = [{ title: 'One', url: 'https://example.com/one', snippet: 'first' }]
  ctx.web.registerSearchProvider({
    id: 'deepseek-unavailable',
    available: () => false,
    search: async () => { throw new Error('must not be called') },
  })
  ctx.web.registerSearchProvider({
    id: 'deepseek-official',
    available: () => true,
    search: async () => ({ content: 'via official', sources, truncated: false }),
  })

  installWebSearchGuard({ ctx })

  const found = await ctx.web.search({ query: 'example' })
  assert.deepEqual(found.sources, sources)
})

test('a selection the ds-bot patch does not own is left untouched', async t => {
  const ctx = new Context()
  await ctx.plugin(WebRuntime, { searchProvider: 'deepseek-official' })
  t.after(async () => ctx.fiber.dispose())

  installWebSearchGuard({ ctx })

  await assert.rejects(() => ctx.web.search({ query: 'example' }), error => {
    assert.equal(error.code, 'WEB_PROVIDER_CONFIGURED_MISSING')
    return true
  })
})

test('mounting web-search-auto evicts the notice provider and takes the id back', async t => {
  const ctx = new Context()
  await ctx.plugin(WebRuntime, { searchProvider: 'auto' })
  t.after(async () => ctx.fiber.dispose())

  installWebSearchGuard({ ctx })
  // native and fallback off keeps the real provider's own degrade
  // deterministic: selection must report it, not the notice placeholder.
  await ctx.plugin(webSearchAuto, { native: false, fallback: false })

  await assert.rejects(() => ctx.web.search({ query: 'example' }), error => {
    assert.equal(error.code, 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE')
    return true
  })
})

test('turning web-search-auto off at runtime parks the notice provider', async t => {
  const ctx = new Context()
  await ctx.plugin(WebRuntime, { searchProvider: 'auto' })
  t.after(async () => ctx.fiber.dispose())

  const fiber = await ctx.plugin(webSearchAuto)
  await fiber.dispose()
  await flushMicrotasks()

  await assert.rejects(() => ctx.web.search({ query: 'example' }), error => {
    assert.equal(error.code, 'WEB_SEARCH_DISABLED')
    assert.match(String(error), /web-search-auto/)
    return true
  })
})

test('the guard repairs the selection when the web service appears after install', async t => {
  const ctx = new Context()
  t.after(async () => ctx.fiber.dispose())

  installWebSearchGuard({ ctx })
  await ctx.plugin(WebRuntime, { searchProvider: 'auto' })
  await untilParked(ctx.web)

  await assert.rejects(() => ctx.web.search({ query: 'example' }), error => {
    assert.equal(error.code, 'WEB_SEARCH_DISABLED')
    return true
  })
})

test('createRuntime installs the web-search guard with the other Bot modules', () => {
  const web = {
    searchProviders: new Map(),
    config: { searchProvider: { get: () => 'auto' } },
  }
  const ctx = fakeContext({ services: { web } })
  createRuntime(ctx, { home: mkdtempSync(join(tmpdir(), 'ds-bot-web-search-guard-')) })

  const parked = web.searchProviders.get('auto')
  assert.ok(parked)
  assert.equal(parked.id, 'auto')
  assert.equal(parked.available(), true)
})
