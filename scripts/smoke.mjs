// Manual harness for the host half. Run from the plugin root:
//   node scripts/smoke.mjs
// It exercises the exact code paths the REST API and the agent tool use.

import { WslProjects } from '../lib/controller.js'
import { listDistros, homeOf } from '../lib/wsl.js'

const distro = process.env.SMOKE_DISTRO || 'Ubuntu'
const ctl = new WslProjects({ distro })

function show(title, value) {
  console.log('\n=== ' + title + ' ===')
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

show('listDistros', await listDistros())
show('homeOf', await homeOf(distro))

const projects = await ctl.projects()
show('projects', { ok: projects.ok, root: projects.root, count: projects.projects?.length, first3: projects.projects?.slice(0, 3) })

const state = await ctl.state()
show('state.status', state.status)
show('state.meta', { ok: state.ok, distro: state.distro, projects: state.projects?.length, configFiles: state.configFiles })
