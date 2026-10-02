// End-to-end check of the project model against a real distribution:
// starting one project must not touch another, stopping must be per project,
// and a stopped project must come back on the port it already had.
//
//   node scripts/check-projects.mjs
//
// It restores the first project it found, so the machine ends as it started.

import { WslProjects } from '../lib/controller.js'
import { bash } from '../lib/wsl.js'

const ctl = new WslProjects({ distro: process.env.SMOKE_DISTRO || 'Ubuntu' })
const failures = []
const check = (ok, message) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + message)
  if (!ok) failures.push(message)
}

/** Everything this run created, so cleanup can be unconditional. */
const created = new Set()

/**
 * The launcher runs dsh as a background child, so systemd killing the launcher
 * does not always take the server with it. Killing by port is the reliable
 * sweep, and the one service that must survive is the caller's own.
 */
async function freePortsExcept(keep) {
  const script = [
    'for p in $(ss -ltn 2>/dev/null | grep -oE "127\\\\.0\\\\.0\\\\.1:198[0-9][0-9]" | cut -d: -f2 | sort -u); do',
    `  case "$p" in ${keep.join('|')}) ;; *) fuser -k "$p/tcp" 2>/dev/null && echo "freed $p" ;; esac`,
    'done',
  ].join('\n')
  return bash(ctl.distro(), script, { timeoutMs: 60000 })
}

async function cleanup(keepUnit, keepPort) {
  for (const unit of created) {
    await ctl.removeUnit(unit).catch(() => {})
  }
  await freePortsExcept([String(keepPort)])
  if (keepUnit) await ctl.start({ project: keepUnit, port: keepPort })
}

const before = await ctl.units()
const initial = before.units || []
check(initial.length >= 1, `a service already exists (${initial.length})`)
if (!initial.length) process.exit(1)

const original = initial.find((service) => service.running) || initial[0]
const other = (await ctl.projects()).projects.find((project) => project.path !== original.project)
check(Boolean(other), 'a second project is available to start')

// 1. Starting another project must leave the first one alone.
const first = await ctl.start({ project: original.project, port: original.port })
check(first.ok === true, 'the original project starts: ' + JSON.stringify(first.error ?? ''))

const started = await ctl.start({ project: other.path })
check(started.ok === true, 'a second project starts: ' + JSON.stringify(started.error ?? ''))
if (started.unit) created.add(started.unit)
// Its own URL is part of the start result, so a service is never reported up
// without the link that makes it usable.
check(Boolean(started.url), 'starting returns that service\'s own URL: ' + String(started.url).slice(0, 44))
check(String(started.url).includes(':' + started.port + '/'), 'the returned URL points at its port')
check(started.port !== original.port, `it took a different port (${started.port} vs ${original.port})`)
check(started.unit !== original.unit, 'it got its own service: ' + started.unit)

const both = (await ctl.units()).units || []
check(both.filter((service) => service.running).length >= 2, 'both projects run at the same time')
check(both.some((service) => service.unit === original.unit && service.running), 'the first service was not disturbed')

// Every running service must carry its own token URL. dsh publishes only one —
// the file belongs to whichever started last — so this is the check that the
// per-service launcher does its job.
const firstUrl = both.find((service) => service.unit === original.unit)?.url
const secondUrl = both.find((service) => service.unit === started.unit)?.url
check(Boolean(firstUrl), 'the first service has a UI URL: ' + String(firstUrl).slice(0, 42))
check(Boolean(secondUrl), 'the second service has a UI URL: ' + String(secondUrl).slice(0, 42))
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

// 4. Cleaning up that project must not touch the first, and must leave no
//    service or stray server behind.
await ctl.stopProject({ project: other.path })
await ctl.removeUnit(started.unit)
created.delete(started.unit)
await freePortsExcept([String(original.port)])
const cleaned = (await ctl.units()).units || []
check(cleaned.some((service) => service.unit === original.unit && service.running), 'the original still runs at the end')
check(!cleaned.some((service) => service.unit === started.unit), 'the temporary service is gone')

const ports = await bash(ctl.distro(), 'ss -ltn 2>/dev/null | grep -oE "127\\\\.0\\\\.0\\\\.1:198[0-9][0-9]" | cut -d: -f2 | sort -u', { timeoutMs: 30000 })
const listening = ports.stdout.trim().split('\n').filter(Boolean)
check(listening.every((port) => String(port) === String(original.port)),
  'no stray server is left listening (' + (listening.join(',') || 'none') + ')')

// Restore the original to exactly what it was.
const restored = await ctl.start({ project: original.project, port: original.port })
check(restored.ok === true, 'the original project is restored')

console.log('')
if (failures.length) {
  console.log('RESULT: ' + failures.length + ' failure(s)')
  process.exit(1)
}
console.log('RESULT: the project model behaves as designed')
