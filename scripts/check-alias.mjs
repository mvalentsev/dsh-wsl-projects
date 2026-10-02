// Round-trip for the alias feature against a real distribution: set a label,
// read it back through state(), then clear it and confirm the file is empty.
//
//   node scripts/check-alias.mjs

import { WslProjects } from '../lib/controller.js'

const ctl = new WslProjects({ distro: process.env.SMOKE_DISTRO || 'Ubuntu' })
const label = 'Round-trip label'

const failures = []
const check = (ok, message) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + message)
  if (!ok) failures.push(message)
}

// Whichever project this machine happens to have, so the check is not tied to
// one developer's layout.
const found = (await ctl.projects()).projects
const target = process.env.SMOKE_PROJECT || found[0]?.path
if (!target) {
  console.log('no project found under the configured projects root')
  process.exit(1)
}
console.log('project: ' + target)

const before = await ctl.state()
check(before.ok === true, 'state() answers')
check(before.aliases && typeof before.aliases === 'object', 'state() carries an aliases map')

const original = before.aliases[target] ?? null

const set = await ctl.setAlias(target, label)
check(set.ok === true, 'setAlias() writes: ' + JSON.stringify(set.error ?? ''))

const after = await ctl.state()
check(after.aliases[target] === label, 'the label survives a re-read: ' + JSON.stringify(after.aliases[target]))

const project = (after.projects || []).find((p) => p.path === target)
check(Boolean(project), 'the aliased project is in the project list')

const cleared = await ctl.setAlias(target, original ?? '')
check(cleared.ok === true, 'setAlias() clears: ' + JSON.stringify(cleared.error ?? ''))

const final = await ctl.state()
check(final.aliases[target] === undefined || final.aliases[target] === original,
  'clearing restored the previous value: ' + JSON.stringify(final.aliases[target]))

// A path that is not absolute must be refused, not written.
const bad = await ctl.setAlias('radio', 'nope')
check(bad.ok === false, 'a relative path is refused')

console.log('')
if (failures.length) {
  console.log('RESULT: ' + failures.length + ' failure(s)')
  process.exit(1)
}
console.log('RESULT: alias round-trip passed')
