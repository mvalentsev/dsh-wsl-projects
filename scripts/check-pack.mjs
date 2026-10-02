// Verifies the packaged plugin, not the working tree.
//
//   node scripts/check-pack.mjs
//
// Every other check reads the checkout. This one installs the published shape of
// the package into a scratch profile, starts a dsh web server on it, and asks
// that server for the plugin's own route. A file left out of `files`, a `exports`
// entry that does not resolve, or a manifest the installer accepts but the loader
// rejects are all invisible from the checkout and visible here.

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, rmSync, cpSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const profile = process.env.PACK_PROFILE || 'packtest'
const profileDir = join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'profiles', profile)
const profilesRoot = join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'profiles')

/**
 * The dsh entry, looked for rather than assumed: `DSH_CLI`, then the usual
 * install location for this platform. It sits behind a path with a space in it,
 * so it is quoted before any shell sees it.
 */
function findDsh() {
  const candidates = [
    process.env.DSH_CLI,
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
    '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh',
    '/usr/local/bin/dsh',
    '/usr/bin/dsh',
  ].filter(Boolean)
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0]
}
const dsh = findDsh()

const failures = []
const check = (ok, msg) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + msg)
  if (!ok) failures.push(msg)
}

// --- the tarball this checkout builds ---------------------------------------

