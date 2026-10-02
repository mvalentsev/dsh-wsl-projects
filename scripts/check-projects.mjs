// The project model against a real distribution.
//
//   node scripts/check-projects.mjs
//
// Two projects at the same time, one port each, stopping one leaves the other,
// and a stopped project comes back on its port. The machine ends as it started:
// a service that existed before the run is restored, and services this run
// created are removed.
//
// SMOKE_PROJECT_A and SMOKE_PROJECT_B choose the two projects.

import { WslProjects } from '../lib/controller.js'
import { bash } from '../lib/wsl.js'

const ctl = new WslProjects({ distro: process.env.SMOKE_DISTRO || 'Ubuntu' })
const failures = []
const check = (ok, message) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + message)
  if (!ok) failures.push(message)
}

/** Every service this run created, so cleanup is unconditional. */
const created = new Set()

/** The ports this run owns. Anything else that listens is somebody's work. */
const claimed = new Set()

async function freePorts(keep) {
  const script = [
    'for p in $(ss -ltn 2>/dev/null | grep -oE "127\\\\.0\\\\.0\\\\.1:198[0-9][0-9]" | cut -d: -f2 | sort -u); do',
    keep.length
      ? `  case "$p" in ${keep.join('|')}) ;; *) fuser -k "$p/tcp" 2>/dev/null && echo "freed $p" ;; esac`
      : '  fuser -k "$p/tcp" 2>/dev/null && echo "freed $p"',
    'done',
  ].join('\n')
  return bash(ctl.distro(), script, { timeoutMs: 60000 })
}

const before = await ctl.units()
const initial = before.units || []
const projects = (await ctl.projects()).projects
check(projects.length >= 2, `two projects are available (${projects.length})`)
if (projects.length < 2) process.exit(1)

const named = (path) => projects.find((project) => project.path === path)
let original = named(process.env.SMOKE_PROJECT_A) || initial.find((service) => service.running) || initial[0]

// A service of our own when the machine has none, so the check never depends on
// the caller having set one up.
let borrowed = true
if (!original) {
  const seed = await ctl.start({ project: projects[0].path })
  check(seed.ok === true, 'a first project starts from nothing: ' + JSON.stringify(seed.error ?? ''))
  original = { unit: seed.unit, project: seed.project, port: seed.port, running: true }
  created.add(seed.unit)
  borrowed = false
} else {
  // An existing stopped service has no port to compare against, so it is
  // brought up first and the state it had is the state to restore.
  const up = await ctl.start({ project: original.project, port: original.port || undefined })
  check(up.ok === true, 'the first project is up: ' + JSON.stringify(up.error ?? ''))
  original = { ...original, port: up.port }
}
claimed.add(String(original.port))

const other = named(process.env.SMOKE_PROJECT_B)
  || projects.find((project) => project.path !== original.project)
check(Boolean(other), 'a second project is available to start')

// 1. Starting another project must leave the first one alone.
const started = await ctl.start({ project: other.path })
check(started.ok === true, 'a second project starts: ' + JSON.stringify(started.error ?? ''))
if (started.unit) created.add(started.unit)
if (started.port) claimed.add(String(started.port))
check(Boolean(started.url), 'starting returns that service\'s own URL')
check(String(started.url).includes(':' + started.port + '/'), 'the returned URL points at its port')
check(String(started.port) !== String(original.port), `it took a different port (${started.port} vs ${original.port})`)
check(started.unit !== original.unit, 'it got its own service: ' + started.unit)

const both = (await ctl.units()).units || []
check(both.filter((service) => service.running).length >= 2, 'both projects run at the same time')
check(both.some((service) => service.unit === original.unit && service.running), 'the first service was not disturbed')

// Every running service carries its own token URL: a token belongs to one
// process, and `~/.dsh/web-url.txt` holds only the last one to start.
const firstUrl = both.find((service) => service.unit === original.unit)?.url
const secondUrl = both.find((service) => service.unit === started.unit)?.url
check(Boolean(firstUrl), 'the first service has a UI URL')
check(Boolean(secondUrl), 'the second service has a UI URL')
check(firstUrl !== secondUrl, 'the two services have different URLs')
check(String(secondUrl).includes(':' + started.port + '/'), 'the second URL points at the second port')

// 2. Stopping is per project.
const stopped = await ctl.stopProject({ project: other.path })
check(stopped.ok === true, 'the second project stops: ' + JSON.stringify(stopped.error ?? ''))
const afterStop = (await ctl.units()).units || []
check(afterStop.some((service) => service.unit === original.unit && service.running), 'the first project kept running')
check(afterStop.some((service) => service.unit === started.unit && !service.running), 'the second is recorded as stopped')

// 3. A stopped project comes back on the port it had.
const restarted = await ctl.start({ project: other.path })
check(restarted.ok === true, 'the stopped project starts again: ' + JSON.stringify(restarted.error ?? ''))
check(String(restarted.port) === String(started.port), `it kept its port (${restarted.port})`)

// 4. Removing that project must not touch the first.
await ctl.stopProject({ project: other.path })
await ctl.removeUnit(started.unit)
created.delete(started.unit)
claimed.delete(String(started.port))
const cleaned = (await ctl.units()).units || []
check(cleaned.some((service) => service.unit === original.unit && service.running), 'the first service still runs')
check(!cleaned.some((service) => service.unit === started.unit), 'the temporary service is gone')

// 5. Put the machine back. A service this run created is removed; one that was
//    already here is left running, as it was found.
if (borrowed) {
  const restored = await ctl.start({ project: original.project, port: original.port })
  check(restored.ok === true, 'the original project is restored on its port')
} else {
  await ctl.removeUnit(original.unit)
  created.delete(original.unit)
  claimed.delete(String(original.port))
  await freePorts([...claimed])
}

const left = await ctl.units()
const ours = (left.units || []).filter((service) => created.has(service.unit))
check(ours.length === 0, 'no service of ours is left (' + (ours.map((s) => s.unit).join(',') || 'none') + ')')
for (const port of claimed) {
  const listener = await bash(ctl.distro(), `ss -ltn 2>/dev/null | grep -c ':${port} ' || true`, { timeoutMs: 20000 })
  if (Number(listener.stdout.trim()) === 0) check(false, `port ${port} should still be served`)
}

console.log('')
console.log(failures.length
  ? `RESULT: ${failures.length} failure(s)`
  : 'RESULT: the project model behaves as designed')
process.exit(failures.length ? 1 : 0)
