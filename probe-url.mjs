import { WslProjects } from './lib/controller.js'
import { bash } from './lib/wsl.js'
import * as S from './lib/scripts.js'
const ctl = new WslProjects({ distro: 'Ubuntu' })
console.log('start radio:', JSON.stringify(await ctl.start({ project: '/home/micha/projects/radio' })))
await new Promise((r) => setTimeout(r, 6000))
const r = await bash('Ubuntu', 'ls -la "$HOME/.dsh/dsh-wsl-projects/urls/"; echo "--- log head ---"; head -n 2 "$HOME/.dsh/dsh-wsl-projects/logs/dsh-web-radio.log" 2>&1', { timeoutMs: 30000 })
console.log(r.stdout)
console.log('units:', JSON.stringify((await ctl.units()).units, null, 2))
