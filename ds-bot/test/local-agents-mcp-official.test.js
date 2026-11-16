import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { LoopbackMcp } from '../src/host/local-agents/mcp.js'
import { LocalAgentAdapter } from '../src/host/local-agents/adapter.js'

const connect = async (mcp) => {
  const client = new Client({ name: 'ds-bot-test', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url), { requestInit: { headers: { Authorization: `Bearer ${mcp.token}` } } }))
  return client
}

test('the official MCP client sees and calls the current schemas without flattening', async (t) => {
  const schema = {
    type: 'object',
    $defs: { choice: { type: 'string', enum: ['one'] } },
    properties: {
      choice: { $ref: '#/$defs/choice' },
      count: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    },
    required: ['choice'],
  }
  const calls = []
  const mcp = new LoopbackMcp(
    () => [{ name: 'message_bot', description: 'Message another Bot', parameters: schema }],
    async ({ name, arguments: args }) => {
      calls.push({ name, args })
      return { text: JSON.stringify(args) }
    },
  )
  await mcp.listen()
  t.after(async () => {
    await mcp.close()
  })
  const client = await connect(mcp)
  t.after(() => client.close())

  const listed = await client.listTools()
  assert.deepEqual(listed.tools, [{ name: 'message_bot', description: 'Message another Bot', inputSchema: schema }])
  const result = await client.callTool({ name: 'message_bot', arguments: { choice: 'one', count: 2 } })
  assert.deepEqual(result, { content: [{ type: 'text', text: '{"choice":"one","count":2}' }] })
  assert.deepEqual(calls, [{ name: 'message_bot', args: { choice: 'one', count: 2 } }])
})

test('the inventory resource is a stable read-only projection of DSH MCP tools', async (t) => {
  const schema = { type: 'object', properties: { query: { type: 'string' } } }
  const visible = [
    { name: 'message_bot', description: 'A team tool, not MCP', parameters: schema },
    { name: 'mcp__github__search', description: 'Search GitHub', parameters: schema },
  ]
  const mcp = new LoopbackMcp(() => visible.slice(0, 1), async () => ({ text: 'ok' }), () => visible)
  await mcp.listen()
  t.after(async () => {
    await mcp.close()
  })
  const client = await connect(mcp)
  t.after(() => client.close())

  const read = async () => {
    const resource = await client.readResource({ uri: 'dsbot://tool-inventory' })
    return JSON.parse(resource.contents[0].text)
  }
  const first = await read()
  assert.deepEqual(first.tools.map(tool => tool.name), ['mcp__github__search'])
  assert.match(first.tools[0].schemaHash, /^[a-f0-9]{64}$/)
  assert.match(first.tools[0].descriptionHash, /^[a-f0-9]{64}$/)

  visible.reverse()
  const github = visible.find(tool => tool.name === 'mcp__github__search')
  github.parameters = { properties: { query: { type: 'string' } }, type: 'object' }
  assert.equal((await read()).revision, first.revision, 'ordering and key order do not change the revision')

  github.parameters = { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } } }
  const schemaChanged = await read()
  assert.notEqual(schemaChanged.revision, first.revision, 'a schema change changes the revision')

  github.description = 'Search public GitHub'
  assert.notEqual((await read()).revision, schemaChanged.revision, 'a description change changes the revision')
})

test('cancelling a bridge call aborts the handler and releases the pending call', async (t) => {
  let started
  const ready = new Promise(resolve => { started = resolve })
  let bridgeSignal
  const mcp = new LoopbackMcp(
    () => [{ name: 'slow_tool', description: 'Wait until cancelled', parameters: { type: 'object', properties: {} } }],
    ({ signal }) => {
      bridgeSignal = signal
      started()
      return new Promise(resolve => {
        signal.addEventListener('abort', () => resolve({ text: 'cancelled', isError: true }), { once: true })
      })
    },
  )
  await mcp.listen()
  t.after(async () => {
    await mcp.close()
  })
  const client = await connect(mcp)
  t.after(() => client.close())

  const controller = new AbortController()
  const call = client.callTool({ name: 'slow_tool', arguments: {} }, { signal: controller.signal })
  await ready
  assert.equal(mcp.calls.size, 1)
  controller.abort()
  await assert.rejects(call, /abort/i)
  for (let attempt = 0; attempt < 100 && mcp.calls.size > 0; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(bridgeSignal.aborted, true)
  assert.equal(mcp.calls.size, 0)
})

test('the pinned DSH MCP 2.2 client and DS-Bot MCP 2.4 client both negotiate the loopback', async (t) => {
  const requireFromHarness = createRequire(new URL('../dev/harness/package.json', import.meta.url))
  const client22 = await import(pathToFileURL(requireFromHarness.resolve('@modelcontextprotocol/client')))
  const mcp = new LoopbackMcp(
    () => [{ name: 'echo', description: 'Echo input', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }],
    async ({ arguments: args }) => ({ text: args.text }),
  )
  await mcp.listen()
  t.after(async () => {
    await mcp.close()
  })

  for (const [label, sdk] of [['2.2', client22], ['2.4', { Client, StreamableHTTPClientTransport }]]) {
    const client = new sdk.Client({ name: `ds-bot-${label}`, version: '1' })
    await client.connect(new sdk.StreamableHTTPClientTransport(new URL(mcp.url), { requestInit: { headers: { Authorization: `Bearer ${mcp.token}` } } }))
    const listed = await client.listTools()
    const result = await client.callTool({ name: 'echo', arguments: { text: `from ${label}` } })
    assert.deepEqual(listed.tools.map(tool => tool.name), ['echo'], `${label} tools`)
    assert.deepEqual(result, { content: [{ type: 'text', text: `from ${label}` }] }, `${label} result`)
    await client.close()
  }
})


test('the adapter gives the loopback the current DSH inventory without widening the callable bridge', async (t) => {
  const adapter = new LocalAgentAdapter({
    rt: { warn: () => {} },
    customAgents: () => [],
    findExecutable: () => undefined,
    spawnEngine: () => { throw new Error('not used') },
    record: () => undefined,
    saveRecord: () => {},
    presetFor: () => 'workspace-write',
    cwdFor: async () => process.cwd(),
    probeCwd: () => process.cwd(),
    toolsFor: () => [],
  })
  const live = { pending: new Map(), push: () => {} }
  const inventory = [
    { name: 'message_bot', description: 'Team tool', parameters: { type: 'object', properties: {} } },
    { name: 'mcp__github__search', description: 'Search GitHub', parameters: { type: 'object', properties: {} } },
  ]
  const mcp = await adapter.ensureMcp(
    live,
    () => [inventory[0]],
    () => inventory,
  )
  t.after(async () => {
    await mcp.close()
  })
  const client = await connect(mcp)
  t.after(() => client.close())

  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['message_bot'])
  const resource = await client.readResource({ uri: 'dsbot://tool-inventory' })
  assert.deepEqual(JSON.parse(resource.contents[0].text).tools.map(tool => tool.name), ['mcp__github__search'])
})
