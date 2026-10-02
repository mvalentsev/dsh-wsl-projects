// A unit created by an older version of this plugin carries no project argument
// and may set DSH_HOME to the shared home. The launcher must still find the
// project from the unit itself and bring the service up on its own home.
//
//   node scripts/check-legacy.mjs
//
// This is the check for the failure that took longest to find: a service
// reported as running its own project while serving another one's workspace.

import { WslProjects } from '../lib/controller.js'
import { bash } from '../lib/wsl.js'
import { writeLaunchScript } from '../lib/scripts.js'
import { cdp } from './ui-probe.mjs'

const ctl = new WslProjects({ distro: process.env.SMOKE_DISTRO || 'Ubuntu' })
let failures = 0
const check = (ok, msg) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + msg)
  if (!ok) failures += 1
}

const UNIT = 'dsh-web-legacy.service'

// Whatever project this machine has, so the check is not tied to one layout.
const projects = (await ctl.projects()).projects
const PROJECT = process.env.SMOKE_PROJECT || projects[0]?.path
if (!PROJECT) {
  console.log('no project found under the configured projects root')
  process.exit(1)
}
const slug = PROJECT.split('/').filter(Boolean).pop()
console.log('project: ' + PROJECT)

const stateScript = 'echo "$HOME/.dsh/dsh-wsl-projects"'

for (const unit of (await ctl.units()).units || []) await ctl.removeUnit(unit.unit)
await bash(ctl.distro(), `rm -f "$HOME/.config/systemd/user/${UNIT}"; rm -rf "$HOME/.config/systemd/user/${UNIT}.d" "$HOME/.dsh/dsh-wsl-projects/homes/${slug}"; for p in $(ss -ltn 2>/dev/null | grep -oE "127\\\\.0\\\\.0\\\\.1:198[0-9][0-9]" | cut -d: -f2 | sort -u); do fuser -k "$p/tcp" 2>/dev/null; done; sleep 2`, { timeoutMs: 60000 })

// The launcher is current, the unit is not. The environment entry is included
// because the old template wrote one, and it is exactly what used to win over
// the launcher's own choice of home.
await bash(ctl.distro(), writeLaunchScript(), { timeoutMs: 60000 })
const oldUnit = [
  '[Unit]',
  'Description=DeepSeek Harness web profile (a unit from an older version)',
  'After=default.target',
  '',
  '[Service]',
  'Type=simple',
  `WorkingDirectory=${PROJECT}`,
  'Environment=DSH_HOME=%h/.dsh',
  `ExecStart=%h/.dsh/dsh-wsl-projects/launch.sh 19800 ${UNIT}`,
  'Restart=always',
  'RestartSec=3',
  'KillMode=mixed',
  '',
  '[Install]',
  'WantedBy=default.target',
  '',
].join('\n')
const wrote = await bash(ctl.distro(), `cat > "$HOME/.config/systemd/user/${UNIT}" <<'UEOF'\n${oldUnit}\nUEOF\nsystemctl --user daemon-reload && systemctl --user enable --now ${UNIT} && echo STARTED`, { timeoutMs: 120000 })
check(wrote.stdout.includes('STARTED'), 'the older unit starts')

let url = ''
for (let i = 0; i < 60; i += 1) {
  await new Promise((r) => setTimeout(r, 1000))
  const r = await bash(ctl.distro(), `cat "$HOME/.dsh/dsh-wsl-projects/urls/${UNIT.replace('.service', '')}" 2>/dev/null`, { timeoutMs: 20000 })
  url = r.stdout.trim()
  if (url) break
}
check(Boolean(url), 'it recorded a URL of its own')

const state = (await bash(ctl.distro(), stateScript, { timeoutMs: 20000 })).stdout.trim()
const home = await bash(ctl.distro(), `grep -o '"path": "[^"]*"' "${state}/homes/${slug}/storages/workspace.json" 2>/dev/null | head -1`, { timeoutMs: 30000 })
check(home.stdout.includes(PROJECT), 'the launcher gave it a home for its own project')

// The dsh process is a child of the launcher, so its environment is the one that
// matters: the launcher's own MainPID never carries DSH_HOME.
const envCheck = await bash(ctl.distro(), [
  'for pid in $(pgrep -f "bin.js --profile web" 2>/dev/null); do',
  '  c="$(readlink /proc/$pid/cwd 2>/dev/null)"',
  '  [ "$c" = "' + PROJECT + '" ] || continue',
  '  echo "pid=$pid cwd=$c"',
  `  echo "home=$(tr '\\0' '\\n' < /proc/$pid/environ 2>/dev/null | sed -n 's/^DSH_HOME=//p')"`,
  'done',
].join('\n'), { timeoutMs: 40000 })
check(envCheck.stdout.includes(`home=${state}/homes/${slug}`),
  'dsh itself runs on that home, not the shared one: ' + envCheck.stdout.trim().replace(/\n/g, ' ').slice(0, 120))

const text = await cdp(9800 + Math.floor(Math.random() * 150), url)
const flat = (text || '').replace(/\s+/g, ' ')
console.log('  UI: ' + flat.slice(0, 100))
check(new RegExp('\\b' + slug + '\\b').test(flat), 'the UI shows ' + slug)
check(!/Choose a workspace/i.test(flat), 'the UI did not fall back to the workspace picker')

await ctl.removeUnit(UNIT)
await bash(ctl.distro(), 'for p in $(ss -ltn 2>/dev/null | grep -oE "127\\\\.0\\\\.0\\\\.1:198[0-9][0-9]" | cut -d: -f2 | sort -u); do fuser -k "$p/tcp" 2>/dev/null; done; sleep 1', { timeoutMs: 40000 })

console.log(failures === 0
  ? 'RESULT: a unit from an older version still opens its own project'
  : `RESULT: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
