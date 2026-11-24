// Learning from work. After a long turn a Bot's chat is marked for review. When the
// team has been idle for a while, and at most every few hours, one background pass
// reads what was said since the last pass and asks whether it taught a skill worth
// keeping or a lasting project rule. Most work teaches nothing, so most passes
// propose nothing. A proposal waits as a card in the Bot's chat until approved, and
// declined changes are remembered so the same idea does not come back.
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { replaceFile } from './files.js'
import { looksLikeKey, looksSecret, writtenIn } from './memory.js'
import { validateCapabilityName } from './capabilities.js'

export const LEARNING = {
  minTurnMs: 3 * 60_000,
  idleMs: 10 * 60_000,
  intervalMs: 12 * 60 * 60_000,
  tickMs: 60_000,
  readMs: 15_000,
  textMax: 24_000,
  userTextMax: 8_000,
  userLineMax: 2_000,
  botLineMax: 1_200,
  learnedMax: 5,
  descriptionMax: 300,
  contentMax: 8_000,
  declinedMax: 20,
  agentsFileMax: 16_000,
  agentsEditMax: 400,
  improvementTextMax: 1_000,
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)} […]` : text)
export const hashOf = text => createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 16)

export function botConfigHash(bot) {
  return hashOf(JSON.stringify({
    name: textOf(bot?.name),
    role: textOf(bot?.role),
    instructions: textOf(bot?.instructions),
    model: textOf(bot?.model),
    workDir: textOf(bot?.workDir),
    permission: textOf(bot?.permission),
    capabilities: [...(Array.isArray(bot?.capabilities) ? bot.capabilities : [])].map(textOf).sort(),
  }))
}

// The answer of the review's model: one JSON object, perhaps in a code fence.
export function parseJson(text) {
  const raw = String(text ?? '').trim()
  // A skill's content may hold code fences of its own, so read the whole answer first
  // and fall back to a fenced block only when that fails.
  const fenced = /^```(?:json)?\s*([\s\S]*?)```\s*$/.exec(raw)?.[1]
  for (const candidate of [raw, fenced]) {
    if (candidate === undefined) continue
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start === -1 || end < start) continue
    try {
      const value = JSON.parse(candidate.slice(start, end + 1))
      if (value && typeof value === 'object' && !Array.isArray(value)) return value
    } catch {}
  }
  return undefined
}

// ---------------------------------------------------------------------------
// The skill review.

export function skillSystem() {
  return [
    'You review a stretch of finished work by an AI Bot and decide whether it taught a skill worth keeping.',
    'A skill is a short document that a future Bot loads when a task of the same class comes up. Strong models already do most tasks well without one, so a weak or narrow skill only adds noise. Most work teaches nothing new: answer "none" unless every test below passes.',
    '',
    'Tests:',
    '1. Reusable: tasks of this class will come up again in later, different work. A rule that only fits this task, file, bug, or pull request fails.',
    '2. Missing knowledge: it gives constraints or context that a capable model does not have or gets wrong: requirements and corrections the user stated, project or tool conventions found by trial and error, pitfalls that cost time, how this user wants the result checked or delivered. General know-how fails, and so does anything that reading the code or the docs shows at once.',
    '3. Earned: the work shows it. The user asked for it or corrected the Bot, or a non-obvious way was found after one that failed. Never invent rules the work did not show.',
    '4. Not covered: no listed skill already says it. When a learned skill of this Bot covers the class, update that skill instead of making a new one. Also update a learned skill that the work showed to be wrong, outdated, or missing a step.',
    '',
    'Never put in a skill: one-off facts, task progress, file lists, dates, version, pull request or issue numbers, pasted errors or logs, facts about the user that are not about how to work (memory keeps those), or keys, passwords, and tokens.',
    'Write rules that stand alone, not the story of this work: a reason says why the rule matters, never when or how it was broken ("the user corrected this before", "version 1.2 missed it"). Examples must be general: do not name the files, functions, values, or fixes that this work happened to touch, not even as an example, and write a placeholder such as `<file>:<line>` instead; name something only when the rule is about it, such as a check the user wants run.',
    '',
    'Form:',
    '- name: the class of task, lowercase letters, digits, and single hyphens, 32 characters at most, e.g. "release-checks", never "fix-login-bug".',
    '- description: one sentence, 200 characters at most, that says when to use the skill. Be concrete about the trigger.',
    '- content: Markdown, 600 words at most. The rules as short imperative lines, each with a brief reason when it is not obvious; numbered steps only where order matters; how to check the work is done. Keep what is still true when you update, and remove what the work showed to be wrong.',
    '',
    'Answer with one JSON object only, one of:',
    '{"action":"none","reason":"<one sentence>"}',
    '{"action":"create","name":"…","description":"…","content":"…","why":"<one sentence: what in this work shows the skill is needed>"}',
    '{"action":"update","name":"<a learned skill listed>","description":"…","content":"<the whole new content>","why":"<one sentence>"}',
  ].join('\n')
}

// `learned`: this Bot's learned skills, in full. `library`: every other skill on the
// team, by name and description. `declined`: proposals the user turned down.
export function skillRequest({ bot, lines, learned = [], library = [], declined = [], language, limit = LEARNING.learnedMax }) {
  const parts = [`The Bot: ${bot.name}${bot.role ? `, ${bot.role}` : ''}.`]
  parts.push(learned.length === 0
    ? 'This Bot has no learned skills yet.'
    : `This Bot's learned skills (${learned.length} of ${limit}${learned.length >= limit ? '; at the limit, only update one' : ''}):\n${learned.map(skill => `<skill name="${skill.name}">\ndescription: ${skill.description}\n${skill.content}\n</skill>`).join('\n')}`)
  if (library.length > 0) parts.push(`Other skills on the team:\n${library.map(skill => `- ${skill.name}: ${skill.description}`).join('\n')}`)
  if (declined.length > 0) parts.push(`Proposals the user declined. Do not propose them again unless this work shows something new:\n${declined.map(entry => `- ${entry.name}: ${entry.description}`).join('\n')}`)
  if (language) parts.push(`Write the description and the content in ${language}.`)
  parts.push(`The work, oldest first ("User:" lines are the user's own words):\n<work>\n${lines.join('\n')}\n</work>`)
  return parts.join('\n\n')
}

