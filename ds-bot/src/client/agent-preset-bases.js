// Plain helpers for the Create Bot preset picker. They stay free of React so the
// selection rules can be tested without a renderer.
const BOT_PREFIX = 'dsbot-bot-'
const GROUP_RELAY_ID = 'dsbot-group-relay'

// A Bot copies one of DSH's native presets. Bot-owned copies and the internal group
// relay are not templates; every other healthy row is a direct choice.
export function presetBases(presets) {
  return (Array.isArray(presets) ? presets : []).filter(preset => preset !== null && typeof preset === 'object'
    && typeof preset.id === 'string' && preset.id !== '' && preset.broken === undefined
    && !preset.id.startsWith(BOT_PREFIX) && preset.id !== GROUP_RELAY_ID)
}

// The native default is the first choice. DSH marks it on every list response, so the
// picker follows whatever the user chose in DSH instead of hard-coding standard here.
export function defaultPresetBase(presets) {
  const rows = presetBases(presets)
  return (rows.find(preset => preset.isDefault) ?? rows[0])?.id ?? ''
}

export function presetBaseName(preset) {
  return preset?.name ?? preset?.id ?? ''
}

// The form distinguishes an older deployment that has no preset service from a
// service that answered with an empty or broken roster. Only the former may create a
// Bot without a Bot-owned preset.
export function presetLoadState(result) {
  if (!result || result.available === false) return { status: 'unavailable', presets: [] }
  return { status: 'ready', presets: presetBases(result.presets) }
}
