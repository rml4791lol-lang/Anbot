// Bundled DSH skills for goal alignment and engineering. The provider keeps the
// full instructions on disk until the native skill tool loads them.
import { readFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { engineeringPresets } from '../shared/engineering-presets.js'

const PROVIDER = 'ds-bot-goal'
const ENGINEERING_PROVIDER = 'anbot-engineering'
const SKILLS = join(dirname(fileURLToPath(import.meta.url)), 'skills')
const GOAL_SKILLS = ['goal-grill', 'report-ds-bot-issue']

function parseSkill(raw, path) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  const metadata = frontmatter?.[1] ? Object.fromEntries(
    frontmatter[1].split('\n').map(line => /^(\w[\w-]*):\s*(.+)$/.exec(line.trim())?.slice(1) ?? []).filter(p => p.length === 2)) : {}
  if (typeof metadata.description !== 'string' || metadata.description.length === 0) {
    throw new Error(`Bundled skill ${path} has no description`)
  }
  return { description: metadata.description, content: raw.slice(frontmatter[0].length).trim() }
}

function candidate(provider, name) {
  const directory = join(SKILLS, name)
  const locator = join(directory, 'SKILL.md')
  const { description } = parseSkill(readFileSync(locator, 'utf8'), locator)
  return {
    name, description,
    invocation: { modelInvocable: true, userInvocable: true },
    provider, source: 'bundled', rank: 550,
    resourceBase: { kind: 'directory', path: directory.split(sep).join('/') },
    locator,
  }
}

function bundledProvider(name, skills) {
  const all = skills.map(skill => candidate(name, skill))
  return {
    name,
    list: () => Promise.resolve(all),
    async get(item) {
      const bundled = all.find(skill => skill.name === item.name)
      if (bundled === undefined) return undefined
      const { locator } = bundled
      const { description, content } = parseSkill(readFileSync(locator, 'utf8'), locator)
      return { ...bundled, description, content }
    },
  }
}

export const goalProvider = () => bundledProvider(PROVIDER, GOAL_SKILLS)
export const engineeringProvider = () => bundledProvider(ENGINEERING_PROVIDER,
  [...new Set(engineeringPresets.flatMap(preset => preset.skills.map(skill => skill.name)))])

export function install(rt) {
  rt.ctx.inject?.({ skills: null }, ctx => ctx.skills.registerProvider(() => goalProvider()))
  rt.ctx.inject?.({ skills: null }, ctx => ctx.skills.registerProvider(() => engineeringProvider()))
}
