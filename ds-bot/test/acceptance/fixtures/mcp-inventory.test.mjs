import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mcpToolInventory } from '../../../src/host/local-agents/mcp.js'

test('the MCP inventory contains only MCP tools and is stable across input order', () => {
  const schema = { type: 'object', properties: { query: { type: 'string' } } }
  const tools = [
    { name: 'message_bot', description: 'A team tool, not MCP', parameters: schema },
    { name: 'mcp__github__search', description: 'Search GitHub', parameters: schema },
  ]
  const first = mcpToolInventory(tools)
  const second = mcpToolInventory([...tools].reverse())
  assert.deepEqual(first.tools.map(tool => tool.name), ['mcp__github__search'])
  assert.equal(second.revision, first.revision)
})
