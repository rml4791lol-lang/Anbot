// A Bot's skill shortlist: at most five skills, each with one line saying when to use
// it. Only those names and lines reach the system prompt; a skill's own instructions
// stay in its SKILL.md until the Bot loads it with the `skill` tool.

export const SKILL_SHORTLIST_MAX = 5
export const SKILL_PURPOSE_MAX = 160
const NAME = /^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/
const NAME_MAX = 64

// Reads the shortlist a caller asked to save. `undefined` leaves it untouched; an
// empty list clears it. The shape is checked here and a repeated name is one skill;
// the count is fitted to five by fitSkillShortlist, which knows which names are
// capability skills.
export function readSkillShortlist(value) {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error('skills must be a list of { name, purpose }')
  const seen = new Set()
  const list = []
  for (const [index, entry] of value.entries()) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`skills[${index}] must be an object with name and purpose`)
    }
    const name = String(entry.name ?? '').trim()
    if (name.length > NAME_MAX || !NAME.test(name)) {
      throw new Error(`skills[${index}].name must be a skill name such as "test-driven-development"`)
    }
    const purpose = String(entry.purpose ?? '').replace(/\s+/g, ' ').trim()
    if (purpose === '') throw new Error(`skills[${index}].purpose is the one line that says when to use ${name}`)
    if (purpose.length > SKILL_PURPOSE_MAX) {
      throw new Error(`skills[${index}].purpose must be at most ${SKILL_PURPOSE_MAX} characters`)
    }
    if (seen.has(name)) continue
    seen.add(name)
    list.push({ name, purpose })
  }
  return list
}

// Fits a checked shortlist into its five slots instead of refusing the whole write.
// A DS-Bot capability skill keeps its slot ahead of a profile skill; the rest are kept
// newest first, because both the picker and a capability attach add at the end of the
// list. The kept entries stay in the caller's order, and `dropped` names what went so
// the host can log it.
export function fitSkillShortlist(list, { capability = new Set(), max = SKILL_SHORTLIST_MAX } = {}) {
  if (!Array.isArray(list) || list.length <= max) return { list: list ?? [], dropped: [] }
  const ranked = list
    .map((skill, index) => ({ index, capability: capability.has(skill.name) }))
    .sort((a, b) => (Number(b.capability) - Number(a.capability)) || (b.index - a.index))
  const kept = new Set(ranked.slice(0, max).map(entry => entry.index))
  return {
    list: list.filter((_, index) => kept.has(index)),
    dropped: list.filter((_, index) => !kept.has(index)).map(skill => skill.name),
  }
}

export const SKILL_SHORTLIST_FALLBACK = 'If no skill in the shortlist matches the task, do the work the ordinary way; do not guess at a skill.'

// The prompt section for one Bot, or '' when it keeps no shortlist: Bots without one
// read exactly as they did before this section existed.
export function skillShortlistSection(list) {
  if (!Array.isArray(list) || list.length === 0) return ''
  return [
    '## Your skill shortlist',
    ...list.map(skill => `- ${skill.name}: ${skill.purpose}`),
    '',
    SKILL_SHORTLIST_FALLBACK,
  ].join('\n')
}
