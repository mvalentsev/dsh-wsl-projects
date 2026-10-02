// A unit created by an older version of this plugin carries no project argument.
// The launcher must still find its project, from the unit itself, and bring the
// service up on its own home. This reproduces that unit deliberately.
import { WslProjects } from '../lib/controller.js'
import { bash } from '../lib/wsl.js'
import { cdp } from './ui-probe.mjs'

const ctl = new WslProjects({ distro: process.env.SMOKE_DISTRO || 'Ubuntu' })
let failures = 0
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures += 1 }

const UNIT = 'dsh-web-legacy.service'
const PROJECT = '/home/micha/projects/dev'

for (const unit of (await ctl.units()).units || []) await ctl.removeUnit(unit.unit)
await bash(ctl.distro(), `rm -f "$HOME/.config/systemd/user/${UNIT}"; rm -rf "$HOME/.config/systemd/user/${UNIT}.d" "$HOME/.dsh/dsh-wsl-projects/homes/dev"; for p in $(ss -ltn 2>/dev/null | grep -oE "127\\\\.0\\\\.0\\\\.1:198[0-9][0-9]" | cut -d: -f2 | sort -u); do fuser -k "$p/tcp" 2>/dev/null; done; sleep 2`, { timeoutMs: 60000 })

// The launcher is current, the unit is not: exactly the machine's situation.
// No `Environment=DSH_HOME=` here — an older unit never set one either, and
// putting it back would be testing an environment entry rather than the unit.
await bash(ctl.distro(), (await import('../lib/scripts.js')).writeLaunchScript(), { timeoutMs: 60000 })
const oldUnit = [
  '[Unit]',
  'Description=DeepSeek Harness web profile (legacy unit)',
  'After=default.target',
  '',
  '[Service]',
  'Type=simple',
  `WorkingDirectory=${PROJECT}`,
  'ExecStart=/home/micha/.dsh/dsh-wsl-projects/launch.sh 19800 ' + UNIT,
  'Restart=always',
  'RestartSec=3',
  'KillMode=mixed',
  '',
  '[Install]',
  'WantedBy=default.target',
  '',
].join('\n')
const wrote = await bash(ctl.distro(), `cat > "$HOME/.config/systemd/user/${UNIT}" <<'UEOF'\n${oldUnit}\nUEOF\nsystemctl --user daemon-reload && systemctl --user enable --now ${UNIT} && echo STARTED`, { timeoutMs: 120000 })
check(wrote.stdout.includes('STARTED'), 'the legacy unit starts: ' + wrote.stdout.trim().slice(0, 80))

// Give the launcher time to create its home and record the URL.
let url = ''
for (let i = 0; i < 60; i += 1) {
  await new Promise((r) => setTimeout(r, 1000))
  const r = await bash(ctl.distro(), `cat "$HOME/.dsh/dsh-wsl-projects/urls/${UNIT.replace('.service', '')}" 2>/dev/null`, { timeoutMs: 20000 })
  url = r.stdout.trim()
  if (url) break
}
check(Boolean(url), 'the legacy unit recorded a URL: ' + url.slice(0, 48))

const home = await bash(ctl.distro(), 'grep -o \'"path": "[^"]*"\' "$HOME/.dsh/dsh-wsl-projects/homes/dev/storages/workspace.json" 2>/dev/null | head -1', { timeoutMs: 30000 })
check(home.stdout.includes(PROJECT), 'the legacy unit got a home for its own project: ' + home.stdout.trim().slice(0, 120))

// The dsh process is a child of the launcher, so its environment is what
// matters — the launcher's own MainPID does not carry DSH_HOME.
const envCheck = await bash(ctl.distro(), [
  'for pid in $(pgrep -f "bin.js --profile web" 2>/dev/null); do',
  '  h="$(tr \'\\0\' \'\\n\' < /proc/$pid/environ 2>/dev/null | sed -n \'s/^DSH_HOME=//p\')"',
  '  c="$(readlink /proc/$pid/cwd 2>/dev/null)"',
  '  [ "$c" = "' + PROJECT + '" ] && echo "pid=$pid DSH_HOME=$h"',
  'done',
].join('\n'), { timeoutMs: 40000 })
check(envCheck.stdout.includes('DSH_HOME=/home/micha/.dsh/dsh-wsl-projects/homes/dev'),
  'dsh itself runs with the project home: ' + envCheck.stdout.trim().slice(0, 140))

const text = await cdp(9800 + Math.floor(Math.random() * 150), url)
const flat = (text || '').replace(/\s+/g, ' ')
console.log('  UI: ' + flat.slice(0, 100))
check(/\bdev\b/.test(flat), 'the UI shows dev')
check(!/\bradio\b/.test(flat), 'the UI does not show radio')
check(!/Choose a workspace/i.test(flat), 'the UI did not fall back to the workspace picker')

await ctl.removeUnit(UNIT)
await bash(ctl.distro(), 'for p in $(ss -ltn 2>/dev/null | grep -oE "127\\\\.0\\\\.0\\\\.1:198[0-9][0-9]" | cut -d: -f2 | sort -u); do fuser -k "$p/tcp" 2>/dev/null; done; sleep 1', { timeoutMs: 40000 })

console.log(failures === 0 ? 'RESULT: a unit from an older version still opens its own project' : `RESULT: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
