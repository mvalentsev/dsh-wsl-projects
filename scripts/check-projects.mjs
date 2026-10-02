// End-to-end check of the project model against a real distribution:
// starting one project must not touch another, stopping must be per project,
// and a stopped project must come back on the port it already had.
//
//   node scripts/check-projects.mjs
//
// It restores the first project it found, so the machine ends as it started.

import { WslProjects } from '../lib/controller.js'

const ctl = new WslProjects({ distro: process.env.SMOKE_DISTRO || 'Ubuntu' })
const failures = []
const check = (ok, message) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + message)
  if (!ok) failures.push(message)
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
check(started.port !== original.port, `it took a different port (${started.port} vs ${original.port})`)
check(started.unit !== original.unit, 'it got its own service: ' + started.unit)

const both = (await ctl.units()).units || []
check(both.filter((service) => service.running).length >= 2, 'both projects run at the same time')
check(both.some((service) => service.unit === original.unit && service.running), 'the first service was not disturbed')

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
//    service of its own behind.
await ctl.stopProject({ project: other.path })
await ctl.removeUnit(started.unit)
const cleaned = (await ctl.units()).units || []
check(cleaned.some((service) => service.unit === original.unit && service.running), 'the original still runs at the end')
check(!cleaned.some((service) => service.unit === started.unit), 'the temporary service is gone')

// Restore the original to exactly what it was.
const restored = await ctl.start({ project: original.project, port: original.port })
check(restored.ok === true, 'the original project is restored')

console.log('')
if (failures.length) {
  console.log('RESULT: ' + failures.length + ' failure(s)')
  process.exit(1)
}
console.log('RESULT: the project model behaves as designed')
