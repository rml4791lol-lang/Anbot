import { execFileSync } from 'node:child_process'

const paths = execFileSync('git', ['diff', '--name-only', 'HEAD'], { encoding: 'utf8' }).split('\n').filter(Boolean)
const forbidden = paths.filter(path => /(^|\/)(deepseek-harness|\.dsh)(\/|$)/.test(path) || path.startsWith('/Users/'))
const outside = paths.filter(path => !path.startsWith('ds-bot/'))
if (forbidden.length > 0 || outside.length > 0) {
  throw new Error(JSON.stringify({ forbidden, outside }))
}
console.log(JSON.stringify({ changedPaths: paths, dshPatched: false }))
