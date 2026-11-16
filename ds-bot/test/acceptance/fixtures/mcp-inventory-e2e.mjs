import assert from 'node:assert/strict'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { LoopbackMcp } from '../../../src/host/local-agents/mcp.js'

const schema = { type: 'object', properties: { query: { type: 'string' } } }
const visible = [
  { name: 'message_bot', description: 'A team tool, not MCP', parameters: schema },
  { name: 'mcp__github__search', description: 'Search GitHub', parameters: schema },
]
const mcp = new LoopbackMcp(() => visible.slice(0, 1), async () => ({ text: 'ok' }), () => visible)
const client = new Client({ name: 'reality-gate', version: '1' })
try {
  await mcp.listen()
  await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url), { requestInit: { headers: { Authorization: `Bearer ${mcp.token}` } } }))
  const read = async () => {
    const resource = await client.readResource({ uri: 'dsbot://tool-inventory' })
    return JSON.parse(resource.contents[0].text)
  }
  const first = await read()
  assert.deepEqual(first.tools.map(tool => tool.name), ['mcp__github__search'])
  assert.match(first.tools[0].schemaHash, /^[a-f0-9]{64}$/)
  assert.match(first.tools[0].descriptionHash, /^[a-f0-9]{64}$/)
  visible.reverse()
  assert.equal((await read()).revision, first.revision)
  const github = visible.find(tool => tool.name === 'mcp__github__search')
  github.parameters = { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } } }
  const changed = await read()
  assert.notEqual(changed.revision, first.revision)
  console.log(JSON.stringify({ tools: first.tools.map(tool => tool.name), initialRevision: first.revision, changedRevision: changed.revision }))
} finally {
  await client.close().catch(() => {})
  await mcp.close()
}
