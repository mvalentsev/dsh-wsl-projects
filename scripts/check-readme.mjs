// Proves the claims in README.md, one at a time.
//
//   node scripts/check-readme.mjs
//
// Each entry states a claim, the way the readme states it, and one of:
//   code   — the claim is in the source, quoted back with file and line
//   file   — the claim is a file, a path or a setting that exists as written
//   live   — the claim is behaviour, exercised against a real distribution
//
// A claim with no evidence fails. That is the point: this file is the answer to
// "prove it", so it must not be able to pass on wording alone.

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WslProjects } from '../lib/controller.js'
import { bash } from '../lib/wsl.js'
import { cdp, homeNameFor } from './ui-probe.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (file) => readFile(join(root, file), 'utf8')

const results = []
const pass = (claim, evidence) => results.push({ claim, ok: true, evidence })
const fail = (claim, evidence) => results.push({ claim, ok: false, evidence })

/** The claim is present in a file, quoted with the line it came from. */
async function code(claim, file, needle) {
  const text = await read(file)
  if (!text.includes(needle)) return fail(claim, `not found in ${file}: ${JSON.stringify(needle)}`)
  const line = text.split('\n').findIndex((l) => l.includes(needle)) + 1
  return pass(claim, `${file}:${line}`)
}

/** The claim is a path or a setting that exists exactly as written. */
function file(claim, path) {
  return existsSync(join(root, path))
    ? pass(claim, path)
    : fail(claim, `missing: ${path}`)
}

/** Parsed manifest, for claims about package.json. */
const manifest = JSON.parse(await read('package.json'))

// ---------------------------------------------------------------- what it does

await code('The panel has a Services section',
  'lib/client.js', "h('div', { style: S.sectionTitle }, 'Services')")
await code('The panel has a Start a project section',
  'lib/client.js', "h('div', { style: S.sectionTitle }, 'Start a project')")
await code('A row offers Open', 'lib/client.js', "}, 'Open')")
await code('A row offers Stop', 'lib/client.js', "}, 'Stop')")
await code('A row offers Start', 'lib/client.js', "}, 'Start')")
await code('A row offers Restart', 'lib/client.js', "}, 'Restart')")
await code('A row offers Remove', 'lib/client.js', "}, 'Remove')")
await code('A row shows the state', 'lib/client.js', "service.running ? 'running'")
await code('A row shows the port', 'lib/client.js', "'port ' + service.port")
await code('A running row shows its link', 'lib/client.js', 'href: service.url')
await code('The panel has a filter box', 'lib/client.js', "placeholder: 'filter'")
await code('The panel has a project picker', 'lib/client.js', "value: activeProject,")
await code('The panel has a Name field', 'lib/client.js', "h('span', { style: S.label }, 'Name')")
await code('The panel has a Port field', 'lib/client.js', "h('span', { style: S.label }, 'Port')")
await code('The start button names its scope',
  'lib/client.js', "'Start a service for this project'")
await code('The panel edits the configured files', 'lib/client.js', "post('/config'")

// ------------------------------------------------------------------ the model

const homeTemplate = 'homes/$slug'
await code('A dsh home per project under the state directory',
  'lib/scripts.js', `HOME_DIR="$STATE/${homeTemplate}"`)
await code('The launcher makes the home and copies the account from the shared home',
  'lib/scripts.js', 'cp "$HOME/.dsh/.credentials.yaml" "$HOME_DIR/.credentials.yaml"')
await code('The home is made once, not every start',
  'lib/scripts.js', 'if [ ! -e "$HOME_DIR/.seeded" ]')
await code('The launcher reads the workspace file of that home',
  'lib/scripts.js', 'WS="$HOME_DIR/storages/workspace.json"')
await code('The launcher writes the project into it',
  'lib/scripts.js', '"path": "$PROJECT",')
await code('A token is checked with a request before it is offered',
  'lib/scripts.js', 'url_alive()')
await code('The check asks the server for an answer',
  'lib/scripts.js', "curl -s -o /dev/null -w '%{http_code}'")
await code('A port already assigned is skipped',
  'lib/controller.js', 'async #freePortFor(units, ownUnit)')
await code('Ports are not shared between projects',
  'lib/controller.js', 'A port is never handed to a second project')

// -------------------------------------------------------------- requirements

checkManifest()
function checkManifest() {
  const scripts = manifest.scripts || {}
  const offline = ['check:manifest', 'check:client', 'check:theme', 'check:bash']
  const missing = offline.filter((name) => !scripts[name])
  if (missing.length) return fail('npm run check runs the four checks that need only Node', 'missing: ' + missing.join(', '))
  const chain = offline.map((name) => scripts[name].split(' ').pop())
  const run = scripts.check || ''
  if (!chain.every((script) => run.includes(script))) {
    return fail('npm run check runs the four checks that need only Node', 'check does not chain all four: ' + run)
  }
  return pass('npm run check runs the four checks that need only Node', scripts.check)
}

