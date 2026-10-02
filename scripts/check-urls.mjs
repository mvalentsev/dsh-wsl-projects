// Does the panel offer a URL that actually works?
//
//   node scripts/check-urls.mjs
//
// A token belongs to one process, so a URL kept from an earlier start is dead:
// the panel would hand out a link to a session that is no longer there, or to a
// different project's. This drives a real distribution through the cases that
// produce that — a fresh start, a restart, and two projects taking the same port
// one after the other — and checks each offered URL over HTTP.

import { WslProjects } from '../lib/controller.js'
import { bash } from '../lib/wsl.js'

const ctl = new WslProjects({ distro: process.env.SMOKE_DISTRO || 'Ubuntu' })
let failures = 0
const check = (ok, msg) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + msg)
  if (!ok) failures += 1
}

const httpCode = async (url) => {
  if (!url) return 'none'
  const r = await bash(ctl.distro(), `curl -s -o /dev/null -w '%{http_code}' --max-time 15 '${url}'`, { timeoutMs: 40000 })
  return r.stdout.trim()
}
const alive = (code) => code === '200' || code === '303'
const freePort = (port) => bash(ctl.distro(), `fuser -k ${port}/tcp 2>/dev/null; sleep 2`, { timeoutMs: 40000 })

const projects = (await ctl.projects()).projects
check(projects.length >= 2, `two projects are available (${projects.length})`)
if (projects.length < 2) process.exit(1)
const target = projects[0]
const other = projects[1]
console.log('projects: ' + target.name + ', ' + other.name)

// Anything left over from an interrupted run would confuse the port swap below.
for (const unit of (await ctl.units()).units || []) await ctl.removeUnit(unit.unit)

const first = await ctl.start({ project: target.path })
check(first.ok === true, 'the project starts: ' + JSON.stringify(first.error ?? ''))
check(alive(await httpCode(first.url)), 'its URL is accepted by the server')

const viaUnits = (await ctl.units()).units.find((u) => u.unit === first.unit)
check(Boolean(viaUnits?.url), 'the units list carries a URL: ' + String(viaUnits?.url).slice(0, 46))
check(alive(await httpCode(viaUnits?.url)), 'and that URL also works')

const restarted = await ctl.restartUnit(first.unit)
check(alive(await httpCode(restarted.url)), 'after a restart the URL still works')
check(restarted.url !== first.url, 'and it is a fresh token, not the dead one')
const afterRestart = (await ctl.units()).units.find((u) => u.unit === first.unit)
check(alive(await httpCode(afterRestart?.url)), 'the units list agrees after the restart')

// The case that broke in practice: two projects taking the same port one after
// the other. The stopped service must not keep offering the URL of the run that
// has ended, or the panel opens a session that is no longer there.
await ctl.stopProject({ project: target.path })
await freePort(first.port)
const swapped = await ctl.start({ project: other.path, port: first.port })
check(swapped.ok === true, 'a second project takes the same port: ' + JSON.stringify(swapped.error ?? ''))
check(alive(await httpCode(swapped.url)), 'its URL works')
check(swapped.url !== first.url, 'and it is not the previous project\'s token')

const afterSwap = (await ctl.units()).units
const stoppedRow = afterSwap.find((u) => u.unit === first.unit)
const runningRow = afterSwap.find((u) => u.unit === swapped.unit)
check(stoppedRow?.url === null, 'a stopped service offers no URL: ' + JSON.stringify(stoppedRow?.url))
check(Boolean(runningRow?.url), 'the running service offers one: ' + String(runningRow?.url).slice(0, 46))
check(alive(await httpCode(runningRow?.url)), 'and the URL the panel would offer actually answers')

console.log('')
for (const unit of [first.unit, swapped.unit]) await ctl.removeUnit(unit)
await bash(ctl.distro(), 'for p in $(ss -ltn 2>/dev/null | grep -oE "127\\\\.0\\\\.0\\\\.1:198[0-9][0-9]" | cut -d: -f2 | sort -u); do fuser -k "$p/tcp" 2>/dev/null; done; sleep 1', { timeoutMs: 40000 })
const remaining = (await ctl.units()).units || []
check(remaining.length === 0, 'nothing of ours is left (' + remaining.map((u) => u.unit).join(',') + ')')

console.log(failures === 0 ? 'RESULT: every offered URL works' : `RESULT: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
