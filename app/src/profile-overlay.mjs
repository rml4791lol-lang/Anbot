const protectedNames = new Set([
  'apikey', 'apikeyenv', 'xapikey', 'baseurl', 'authorization', 'proxyauthorization', 'authheader',
  'accesstoken', 'refreshtoken', 'bearertoken', 'token', 'password', 'clientsecret', 'privatekey', 'cookie', 'setcookie',
  'header', 'headers', 'env', 'environment', 'secret', 'credentials',
])
const privateSuffix = /(?:apikey|accesstoken|refreshtoken|bearertoken|password|secret|privatekey)$/u
const namedCredential = /(?:^|[._-])(?:token|key|secret|password)$/iu
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor'])
/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isMapping = value => value !== null && typeof value === 'object'
  && [null, Object.prototype].includes(Object.getPrototypeOf(value))

/** @param {unknown} value @param {Set<object>} seen @returns {boolean} */
function canRestate(value, seen = new Set()) {
  if (!isMapping(value) && !Array.isArray(value)) return true
  if (seen.has(value)) return false
  seen.add(value)
  const safe = Object.entries(value).every(([key, child]) => {
    const name = key.toLowerCase().replace(/[._-]/gu, '')
    return !unsafeKeys.has(key) && !protectedNames.has(name) && !privateSuffix.test(name)
      && !namedCredential.test(key) && canRestate(child, seen)
  })
  seen.delete(value)
  return safe
}

/** @param {unknown} current @param {unknown} override @returns {unknown} */
function mergeConfig(current, override) {
  if (!isMapping(current) || !isMapping(override) || Object.hasOwn(current, '__jsExpr') || Object.hasOwn(override, '__jsExpr')) return override
  return Object.fromEntries([
    ...Object.entries(current),
    ...Object.entries(override).map(([key, value]) => [key, mergeConfig(Object.hasOwn(current, key) ? current[key] : undefined, value)]),
  ])
}

// Cordis replaces a row's config. Restate an owned row only when its identity
// still matches and when emitting its complete config won't duplicate secrets.
/**
 * @template {{ id: string, name: string, config: unknown }} Row
 * @param {{ id: string, name: string, config?: unknown } | undefined} current
 * @param {Row} override
 * @returns {(Omit<Row, 'config'> & { config: unknown }) | undefined}
 */
export function composeOwnedRow(current, override) {
  if (current !== undefined && (current.id !== override.id || current.name !== override.name)) return undefined
  if (!canRestate(current?.config) || !canRestate(override.config)) return undefined
  return { ...override, config: mergeConfig(current?.config, override.config) }
}
