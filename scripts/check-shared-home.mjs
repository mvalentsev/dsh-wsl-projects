// The central claim, as an experiment.
//
//   node scripts/check-shared-home.mjs
//
// README says: dsh opens the workspace named in $DSH_HOME/storages/workspace.json
// and does not compare it with the folder the process started in. That is the
// reason each project needs its own home, so it deserves a demonstration rather
// than a quotation from the source.
//
// The experiment holds everything else constant. Two processes, two ports, one
// shared home, and two different working directories. If a browser shows the
// same project on both ports, the claim holds: the working directory did not
// decide, the home did.

import { existsSync } from 'node:fs'
import { bash } from '../lib/wsl.js'
import { cdp } from './ui-probe.mjs'

const distro = process.env.SMOKE_DISTRO || 'Ubuntu'
const failures = []
const check = (ok, msg) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + msg)
  if (!ok) failures.push(msg)
}

const projects = await bash(distro, 'ls -d /home/*/projects/* 2>/dev/null | head -2', { timeoutMs: 30000 })
const [projectA, projectB] = projects.stdout.trim().split('\n').filter(Boolean)
if (!projectA || !projectB) {
  console.log('need two projects under the home directory to run this experiment')
  process.exit(1)
}

const portA = 19861
const portB = 19862
const home = '/tmp/shared-home-proof'

console.log('one shared home, two processes, two folders')
console.log('  home   : ' + home)
console.log('  A      : ' + projectA + ' on ' + portA)
console.log('  B      : ' + projectB + ' on ' + portB)
console.log('')

const title = 'shared-home-proof-marker'
const setup = `set -u
export PATH="$HOME/.local/share/fnm/aliases/default/bin:$PATH"
DSH="$HOME/.local/share/fnm/node-versions/v24.20.0/installation/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"
rm -rf "${home}"; mkdir -p "${home}/storages"
id="$(uuidgen)"
cat > "${home}/storages/workspace.json" <<JSON
{
  "unit": { "name": "workspace", "version": 2 },
  "global": { "initialized": true, "workspaceIds": ["$id"], "archivedSessionIds": [], "pinnedSessionIds": [] },
  "tables": { "workspaces": { "$id": { "path": "${projectA}", "title": "${title}", "sessionIds": [], "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" } } }
}
JSON
fuser -k ${portA}/tcp 2>/dev/null; fuser -k ${portB}/tcp 2>/dev/null
( cd "${projectA}" && DSH_HOME="${home}" setsid nohup node "$DSH" --profile web --no-open --port ${portA} > /tmp/pf-a.log 2>&1 & )
( cd "${projectB}" && DSH_HOME="${home}" setsid nohup node "$DSH" --profile web --no-open --port ${portB} > /tmp/pf-b.log 2>&1 & )
echo started`
const set = await bash(distro, setup, { timeoutMs: 120000 })
if (process.env.DSH_WSL_DEBUG) {
  console.log('setup exit:', set.code, 'stdout:', JSON.stringify(set.stdout.slice(0, 200)), 'stderr:', JSON.stringify((set.stderr || '').slice(0, 300)))
}

const url = async (port, tag) => {
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 1000))
    const found = await bash(distro, `grep -oE "http://127\\\\.0\\\\.0\\\\.1:${port}/\\\\?token=[A-Za-z0-9_-]+" /tmp/pf-${tag}.log 2>/dev/null | tail -1`, { timeoutMs: 20000 })
    if (found.stdout.trim()) return found.stdout.trim()
  }
  return ''
}

const urlA = await url(portA, 'a')
const urlB = await url(portB, 'b')
check(Boolean(urlA) && Boolean(urlB), 'both processes started')

const facts = await bash(distro, [
  `echo "cwd A: $(readlink /proc/$(ss -ltnp 2>/dev/null | grep ':${portA}' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)/cwd 2>/dev/null)"`,
  `echo "cwd B: $(readlink /proc/$(ss -ltnp 2>/dev/null | grep ':${portB}' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)/cwd 2>/dev/null)"`,
  `echo "home names: $(grep -o '"path": "[^"]*"' ${home}/storages/workspace.json | head -1)"`,
  `echo "home title: $(grep -o '"title": "[^"]*"' ${home}/storages/workspace.json | head -1)"`,
].join('\n'), { timeoutMs: 40000 })
console.log('')
console.log(facts.stdout.trim().split('\n').map((l) => '  ' + l).join('\n'))
console.log('')

// The working directories really are different: without that the experiment
// would prove nothing.
check(facts.stdout.includes('cwd A: ' + projectA), 'process A runs in ' + projectA)
check(facts.stdout.includes('cwd B: ' + projectB), 'process B runs in ' + projectB)

const shown = (text) => (text || '').replace(/\s+/g, ' ')
const textA = shown(await cdp(9750, urlA))
const textB = shown(await cdp(9760, urlB))
console.log('  A shows: ' + textA.slice(0, 90))
console.log('  B shows: ' + textB.slice(0, 90))

// The home carries a marker of its own, so what the browser shows cannot be
// confused with either folder name.
check(new RegExp(title).test(textA), 'port ' + portA + ' shows the project the home names')
check(new RegExp(title).test(textB), 'port ' + portB + ' shows it too, though its folder is different')
check(!new RegExp('\\b' + projectB.split('/').pop() + '\\b').test(textB),
  'and port ' + portB + ' does not show its own folder')

await bash(distro, `fuser -k ${portA}/tcp 2>/dev/null; fuser -k ${portB}/tcp 2>/dev/null; rm -f /tmp/pf-a.log /tmp/pf-b.log; rm -rf ${home}; sleep 1`, { timeoutMs: 40000 })

console.log('')
console.log(failures.length
  ? `RESULT: ${failures.length} failure(s)`
  : 'RESULT: the home decides the project, not the working directory — proven')
process.exit(failures.length ? 1 : 0)
