// The loopback MCP server: one per CLI session, Streamable HTTP on 127.0.0.1
// with a random port and a per-session bearer token. It serves only the DS Bot
// team tools; every call is handed to the adapter, which emits it as a DSH tool
// call and answers here once the result arrives.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import {
  McpServer,
  fromJsonSchema,
  isInitializeRequest,
  readRequestBody,
} from '@modelcontextprotocol/server'
import {
  NodeStreamableHTTPServerTransport,
  localhostHostValidation,
  localhostOriginValidation,
  toWebRequest,
} from '@modelcontextprotocol/node'

const KEEPALIVE_MS = 20_000
const INVENTORY_URI = 'dsbot://tool-inventory'

const hash = value => createHash('sha256').update(value).digest('hex')
const canonicalJson = (value) => {
  if (Array.isArray(value)) return value.map(item => canonicalJson(item))
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value).sort().filter(key => value[key] !== undefined)
    return Object.fromEntries(entries.map(key => [key, canonicalJson(value[key])]))
  }
  return value
}

export function mcpToolInventory(tools) {
  const facts = tools
    .filter(tool => tool.name.startsWith('mcp__'))
    .map(tool => ({
      name: tool.name,
      schemaHash: hash(JSON.stringify(canonicalJson(tool.parameters ?? {}))),
      descriptionHash: hash(tool.description ?? ''),
    }))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  return {
    schemaVersion: 1,
    source: 'dsh',
    tools: facts,
    revision: hash(JSON.stringify(facts)),
  }
}

export class LoopbackMcp {
  // onCall(name, args, callId, signal) -> Promise<{text, isError}> runs while
  // the adapter waits for the DSH result; it resolves when the tool call settles.
  // inventoryTools reads every DSH-visible schema; the tool bridge stays
  // restricted to the current turn's permitted team tools.
  constructor(tools, onCall, inventoryTools = tools) {
    this.token = randomBytes(32).toString('hex')
    this.tools = tools
    this.inventoryTools = inventoryTools
    this.onCall = onCall
    this.calls = new Map()
    this.server = undefined
    this.sessions = new Map()
    this.url = undefined
  }