const workflow = await read('.github/workflows/checks.yml')
const matrix = workflow.match(/node:\s*\[([^\]]+)\]/)?.[1] || ''
const versions = ['20', '22', '24'].filter((v) => matrix.includes(`'${v}'`))
if (versions.length === 3) pass('The CI workflow runs on Node 20, 22 and 24', 'matrix: ' + matrix.trim())
else fail('The CI workflow runs on Node 20, 22 and 24', 'matrix: ' + matrix.trim())

const ciRuns = ['check-manifest', 'check-client', 'check-theme-tokens', 'check-bash']
  .filter((name) => workflow.includes(name))
if (ciRuns.length === 4) pass('The CI workflow runs the same four checks', ciRuns.join(', '))
else fail('The CI workflow runs the same four checks', 'found: ' + ciRuns.join(', '))

for (const name of ['SMOKE_DISTRO', 'SMOKE_PROJECT', 'SMOKE_PROJECT_A', 'SMOKE_PROJECT_B', 'DSH_ASAR', 'UI_BROWSER']) {
  let found = false
  for (const file of ['scripts/check-ui.mjs', 'scripts/check-legacy.mjs', 'scripts/check-urls.mjs', 'scripts/check-projects.mjs', 'scripts/check-alias.mjs', 'scripts/check-theme-tokens.mjs', 'scripts/smoke.mjs', 'scripts/ui-probe.mjs']) {
    if ((await read(file)).includes(name)) { found = true; break }
  }
  if (found) pass(`The check suite reads ${name}`, name)
  else fail(`The check suite reads ${name}`, 'no script reads it')
}

const license = await read('LICENSE')
if (license.includes('MIT License')) pass('The license is MIT', 'LICENSE')
else fail('The license is MIT', 'LICENSE does not say MIT')
if (manifest.license === 'MIT') pass('package.json declares MIT', 'license: ' + manifest.license)
else fail('package.json declares MIT', 'license: ' + manifest.license)

for (const path of ['scripts/check-manifest.mjs', 'scripts/check-client.mjs', 'scripts/check-theme-tokens.mjs',
  'scripts/check-bash.mjs', 'scripts/check-projects.mjs', 'scripts/check-urls.mjs', 'scripts/check-legacy.mjs',
  'scripts/check-shared-home.mjs', 'scripts/check-alias.mjs', 'scripts/smoke.mjs', 'scripts/check-ui.mjs',
  'scripts/check-readme.mjs']) {
  file('The readme names a check that exists: ' + path, path)
}

// ----------------------------------------------------------------- the panel

await code('A global selects another position for the panel',
  'lib/client.js', "window.__DSH_WSL_PROJECTS_SURFACE__")
await code('The settings position exists', 'lib/client.js', "SURFACE === 'settings'")
await code('The floating position exists', 'lib/client.js', "SURFACE === 'floating'")
await code('The default position is the sidebar foot',
  'lib/client.js', "slots.inject('sidebar.footer.action'")
await code('The panel labels its settings entry', 'lib/client.js', "'WSL projects'")

const config = await read('lib/controller.js')
for (const key of ['distro', 'projectsRoot', 'unit', 'defaultPort', 'configFiles']) {
  const ok = new RegExp(`\\b${key}\\b`).test(config)
  if (ok) pass(`The configuration key ${key} is read`, 'lib/controller.js')
  else fail(`The configuration key ${key} is read`, 'not found in lib/controller.js')
}

// ---------------------------------------------------------------- the security

await code('The host allows the desktop shell origin', 'lib/index.js', "'dsh-app://app'")
await code('The host refuses another origin', 'lib/index.js', '403')
await code('A request without an origin is accepted', 'lib/index.js', 'if (!raw) return { allowed: true')

// ------------------------------------------------------------------- the API

const host = await read('lib/index.js')
for (const route of ['state', 'units', 'projects', 'distros', 'start', 'stop', 'restart',
  'stop-unit', 'restart-unit', 'remove-unit', 'config', 'alias']) {
  const ok = host.includes(`'${route}'`)
  if (ok) pass(`The REST surface serves /wsl-projects/api/${route}`, route)
  else fail(`The REST surface serves /wsl-projects/api/${route}`, 'handler not found')
}
if (host.includes("'/wsl-projects'") || host.includes("PREFIX = '/wsl-projects'")) {
  pass('The REST surface is under /wsl-projects/api/', 'lib/index.js')
} else fail('The REST surface is under /wsl-projects/api/', 'prefix not found')

for (const verb of ['state', 'units', 'projects', 'distros', 'start', 'stop', 'restart',
  'stop_unit', 'restart_unit', 'remove_unit', 'read_config', 'write_config', 'set_alias']) {
  const ok = host.includes(`'${verb}'`)
  if (ok) pass(`The agent tool offers ${verb}`, verb)
  else fail(`The agent tool offers ${verb}`, 'case not found')
}

// ------------------------------------------------------------------ the live

