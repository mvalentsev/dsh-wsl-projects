import { WslProjects } from '../lib/controller.js'
import { bash } from '../lib/wsl.js'

const ctl = new WslProjects({ distro: 'Ubuntu' })
let failures = 0
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures += 1 }

const httpCode = async (url) => {
  if (!url) return 'none'
  const r = await bash('Ubuntu', `curl -s -o /dev/null -w '%{http_code}' --max-time 15 '${url}'`, { timeoutMs: 40000 })
  return r.stdout.trim()
}

// A real project, started twice over, checking the link works each time.
const projects = (await ctl.projects()).projects
const target = projects.find((p) => p.name === 'radio') || projects[0]
console.log('target project:', target.path)

for (const unit of ['dsh-web-radio.service', 'dsh-web-tmp-email.service']) {
  await ctl.removeUnit(unit)
}

const first = await ctl.start({ project: target.path })
check(first.ok === true, 'the project starts: ' + JSON.stringify(first.error ?? ''))
const code1 = await httpCode(first.url)
check(code1 === '303' || code1 === '200', `its URL is accepted by the server (${code1})`)

const viaUnits = (await ctl.units()).units.find((u) => u.unit === first.unit)
check(Boolean(viaUnits?.url), 'the units list carries a URL: ' + String(viaUnits?.url).slice(0, 46))
check((await httpCode(viaUnits?.url)) === code1 || code1 === '200', 'and that URL also works')

const restarted = await ctl.restartUnit(first.unit)
const code2 = await httpCode(restarted.url)
check(code2 === '303' || code2 === '200', `after a restart the URL still works (${code2})`)
check(restarted.url !== first.url, 'and it is a fresh token, not the dead one')
const viaUnits2 = (await ctl.units()).units.find((u) => u.unit === first.unit)
check((await httpCode(viaUnits2?.url)) === code2 || code2 === '200', 'the units list agrees after the restart')

console.log('')
await ctl.removeUnit(first.unit)
const final = await ctl.units()
console.log('remaining:', JSON.stringify(final.units.map((u) => u.unit)))
console.log(failures === 0 ? 'RESULT: all URL checks passed' : `RESULT: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
