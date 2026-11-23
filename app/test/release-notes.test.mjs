import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import {
  checksums, copyName, downloadBlock, formatSize, missingPackages, PACKAGES, packageName, releaseRepository, REPO, withDownloads,
} from '../scripts/release-notes.mjs'

const script = fileURLToPath(new URL('../scripts/release-notes.mjs', import.meta.url))
const read = file => readFileSync(new URL(file, import.meta.url), 'utf8')
const names = version => PACKAGES.map(entry => packageName(version, entry))
const MB = 1024 ** 2

test('the desktop packages carry Anbot names, and copies drop the version', () => {
  assert.match(read('../electron-builder.yml'), /^artifactName: Anbot-\$\{version\}-\$\{os\}-\$\{arch\}\.\$\{ext\}$/mu)
  assert.deepEqual(names('0.2.3'), [
    'Anbot-0.2.3-win-x64.exe',
    'Anbot-0.2.3-mac-arm64.zip',
    'Anbot-0.2.3-mac-x64.zip',
    'Anbot-0.2.3-linux-x86_64.AppImage',
    'Anbot-0.2.3-linux-amd64.deb',
    'Anbot-0.2.3-android.apk',
  ])
  assert.deepEqual(PACKAGES.map(copyName), [
    'Anbot-win-x64.exe',
    'Anbot-mac-arm64.zip',
    'Anbot-mac-x64.zip',
    'Anbot-linux-x86_64.AppImage',
    'Anbot-linux-amd64.deb',
    'Anbot-android.apk',
  ])
})

test('sizes are whole megabytes, as GitHub shows them', () => {
  assert.equal(formatSize(222_174_558), '212 MB')
  assert.equal(formatSize(10), '1 MB')
})

test('the independent repository is the only accepted release identity', () => {
  assert.equal(REPO, 'rml4791lol-lang/Anbot')
  assert.equal(releaseRepository(REPO), REPO)
  assert.equal(releaseRepository(''), REPO)
  assert.equal(releaseRepository(undefined), REPO)
  assert.throws(() => releaseRepository('Fei2411/DS-Bot'), /rml4791lol-lang\/Anbot/u)
})