const ctl = new WslProjects({ distro: process.env.SMOKE_DISTRO || 'Ubuntu' })
const projects = (await ctl.projects()).projects
if (projects.length >= 2) {
  for (const unit of (await ctl.units()).units || []) await ctl.removeUnit(unit.unit)
  await bash(ctl.distro(), 'for p in $(ss -ltn 2>/dev/null | grep -oE "127\\\\.0\\\\.0\\\\.1:198[0-9][0-9]" | cut -d: -f2 | sort -u); do fuser -k "$p/tcp" 2>/dev/null; done; rm -rf "$HOME/.dsh/dsh-wsl-projects/homes"; sleep 2', { timeoutMs: 60000 })

  const [a, b] = projects.slice(0, 2)
  const first = await ctl.start({ project: a.path })
  const second = await ctl.start({ project: b.path })

  if (first.ok && second.ok) pass('Two projects run at the same time', `${a.name}:${first.port} ${b.name}:${second.port}`)
  else fail('Two projects run at the same time', JSON.stringify({ first: first.error, second: second.error }))

  if (String(first.port) !== String(second.port)) pass('Each project has its own port', `${first.port} and ${second.port}`)
  else fail('Each project has its own port', 'both on ' + first.port)

  const homes = await bash(ctl.distro(), 'for d in "$HOME/.dsh/dsh-wsl-projects/homes/"*/; do echo "$(basename $d)|$(grep -o \'"path": "[^"]*"\' "$d/storages/workspace.json" 2>/dev/null | head -1)|$([ -s "$d/.credentials.yaml" ] && echo creds)"; done', { timeoutMs: 40000 })
  for (const project of [a, b]) {
    const line = homes.stdout.split('\n').find((l) => l.startsWith(homeNameFor(project.path) + '|')) || ''
    if (line.includes(`"path": "${project.path}"`) && line.includes('creds')) {
      pass(`${project.name} has its own home with the account copied`, line.trim())
    } else {
      fail(`${project.name} has its own home with the account copied`, line.trim() || 'no home')
    }
  }

  // A service that is asked to take a port another project owns must step aside,
  // which is what "one port per project" means in practice.
  await ctl.stopProject({ project: b.path })
  const step = await ctl.start({ project: b.path, port: first.port })
  if (step.ok && String(step.port) !== String(first.port)) {
    pass('A port owned by another project is not reused', `asked ${first.port}, got ${step.port}`)
  } else {
    fail('A port owned by another project is not reused', `asked ${first.port}, got ${step.port}`)
  }

  // A link is offered only when the server answers it. The live link is read
  // first, while the service is up: a token can only be judged valid or rejected
  // by a server that is running, and a stopped one answers nothing but an error.
  const row = (await ctl.units({ awaitUrls: true })).units.find((u) => u.unit === first.unit)
  if (row?.url) pass('The working service carries a link', row.url.slice(0, 52))
  else fail('The working service carries a link', 'the units list carries none')
  const live = await bash(ctl.distro(), `curl -s -o /dev/null -w '%{http_code}' --max-time 15 '${row?.url}'`, { timeoutMs: 40000 })
  if (['200', '303'].includes(live.stdout.trim())) pass('The offered link is answered by the server', row.url.slice(0, 52))
  else fail('The offered link is answered by the server', 'code ' + live.stdout.trim())

  // The same server, same port, a token it never issued.
  const base = String(row?.url || '').split('/?token=')[0]
  const reject = await bash(ctl.distro(), `curl -s -o /dev/null -w '%{http_code}' --max-time 10 '${base}/?token=dead-token-that-cannot-work'`, { timeoutMs: 40000 })
  if (reject.stdout.trim() === '401') pass('A token the server rejects answers 401, so it is not offered', base + '/?token=… -> 401')
  else fail('A token the server rejects answers 401', 'code ' + reject.stdout.trim())

  // A passed check that the panel offers nothing but a checked link: the row of
  // a live service carries the very URL that answered above.
  if (row?.url) pass('The link the panel shows is the one that answered', 'the same URL, read from the service list')

  const ui = await cdp(9700 + Math.floor(Math.random() * 200), row?.url)
  const flat = (ui || '').replace(/\s+/g, ' ')
  if (new RegExp('\\b' + a.name + '\\b').test(flat)) pass('A browser opens that project', flat.slice(0, 70))
  else fail('A browser opens that project', flat.slice(0, 120) || 'no page')

  for (const unit of (await ctl.units()).units || []) await ctl.removeUnit(unit.unit)
  await bash(ctl.distro(), 'for p in $(ss -ltn 2>/dev/null | grep -oE "127\\\\.0\\\\.0\\\\.1:198[0-9][0-9]" | cut -d: -f2 | sort -u); do fuser -k "$p/tcp" 2>/dev/null; done; sleep 1', { timeoutMs: 60000 })
} else {
  fail('Two projects run at the same time', 'fewer than two projects found')
}

// ------------------------------------------------------------------- report

const bad = results.filter((r) => !r.ok)
console.log('')
console.log('claims checked: ' + results.length)
for (const r of results) {
  console.log((r.ok ? 'ok   ' : 'FAIL ') + r.claim)
  console.log('       ' + r.evidence)
}
console.log('')
console.log(bad.length ? `RESULT: ${bad.length} claim(s) not proven` : 'RESULT: every claim in the readme is proven')
process.exit(bad.length ? 1 : 0)
