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
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const offlineOnly = process.argv.includes('--offline')

/** Each check, what it is for, and what it needs. */
const CHECKS = [
  { file: 'check-manifest.mjs', needs: ['node'], says: 'manifest, exports and package contents' },
  { file: 'check-client.mjs', needs: ['node'], says: 'the client half: factory, slots, decisions' },
  { file: 'check-theme-tokens.mjs', needs: ['node'], says: 'theme tokens exist and no colour literal' },
  { file: 'check-assets.mjs', needs: ['browser'], says: 'the readme images render and follow the theme' },
  { file: 'check-bash.mjs', needs: ['node'], says: 'every generated shell script parses (bash when reachable)' },
  { file: 'check-pack.mjs', needs: ['node'], says: 'the packed tarball installs and starts' },
  { file: 'check-projects.mjs', needs: ['distro'], says: 'the project model, two projects at once' },
  { file: 'check-urls.mjs', needs: ['distro'], says: 'every link the panel offers answers' },
  { file: 'check-legacy.mjs', needs: ['distro'], says: 'a unit from an older version is repaired' },
  { file: 'check-shared-home.mjs', needs: ['distro'], says: 'the home decides the project, proven' },
  { file: 'check-alias.mjs', needs: ['distro'], says: 'the name store round-trips' },
  // A browser alone is not enough: this check starts services and reads the pages
  // they serve, so it needs a distribution as well. Marking it as needing only a
  // browser ran it on a CI runner, where it failed for want of a distribution —
  // the failure that broke the first two CI runs.
  { file: 'check-ui.mjs', needs: ['browser', 'distro'], says: 'a browser shows the correct project' },
  { file: 'check-readme.mjs', needs: ['distro'], says: 'every claim in the readme, with evidence' },
]

/**
 * Whether a check can run here at all, and why not when it cannot.
 *
 * The distribution case is deliberately strict. A first version asked whether the
 * `systemctl` binary exists, and a CI runner has the binary, so the checks started
 * and failed on their first real call — three runs were spent on failures that
 * looked like defects in the plugin. A distribution now counts as available only
 * when a distribution actually answers and has projects to work with, because
 * that is what those checks need.
 */
function availability(needs) {
  if (needs === 'node') return { ok: true }
  if (needs === 'distro') {
    const distro = process.env.SMOKE_DISTRO || 'Ubuntu'
    const probe = spawnSync('wsl.exe', ['-d', distro, '--', 'bash', '-lc', 'echo ok'], { encoding: 'utf8' })
    const viaWsl = probe.status === 0 && String(probe.stdout).includes('ok')
    if (!viaWsl) {
      const native = spawnSync('systemctl', ['--user', 'is-system-running'], { encoding: 'utf8' })
      const state = String(native.stdout || '').trim()
      const viaSystemd = (native.status === 0 || state === 'degraded') && state !== ''
      if (!viaSystemd) return { ok: false, why: 'no WSL distribution, and no systemd user session here' }
    }
    // Those checks work on projects. A machine that has none is a machine where
    // they cannot say anything, and reporting that as a failure is a false alarm.
    // The controller is imported by URL: a plain path is not a module specifier on
    // Windows, and that mistake made this probe report zero projects on a machine
    // that has twenty-one.
    const controller = pathToFileURL(join(root, 'lib', 'controller.js')).href
    const projects = spawnSync(process.execPath, ['-e',
      `import(${JSON.stringify(controller)}).then(async (m) => {
        const ctl = new m.WslProjects({ distro: ${JSON.stringify(distro)} })
        const found = await ctl.projects()
        process.stdout.write('PROJECTS:' + (found.projects || []).length)
      }).catch((error) => process.stdout.write('PROJECTS:0 ' + String(error && error.message)))`,
    ], { encoding: 'utf8', timeout: 240000, env: { ...process.env, SMOKE_DISTRO: distro } })
    const count = Number((String(projects.stdout || '').match(/PROJECTS:(\d+)/) || [])[1] || 0)
    if (count < 2) {
      const why = String(projects.stdout || '').replace('PROJECTS:0', '').trim()
      return { ok: false, why: `only ${count} project(s) under the projects root; two are needed${why ? ' (' + why.slice(0, 80) + ')' : ''}` }
    }
    return { ok: true }
  }
  if (needs === 'browser') {
    // The browser checks speak Chrome's debugging protocol over a WebSocket,
    // and that became a Node global only in Node 22. A Node without it cannot
    // ask a browser anything, so the browser checks report that and are
    // skipped here instead of crashing inside the protocol.
    if (typeof WebSocket === 'undefined') {
      return { ok: false, why: 'this Node has no WebSocket global to speak the debugging protocol on (Node 22+)' }
    }
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
const transcript = []
for (const [index, check] of CHECKS.entries()) {
  const label = `${index + 1}/${CHECKS.length} ${check.file.replace('.mjs', '')}`
  const needs = Array.isArray(check.needs) ? check.needs : [check.needs]
  if (offlineOnly && needs.some((need) => need !== 'node')) {
    results.push({ ...check, state: 'skipped', note: '--offline' })
    console.log(`${label.padEnd(28)} skipped  (--offline)`)
    continue
  }
  const missing = needs.map((need) => availability(need)).find((can) => !can.ok)
  if (missing) {
    results.push({ ...check, state: 'skipped', note: missing.why })
    console.log(`${label.padEnd(28)} skipped  (${missing.why})`)
    continue
  }
  const run = spawnSync(process.execPath, [join(root, 'scripts', check.file)], { encoding: 'utf8' })
  const output = String(run.stdout || '') + String(run.stderr || '')
  const verdict = output.split('\n').filter((line) => /^(RESULT|FAIL)/.test(line.trim())).pop() || ''
  const ok = run.status === 0 && !/^FAIL/m.test(verdict.trim())
  console.log(`${label.padEnd(28)} ${ok ? 'ok      ' : 'FAILED  '} ${verdict.trim() || 'no verdict'}`)
  // A failure has to say why, here, in the log of the machine that saw it. When
  // this ran on CI the reason was invisible: the log needs a token, and a summary
  // line saying "FAILED, no verdict" told nobody anything.
  if (!ok) {
    console.log(`--- ${check.file}: what it printed ---`)
    console.log(output.trim().split('\n').slice(-30).map((line) => '    ' + line).join('\n'))
  }
  transcript.push(`### ${check.file}: ${ok ? 'ok' : 'FAILED'} — ${verdict.trim() || 'no verdict'}\n\n${output.trim()}\n`)
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

// The whole run, written down. CI keeps it as an artifact, so a failure can be
// read after the fact without a token for the log API.
try {
  writeFileSync(join(root, 'check-report.md'), [
    '# Checks',
    '',
    `run on ${process.platform} with Node ${process.version}`,
    `checks run: ${results.length - skipped.length}, skipped: ${skipped.length}, failed: ${failed.length}`,
    '',
    ...skipped.map((s) => `- skipped ${s.file}: ${s.note}`),
    ...failed.map((f) => `- failed ${f.file}: ${f.verdict}`),
    '',
    ...transcript,
  ].join('\n'))
} catch { /* a read-only checkout is not a reason to fail */ }

process.exit(failed.length ? 1 : 0)