test('the table lists the desktop and phone packages', () => {
  const sizes = Object.fromEntries(names('0.2.3').map((name, index) => [name, (index + 1) * 100 * MB]))
  const block = downloadBlock({ version: '0.2.3', sizes })
  const rows = block.split('\n').filter(line => line.startsWith('| ') && !line.startsWith('| System'))
  assert.equal(rows.length, 6)
  assert.match(rows[0], /^\| \*\*Windows 10\/11 \(64-bit \/ 64 位\)\*\*<br>Double-click to install \/ 双击安装 \| \[Anbot-0\.2\.3-win-x64\.exe\]\(https:\/\/github\.com\/rml4791lol-lang\/Anbot\/releases\/download\/v0\.2\.3\/Anbot-0\.2\.3-win-x64\.exe\) \| 100 MB \|$/u)
  assert.match(rows[1], /^\| macOS, Apple chip .*mac-arm64\.zip.*\| 200 MB \|$/u)
  assert.match(rows[2], /^\| macOS, Intel .*mac-x64\.zip.*\| 300 MB \|$/u)
  assert.match(rows[3], /^\| Linux, AppImage .*linux-x86_64\.AppImage.*\| 400 MB \|$/u)
  assert.match(rows[4], /^\| Linux, deb .*linux-amd64\.deb.*\| 500 MB \|$/u)
  assert.match(block, /^## Download \/ 下载$/mu)
  assert.match(block, /The `\.blockmap`, `latest\*\.yml` and source code archives are for updates and the repository/u)
  assert.match(block, /Android.*Anbot-0\.2\.3-android\.apk/u)
  assert.doesNotMatch(block, /DS-Bot-|Fei2411/u)
  assert.match(block, /\[SHA256SUMS\.txt\]\(https:\/\/github\.com\/rml4791lol-lang\/Anbot\/releases\/download\/v0\.2\.3\/SHA256SUMS\.txt\)/u)
  assert.doesNotMatch(block, /Mirror/u)
})

test('a mirror adds a second link to the same Anbot release asset', () => {
  const sizes = Object.fromEntries(names('0.2.3').map(name => [name, MB]))
  const block = downloadBlock({ version: '0.2.3', sizes, mirror: 'https://mirror.example/anbot/v0.2.3/' })
  assert.match(block, /\| Anbot-0\.2\.3-win-x64\.exe: \[Mirror \/ 国内镜像\]\(https:\/\/mirror\.example\/anbot\/v0\.2\.3\/Anbot-0\.2\.3-win-x64\.exe\) · \[GitHub\]\(https:\/\/github\.com\/rml4791lol-lang\/Anbot\/releases\/download\/v0\.2\.3\/Anbot-0\.2\.3-win-x64\.exe\) \|/u)
  assert.doesNotMatch(block, /someone\/DS-Bot/u)
})

test('SHA256SUMS.txt lists each desktop package under both of its names', () => {
  const hashes = Object.fromEntries(names('0.2.3').map((name, index) => [name, String(index).repeat(64)]))
  const lines = checksums('0.2.3', hashes).split('\n')
  assert.equal(lines.pop(), '')
  assert.equal(lines.length, 12)
  assert.equal(lines[0], `${'0'.repeat(64)}  Anbot-0.2.3-win-x64.exe`)
  assert.equal(lines[1], `${'0'.repeat(64)}  Anbot-win-x64.exe`)
  assert.equal(lines[8], `${'4'.repeat(64)}  Anbot-0.2.3-linux-amd64.deb`)
  assert.equal(lines[9], `${'4'.repeat(64)}  Anbot-linux-amd64.deb`)
})

test('a missing desktop package is named; other files do not count', () => {
  const present = ['Anbot-0.2.3-win-x64.exe', 'Anbot-0.2.3-win-x64.exe.blockmap', 'Anbot-mac-arm64.zip', 'Anbot-0.2.2-mac-x64.zip',
    'Anbot-0.2.3-linux-x86_64.AppImage', 'Anbot-0.2.3-linux-amd64.deb', 'Anbot-0.2.3-android.apk', 'latest.yml']
  assert.deepEqual(missingPackages('0.2.3', present), ['Anbot-0.2.3-mac-arm64.zip', 'Anbot-0.2.3-mac-x64.zip'])
  assert.deepEqual(missingPackages('0.2.3', names('0.2.3')), [])
})

test('the table goes on top of the notes, and a second run replaces it', () => {
  const sizes = Object.fromEntries(names('0.2.3').map(name => [name, MB]))
  const block = downloadBlock({ version: '0.2.3', sizes })
  const once = withDownloads('## What changed\r\n\r\n- Fixed it\r\n', block)
  assert.ok(once.startsWith(`${block}\n\n## What changed`))
  assert.equal(withDownloads(once, block), once)
  const bigger = downloadBlock({ version: '0.2.3', sizes: Object.fromEntries(names('0.2.3').map(name => [name, 2 * MB])) })
  const again = withDownloads(once, bigger)
  assert.ok(again.startsWith(`${bigger}\n\n## What changed`))
  assert.equal(again.split('## Download / 下载').length, 2)
  assert.equal(withDownloads('', block), `${block}\n`)
})

test('the script hashes and copies the desktop packages and prints the notes', (t) => {
  const work = mkdtempSync(join(tmpdir(), 'anbot-release-notes-'))
  t.after(() => { rmSync(work, { recursive: true, force: true }) })
  const from = join(work, 'packages')
  const to = join(work, 'attach')
  mkdirSync(from)
  for (const name of names('0.2.3')) writeFileSync(join(from, name), `package ${name}`)
  writeFileSync(join(from, 'Anbot-0.2.3-win-x64.exe.blockmap'), 'map')
  writeFileSync(join(work, 'notes.md'), '- Fixed it\n')
  const env = { ...process.env, GITHUB_REPOSITORY: REPO, MIRROR_BASE: '' }
  const run = spawnSync(process.execPath, [script, '0.2.3', from, to, join(work, 'notes.md')], { encoding: 'utf8', env })
  assert.equal(run.status, 0, run.stderr)
  assert.ok(run.stdout.startsWith('<!-- downloads -->\n## Download / 下载\n'))
  assert.ok(run.stdout.endsWith('<!-- /downloads -->\n\n- Fixed it\n'))
  assert.match(run.stdout, /\/rml4791lol-lang\/Anbot\/releases\/download\/v0\.2\.3\/Anbot-0\.2\.3-win-x64\.exe/u)
  assert.deepEqual(readdirSync(to).sort(), [...PACKAGES.map(copyName), 'SHA256SUMS.txt'].sort())
  const sums = readFileSync(join(to, 'SHA256SUMS.txt'), 'utf8')
  for (const entry of PACKAGES) {
    const name = packageName('0.2.3', entry)
    const hash = createHash('sha256').update(`package ${name}`).digest('hex')
    assert.ok(sums.includes(`${hash}  ${name}\n`) && sums.includes(`${hash}  ${copyName(entry)}\n`), name)
    assert.equal(readFileSync(join(to, copyName(entry)), 'utf8'), `package ${name}`)
  }
})

test('the script stops when a package or the repository identity is wrong', (t) => {
  const work = mkdtempSync(join(tmpdir(), 'anbot-release-notes-'))
  t.after(() => { rmSync(work, { recursive: true, force: true }) })
  for (const name of names('0.2.3').slice(1)) writeFileSync(join(work, name), name)
  const missing = spawnSync(process.execPath, [script, '0.2.3', work, join(work, 'attach')], { encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: REPO } })
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /has no Anbot-0\.2\.3-win-x64\.exe$/mu)

  for (const name of names('0.2.3')) writeFileSync(join(work, name), name)
  const wrongRepo = spawnSync(process.execPath, [script, '0.2.3', work, join(work, 'attach')], {
    encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: 'Fei2411/DS-Bot' },
  })
  assert.equal(wrongRepo.status, 1)
  assert.match(wrongRepo.stderr, /rml4791lol-lang\/Anbot/u)
})

