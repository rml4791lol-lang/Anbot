// The app's own `--patch` overlay, written next to the profiles as search-patch.mjs does
// (`<DSH_HOME>/profiles/app-onboarding.patch.yml`) and read by DSH only through `patchFiles`.
// It turns off DSH Web's automatic credential step: the Bot team connects the model in its
// own chat instead. `credentialOnboarding` is the documented switch of
// @deepseek-ai/dsh-client-ui-settings-models.
//
// Cordis replaces the whole config. Build this app-owned override from the composed
// UI settings row to retain the profile's other options. Provider rows are untouched.
import { dirname, join } from 'node:path'
import { rmSync, writeFileSync } from 'node:fs'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { dump } from 'js-yaml'
import { composeOwnedRow } from './profile-overlay.mjs'

export const APP_PATCH_NAME = 'app-onboarding.patch.yml'
export const APP_PATCH_ROWS = [
  { id: 'ui-settings-models', name: '@deepseek-ai/dsh-client-ui-settings-models', config: { credentialOnboarding: false } },
]

/**
 * Write the overlay for this launch; DSH stops when a `patchFiles` entry is missing.
 * @param {import('@deepseek-ai/dsh-app-boot').Profile} profile
 * @returns {string[]} its part of the `patchFiles` argument
 */
export function writeAppPatch(profile) {
  const file = join(dirname(profile.dir), APP_PATCH_NAME)
  const layers = [...(profile.layers ?? []).map(layer => layer.patches), profile.patches ?? []]
  const entries = composeEntries(layers)
  const rows = APP_PATCH_ROWS.map(override => composeOwnedRow(entries.find(entry => entry.id === override.id), override)).filter(Boolean)
  if (rows.length === 0) {
    rmSync(file, { force: true })
    return []
  }
  writeFileSync(file, dump(rows, { schema: entryListSchema }), 'utf8')
  return [file]
}