export function agentsSystem() {
  return [
    'You review a stretch of finished work that AI Bots did in one project folder, and decide whether the project\'s AGENTS.md should change.',
    'Every agent that works in this folder reads AGENTS.md at the start of every task. So each line costs attention on every task: a file that is short and current helps; a long or stale one hurts. Most work should change nothing: answer "none" unless a change passes every test below.',
    '',
    'What belongs in AGENTS.md:',
    '- How the user wants agents to work here: requirements, rules, and corrections the user stated, especially ones the user had to repeat.',
    '- How the user wants to be talked to: language, length, format, what to report.',
    '- Things to always do and never do in this project, with a short reason when it is not obvious.',
    '- Project facts an agent needs on almost every task and cannot see at once from the code: the command that checks the work, a folder that must not be touched, a step that must come before a commit or a push.',
    '',
    'Tests for each change:',
    '1. Almost every task: the rule matters to most future work in this folder, not to one kind of task. A procedure for one kind of task belongs in a skill, not here.',
    '2. Earned: the work shows it. The user said it, or repeated it, or corrected an agent, or the same problem came back. Never invent rules the work did not show.',
    '3. Not obvious: a capable agent would not do it anyway, and reading the code or the docs does not show it at once.',
    '4. Lasting: still true next month. Never add task progress, plans, dates, versions, pull request or issue numbers, file lists, pasted errors or logs, or keys, passwords, and tokens.',
    '5. Not already said: if the file already says it, change nothing; if the file says it unclearly or partly, replace that line instead of adding one.',
    '',
    'Also remove or fix lines the work shows to be wrong or outdated, such as a rule the user reversed, and merge lines that say the same thing. Do not remove a line only because this work did not use it. Keep the user\'s own words and the file\'s language and style; do not rewrite lines that are fine.',
    '',
    'Answer with one JSON object only, one of:',
    '{"action":"none","reason":"<one sentence>"}',
    '{"action":"edit","edits":[<1 to 3 edits>]}',
    'Each edit is one of:',
    '{"op":"add","after":"<an exact whole line of the file to add below, or empty for the end>","text":"<the new line or lines>","why":"<one sentence: what in this work shows it>"}',
    '{"op":"replace","old":"<exact text of the file, one or more whole lines>","text":"<the new text>","why":"…"}',
    '{"op":"remove","old":"<exact text of the file, one or more whole lines>","why":"…"}',
    'Write new lines in the form the file already uses, such as "- " bullets under the right heading.',
  ].join('\n')
}

// The folder, its AGENTS.md, declined edits, and work.
export function agentsRequest({ folder, current, lines, declined = [], language }) {
  const parts = [`Project folder: ${folder}`]
  parts.push(current === undefined ? 'There is no AGENTS.md yet.' : `Current AGENTS.md:\n\`\`\`md\n${current}\n\`\`\``)
  const turnedDown = declined.filter(entry => entry.kind === 'agents' && entry.folder === folder)
    .flatMap(entry => entry.edits ?? [])
    .map(edit => `- ${edit.op}: ${clip(edit.text || edit.old || '', 200)}`)
  if (turnedDown.length > 0) parts.push(`Changes the user turned down before; do not propose them again:\n${turnedDown.join('\n')}`)
  if (language) parts.push(`The user writes in ${language}.`)
  parts.push(`The work, oldest first:\n${lines.join('\n')}`)
  return parts.join('\n\n')
}

// What keeps a proposal from the user, or undefined when it may be shown.
// `skills`: the team's skills by name; `learned`: names this Bot learned.
// Skills often talk about code such as `password == input`; read keys everywhere, but
// password wording only outside code.
const holdsSecret = text => looksLikeKey(text) || looksSecret(text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' '))

const textOf = value => typeof value === 'string' ? value : ''
const lineBlock = value => value.split(/\r?\n/)
const occurrences = (lines, block) => {
  const found = []
  for (let at = 0; at <= lines.length - block.length; at += 1) {
    if (block.every((line, index) => lines[at + index] === line)) found.push(at)
  }
  return found
}

export function withoutReviewedAgentsRecords(records, reviewedOrders) {
  const reviewed = new Set(reviewedOrders)
  return records.filter(record => !reviewed.has(record.order))
}

export function applyEdits(current, edits) {
  let text = current ?? ''
  let newline = text.includes('\r\n') ? '\r\n' : '\n'
  let trailing = text.endsWith('\n')
  let lines = text === '' ? [] : text.split(/\r?\n/)
  if (trailing) lines.pop()
  for (const edit of edits) {
    if (!['add', 'replace', 'remove'].includes(edit.op)) throw new Error('unknown edit operation')
    if (edit.op === 'add') {
      const added = lineBlock(textOf(edit.text))
      const after = textOf(edit.after)
      if (current === undefined && after !== '') throw new Error('a new AGENTS.md can only add at the end')
      if (!text) {
        lines = added
        trailing = true
      } else if (!after) {
        lines.push(...added)
        trailing = true
      } else {
        const positions = occurrences(lines, [after])
        if (positions.length !== 1) throw new Error('the add anchor must occur once as a whole line')
        const at = positions[0]
        lines.splice(at + 1, 0, ...added)
      }
    } else {
      const old = lineBlock(textOf(edit.old))
      if (current === undefined) throw new Error('a new AGENTS.md can only add lines')
      const positions = occurrences(lines, old)
      if (positions.length !== 1) throw new Error('the old text must occur once as whole lines')
      const at = positions[0]
      const replacement = edit.op === 'replace' ? lineBlock(textOf(edit.text)) : []
      lines.splice(at, old.length, ...replacement)
    }
    text = lines.join(newline) + (trailing && lines.length > 0 ? newline : '')
    newline = text.includes('\r\n') ? '\r\n' : '\n'
    trailing = text.endsWith('\n')
    lines = text === '' ? [] : text.split(/\r?\n/)
    if (trailing) lines.pop()
  }
  return text
}

// The review's answer as a proposal. A single edit written as the answer itself, with
// its operation as the action, is that edit; a replacement with no text removes; lines
// one edit names that stand apart in the file, each once, are one edit each.
export function agentsAnswer(reply, current) {
  let answer = parseJson(reply)
  if (['add', 'replace', 'remove'].includes(answer?.action)) {
    const { action, ...edit } = answer
    answer = { action: 'edit', edits: [{ op: action, ...edit }] }
  }
  if (!Array.isArray(answer?.edits)) return answer
  const lines = lineBlock(current ?? '')
  const apart = edit => {
    if (edit?.op !== 'replace' && edit?.op !== 'remove') return [edit]
    const old = lineBlock(textOf(edit.old))
    const text = lineBlock(textOf(edit.text))
    if (old.length < 2 || occurrences(lines, old).length > 0 || old.some(line => occurrences(lines, [line]).length !== 1)) return [edit]
    if (edit.op === 'replace' && text.length !== old.length) return [edit]
    return old.map((line, index) => ({ ...edit, old: line, ...(edit.op === 'replace' ? { text: text[index] } : {}) }))
  }
  const removes = edit => {
    const { text, ...rest } = edit
    return { ...rest, op: 'remove' }
  }
  const edits = answer.edits.map(edit => edit?.op === 'replace' && textOf(edit.text).trim() === '' ? removes(edit) : edit)
  return { ...answer, edits: edits.flatMap(apart) }
}