test('the Anbot workflow attaches its own packages and cannot publish to upstream npm', () => {
  const text = read('../../.github/workflows/release.yml')
  const workflow = YAML.parse(text)
  assert.equal(workflow.permissions.contents, 'write')
  assert.equal(workflow.permissions['id-token'], undefined)
  assert.doesNotMatch(text, /npm\s+publish|id-token|npmjs\.com|Trusted Publishing/u)
  assert.doesNotMatch(text, /legacy-release-assets|DeepSeek-Bot|DS-Bot-/u)
  assert.match(text, /rml4791lol-lang\/Anbot/u)
  assert.match(text, /APP_REPOSITORY: rml4791lol-lang\/Anbot/u)
  assert.match(text, /name: Anbot-win-x64/u)
  assert.match(text, /name: Anbot-mac-\$\{\{ matrix\.arch \}\}/u)
  assert.match(text, /name: Anbot-linux-x64/u)
})

test('the release becomes Latest last, after all package uploaders', () => {
  const workflow = YAML.parse(read('../../.github/workflows/release.yml'))
  const runs = job => (job.steps ?? []).map(step => step.run ?? '').join('\n')
  const latest = Object.entries(workflow.jobs).filter(([, job]) => /gh release edit "\$TAG" --latest/u.test(runs(job)))
  assert.equal(latest.length, 1)
  const [name, job] = latest[0]
  const before = (jobName, seen = new Set()) => {
    for (const need of [workflow.jobs[jobName].needs ?? []].flat()) if (!seen.has(need)) before(need, seen.add(need))
    return seen
  }
  const uploaders = Object.keys(workflow.jobs).filter(other => other !== name && /gh release upload/u.test(runs(workflow.jobs[other])))
  assert.deepEqual(uploaders.sort(), ['app-android', 'app-linux', 'app-macos', 'app-windows', 'checks'])
  for (const uploader of uploaders) assert.ok(before(name).has(uploader), `${name} must come after ${uploader}`)
  assert.match(job.steps.at(-1).run, /^gh release edit "\$TAG" --latest$/u)
  assert.match(runs(job), /node scripts\/release-notes\.mjs /u)
})

test('the desktop README links only the Anbot release', () => {
  const text = read('../README.md')
  assert.match(text, /\(https:\/\/github\.com\/rml4791lol-lang\/Anbot\/releases\/latest\)/u)
  assert.doesNotMatch(text, /Fei2411\/DS-Bot\/releases|DS-Bot#v\d/u)
})
