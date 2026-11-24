const SHELL_TOOLS = new Set(['bash', 'pwsh'])
const REMOVE = new Set(['rm', 'remove-item', 'ri', 'del', 'erase', 'rmdir', 'rd'])
const DISK = new Set(['mkfs', 'wipefs', 'diskpart', 'format-volume', 'clear-disk', 'initialize-disk'])
const SHELL = new Set(['bash', 'sh', 'zsh', 'pwsh', 'powershell', 'cmd'])
const WRAPPERS = new Set(['env', 'command', 'exec', 'nohup'])
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'])
const SEPARATOR = /^[;&|\n]+$/u
const tokenPattern = /"(?:[^"\\]|\\.)*"|'[^']*'|[;&|\n]+|[^\s"';&|\n]+/gu

const unquote = word => word.replace(/^(["'])([\s\S]*)\1$/u, '$2')
const executable = word => unquote(word).split(/[/\\]/u).at(-1).toLowerCase().replace(/\.exe$/u, '')

function commandRisk(tokens, depth) {
  const args = tokens.map(unquote)
  // Environment assignments do not consume the command position.
  while (args.length && (/^\w+=/u.test(args[0]) || args[0] === '&' || WRAPPERS.has(executable(args[0])))) args.shift()
  if (args.length === 0) return undefined
  const head = executable(args.shift())
  const lower = args.map(value => value.toLowerCase())
  if (head === 'sudo' || head === 'doas') return 'elevated'
  if (DISK.has(head) || head.startsWith('mkfs.')) return 'disk'
  if (REMOVE.has(head) && lower.some(word => word === '--recursive' || /^-([a-z]*r[a-z]*|recurse)$/u.test(word))) return 'delete'
  if (head === 'git') {
    // The subcommand may follow git-wide options (e.g. -C <folder>).
    let index = 0
    while (args[index]?.startsWith('-')) index += GIT_OPTIONS_WITH_VALUE.has(args[index]) ? 2 : 1
    const operation = lower[index]
    if (operation === 'push') return 'remote'
    if ((operation === 'reset' && lower.includes('--hard'))
      || (operation === 'restore' && !lower.includes('--staged'))
      || (operation === 'restore' && lower.includes('--worktree'))
      || (operation === 'clean' && lower.some(word => /^-[a-z]*f/u.test(word) || word === '--force'))
      || (operation === 'branch' && args.some(word => word === '-D' || word === '--delete'))) return 'git'
  }
  if (depth > 0 && SHELL.has(head)) {
    const script = lower.findIndex(word => /^-(?:[a-z]*c|command)$/u.test(word) || word === '/c')
    if (script !== -1 && args[script + 1]) return shellCommandRisk(args[script + 1], depth - 1)
  }
  return undefined
}

export function shellCommandRisk(command, depth = 2) {
  const segment = []
  for (const token of [...(command.match(tokenPattern) ?? []), '\n']) {
    if (!SEPARATOR.test(token)) {
      segment.push(token)
      continue
    }
    const risk = commandRisk(segment, depth)
    if (risk !== undefined) return risk
    segment.length = 0
  }
  return undefined
}

const REASONS = {
  git: ['This Git command can discard work.', '此 Git 命令可能丢弃改动。'],
  remote: ['This command can update a remote Git repository.', '此命令可能改动远程 Git 仓库。'],
  delete: ['This command can delete a directory recursively.', '此命令可能递归删除目录。'],
  disk: ['This command can alter disk contents.', '此命令可能更改磁盘内容。'],
  elevated: ['This command requests elevated privileges.', '此命令请求提升权限。'],
}

export function install(rt) {
  rt.ctx.on('tools/pre-execute', async (exec, next) => {
    if (!SHELL_TOOLS.has(exec.name) || typeof exec.arguments?.command !== 'string') return next()
    await rt.load()
    if (!rt.isBotSession(exec.agent?.session?.id ?? exec.agent?.id)) return next()
    const risk = shellCommandRisk(exec.arguments.command)
    if (risk === undefined) return next()
    const decision = await next()
    if (exec.signal?.aborted) return { kind: 'cancel' }
    if (decision.kind !== 'allow') return decision
    const [en, zh] = REASONS[risk]
    return { kind: 'ask', reason: en, displayReason: { en, zh } }
  })
}
