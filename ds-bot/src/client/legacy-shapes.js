// Retired built-in avatar slots and the current preset each one becomes. Old state
// strings stay on disk; the remap runs at lookup time only. The v1 slot ids
// (anbot-girl, ds-*) and the older vendor bitmaps (gpt, qwen, kimi, claude, gemini,
// glm, anbot) plus the vector slots that mapped to them all land on one of the
// fifteen current presets.
const LEGACY_REMAP = {
  'anbot-girl': 'anbot',
  'ds-headphone': 'headphone',
  'ds-glasses': 'glasses',
  'ds-scarf': 'scarf',
  'ds-nightcap': 'nightcap',
  'ds-overalls': 'overalls',
  'ds-chef': 'chef',
  'ds-wizard': 'wizard',
  'ds-astro': 'astro',
  'ds-detective': 'detective',
  'ds-painter': 'painter',
  'ds-gardener': 'gardener',
  'ds-barista': 'barista',
  'ds-skater': 'skater',
  'ds-raincoat': 'raincoat',
  anbot: 'anbot', whale: 'anbot',
  gpt: 'headphone', hex: 'headphone',
  qwen: 'glasses', wave: 'glasses',
  kimi: 'scarf', moon: 'scarf',
  claude: 'nightcap', squircle: 'nightcap',
  gemini: 'overalls', star: 'overalls',
  glm: 'chef', zed: 'chef',
}

export const legacyShape = stored => (typeof stored === 'string' && Object.hasOwn(LEGACY_REMAP, stored) ? LEGACY_REMAP[stored] : undefined)
