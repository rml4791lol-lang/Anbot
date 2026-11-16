import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const path = fileURLToPath(new URL('../../../src/host/local-agents/mcp.js', import.meta.url))
const source = readFileSync(path, 'utf8')
const broken = "  const facts = tools\n    .map(tool => ({"
const repaired = "  const facts = tools\n    .filter(tool => tool.name.startsWith('mcp__'))\n    .map(tool => ({"
if (!source.includes(broken)) throw new Error('the MCP inventory drift fixture is not present')
writeFileSync(path, source.replace(broken, repaired), 'utf8')
console.log(JSON.stringify({ repaired: true, path: 'ds-bot/src/host/local-agents/mcp.js' }))