  async listen() {
    const validHost = localhostHostValidation()
    const validOrigin = localhostOriginValidation()
    this.server = createServer((request, response) => {
      if (request.headers.authorization !== `Bearer ${this.token}`) {
        writeJson(response, 401, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32001, message: 'unauthorized' },
        })
        return
      }
      if (!validHost(request, response) || !validOrigin(request, response)) return
      void this.handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500)
        response.end()
      })
    })
    await new Promise((resolve, reject) => {
      this.server.listen(0, '127.0.0.1', () => resolve()).once('error', reject)
    })
    const { port } = this.server.address()
    this.url = `http://127.0.0.1:${port}/mcp`
    return this.url
  }

  async handle(request, response) {
    const sessionId = request.headers['mcp-session-id']
    const session = typeof sessionId === 'string' ? this.sessions.get(sessionId) : undefined
    if (session !== undefined) this.syncTools(session)
    if (request.method !== 'POST') {
      if (session === undefined) {
        writeJson(response, 400, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'invalid session' },
        })
        return
      }
      await session.transport.handleRequest(request, response)
      return
    }

    let web
    try {
      web = await toWebRequest(request)
    } catch (error) {
      if (error?.status === 413 || error?.name === 'RequestBodyTooLargeError') {
        response.writeHead(413)
        response.end()
        return
      }
      throw error
    }
    const body = await readRequestBody(web)
    if (body.tooLarge) {
      response.writeHead(413)
      response.end()
      return
    }
    let parsed
    try { parsed = body.text === '' ? undefined : JSON.parse(body.text) } catch {
      writeJson(response, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'parse error' },
      })
      return
    }
    if (session !== undefined) {
      await session.transport.handleRequest(request, response, parsed)
      return
    }
    if (sessionId !== undefined) {
      writeJson(response, 404, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32001, message: 'unknown session' },
      })
      return
    }
    const initializing = Array.isArray(parsed) ? parsed.some(isInitializeRequest) : isInitializeRequest(parsed)
    if (!initializing) {
      writeJson(response, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'initialize first' },
      })
      return
    }

    const mcpSession = { tools: new Map() }
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      keepAliveMs: KEEPALIVE_MS,
      onsessioninitialized: id => this.sessions.set(id, mcpSession),
      onsessionclosed: id => this.sessions.delete(id),
    })
    const server = this.serverForRequest()
    mcpSession.transport = transport
    mcpSession.server = server
    this.syncTools(mcpSession)
    transport.onclose = () => {
      if (transport.sessionId !== undefined) this.sessions.delete(transport.sessionId)
    }
    await server.connect(transport)
    try {
      await transport.handleRequest(request, response, parsed)
    } catch (error) {
      await transport.close().catch(() => {})
      await server.close().catch(() => {})
      throw error
    }
  }

  serverForRequest() {
    const server = new McpServer({ name: 'ds-bot', version: '1' })
    server.registerResource('tool-inventory', INVENTORY_URI, {
      title: 'DSH MCP tool inventory',
      description: 'Read-only hashes of the MCP tools visible through DSH in this turn.',
      mimeType: 'application/json',
    }, async uri => ({
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(mcpToolInventory(this.inventoryTools())),
      }],
    }))
    return server
  }

  // DSH can expose a different set on the next turn. Reconcile the same MCP
  // session instead of replacing the server or keeping another registry.
  syncTools(mcpSession) {
    const desired = new Map(this.tools().map(tool => [tool.name, tool]))
    for (const [name, current] of mcpSession.tools) {
      if (desired.has(name)) continue
      current.registered.remove()
      mcpSession.tools.delete(name)
    }
    for (const [name, tool] of desired) {
      const fingerprint = JSON.stringify(canonicalJson({ description: tool.description ?? '', parameters: tool.parameters ?? {} }))
      const current = mcpSession.tools.get(name)
      if (current?.fingerprint === fingerprint) continue
      const schema = fromJsonSchema(tool.parameters ?? { type: 'object', properties: {} })
      if (current !== undefined) {
        current.registered.update({ description: tool.description ?? '', paramsSchema: schema })
        current.fingerprint = fingerprint
        continue
      }
      const registered = mcpSession.server.registerTool(name, {
        description: tool.description ?? '',
        inputSchema: schema,
      }, async (args, context) => this.call(name, args, context))
      mcpSession.tools.set(name, { registered, fingerprint })
    }
  }

  async call(name, args, context) {
    const callId = `mcp-${randomUUID()}`
    const controller = new AbortController()
    let rejectCancelled
    const cancelled = new Promise((_, reject) => { rejectCancelled = reject })
    const entry = {
      cancel: (error) => {
        controller.abort(error)
        rejectCancelled(error)
      },
    }
    this.calls.set(callId, entry)
    const onAbort = () => entry.cancel(context.mcpReq.signal.reason ?? new Error('the call was cancelled'))
    if (context.mcpReq.signal.aborted) onAbort()
    else context.mcpReq.signal.addEventListener('abort', onAbort, { once: true })
    try {
      const result = await Promise.race([
        this.onCall({ name, arguments: args, callId, signal: controller.signal }),
        cancelled,
      ])
      return {
        content: [{ type: 'text', text: result.text ?? '' }],
        ...(result.isError === true ? { isError: true } : {}),
      }
    } catch (error) {
      return { content: [{ type: 'text', text: error?.message ?? String(error) }], isError: true }
    } finally {
      context.mcpReq.signal.removeEventListener('abort', onAbort)
      this.calls.delete(callId)
    }
  }

  // A queued or in-flight tool call that the CLI cancelled, or that an abort
  // must fail instead of leaving the agent waiting.
  failAll(error) {
    for (const call of this.calls.values()) call.cancel(error)
    this.calls.clear()
  }

  async close() {
    this.failAll(new Error('the session closed'))
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    this.server?.closeAllConnections?.()
    await Promise.all(sessions.map(async ({ transport, server }) => {
      await transport.close().catch(() => {})
      await server.close().catch(() => {})
    }))
    await new Promise(resolve => {
      if (this.server === undefined || !this.server.listening) resolve()
      else this.server.close(() => resolve())
    })
  }
}

const writeJson = (response, status, value) => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}
