// Runs every check, in one sequence, and reports what each one covers.
//
//   node scripts/check-all.mjs
//
// The checks are separate files on purpose: some need only Node, some need a
// distribution, some need a browser. Run together they also prove they do not
// disturb each other — two of them once cleared ports the other was using, and
// the failures looked like defects in the plugin.
//
// A check that cannot run here is reported as skipped with the reason, not as a
// pass. `--offline` runs only the checks that need Node.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const offlineOnly = process.argv.includes('--offline')

/** Each check, what it is for, and what it needs. */
const CHECKS = [
  { file: 'check-manifest.mjs', needs: 'node', says: 'manifest, exports and package contents' },
  { file: 'check-client.mjs', needs: 'node', says: 'the client half: factory, slots, decisions' },
  { file: 'check-theme-tokens.mjs', needs: 'node', says: 'theme tokens exist and no colour literal' },
  { file: 'check-bash.mjs', needs: 'node', says: 'every generated shell script parses (bash when reachable)' },
  { file: 'check-pack.mjs', needs: 'node', says: 'the packed tarball installs and starts' },
  { file: 'check-projects.mjs', needs: 'distro', says: 'the project model, two projects at once' },
  { file: 'check-urls.mjs', needs: 'distro', says: 'every link the panel offers answers' },
  { file: 'check-legacy.mjs', needs: 'distro', says: 'a unit from an older version is repaired' },
  { file: 'check-shared-home.mjs', needs: 'distro', says: 'the home decides the project, proven' },
  { file: 'check-alias.mjs', needs: 'distro', says: 'the name store round-trips' },
  { file: 'check-ui.mjs', needs: 'browser', says: 'a browser shows the correct project' },
  { file: 'check-readme.mjs', needs: 'distro', says: 'every claim in the readme, with evidence' },
]

/** Whether a check can run here at all, and why not when it cannot. */
function availability(needs) {
  if (needs === 'node') return { ok: true }
  if (needs === 'distro') {
    const probe = spawnSync('wsl.exe', ['-d', process.env.SMOKE_DISTRO || 'Ubuntu', '--', 'bash', '-lc', 'echo ok'], { encoding: 'utf8' })
    if (probe.status === 0) return { ok: true }
    // A local systemd, and a live user bus with it. Asking whether the
    // `systemctl` binary exists is not enough: a CI runner has the binary and no
    // user session, so the checks would start and then fail on their first real
    // call — which is exactly what happened the first time CI ran.
    const native = spawnSync('systemctl', ['--user', 'is-system-running'], { encoding: 'utf8' })
    const state = String(native.stdout || '').trim()
    if (native.status === 0 || state === 'degraded') return { ok: true }
    return { ok: false, why: 'no WSL distribution, and no systemd user session here' }
  }
  if (needs === 'browser') {
    const candidates = [
      process.env.UI_BROWSER,
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
    ].filter(Boolean)
    return candidates.some((candidate) => existsSync(candidate))
      ? { ok: true }
      : { ok: false, why: 'no Chromium-based browser found; set UI_BROWSER' }
  }
  return { ok: true }
}

const results = []
for (const [index, check] of CHECKS.entries()) {
  const label = `${index + 1}/${CHECKS.length} ${check.file.replace('.mjs', '')}`
  if (offlineOnly && check.needs !== 'node') {
    results.push({ ...check, state: 'skipped', note: '--offline' })
    console.log(`${label.padEnd(28)} skipped  (--offline)`)
    continue
  }
  const can = availability(check.needs)
  if (!can.ok) {
    results.push({ ...check, state: 'skipped', note: can.why })
    console.log(`${label.padEnd(28)} skipped  (${can.why})`)
    continue
  }
  const run = spawnSync(process.execPath, [join(root, 'scripts', check.file)], { encoding: 'utf8' })
  const output = String(run.stdout || '') + String(run.stderr || '')
  const verdict = output.split('\n').filter((line) => /^(RESULT|FAIL)/.test(line.trim())).pop() || ''
  const ok = run.status === 0 && !/^FAIL/m.test(verdict.trim())
  console.log(`${label.padEnd(28)} ${ok ? 'ok      ' : 'FAILED  '} ${verdict.trim() || 'no verdict'}`)
  if (!ok) {
    console.log(output.split('\n').filter((line) => line.startsWith('FAIL')).slice(0, 6).map((l) => '    ' + l.trim()).join('\n'))
  }
  results.push({ ...check, state: ok ? 'ok' : 'failed', verdict: verdict.trim() })
}

const failed = results.filter((r) => r.state === 'failed')
const skipped = results.filter((r) => r.state === 'skipped')
console.log('')
console.log(`checks run: ${results.length - skipped.length}, skipped: ${skipped.length}, failed: ${failed.length}`)
for (const skip of skipped) console.log(`  skipped ${skip.file}: ${skip.note}`)
// Skipping is honest, but it must not become a way to pass with nothing checked.
// `CHECK_REQUIRE_ALL=1` turns a skip into a failure, for a job that is expected
// to have everything.
const strict = process.env.CHECK_REQUIRE_ALL === '1'
if (strict && skipped.length) {
  console.log(`RESULT: ${skipped.length} check(s) could not run, and CHECK_REQUIRE_ALL is set`)
  process.exit(1)
}
console.log(failed.length
  ? `RESULT: ${failed.length} check(s) failed: ${failed.map((f) => f.file).join(', ')}`
  : 'RESULT: every check that could run here passed')
process.exit(failed.length ? 1 : 0)
