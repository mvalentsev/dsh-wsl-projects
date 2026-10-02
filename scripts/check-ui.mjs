// What the user actually sees, per project.
//
//   node scripts/check-ui.mjs
//
// Every earlier check looked at links, tokens or files. This one opens the UI of
// each service in a real browser and reads the project it shows, which is the
// only question that matters: the reported symptom was that opening one project
// served another.
//
// It rebuilds the per-project homes from nothing, so it also proves the seeding
// works on a machine that has never run this version.

import { WslProjects } from '../lib/controller.js'
import { bash } from '../lib/wsl.js'
import { cdp, homeNameFor } from './ui-probe.mjs'

const ctl = new WslProjects({ distro: process.env.SMOKE_DISTRO || 'Ubuntu' })
let failures = 0
const check = (ok, msg) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + msg)
  if (!ok) failures += 1
}

const projects = (await ctl.projects()).projects
// The first two this machine has. Names are read from the machine rather than
// written here, so the check travels between layouts. `SMOKE_PROJECT_A` and
// `SMOKE_PROJECT_B` override the choice.
const named = (path) => projects.find((project) => project.path === path)
const chosen = [
  named(process.env.SMOKE_PROJECT_A),
  named(process.env.SMOKE_PROJECT_B),
].filter(Boolean)
if (chosen.length < 2) {
  chosen.length = 0
  chosen.push(...projects.slice(0, 2))
}
if (chosen.length < 2) {
  console.log('need two projects under the configured projects root; found ' + projects.length)
  process.exit(1)
}
console.log('projects: ' + chosen.map((p) => p.name).join(', '))

console.log('=== starting from nothing: removing services and per-project homes ===')
for (const unit of (await ctl.units()).units || []) await ctl.removeUnit(unit.unit)
await bash(ctl.distro(), 'for p in $(ss -ltn 2>/dev/null | grep -oE "127\\.0\\.0\\.1:198[0-9][0-9]" | cut -d: -f2 | sort -u); do fuser -k "$p/tcp" 2>/dev/null; done; rm -rf "$HOME/.dsh/dsh-wsl-projects/homes"; sleep 2', { timeoutMs: 60000 })

const started = []
for (const project of chosen) {
  const r = await ctl.start({ project: project.path })
  check(r.ok === true, project.name + ' starts: ' + JSON.stringify(r.error ?? ''))
  // The spread comes first: `start` reports its own fields and would otherwise
  // leave `project` undefined, which the labels below rely on.
  started.push({ ...r, project })
}

console.log('')
console.log('=== each home was seeded and points at its own project ===')
const homes = await bash(ctl.distro(), 'for d in "$HOME/.dsh/dsh-wsl-projects/homes/"*/; do echo "$(basename $d)|$(grep -o \'"path": "[^"]*"\' "$d/storages/workspace.json" 2>/dev/null | head -1)|$([ -s "$d/.credentials.yaml" ] && echo creds || echo NO-CREDS)"; done', { timeoutMs: 40000 })
for (const line of homes.stdout.trim().split('\n').filter(Boolean)) {
  console.log('  ' + line)
}
for (const entry of started) {
  const slug = homeNameFor(entry.project.path)
  const line = homes.stdout.split('\n').find((l) => l.startsWith(slug + '|')) || ''
  check(line.includes('"path": "' + entry.project.path + '"'), entry.project.name + "'s home names its own project")
  check(line.includes('creds'), entry.project.name + "'s home has the account")
}

console.log('')
console.log('=== what a browser shows for each service ===')
for (const entry of started) {
  const row = (await ctl.units({ awaitUrls: true })).units.find((u) => u.unit === entry.unit)
  const text = await cdp(9400 + Math.floor(Math.random() * 400), row?.url)
  const shown = (text || '').replace(/\s+/g, ' ').slice(0, 120)
  console.log('  ' + entry.project.name + ' -> ' + shown)
  check(Boolean(text), entry.project.name + ': the UI rendered something')
  check(!/Choose a workspace/i.test(text || ''), entry.project.name + ': the UI opened a project, not the picker')
  check(new RegExp('\\b' + entry.project.name + '\\b').test(text || ''), entry.project.name + ': the UI names ' + entry.project.name)
  const other = started.find((s) => s.unit !== entry.unit).project.name
  // The regression was one project's UI naming another, so the absence matters
  // as much as the presence.
  check(!new RegExp('\\b' + other + '\\b').test(text || ''), entry.project.name + ': the UI does not name ' + other)}

console.log('')
console.log('=== cleanup ===')
for (const entry of started) await ctl.removeUnit(entry.unit)
await bash(ctl.distro(), 'for p in $(ss -ltn 2>/dev/null | grep -oE "127\\.0\\.0\\.1:198[0-9][0-9]" | cut -d: -f2 | sort -u); do fuser -k "$p/tcp" 2>/dev/null; done; sleep 1', { timeoutMs: 40000 })

console.log(failures === 0 ? 'RESULT: every project opens as itself' : `RESULT: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
