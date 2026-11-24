import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({
  stdin: {
    contents: "export { Bubbles } from './src/client/cells.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  write: false,
  logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

let slots = []
let at = 0
const react = {
  Fragment: 'fragment',
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  createContext: initial => {
    const context = { value: initial }
    context.Provider = ({ value, children }) => { context.value = value; return children }
    return context
  },
  useContext: context => context.value,
  useCallback: callback => callback,
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: compute => compute(),
  useRef: initial => {
    const index = at++
    if (!(index in slots)) slots[index] = { current: initial }
    return slots[index]
  },
  useState: initial => {
    const index = at++
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
    return [slots[index], value => {
      slots[index] = typeof value === 'function' ? value(slots[index]) : value
    }]
  },
  useId: () => 'folded-message-copy',
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
}

const copied = []
const reported = []
let clipboardSucceeds = true
const window = {
  innerWidth: 1024,
  innerHeight: 768,
  addEventListener() {},
  removeEventListener() {},
  matchMedia: () => ({ matches: false }),
}
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module,
  exports: module.exports,
  AbortController,
  URL,
  TextDecoder,
  TextEncoder,
  document: { body: {} },
  fetch,
  navigator: { clipboard: {} },
  setTimeout: () => 0,
  clearTimeout() {},
  window,
  require: name => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      return {
        MarkdownText: ({ text }) => text,
        writeClipboard: text => { copied.push(text); return Promise.resolve(clipboardSucceeds) },
      }
    }
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { Bubbles } = module.exports

const expand = node => {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type({ ...node.props, children: node.children }))
  return { ...node, props: { ...node.props, children: expand(node.children) } }
}
const findAll = (node, match) => {
  if (Array.isArray(node)) return node.flatMap(child => findAll(child, match))
  if (!node || typeof node !== 'object') return []
  return [...(match(node) ? [node] : []), ...findAll(node.props.children, match)]
}
const words = node => {
  if (node === null || node === undefined) return ''
  if (Array.isArray(node)) return node.map(words).join('')
  return typeof node === 'object' ? words(node.props.children) : String(node)
}

const bot = { id: 'bot', name: 'Bot' }
const roster = { bots: [bot], byId: { bot }, roomsById: {} }
const anchor = {
  getBoundingClientRect: () => ({ left: 20, right: 60, top: 20, bottom: 40, width: 40, height: 20 }),
}
const fresh = () => { slots = []; at = 0 }
const render = props => {
  at = 0
  return expand(Bubbles({ roster, selfId: bot.id, sessionId: bot.id, actions: {}, ...props }))
}
const openCopy = props => {
  let tree = render(props)
  const more = findAll(tree, node => node.type === 'button' && node.props['aria-label'] === 'More message actions')[0]
  assert.ok(more, 'the message menu opens')
  more.props.onClick({ currentTarget: anchor })
  tree = render(props)
  const copy = findAll(tree, node => node.type === 'button' && node.props.role === 'menuitem' && words(node) === 'Copy')[0]
  assert.ok(copy, 'the menu has Copy')
  return copy
}

test('Copy reads the full retained message once and preserves original Markdown', async t => {
  const full = `${'retained text '.repeat(150)}\nKeep @docs/spec.md and @src/app.js unchanged.`
  const prefix = full.slice(0, 900)
  let reads = 0
  const whole = { length: full.length, load: async () => { reads += 1; return { text: full, whole: true } } }

  await t.test('an expanded attachment is reused by Copy', async () => {
    fresh()
    copied.length = 0
    reported.length = 0
    clipboardSucceeds = true
    const actions = { reportError: (error, where) => reported.push({ message: error.message, where }) }
    let tree = render({ texts: [prefix], whole, actions })
    const show = findAll(tree, node => node.type === 'button' && node.props.className === 'bt-more')[0]
    assert.ok(show)
    await show.props.onClick()
    tree = render({ texts: [prefix], whole, actions })
    assert.match(words(tree), /@docs\/spec\.md/)

    const copy = openCopy({ texts: [prefix], whole, actions })
    await copy.props.onClick()
    assert.equal(reads, 1, 'expansion and Copy share one full read')
    assert.deepEqual(copied, [full])
    assert.deepEqual(reported, [])
  })

  await t.test('Copy reads first and expansion reuses the copied text', async () => {
    fresh()
    copied.length = 0
    reported.length = 0
    clipboardSucceeds = true
    reads = 0
    const actions = { reportError: (error, where) => reported.push({ message: error.message, where }) }
    const copy = openCopy({ texts: [prefix], whole, actions })
    await copy.props.onClick()
    assert.equal(reads, 1)

    let tree = render({ texts: [prefix], whole, actions })
    const show = findAll(tree, node => node.type === 'button' && node.props.className === 'bt-more')[0]
    await show.props.onClick()
    tree = render({ texts: [prefix], whole, actions })
    assert.match(words(tree), /@src\/app\.js/)
    assert.equal(reads, 1, 'expansion uses the text Copy already loaded')
    assert.deepEqual(copied, [full])
    assert.deepEqual(reported, [])
  })

  await t.test('a malformed whole result is rejected without writing the prefix', async () => {
    fresh()
    copied.length = 0
    reported.length = 0
    clipboardSucceeds = true
    const actions = { reportError: (error, where) => reported.push({ message: error.message, where }) }
    const copy = openCopy({
      texts: [prefix],
      whole: { length: full.length, load: async () => ({ text: prefix, whole: true }) },
      actions,
    })
    await copy.props.onClick()
    assert.deepEqual(copied, [])
    assert.deepEqual(reported, [{ message: 'Could not read the whole message', where: 'copy' }])
  })

  await t.test('a failed whole read is reported without writing the prefix', async () => {
    fresh()
    copied.length = 0
    reported.length = 0
    clipboardSucceeds = true
    const actions = { reportError: (error, where) => reported.push({ message: error.message, where }) }
    const copy = openCopy({
      texts: [prefix],
      whole: { length: full.length, load: async () => { throw new Error('attachment unavailable') } },
      actions,
    })
    await copy.props.onClick()
    assert.deepEqual(copied, [])
    assert.deepEqual(reported, [{ message: 'Could not read the whole message', where: 'copy' }])
  })

  await t.test('a refused clipboard write is reported', async () => {
    fresh()
    copied.length = 0
    reported.length = 0
    clipboardSucceeds = false
    const actions = { reportError: (error, where) => reported.push({ message: error.message, where }) }
    const copy = openCopy({ texts: [prefix], whole, actions })
    await copy.props.onClick()
    assert.deepEqual(copied, [full])
    assert.deepEqual(reported, [{ message: 'Could not copy the message', where: 'copy' }])
  })
})