/**
 * Runs a command that is a shell script on Windows — `npm`, and the dsh entry
 * behind a path with a space — and returns its stdout alone. The shell is what
 * quotes the path, and the streams are kept apart because mixing them once turned
 * a page of npm notices into "the tarball".
 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: true, ...options })
  if (result.error) throw result.error
  return { stdout: String(result.stdout || ''), stderr: String(result.stderr || ''), status: result.status }
}

console.log('=== packing ===')
if (existsSync(profileDir)) rmSync(profileDir, { recursive: true, force: true })
const packed = run('npm', ['pack'], { cwd: root })
const tarball = packed.stdout.trim().split('\n').pop().trim()
check(tarball.endsWith('.tgz'), 'npm pack produces a tarball: ' + tarball)

// Windows `tar` ends each line with a carriage return, which makes an exact
// comparison fail while the listing looks correct on screen.
const listed = execFileSync('tar', ['-tzf', join(root, tarball)], { encoding: 'utf8' })
  .split('\n').map((line) => line.replace(/\r$/, '').trim())
  .filter(Boolean).map((line) => line.replace(/^package\//, ''))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
for (const required of ['package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js', 'lib/controller.js', 'lib/scripts.js', 'lib/wsl.js', 'README.md', 'CHANGELOG.md', 'LICENSE']) {
  check(listed.includes(required), 'the tarball carries ' + required)
}
check(!listed.some((name) => name.startsWith('scripts/')),
  'the tarball leaves the checks out: ' + listed.filter((n) => n.startsWith('scripts/')).join(', '))

// --- installed into a scratch profile ---------------------------------------

console.log('')
console.log('=== installing ' + tarball + ' into profile ' + profile + ' ===')
// The scratch profile starts as a copy of an existing profile, with this package
// removed from it. A bare profile is not a fair test: the plugin waits for the
// web server service, and a profile that provides no web server cannot satisfy
// that — the plugin would be reported as inert for a reason that has nothing to
// do with the package.
const candidates = ['desktop', 'web'].map((name) => join(profilesRoot, name))
const source = candidates.find((candidate) => existsSync(candidate))
if (!source) {
  console.log('NOTE no dsh profile found under ' + profilesRoot)
  console.log('NOTE the tarball contents were checked; install and start need a profile')
  console.log('')
  console.log(failures.length ? `RESULT: ${failures.length} failure(s)` : 'RESULT: the tarball is complete')
  process.exit(failures.length ? 1 : 0)
}
check(true, 'a profile to copy exists: ' + source)
if (existsSync(source)) {
  // pnpm records the absolute path of its store inside the profile, so the store
  // and the lockfile are left behind and pnpm builds them again for the copy.
  // Copying them makes pnpm refuse the install: the store belongs to the profile
  // it was made in.
  cpSync(source, profileDir, {
    recursive: true,
    dereference: false,
    filter: (from) => !from.includes(`${sep}node_modules${sep}.pnpm`)
      && !from.includes(`${sep}node_modules${sep}${manifest.name}`)
      && !from.endsWith(`${sep}.modules.yaml`)
      && !from.endsWith('pnpm-lock.yaml')
      && !from.endsWith('pnpm-workspace.yaml'),
  })
  const copied = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
  // Both places, or the installer sees the dependency already satisfied and
  // leaves the bundle list alone — the package would sit in node_modules and
  // never load.
  delete copied.dependencies?.[manifest.name]
  copied.dsh.profile.bundles = (copied.dsh.profile.bundles || []).filter((name) => name !== manifest.name)
  await writeFile(join(profileDir, 'package.json'), JSON.stringify(copied, null, 2) + '\n')
  check(!copied.dsh.profile.bundles.includes(manifest.name), 'the copy does not list the package as a bundle')
  check(!copied.dependencies?.[manifest.name], 'and does not depend on it either')
}

const install = run(`"${dsh}"`, ['plugin', '--profile', profile, 'add', join(root, tarball)])
check(/Done in|added/i.test(install.stdout),
  'the installer accepts the tarball: ' + (install.stdout || install.stderr).trim().slice(0, 120))

const installedManifest = join(profileDir, 'node_modules', manifest.name, 'package.json')
check(existsSync(installedManifest), 'the package lands in the profile')
if (existsSync(installedManifest)) {
  const installed = JSON.parse(execFileSync('node', ['-p', `JSON.stringify(require(${JSON.stringify(installedManifest)}))`], { encoding: 'utf8' }))
  check(installed.version === manifest.version, `the installed version matches (${installed.version})`)
  const profileBundles = JSON.parse(execFileSync('node', ['-p', `JSON.stringify(require(${JSON.stringify(join(profileDir, 'package.json'))}))`], { encoding: 'utf8' }))
  check((profileBundles.dsh?.profile?.bundles || []).includes(manifest.name),
    'the profile lists the package as a bundle')
}

// --- the packaged copy actually runs ----------------------------------------

console.log('')
console.log('=== starting a server on the packaged plugin ===')
// A fixed port would clash with a server left behind by an earlier run, and the
// failure would say nothing about the package. The operating system picks a free
// one instead.
const port = Number(process.env.PACK_PORT) || await new Promise((resolve) => {
  const probe = createServer()
  probe.listen(0, '127.0.0.1', () => {
    const chosen = probe.address().port
    probe.close(() => resolve(chosen))
  })
})
// DSH_HOME is deliberately not overridden: the profile that was just installed
// lives in the real home, and pointing dsh at another directory makes it report
// that the profile does not exist.
const child = spawn(`"${dsh}"`, ['--profile', profile, '--no-open', '--port', String(port)], {
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: true,
})
let log = ''
child.stdout.on('data', (d) => { log += String(d) })
child.stderr.on('data', (d) => { log += String(d) })

const token = await new Promise((resolve) => {
  const deadline = Date.now() + 120000
  const poll = setInterval(() => {
    const found = log.match(new RegExp('http://127\\.0\\.0\\.1:' + port + '/\\?token=[A-Za-z0-9_-]+'))
    if (found) { clearInterval(poll); resolve(found[0]) }
    else if (Date.now() > deadline) { clearInterval(poll); resolve('') }
  }, 1000)
})
check(Boolean(token), 'the server starts on the packaged plugin')
if (!token) {
  // The whole log: a loader error names the file and the line that failed, and
  // that is the only way to tell a packaging fault from a start-up one.
  console.log('--- server output ---')
  console.log(log.trim().split('\n').slice(-25).map((l) => '  ' + l).join('\n'))
}

if (token) {
  const route = async (path) => {
    const response = await fetch('http://127.0.0.1:' + port + path, {
      headers: { Origin: 'http://127.0.0.1:' + port, Cookie: '' },
    })
    return { status: response.status, body: await response.text() }
  }
  // The route from the packaged host half, reached over HTTP.
  const state = await route('/wsl-projects/api/state?contract=2')
  check(state.status === 200, 'the packaged host half answers its route: ' + state.status)
  check(state.body.includes('"contract"'), 'and speaks the current contract')
  check(state.body.includes('"services"'), 'and reports services')
  const foreign = await fetch('http://127.0.0.1:' + port + '/wsl-projects/api/state', { headers: { Origin: 'http://evil.example' } })
  check(foreign.status === 403, 'and refuses a foreign origin: ' + foreign.status)
}

child.kill()
await new Promise((r) => setTimeout(r, 2000))
if (existsSync(profileDir)) rmSync(profileDir, { recursive: true, force: true })

console.log('')
console.log(failures.length ? `RESULT: ${failures.length} failure(s)` : 'RESULT: the packaged plugin installs and runs')
process.exit(failures.length ? 1 : 0)
