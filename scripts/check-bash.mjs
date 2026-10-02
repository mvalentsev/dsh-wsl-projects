// Checks the shell scripts this plugin generates.
//
//   node scripts/check-bash.mjs
//
// These scripts are built by JavaScript template literals, and that is where they
// break: a stray backtick ends a literal early, `${...}` that should have been
// escaped is evaluated by JavaScript, and a heredoc whose terminator moves leaves
// the rest of the file inside a string. None of that is visible in the JavaScript
// that produced it, and all of it makes a service fail to start.
//
// The checks below are structural and run without bash, so they work everywhere,
// including CI. When bash is present the text is handed to `bash -n` as well,
// which is the only way to be sure — a structural check can miss an error that
// bash would catch, and the summary says which of the two ran.

import { spawnSync } from 'node:child_process'
import { bash } from '../lib/wsl.js'
import { writeLaunchScript, installLaunchScript, unitActionScript, unitsScript, statusScript, unitCreateForProjectScript } from '../lib/scripts.js'

const failures = []
const notes = []
const check = (label, ok, detail = '') => {
  if (ok) notes.push('PASS ' + label)
  else failures.push('FAIL ' + label + (detail ? ' — ' + detail : ''))
}

const scripts = {
  'launch.sh': installLaunchScript(),
  'launcher-report.sh': writeLaunchScript(),
  'unit-create.sh': unitCreateForProjectScript({ unit: 'dsh-web-x.service', project: '/tmp/x', port: 19800, description: 'd' }),
  'unit-restart.sh': unitActionScript({ unit: 'dsh-web-x.service', verb: 'restart' }),
  'unit-stop.sh': unitActionScript({ unit: 'dsh-web-x.service', verb: 'stop' }),
  'units.sh': unitsScript(),
  'status.sh': statusScript(),
}

/** Balanced shell constructs, counted outside heredocs and comments. */
function balance(text) {
  const lines = text.split('\n')
  const counts = { if: 0, fi: 0, case: 0, esac: 0, do: 0, done: 0, heredocOpen: 0, heredocClose: [] }
  let heredoc = null
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (heredoc) {
      if (line === heredoc) { counts.heredocClose.push(heredoc); heredoc = null }
      continue
    }
    const open = line.match(/<<-?'?([A-Za-z_][A-Za-z0-9_]*)'?/)
    if (open) { heredoc = open[1]; counts.heredocOpen += 1; continue }
    if (/^\s*#/.test(line)) continue
    counts.if += (line.match(/(^|[\s;&|(])if[\s(]/g) || []).length
    counts.fi += (line.match(/(^|[\s;&|])fi([\s;&|)]|$)/g) || []).length
    counts.case += (line.match(/(^|[\s;&|(])case[\s(]/g) || []).length
    counts.esac += (line.match(/(^|[\s;&|])esac([\s;&|)]|$)/g) || []).length
    counts.do += (line.match(/(^|[\s;&|])do([\s;&|]|$)/g) || []).length
    counts.done += (line.match(/(^|[\s;&|])done([\s;&|)]|$)/g) || []).length
  }
  return { ...counts, unterminatedHeredoc: heredoc }
}

const distro = process.env.SMOKE_DISTRO || 'Ubuntu'
let bashChecked = 0

for (const [name, source] of Object.entries(scripts)) {
  check(`${name}: is not empty`, source.trim().length > 50, `${source.length} bytes`)
  // Only artifacts that cannot be legal shell. A search for `${` was tried here
  // and removed: every script contains it legitimately, as `${VAR}` and
  // `${1:-default}`, so the check failed on all of them and proved nothing. What
  // catches a broken template is `bash -n` below, and the balance checks.
  check(`${name}: no JavaScript text leaked in`, !/\bundefined\b|\bNaN\b|\[object Object\]|at \w+ \(/.test(source),
    'a JavaScript value reached the output')

  const b = balance(source)
  check(`${name}: every if has a fi`, b.if === b.fi, `if=${b.if} fi=${b.fi}`)
  check(`${name}: every case has an esac`, b.case === b.esac, `case=${b.case} esac=${b.esac}`)
  check(`${name}: every do has a done`, b.do === b.done, `do=${b.do} done=${b.done}`)
  check(`${name}: every heredoc is closed`, !b.unterminatedHeredoc, `unterminated: ${b.unterminatedHeredoc || 'none'}`)

  // The real test: bash parses it. The text goes to a file inside the
  // distribution first, because bash on Windows cannot be handed a Windows path
  // and a rule has to hold for the file it will actually become. When no bash is
  // reachable the structural checks above still ran, and the summary says so —
  // a missing bash is not a fault in the scripts.
  const parsed = await bash(distro, [
    `cat > /tmp/dsh-syntax-${name} <<'DSH_SYNTAX_EOF'`,
    source,
    'DSH_SYNTAX_EOF',
    `if bash -n /tmp/dsh-syntax-${name} 2>/tmp/dsh-syntax-err; then echo PARSE_OK; else echo PARSE_FAIL; cat /tmp/dsh-syntax-err; fi`,
    `rm -f /tmp/dsh-syntax-${name} /tmp/dsh-syntax-err`,
  ].join('\n'), { timeoutMs: 60000 })
  const reachable = /PARSE_(OK|FAIL)/.test(parsed.stdout)
  if (!reachable) {
    bashChecked = -1
    continue
  }
  const ok = parsed.stdout.includes('PARSE_OK')
  check(`${name}: bash accepts it`, ok, parsed.stdout.replace(/PARSE_(OK|FAIL)/, '').trim().slice(0, 200))
  bashChecked += 1
}

for (const note of notes) console.log(note)
console.log('')
if (bashChecked <= 0) {
  console.log('NOTE no bash was reachable, so only the structural checks ran')
  console.log('NOTE CI has bash, so this is checked in full there')
}
console.log(`scripts checked: ${Object.keys(scripts).length}; parsed by bash: ${Math.max(0, bashChecked)}`)
console.log(failures.length ? `RESULT: ${failures.length} failure(s)` : 'RESULT: every generated script is well formed')
for (const failure of failures) console.log(failure)
process.exit(failures.length ? 1 : 0)
