// Compatibility identifiers are kept here so released installs can upgrade in place.
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const PRODUCT_NAME = 'Anbot'
export const APP_ID = 'io.github.rml4791lol-lang.anbot'
export const LEGACY_PRODUCT_NAMES = ['DS Bot', 'DeepSeek Bot']
export const LEGACY_ENGINE = 'deepseek-bot-engine'

export const homeFromEnv = (env = process.env) => env.ANBOT_HOME || env.DS_BOT_HOME || undefined
export const workspaceFromEnv = (env = process.env) => env.ANBOT_WORKSPACE || env.DS_BOT_WORKSPACE || undefined
export const shellDataFromEnv = (env = process.env) => env.ANBOT_SHELL_DATA || env.DS_BOT_SHELL_DATA || undefined

/** Keep the shell data and Chromium encryption identity of an existing installation. */
export function configureIdentity(app, { env = process.env, platform = process.platform, exists = existsSync, mkdir = mkdirSync } = {}) {
  const current = app.getPath('userData')
  const explicit = shellDataFromEnv(env)
  // An explicitly isolated run must never discover an installed application.
  const legacyName = explicit || homeFromEnv(env) || exists(join(current, 'locations.json'))
    ? undefined
    : LEGACY_PRODUCT_NAMES.find(name => exists(join(app.getPath('appData'), name)))
  const legacy = legacyName === undefined ? undefined : join(app.getPath('appData'), legacyName)
  const userData = explicit || legacy || current
  mkdir(userData, { recursive: true })
  app.setPath('userData', userData)
  app.setPath('sessionData', userData)
  if (platform === 'win32') app.setAppUserModelId(APP_ID)
  // Electron 44 captures this name for OSCrypt before ready. Restore the visible name
  // before creating menus or windows; the captured keychain identity stays unchanged.
  if (legacyName !== undefined && platform !== 'win32') {
    app.setName(legacyName)
    app.once('ready', () => { app.setName(PRODUCT_NAME) })
  }
  return { userData, legacy: legacy !== undefined, legacyName }
}
