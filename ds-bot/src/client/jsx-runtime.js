// A small automatic-JSX runtime for the client bundle. The shell seeds `react`
// as a module, but not React's generated `react/jsx-runtime` entry; this shim
// keeps a dependency that is compiled with the automatic runtime on the same
// `createElement` the rest of the client uses.
import { createElement, Fragment } from 'react'

export { Fragment }

const childrenOf = children => (children === undefined ? [] : Array.isArray(children) ? children : [children])

export function jsx(type, props, key) {
  const { children, ...rest } = props ?? {}
  return createElement(type, key === undefined ? rest : { ...rest, key }, ...childrenOf(children))
}

export const jsxs = jsx
export const jsxDEV = jsx
