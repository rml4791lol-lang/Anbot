import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

export const STEP_KINDS = new Set(['api', 'capture', 'wait', 'restart', 'command', 'file'])
export const MODES = new Set(['mock', 'attached'])
export const DATA_MODES = new Set(['mock', 'live', 'preview'])
export const WORKSPACE_KINDS = new Set(['scratch', 'existing', 'worktree'])

const text = value => typeof value === 'string' && value.trim() !== ''
const requiredText = (value, name, problems) => {
  if (!text(value)) problems.push(`${name} must be a non-empty string`)
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const relative = value => {
  if (isAbsolute(value)) return false
  return !value.split(/[\\/]+/).includes('..')
}

function validateWorkspace(value, problems) {
  if (!object(value)) {
    problems.push('workspace must be an object')
    return
  }
  if (!WORKSPACE_KINDS.has(value.kind)) problems.push('workspace kind must be scratch, existing or worktree')
  requiredText(value.path, 'workspace path', problems)
  if (value.kind === 'scratch' && text(value.path) && !relative(value.path)) {
    problems.push('workspace path for scratch must be a relative path without ..')
  }
}

function validateStep(step, index, problems) {
  const label = `steps[${index}]`
  if (!object(step)) {
    problems.push(`${label} must be an object`)
    return
  }
  requiredText(step.id, `${label}.id`, problems)
  if (!STEP_KINDS.has(step.kind)) {
    problems.push(`${label}: unknown step kind: ${step.kind}`)
    return
  }
  if (step.kind === 'api' || step.kind === 'capture') requiredText(step.endpoint, `${label}.endpoint`, problems)
  if (step.kind === 'capture' || step.kind === 'file') requiredText(step.path, `${label}.path`, problems)
  if (step.kind === 'wait' && (!Number.isSafeInteger(step.ms) || step.ms < 0)) {
    problems.push(`${label}.ms must be a non-negative safe integer`)
  }
  if (step.kind === 'command') {
    if (!Array.isArray(step.argv) || step.argv.length === 0 || step.argv.some(value => typeof value !== 'string')) {
      problems.push(`${label}.argv must be a non-empty array of strings`)
    }
    if (typeof step.command === 'string') problems.push(`${label} may not use a shell command string`)
  }
}

function validateAcceptance(check, index, problems) {
  const label = `acceptance[${index}]`
  if (!object(check)) {
    problems.push(`${label} must be an object`)
    return
  }
  requiredText(check.id, `${label}.id`, problems)
  if (!['file', 'json'].includes(check.kind)) problems.push(`${label}: unknown acceptance kind: ${check.kind}`)
  requiredText(check.path, `${label}.path`, problems)
}

export function validateManifest(value) {
  const problems = []
  if (!object(value)) return ['manifest must be an object']
  if (value.schemaVersion !== 1) problems.push('schemaVersion must be 1')
  requiredText(value.id, 'id', problems)
  requiredText(value.title, 'title', problems)
  if (!Array.isArray(value.modes) || value.modes.length === 0) problems.push('modes must be a non-empty array')
  for (const mode of value.modes ?? []) if (!MODES.has(mode)) problems.push(`unknown mode: ${mode}`)
  if (!DATA_MODES.has(value.dataMode)) problems.push('dataMode must be mock, live or preview')
  if (value.modes?.includes('attached')) requiredText(value.baseUrl, 'baseUrl', problems)
  if (Array.isArray(value.modes) && value.modes.length === 1 && value.modes[0] === 'mock' && value.dataMode !== 'mock') {
    problems.push('dataMode must be mock when the manifest only supports mock mode')
  }
  if (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs <= 0) problems.push('timeoutMs must be a positive safe integer')
  validateWorkspace(value.workspace, problems)
  if (!Array.isArray(value.steps) || value.steps.length === 0) problems.push('steps must be a non-empty array')
  for (const [index, step] of (value.steps ?? []).entries()) validateStep(step, index, problems)
  if (!Array.isArray(value.acceptance) || value.acceptance.length === 0) problems.push('acceptance must be a non-empty array')
  for (const [index, check] of (value.acceptance ?? []).entries()) validateAcceptance(check, index, problems)
  return problems
}

export async function loadManifest(path) {
  let value
  try {
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw Object.assign(new Error(`Could not read manifest ${path}: ${error?.message ?? String(error)}`), { code: 'AIOS_MANIFEST' })
  }
  const problems = validateManifest(value)
  if (problems.length > 0) throw Object.assign(new Error(problems.join('\n')), { code: 'AIOS_MANIFEST' })
  return value
}
