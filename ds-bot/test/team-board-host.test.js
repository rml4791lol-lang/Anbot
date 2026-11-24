import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/team-board-host.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
  createContext: initial => ({ value: initial, Provider: ({ children }) => children }),
  useContext: context => context.value,
  useEffect() {},
  useLayoutEffect() {},
  useRef: current => ({ current }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useMemo: make => make(),
  useCallback: fn => fn,
  useId: () => 'id',
  useSyncExternalStore: (_subscribe, get) => get(),
  Fragment: Symbol('Fragment'),
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
})
const { TeamBoardHost } = module.exports

const hooked = ui => ({
  useRoster: select => select({}),
  useWork: select => select({}),
  useUi: select => select(ui),
})

test('the team board toggle and close control use the shared UI actions', () => {
  const calls = []
  const closed = TeamBoardHost({
    ...hooked({ teamBoardOpen: false }),
    actions: { openTeamBoard: () => calls.push('open') },
  })
  assert.equal(closed.props.className, 'tbh-toggle')
  closed.props.onClick()
  assert.deepEqual(calls, ['open'])

  const open = TeamBoardHost({
    ...hooked({ teamBoardOpen: true }),
    actions: { closeTeamBoard: () => calls.push('close') },
  })
  assert.equal(open.props.className, 'tbh')
  const board = open.props.children.find(child => child.type?.name === 'TeamBoard')
  board.props.onClose()
  assert.deepEqual(calls, ['open', 'close'])
})