export function agentsProblem(proposal, current) {
  if (proposal === undefined) return 'the answer is not a JSON object'
  if (proposal.action === 'none') return undefined
  if (proposal.action !== 'edit') return `unknown action ${String(proposal.action)}`
  if (!Array.isArray(proposal.edits) || proposal.edits.length < 1 || proposal.edits.length > 3) return 'an edit needs 1 to 3 changes'
  const initial = current ?? ''
  let result = initial
  for (const edit of proposal.edits) {
    if (!edit || !['add', 'replace', 'remove'].includes(edit.op)) return 'unknown edit operation'
    const text = textOf(edit.text)
    const old = textOf(edit.old)
    const after = textOf(edit.after)
    const why = textOf(edit.why)
    if (why.trim() === '') return 'each edit needs a reason'
    if (edit.op !== 'remove' && text === '') return 'an add or replacement needs text'
    if (text.length > LEARNING.agentsEditMax) return `edit text must have at most ${LEARNING.agentsEditMax} characters`
    if (holdsSecret(text) || holdsSecret(why)) return 'it looks like it holds a secret'
    if (/#\d{2,}|\b\d{4}-\d{2}-\d{2}\b|\bv\d+\.\d+/u.test(text)) return 'the edit contains a task number, date, or version'
    const lines = lineBlock(result)
    if (edit.op === 'add') {
      if (typeof edit.after !== 'string') return 'an add needs an anchor'
      if (current === undefined && after !== '') return 'a new AGENTS.md can only add at the end'
      if (after !== '' && (after.includes('\n') || occurrences(lines, [after]).length !== 1)) return 'the add anchor must be one exact whole line'
    } else {
      if (current === undefined) return 'a new AGENTS.md can only add lines'
      if (old === '' || old.startsWith('\n') || old.endsWith('\n') || occurrences(lines, lineBlock(old)).length !== 1) return 'the old text must occur exactly once as whole lines'
    }
    result = applyEdits(result, [edit])
  }
  if (result.length > Math.max(initial.length + 800, 4_000)) return 'the resulting AGENTS.md is too large'
  if (result === initial) return 'the edits change nothing'
  return undefined
}

const improvementFields = ['observedProblem', 'proposedChange', 'expectedBenefit', 'rollbackPath']

export function improvementSystem() {
  return [
    'You turn verified task evidence into one reviewable Bot improvement proposal.',
    'The task was already checked against its declared acceptance evidence. Do not restate completion or invent facts beyond that evidence.',
    'Most verified tasks should produce "none". A proposal must name a reusable improvement, not merely describe the task.',
    '',
    'An improvement changes either:',
    '- a learned skill of the affected Bot: action "create" or "update", with name, description, content, and why;',
    '- the project AGENTS.md used by the affected Bot: action "edit", with 1 to 3 exact whole-line edits.',
    'Prefer a skill for a repeatable procedure. Use AGENTS.md only for a lasting rule that applies to most work in that project.',
    '',
    'Every proposal also needs:',
    '- observedProblem: the concrete recurring problem shown by the verified evidence;',
    '- proposedChange: what will change, in plain language;',
    '- expectedBenefit: the future outcome this should improve;',
    '- rollbackPath: how the user can restore the previous behavior.',
    'Never include secrets, credentials, dates, issue or PR numbers, task progress, file lists, or pasted logs in the proposed skill or AGENTS edits.',
    '',
    'Answer with one JSON object only:',
    '{"action":"none","reason":"<one sentence>"}',
    '{"action":"create","scope":"skill","name":"<lowercase-hyphen-name>","description":"<when to use it>","content":"<Markdown skill>","why":"<why the evidence earns it>","observedProblem":"…","proposedChange":"…","expectedBenefit":"…","rollbackPath":"…"}',
    '{"action":"update","scope":"skill","name":"<a learned skill listed>","description":"…","content":"<the whole new content>","why":"…","observedProblem":"…","proposedChange":"…","expectedBenefit":"…","rollbackPath":"…"}',
    '{"action":"edit","scope":"agents","edits":[{"op":"add|replace|remove","after":"<anchor or empty>","old":"<exact old whole lines when needed>","text":"<new text when needed>","why":"…"}],"observedProblem":"…","proposedChange":"…","expectedBenefit":"…","rollbackPath":"…"}',
  ].join('\n')
}

export function improvementRequest({ bot, detail, learned = [], agents }) {
  const evidence = (detail?.evidence ?? []).filter(item => item?.trust === 'verified' && item.stale !== true)
  const task = detail?.task ?? {}
  const parts = [
    `The affected Bot: ${bot.name}${bot.role ? `, ${bot.role}` : ''} (${bot.id}).`,
    `Verified task ${detail?.taskId ?? ''}: ${task.title || task.sourceId || ''}`,
    `Acceptance: ${task.acceptance || 'not stated'}`,
    `Verification: ${detail?.verification?.reason || 'verified'}`,
    `Verified evidence:\n${evidence.map(item => `<evidence id="${item.id}" source="${item.sourceId || ''}">\n${item.title ? `${item.title}\n` : ''}${item.text || ''}\n</evidence>`).join('\n')}`,
  ]
  parts.push(learned.length === 0
    ? 'This Bot has no learned skills yet, so only create a new skill or edit its project AGENTS.md.'
    : `This Bot's learned skills:\n${learned.map(skill => `<skill name="${skill.name}">\ndescription: ${skill.description}\n${skill.content}\n</skill>`).join('\n')}`)
  parts.push(agents?.current === undefined
    ? 'No writable project AGENTS.md is available for this Bot.'
    : `Project folder: ${agents.folder}\nCurrent AGENTS.md:\n\`\`\`md\n${agents.current}\n\`\`\``)
  return parts.join('\n\n')
}

export function improvementProblem(answer, { detail, bot, learned = [], skills = {}, agents, limit = LEARNING.learnedMax }) {
  if (!detail || detail.empty === true) return 'the task is no longer available'
  if (detail.verification?.status === 'stale') return 'the task evidence is stale and needs review'
  if (detail.verification?.status !== 'verified') return 'the task has no verified acceptance evidence'
  const evidence = (detail.evidence ?? []).filter(item => item?.trust === 'verified' && item.stale !== true)
  if (evidence.length === 0) return 'the task has no fresh verified evidence'
  if (!bot) return 'the affected Bot is no longer available'
  if (answer === undefined || answer === null || typeof answer !== 'object') return 'the answer is not a JSON object'
  if (answer.action === 'none') return undefined
  for (const field of improvementFields) {
    const value = textOf(answer[field]).trim()
    if (value === '') return `${field} is required`
    if (value.length > LEARNING.improvementTextMax) return `${field} must have at most ${LEARNING.improvementTextMax} characters`
    if (holdsSecret(value)) return 'it looks like it holds a secret'
  }
  if (answer.scope === 'skill') return skillProblem(answer, { skills, learned, limit })
  if (answer.scope === 'agents') {
    if (agents?.current === undefined && agents?.exists !== false) return 'the Bot has no writable project AGENTS.md'
    return agentsProblem(answer, agents?.current)
  }
  return 'scope must be skill or agents'
}

export function skillProblem(proposal, { skills, learned, limit = LEARNING.learnedMax }) {
  if (proposal === undefined) return 'the answer is not a JSON object'
  const { action } = proposal
  if (action === 'none') return undefined
  if (action !== 'create' && action !== 'update') return `unknown action ${String(action)}`
  let name
  try {
    name = validateCapabilityName(proposal.name)
  } catch (error) {
    return error.message
  }
  const description = typeof proposal.description === 'string' ? proposal.description.trim() : ''
  const content = typeof proposal.content === 'string' ? proposal.content.trim() : ''
  const why = typeof proposal.why === 'string' ? proposal.why.trim() : ''
  if (description === '' || description.length > LEARNING.descriptionMax) return `the description must have 1 to ${LEARNING.descriptionMax} characters`
  if (content === '' || content.length > LEARNING.contentMax) return `the content must have 1 to ${LEARNING.contentMax} characters`
  if (holdsSecret(description) || holdsSecret(content) || holdsSecret(why)) return 'it looks like it holds a secret'
  const existing = Object.hasOwn(skills, name) ? skills[name] : undefined
  if (action === 'create') {
    if (existing !== undefined) return `${name} already exists`
    if (learned.length >= limit) return `the Bot already keeps ${limit} learned skills`
  } else {
    if (existing === undefined || existing.kind !== 'skill' || !learned.includes(name)) return `${name} is not a learned skill of this Bot`
    if (existing.content.trim() === content && existing.description.trim() === description) return 'the update changes nothing'
  }
  return undefined
}

// ---------------------------------------------------------------------------

export function install(rt) {
  const { ctx, config, home, state } = rt
  const settings = { ...LEARNING, ...(config.learningTimes ?? {}) }
  const automatic = config.automaticLearning === true
  const on = config.learning !== false && config.memory !== false
  const view = () => ({})
  if (!on) {
    Object.assign(rt, { learningView: view, learningSettledView: view, improvementView: () => ({ proposals: [], history: [] }), learningEndpoint: async () => { throw new Error('Learning is turned off on this host') }, learningRun: async () => 0 })
    return
  }

  const root = join(home, 'learning')
  const path = join(root, 'state.json')
  // `pending`: Bot id → chats with a long turn since the last pass. `agentsPending`:
  // folder → queued work waiting for AGENTS.md review. `cursors`: newest line read.
  // `proposals`: waiting for the user, by id. `settled`: answered ones, by id, with
  // the outcome; their cards stay in the chat part they were answered in.
  // `learned`: skill names learned by Bot. `versions`: approved task improvements
  // by Bot and changed scope; the full audit stays with each settled proposal.
  let saved
  const data = () => {
    if (saved !== undefined) return saved
    try {
      saved = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') rt.warn('ds-bot: unreadable learning state %s: %s', path, error?.message ?? error)
      saved = {}
    }
    saved.pending ??= {}
    saved.cursors ??= {}
    saved.proposals ??= {}
    saved.settled ??= {}
    saved.declined ??= []
    saved.learned ??= {}
    saved.agentsPending ??= {}
    saved.versions ??= {}
    return saved
  }
  let stopped = false
  let writing = Promise.resolve()
  const persist = () => {
    if (stopped) return writing
    const text = JSON.stringify(data(), null, 1)
    writing = writing.then(async () => {
      await mkdir(dirname(path), { recursive: true })
      const temp = `${path}.${process.pid}.tmp`
      await writeFile(temp, text, 'utf8')
      await replaceFile(temp, path)
    }).catch(error => rt.warn('ds-bot: saving the learning state failed: %s', error?.message ?? error))
    return writing
  }

  // A turn in a Bot's own chat that ran long marks the chat for the next pass.
  const started = new Map()
  const noted = new Map()
  let lastActivity = Date.now()
  ctx.on('agent/status', ({ agent, status }) => {
    if (stopped || !automatic) return
    const id = agent?.id
    if (id === undefined || !rt.isBotSession(id)) return
    lastActivity = Date.now()
    if (status !== 'idle') {
      if (!started.has(id)) started.set(id, Date.now())
      return
    }
    const since = started.get(id)
    started.delete(id)
    const botId = rt.chatOwners.get(id)
    if (since === undefined || botId === undefined || Date.now() - since < settings.minTurnMs) return
    const pending = data().pending
    pending[botId] = [...new Set([...(pending[botId] ?? []), id])]
    noted.set(id, (noted.get(id) ?? 0) + 1)
    void persist()
  })

  // After the text budget, keep scanning to the cursor for user corrections.
  async function linesSince(sessionId) {
    const cursor = data().cursors[sessionId]
    const kept = []
    const userLines = []
    const keptRecords = []
    const userRecords = []
    let used = 0
    let userUsed = 0
    let overBudget = false
    let through
    for await (const line of rt.partLines(sessionId, AbortSignal.timeout(settings.readMs), { pages: Infinity })) {
      through ??= line.seq
      if (cursor !== undefined && line.seq <= cursor) break
      const text = clip(line.text, line.who === 'user' ? settings.userLineMax : settings.botLineMax)
      if (!overBudget && used + text.length <= settings.textMax) {
        kept.push(text)
        keptRecords.push({ text, time: line.time })
        used += text.length
        continue
      }
      overBudget = true
      if (text.startsWith('User: ') && userUsed + text.length <= settings.userTextMax) {
        userLines.push(text)
        userRecords.push({ text, time: line.time })
        userUsed += text.length
      }
    }
    return { lines: [...kept, ...userLines].reverse(), work: [...keptRecords, ...userRecords].reverse(), through }
  }

  const skillsOf = () => Object.fromEntries(Object.entries(state.capabilities?.items ?? {}).filter(([, item]) => item.kind === 'skill'))
  const learnedOf = bot => (data().learned[bot.id] ?? []).filter(name => skillsOf()[name] !== undefined && (bot.capabilities ?? []).includes(name))
  const waitingFor = botId => Object.values(data().proposals).filter(entry => entry.botId === botId)

  async function reviewSkill(bot, lines) {
    const skills = skillsOf()
    const learned = learnedOf(bot)
    const library = Object.values(skills).filter(item => !learned.includes(item.name)).map(item => ({ name: item.name, description: item.description }))
    const text = skillRequest({
      bot,
      lines,
      learned: learned.map(name => skills[name]),
      library,
      declined: data().declined.filter(entry => entry.kind !== 'agents'),
      language: writtenIn(lines.filter(line => line.startsWith('User: ')).map(line => line.slice(6)), rt.uiLanguage?.()),
      limit: settings.learnedMax,
    })
    const reply = await rt.botShot(bot, skillSystem(), text, { sessionId: rt.chatOf(bot.id), kind: 'memory' })
    const proposal = parseJson(reply)
    if (['description', 'content', 'why'].some(key => {
      const value = proposal?.[key]
      return typeof value === 'string' && rt.redactSecrets(value) !== value
    })) {
      rt.warn('ds-bot: the skill review of %s proposed content containing a saved secret', bot.name)
      return undefined
    }
    const problem = skillProblem(proposal, { skills, learned, limit: settings.learnedMax })
    if (problem !== undefined) {
      rt.warn('ds-bot: the skill review of %s proposed nothing usable: %s', bot.name, problem)
      return undefined
    }
    if (proposal.action === 'none') return undefined
    const name = proposal.name.trim()
    const previous = proposal.action === 'update' ? skills[name] : undefined
    return {
      id: randomUUID(),
      kind: 'skill',
      action: proposal.action,
      botId: bot.id,
      at: Date.now(),
      name,
      description: proposal.description.trim(),
      content: proposal.content.trim(),
      why: typeof proposal.why === 'string' ? clip(proposal.why.trim(), 300) : '',
      ...(previous ? {
        previous: { description: previous.description, content: previous.content },
        base: hashOf(`${previous.description}\n${previous.content}`),
      } : {}),
    }
  }

  async function reviewAgents(bot, folder, current, lines) {
    const language = writtenIn(lines.filter(line => line.startsWith('User: ')).map(line => line.slice(6)), rt.uiLanguage?.())
    const request = agentsRequest({ folder, current, lines, declined: data().declined, language })
    const reply = await rt.botShot(bot, agentsSystem(), request, { sessionId: rt.chatOf(bot.id), kind: 'memory' })
    const answer = agentsAnswer(reply, current)
    if (answer === undefined || answer === null || typeof answer !== 'object') throw new Error('the answer is not a JSON object')
    if (Array.isArray(answer.edits) && answer.edits.some(edit => [edit?.text, edit?.why].some(value => typeof value === 'string' && rt.redactSecrets(value) !== value))) {
      rt.warn('ds-bot: the AGENTS.md review of %s proposed content containing a saved secret', bot.name)
      return undefined
    }
    const problem = agentsProblem(answer, current)
    if (problem !== undefined) {
      if (answer?.action !== 'none') rt.warn('ds-bot: the AGENTS.md review of %s proposed nothing usable: %s', bot.name, problem)
      return undefined
    }
    if (answer.action === 'none') return undefined
    const content = applyEdits(current, answer.edits)
    return {
      id: randomUUID(),
      kind: 'agents',
      botId: bot.id,
      at: Date.now(),
      folder,
      path: join(folder, 'AGENTS.md'),
      base: hashOf(current ?? ''),
      exists: current !== undefined,
      edits: answer.edits.map(edit => ({ ...edit, text: textOf(edit.text), old: textOf(edit.old), why: textOf(edit.why) })),
      content,
    }
  }

  async function improvementAgents(bot) {
    if (!bot.workDir || config.agentsMd === false) return undefined
    try {
      const folder = await rt.real(bot.workDir)
      await rt.workFolder(folder)
      const current = await agentsFile(folder)
      return { folder, path: join(folder, 'AGENTS.md'), current, exists: current !== undefined }
    } catch (error) {
      rt.warn('ds-bot: the task improvement folder lookup for %s failed: %s', bot.name, error?.message ?? error)
      return undefined
    }
  }

  async function reviewImprovement(bot, detail) {
    const skills = skillsOf()
    const learned = learnedOf(bot)
    const agents = await improvementAgents(bot)
    const reply = await rt.botShot(bot, improvementSystem(), improvementRequest({ bot, detail, learned: learned.map(name => skills[name]), agents }), {
      sessionId: rt.chatOf(bot.id), kind: 'memory',
    })
    const answer = parseJson(reply)
    const textValues = answer === undefined ? [] : [
      ...improvementFields.map(field => answer[field]),
      answer.scope === 'skill' ? answer.description : undefined,
      answer.scope === 'skill' ? answer.content : undefined,
      answer.scope === 'skill' ? answer.why : undefined,
      ...(Array.isArray(answer.edits) ? answer.edits.flatMap(edit => [edit?.text, edit?.why]) : []),
    ]
    if (textValues.some(value => typeof value === 'string' && rt.redactSecrets(value) !== value)) {
      rt.warn('ds-bot: the task improvement review of %s proposed content containing a saved secret', bot.name)
      return undefined
    }
    const problem = improvementProblem(answer, { detail, bot, learned, skills, agents, limit: settings.learnedMax })
    if (problem !== undefined) throw new Error(`the task improvement proposal is not usable: ${problem}`)
    if (answer.action === 'none' || (!automatic && answer.scope === 'skill')) return undefined
    const verified = detail.evidence.filter(item => item.trust === 'verified' && item.stale !== true)
    let target
    let label
    let base
    let afterHash
    let fields
    if (answer.scope === 'skill') {
      const name = answer.name.trim()
      const current = answer.action === 'update' ? skills[name] : undefined
      target = name
      label = `Skill · ${name}`
      base = current === undefined ? hashOf('') : hashOf(`${current.description}\n${current.content}`)
      afterHash = hashOf(`${answer.description.trim()}\n${answer.content.trim()}`)
      fields = {
        kind: 'skill',
        action: answer.action,
        name,
        description: answer.description.trim(),
        content: answer.content.trim(),
        why: textOf(answer.why).trim(),
        ...(current ? {
          previous: { description: current.description, content: current.content },
          base: hashOf(`${current.description}\n${current.content}`),
        } : {}),
      }
    } else {
      const content = applyEdits(agents.current, answer.edits)
      target = agents.folder
      label = `AGENTS.md · ${agents.folder}`
      base = hashOf(agents.current ?? '')
      afterHash = hashOf(content)
      fields = {
        kind: 'agents',
        action: 'edit',
        folder: agents.folder,
        path: agents.path,
        base,
        exists: agents.current !== undefined,
        edits: answer.edits.map(edit => ({ ...edit, text: textOf(edit.text), old: textOf(edit.old), why: textOf(edit.why) })),
        content,
      }
    }
    return {
      id: randomUUID(),
      ...fields,
      botId: bot.id,
      at: Date.now(),
      improvement: {
        taskId: detail.taskId,
        taskTitle: detail.task?.title || detail.task?.sourceId || detail.taskId,
        evidenceIds: verified.map(item => item.id),
        sourceIds: [...new Set(verified.map(item => item.sourceId).filter(Boolean))],
        verification: {
          status: detail.verification.status,
          verifiedAt: detail.verification.verifiedAt ?? null,
          reason: detail.verification.reason ?? '',
        },
        affectedBot: { id: bot.id, name: bot.name },
        scope: { kind: answer.scope, target, label },
        observedProblem: textOf(answer.observedProblem).trim(),
        proposedChange: textOf(answer.proposedChange).trim(),
        expectedBenefit: textOf(answer.expectedBenefit).trim(),
        rollbackPath: textOf(answer.rollbackPath).trim(),
        botConfigHash: botConfigHash(bot),
        beforeHash: base,
        afterHash,
        changeKey: `${answer.scope}:${target}`,
      },
    }
  }

  const exists = async path => {
    try { await access(path); return true } catch { return false }
  }
  async function agentsFile(folder) {
    const path = join(folder, 'AGENTS.md')
    try {
      const content = await readFile(path, 'utf8')
      return content.length <= LEARNING.agentsFileMax ? content : undefined
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
  }

  function queueAgentsWork(folder, bot, records) {
    if (records.length === 0) return
    const queue = data().agentsPending[folder] ??= { botId: bot.id, records: [] }
    if (rt.botOf(queue.botId) === undefined) queue.botId = bot.id
    queue.records ??= []
    let order = queue.records.reduce((max, item) => Math.max(max, item.order ?? 0), -1) + 1
    for (const item of records) queue.records.push({ botId: bot.id, text: item.text, time: item.time, order: order++ })
    const max = settings.textMax + settings.userTextMax
    let size = queue.records.reduce((sum, item) => sum + item.text.length, 0)
    const removed = new Set()
    const oldest = [...queue.records].sort((a, b) => (a.time ?? 0) - (b.time ?? 0) || a.order - b.order)
    for (const item of oldest) {
      if (size <= max) break
      if (item.text.startsWith('User: ')) continue
      removed.add(item)
      size -= item.text.length
    }
    for (const item of oldest) {
      if (size <= max) break
      if (!item.text.startsWith('User: ')) continue
      removed.add(item)
      size -= item.text.length
    }
    if (removed.size > 0) queue.records = queue.records.filter(item => !removed.has(item))
    if (queue.records.length === 0) delete data().agentsPending[folder]
  }

  // One pass over every Bot with a long turn since the last one. A Bot with a
  // proposal still waiting is skipped: its chat is read again in the next pass.
  let running
  async function run() {
    if (stopped || !automatic) return 0
    if (running) return running
    running = (async () => {
      const store = data()
      store.lastRun = Date.now()
      let made = 0
      for (const [botId, pendingSessions] of Object.entries(store.pending)) {
        if (stopped) break
        const bot = rt.botOf(botId)
        if (bot === undefined) {
          delete store.pending[botId]
          continue
        }
        if (waitingFor(botId).length > 0) continue
        const sessions = [...pendingSessions]
        const notedAtStart = new Map(sessions.map(sessionId => [sessionId, noted.get(sessionId)]))
        try {
          const read = []
          for (const sessionId of sessions) read.push({ sessionId, ...await linesSince(sessionId) })
          if (stopped) return made
          const lines = read.flatMap(entry => entry.lines)
          const proposal = lines.length === 0 ? undefined : await reviewSkill(bot, lines)
          if (stopped) return made
          if (proposal !== undefined) {
            store.proposals[proposal.id] = proposal
            made += 1
          }
          if (config.agentsMd !== false) {
            for (const entry of read) {
              try {
                const agent = await rt.resolveAgent(entry.sessionId)
                const reported = rt.sessionFolder(agent.session)
                if (!reported) continue
                const folder = await rt.real(reported)
                try { await rt.workFolder(folder) } catch { continue }
                if (!await exists(join(folder, '.git')) && !await exists(join(folder, 'AGENTS.md'))) continue
                queueAgentsWork(folder, bot, entry.work ?? [])
              } catch (error) {
                rt.warn('ds-bot: the AGENTS.md folder lookup for %s failed: %s', entry.sessionId, error?.message ?? error)
              }
            }
          }
          for (const entry of read) if (entry.through !== undefined) store.cursors[entry.sessionId] = entry.through
          const remaining = (store.pending[botId] ?? []).filter(sessionId =>
            !notedAtStart.has(sessionId) || noted.get(sessionId) !== notedAtStart.get(sessionId))
          if (remaining.length === 0) delete store.pending[botId]
          else store.pending[botId] = remaining
        } catch (error) {
          rt.warn('ds-bot: the learning review of %s failed: %s', bot.name, error?.message ?? error)
          continue
        }
      }
      if (config.agentsMd !== false) {
        for (const [folder, group] of Object.entries(store.agentsPending)) {
          if (stopped) break
          let bot = rt.botOf(group.botId)
          if (bot === undefined) {
            const contributor = group.records.find(item => rt.botOf(item.botId) !== undefined)
            if (contributor === undefined) {
              delete store.agentsPending[folder]
              continue
            }
            group.botId = contributor.botId
            bot = rt.botOf(group.botId)
          }
          if (Object.values(store.proposals).some(entry => entry.kind === 'agents' && entry.folder === folder)) continue
          try {
            const reviewRecords = [...group.records]
            const reviewedOrders = reviewRecords.map(item => item.order)
            const current = await agentsFile(folder)
            if (stopped) return made
            if (current === undefined && await exists(join(folder, 'AGENTS.md'))) continue
            const lines = []
            let used = 0
            let userUsed = 0
            let overBudget = false
            for (const item of reviewRecords.sort((a, b) => (a.time ?? 0) - (b.time ?? 0) || a.order - b.order)) {
              if (!overBudget && used + item.text.length <= settings.textMax) {
                lines.push(item.text)
                used += item.text.length
                continue
              }
              overBudget = true
              if (item.text.startsWith('User: ') && userUsed + item.text.length <= settings.userTextMax) {
                lines.push(item.text)
                userUsed += item.text.length
              }
            }
            if (lines.length === 0) continue
            const proposal = await reviewAgents(bot, folder, current, lines)
            if (stopped) return made
            if (proposal !== undefined) {
              store.proposals[proposal.id] = proposal
              made += 1
            }
            const queue = store.agentsPending[folder]
            if (queue) {
              queue.records = withoutReviewedAgentsRecords(queue.records ?? [], reviewedOrders)
              if (queue.records.length === 0) delete store.agentsPending[folder]
            }
          } catch (error) {
            rt.warn('ds-bot: the AGENTS.md review of %s failed: %s', folder, error?.message ?? error)
          }
        }
      }
      await persist()
      return made
    })().finally(() => { running = undefined })
    return running
  }

  const due = () => {
    if (stopped || !automatic) return false
    const store = data()
    const hasPending = Object.values(store.pending).some(sessions => sessions.length > 0)
      || (config.agentsMd !== false && Object.values(store.agentsPending).some(queue => queue.records?.length > 0))
    if (!hasPending || rt.readOnly() !== undefined) return false
    if (Object.keys(rt.workView()).length > 0 || Date.now() - lastActivity < settings.idleMs) return false
    return store.lastRun === undefined || Date.now() - store.lastRun >= settings.intervalMs
  }
  ctx.effect(() => {
    const timer = setInterval(() => {
      if (due()) void run().catch(error => rt.warn('ds-bot: learning pass failed: %s', error?.message ?? error))
    }, settings.tickMs)
    timer.unref?.()
    return () => {
      stopped = true
      clearInterval(timer)
      // A new host may take over after disposal; finish only writes already queued.
      return writing
    }
  }, 'ds-bot: learning')

  async function proposeImprovement({ taskId }) {
    const id = String(taskId ?? '').trim()
    if (id === '') throw Object.assign(new Error('No task named'), { code: 'bot/invalid' })
    if (typeof rt.taskDetailFor !== 'function') throw new Error('Task detail is unavailable on this host')
    const detail = await rt.taskDetailFor(id)
    if (detail?.empty === true) throw Object.assign(new Error('The task is no longer available'), { code: 'bot/stale' })
    if (detail.verification?.status === 'stale') throw new Error('The task evidence is stale and needs review')
    if (detail.verification?.status !== 'verified') throw new Error('The task has no verified acceptance evidence')
    if ((detail.evidence ?? []).every(item => item.trust !== 'verified' || item.stale === true)) throw new Error('The task has no fresh verified evidence')
    const owner = detail.owner ?? {}
    const bot = owner.kind === 'bot' && owner.id ? rt.botOf(owner.id) : undefined
    if (bot === undefined) throw new Error('Only a task owned by a Bot can produce an improvement')
    const proposal = await reviewImprovement(bot, detail)
    if (proposal === undefined) return null
    data().proposals[proposal.id] = proposal
    await persist()
    return proposal
  }

  function settledAnswer(proposal, approve) {
    const store = data()
    if (!Object.hasOwn(store.settled, proposal.id)) return undefined
    const settled = store.settled[proposal.id]
    const expected = approve ? 'approved' : 'declined'
    if (settled.outcome !== expected) {
      throw Object.assign(new Error(`This proposal was already ${settled.outcome}`), { code: 'bot/conflict' })
    }
    return { applied: settled.outcome === 'approved', duplicate: true, proposal: settled }
  }

  async function requiresReview(proposal, reason) {
    const open = data().proposals[proposal.id]
    if (open === undefined) return
    open.requiresReview = true
    open.reviewReason = clip(reason, LEARNING.improvementTextMax)
    open.reviewedAt = Date.now()
    await persist()
    throw Object.assign(new Error(`${reason}; review the proposal before applying it`), { code: 'bot/refused' })
  }

  async function checkImprovement(proposal) {
    const bot = rt.botOf(proposal.botId)
    if (bot === undefined) return requiresReview(proposal, 'The affected Bot is gone')
    if (proposal.improvement.botConfigHash !== botConfigHash(bot)) return requiresReview(proposal, 'The Bot configuration changed since this proposal was created')
    const detail = await rt.taskDetailFor(proposal.improvement.taskId)
    if (detail?.verification?.status === 'stale') return requiresReview(proposal, `The task evidence is stale: ${detail.verification.reason || 'acceptance changed'}`)
    if (detail?.verification?.status !== 'verified') return requiresReview(proposal, 'The task no longer has verified acceptance evidence')
    const verified = (detail.evidence ?? []).filter(item => item.trust === 'verified' && item.stale !== true)
    const available = new Set(verified.map(item => item.id))
    const sources = new Set(verified.map(item => item.sourceId).filter(Boolean))
    if (proposal.improvement.evidenceIds.some(id => !available.has(id)) || proposal.improvement.sourceIds.some(id => !sources.has(id))) {
      return requiresReview(proposal, 'The verified task evidence changed since this proposal was created')
    }
  }

  async function taskImprovementAudit(proposal) {
    const bot = rt.botOf(proposal.botId)
    if (bot === undefined) throw new Error('The affected Bot is gone')
    await checkImprovement(proposal)
    const store = data()
    const versions = store.versions[bot.id] ??= {}
    const version = (Number.isInteger(versions[proposal.improvement.changeKey]) ? versions[proposal.improvement.changeKey] : 0) + 1
    let beforeHash = proposal.improvement.beforeHash
    let afterHash = proposal.improvement.afterHash
    try {
      if (proposal.kind === 'agents') {
        await applyAgents(proposal)
      } else {
        const current = skillsOf()[proposal.name]
        beforeHash = proposal.action === 'update' && current ? hashOf(`${current.description}\n${current.content}`) : hashOf('')
        await applySkill(proposal)
        const after = skillsOf()[proposal.name]
        if (after) afterHash = hashOf(`${after.description}\n${after.content}`)
      }
    } catch (error) {
      if (/changed since this was proposed|exists now|is gone/i.test(error?.message ?? '')) await requiresReview(proposal, error.message)
      throw error
    }
    versions[proposal.improvement.changeKey] = version
    return {
      id: randomUUID(),
      action: 'apply',
      at: Date.now(),
      proposalId: proposal.id,
      version,
      botId: bot.id,
      scope: proposal.improvement.changeKey,
      taskId: proposal.improvement.taskId,
      evidenceIds: [...proposal.improvement.evidenceIds],
      sourceIds: [...proposal.improvement.sourceIds],
      beforeHash,
      afterHash,
      rollbackPath: proposal.improvement.rollbackPath,
    }
  }

  // The user's answer to a card. Repeated answers with the same decision return the
  // settled result; a different decision is refused because the first one is history.
  async function answerProposal({ id, approve }) {
    const store = data()
    const proposal = Object.hasOwn(store.proposals, id) ? store.proposals[id] : undefined
    if (proposal === undefined) {
      if (Object.hasOwn(store.settled, id)) return settledAnswer(store.settled[id], approve)
      throw Object.assign(new Error('This proposal is no longer open'), { code: 'bot/stale' })
    }
    if (!visibleProposal(proposal)) throw Object.assign(new Error('Request this Skill change in the Bot chat before approving it.'), { code: 'bot/stale' })
    if (proposal.requiresReview === true) {
      throw Object.assign(new Error(`This proposal requires review: ${proposal.reviewReason}`), { code: 'bot/refused' })
    }
    const settle = (outcome, extra = {}) => {
      delete store.proposals[id]
      const { saved: _saved, ...kept } = proposal
      const settled = { ...kept, ...extra, sessionId: rt.chatOf(proposal.botId), outcome, settledAt: Date.now() }
      store.settled[id] = settled
      return settled
    }
    if (approve !== true) {
      const decline = proposal.kind === 'agents'
        ? { kind: 'agents', folder: proposal.folder, edits: proposal.edits.map(({ op, text, old }) => ({ op, text, old })), at: Date.now() }
        : { name: proposal.name, description: proposal.description, at: Date.now() }
      if (proposal.improvement) decline.improvement = { taskId: proposal.improvement.taskId, evidenceIds: proposal.improvement.evidenceIds }
      store.declined = [...store.declined, decline].slice(-settings.declinedMax)
      const settled = settle('declined')
      await persist()
      return { applied: false, duplicate: false, proposal: settled }
    }
    let audit
    if (proposal.improvement) audit = await taskImprovementAudit(proposal)
    else if (proposal.kind === 'agents') await applyAgents(proposal)
    else await applySkill(proposal)
    const version = audit?.version
    const settled = settle('approved', audit ? { audit, version } : {})
    await persist()
    return { applied: true, duplicate: false, proposal: settled }
  }

  const decisions = new Map()
  async function answer({ id, approve }) {
    const active = decisions.get(id)
    if (active !== undefined) {
      if (active.approve !== approve) {
        throw Object.assign(new Error(`This proposal is being ${active.approve ? 'approved' : 'declined'}`), { code: 'bot/conflict' })
      }
      return active.promise
    }
    const decision = { approve, promise: undefined }
    decision.promise = answerProposal({ id, approve })
    decisions.set(id, decision)
    try {
      return await decision.promise
    } finally {
      if (decisions.get(id) === decision) decisions.delete(id)
    }
  }

  const agentsApplying = new Map()
  async function applyAgents(proposal) {
    const path = proposal.path
    const previous = agentsApplying.get(path) ?? Promise.resolve()
    let release
    const lock = new Promise(resolve => { release = resolve })
    const queued = previous.catch(() => {}).then(() => lock)
    agentsApplying.set(path, queued)
    await previous.catch(() => {})
    try {
      const folder = await rt.real(proposal.folder)
      await rt.workFolder(folder)
      if (join(folder, 'AGENTS.md') !== path) throw new Error('AGENTS.md changed since this was proposed')
      const readCurrent = async () => {
        try { return await readFile(path, 'utf8') } catch (error) {
          if (error?.code !== 'ENOENT') throw error
          return undefined
        }
      }
      const checkCurrent = current => {
        const existsNow = current !== undefined
        if (existsNow !== proposal.exists || hashOf(current ?? '') !== proposal.base) {
          throw new Error('AGENTS.md changed since this was proposed')
        }
      }
      checkCurrent(await readCurrent())
      const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
      try {
        await writeFile(temp, proposal.content, 'utf8')
        checkCurrent(await readCurrent())
        await replaceFile(temp, path)
      } finally {
        await unlink(temp).catch(() => {})
      }
    } finally {
      release()
      if (agentsApplying.get(path) === queued) agentsApplying.delete(path)
    }
  }

  async function applySkill(proposal) {
    const bot = rt.botOf(proposal.botId)
    if (bot === undefined) throw new Error('The Bot that learned this skill is gone')
    const current = skillsOf()[proposal.name]
    const store = data()
    if (proposal.action === 'create') {
      if (proposal.saved) {
        if (current === undefined || current.description !== proposal.description || current.content !== proposal.content) {
          throw new Error(`${proposal.name} changed since this was proposed`)
        }
        store.learned[bot.id] = [...new Set([...(store.learned[bot.id] ?? []), current.name])]
        await persist()
      } else {
        if (current !== undefined) throw new Error(`A skill named ${proposal.name} exists now`)
        const item = await rt.capabilitySave({ name: proposal.name, kind: 'skill', description: proposal.description, content: proposal.content }, { botId: bot.id, ui: false })
        proposal.saved = true
        store.learned[bot.id] = [...new Set([...(store.learned[bot.id] ?? []), item.name])]
        await persist()
      }
    } else if (proposal.action === 'update') {
      if (current === undefined || hashOf(`${current.description}\n${current.content}`) !== proposal.base) throw new Error(`${proposal.name} changed since this was proposed`)
      const item = await rt.capabilitySave({ name: proposal.name, kind: 'skill', description: proposal.description, content: proposal.content }, { botId: bot.id, ui: false })
      store.learned[bot.id] = [...new Set([...(store.learned[bot.id] ?? []), item.name])]
      await persist()
    }
    if (!(bot.capabilities ?? []).includes(proposal.name)) await rt.capabilityEndpoint('bot-capability', { botId: bot.id, name: proposal.name, attached: true })
  }

  async function learningEndpoint(endpoint, body) {
    if (endpoint === 'learning-answer') return answer({ id: String(body.id ?? ''), approve: body.approve === true })
    if (endpoint === 'task-improvement-propose') return proposeImprovement({ taskId: body.taskId })
    throw new Error(`Unknown endpoint ${endpoint}`)
  }

  async function removeLearned(name) {
    const learned = data().learned
    const deleted = String(name ?? '')
    for (const [botId, names] of Object.entries(learned)) {
      learned[botId] = (Array.isArray(names) ? names : []).filter(entry => entry !== deleted)
    }
    await persist()
  }

  const visibleProposal = entry => automatic || entry.requested === true || (entry.kind === 'agents' && Boolean(entry.improvement))
  function parseSkillRequest(text) {
    const match = text.trim().match(/^(?:\/skill\s+(create|update)\s+|(?:please\s+)?(create|update)\s+(?:the\s+)?skill\s+|(?:请(?:帮我)?\s*)?(创建|新建|更新|修改)(?:技能|\s+skill)\s*)(?:`([a-z0-9-]+)`|([a-z0-9-]+))(?=\s|[:：]|$)\s*[:：]?\s*([\s\S]*)$/iu)
    if (!match) return undefined
    const action = match[1] ?? match[2] ?? (['创建', '新建'].includes(match[3]) ? 'create' : 'update')
    return [action.toLowerCase(), (match[4] ?? match[5]).toLowerCase(), match[6]]
  }
  ctx.on('agent/pre-step', async ({ agent, step, messages, signal }, next) => {
    if (step !== 1 || messages.length !== 1) return next()
    const [message] = messages
    if (message.source?.kind !== 'user' || message.content?.length !== 1 || message.content[0].type !== 'text') return next()
    const request = parseSkillRequest(message.content[0].text)
    if (!request) return next()
    await rt.load()
    const botId = rt.chatOwners.get(agent.id)
    if (!botId) return next()
    signal?.throwIfAborted()
    await requestSkill(botId, ...request)
    return { kind: 'enter', messages: [] }
  })
  const drafting = new Map()
  function requestSkill(botId, action, name, instruction) {
    const key = JSON.stringify([botId, name])
    if (drafting.has(key)) return drafting.get(key)
    const run = draftRequestedSkill(botId, action, name, instruction).finally(() => drafting.delete(key))
    drafting.set(key, run)
    return run
  }

  async function draftRequestedSkill(botId, action, name, instruction) {
    validateCapabilityName(name)
    const bot = rt.botOf(botId)
    if (!bot || stopped || rt.readOnly() !== undefined) throw new Error('Skill drafting is unavailable here.')
    const before = skillsOf()[name]
    if ((action === 'update') !== Boolean(before)) throw new Error(action === 'update' ? 'No shared Skill has this name.' : 'This Skill already exists.')
    if (before && before.createdBy && before.createdBy !== botId && !state.mainBotIds.includes(botId)) {
      throw new Error('Ask the Skill owner or a Main Bot to request the update.')
    }
    if (instruction.trim() === '') throw new Error('Describe the requested Skill change after the name.')
    if (holdsSecret(instruction) || rt.redactSecrets(instruction) !== instruction) throw new Error('Remove secrets from the Skill request.')
    const pending = Object.values(data().proposals).find(entry => entry.requested && entry.botId === botId && entry.name === name)
    if (pending && pending.action === action && pending.requestHash === hashOf(instruction)) return pending
    const reply = await rt.botShot(bot, 'Draft a user-requested Skill. Return only a JSON object with description, content and why. Do not include secrets or one-off task details.', JSON.stringify({
      action, name, instruction, existing: before ? { description: before.description, content: before.content } : null,
    }), { sessionId: rt.chatOf(botId), kind: 'memory' })
    const draft = parseJson(reply)
    const item = { action, name, description: textOf(draft?.description).trim(), content: textOf(draft?.content).trim(), why: clip(textOf(draft?.why).trim(), 300) }
    if (item.description === before?.description.trim() && item.content === before?.content.trim()) return null
    if (skillsOf()[name] !== before) throw new Error('The Skill changed while the draft was prepared.')
    if ([item.description, item.content, item.why].some(value => rt.redactSecrets(value) !== value)) throw new Error('The Skill draft contains a saved secret.')
    const problem = skillProblem(item, { skills: skillsOf(), learned: before ? [name] : [], limit: settings.learnedMax })
    if (problem) throw new Error(problem)
    const store = data()
    const same = Object.values(store.proposals).find(entry => entry.requested && entry.botId === botId && entry.name === name
      && entry.action === action && entry.description === item.description && entry.content === item.content)
    if (same) return same
    if (pending) throw new Error('Approve or decline the pending change to this Skill first.')
    const proposal = { ...item, id: randomUUID(), kind: 'skill', requested: true, requestHash: hashOf(instruction), botId, at: Date.now(),
      ...(before ? { previous: { description: before.description, content: before.content }, base: hashOf(`${before.description}\n${before.content}`) } : {}) }
    store.proposals[proposal.id] = proposal
    await persist()
    return proposal
  }

  // Per Bot, its proposals waiting for the user.
  const learningView = () => {
    const byBot = {}
    for (const entry of Object.values(data().proposals)) if (visibleProposal(entry)) (byBot[entry.botId] ??= []).push(entry)
    return byBot
  }
  // Every pending and answered proposal tied to one task, including history that
  // left the Bot's current chat part.
  const improvementView = (taskId) => {
    const pending = Object.values(data().proposals).filter(entry => visibleProposal(entry) && entry.improvement?.taskId === taskId)
    const history = Object.values(data().settled).filter(entry => entry.improvement?.taskId === taskId)
    const byTime = (a, b) => (a.at ?? 0) - (b.at ?? 0) || (a.settledAt ?? 0) - (b.settledAt ?? 0)
    return { proposals: pending.sort(byTime), history: history.sort(byTime) }
  }
  // Per Bot, the answered proposals of its current chat part.
  const learningSettledView = () => {
    const byBot = {}
    for (const entry of Object.values(data().settled)) {
      if (rt.botOf(entry.botId) !== undefined && entry.sessionId === rt.chatOf(entry.botId)) (byBot[entry.botId] ??= []).push(entry)
    }
    return byBot
  }

  const capabilityDelete = rt.capabilityDelete
  rt.capabilityDelete = async (...args) => {
    const result = await capabilityDelete(...args)
    await removeLearned(args[0])
    return result
  }
  const capabilityEndpoint = rt.capabilityEndpoint
  rt.capabilityEndpoint = async (endpoint, body, ...args) => {
    const result = await capabilityEndpoint(endpoint, body, ...args)
    if (endpoint === 'capability-delete') await removeLearned(body?.name)
    return result
  }

  Object.assign(rt, { learningView, learningSettledView, improvementView, learningEndpoint, learningRun: run, requestSkill, parseSkillRequest })
}
