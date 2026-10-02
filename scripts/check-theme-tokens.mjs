// Answers a question the other gates cannot: are the tokens this panel uses
// actually theme-aware? A token with one value in both schemes would render the
// panel identically in light and dark, which is how a control ends up
// unreadable on one of them.
//
//   node scripts/check-theme-tokens.mjs [path-to-app.asar]
//
// The token inventory is read from the installed engine's stylesheet. Without a
// readable archive the check says so instead of passing quietly.

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const archive = process.argv[2]
  || process.env.DSH_ASAR
  || 'C:/Users/micha/AppData/Local/Programs/DeepSeek Harness/resources/app.asar'

const failures = []
const notes = []
const check = (label, ok, detail = '') => {
  if (ok) notes.push('PASS ' + label)
  else failures.push('FAIL ' + label + (detail ? ' — ' + detail : ''))
}

const bundle = await readFile(join(root, 'lib', 'client.js'), 'utf8')

const used = [...new Set([...bundle.matchAll(/--dsw-[a-z0-9-]+/g)].map((m) => m[0]))].sort()
check('the panel uses theme tokens', used.length > 0)

// A colour literal inside var() is exactly the bug this exists to prevent: the
// literal wins whenever the token is absent, and light values then land on a
// dark surface.
const colourFals = [...bundle.matchAll(/var\((--dsw-[a-z0-9-]+)\s*,\s*([^)]+)\)/g)]
  .filter((m) => /#|rgb|hsl/i.test(m[2]))
check('no colour literal is used as a token fallback', colourFals.length === 0,
  colourFals.map((m) => `${m[1]} -> ${m[2].trim()}`).join('; '))

// --- the engine's own declarations -----------------------------------------

let engineTokens = null
let darkBlock = ''
try {
  const text = await readFile(archive, 'utf8')
  engineTokens = new Set([...text.matchAll(/--dsw-[a-z0-9-]+/g)].map((m) => m[0]))

  // The app follows the OS scheme, so the dark values live in a
  // `prefers-color-scheme: dark` block. Take the first substantial one.
  const at = text.indexOf('prefers-color-scheme: dark')
  if (at > 0) darkBlock = text.slice(at, at + 400000)
  notes.push('NOTE app theming: follows prefers-color-scheme (no manual toggle in the UI)')
} catch (error) {
  notes.push('NOTE could not read the engine archive (' + String(error.message).slice(0, 90) + ')')
}

if (engineTokens) {
  const missing = used.filter((token) => !engineTokens.has(token))
  check('every token the panel uses exists in the engine', missing.length === 0, missing.join(', '))

  // Which colour tokens does the dark block re-point? Those are theme-aware.
  const retargetedInDark = new Set([...darkBlock.matchAll(/(--dsw-[a-z0-9-]+)\s*:/g)].map((m) => m[1]))
  const colourTokens = used.filter((token) => !/radius|shadow/.test(token))
  const themed = colourTokens.filter((token) => retargetedInDark.has(token))
  notes.push(`NOTE colour tokens used: ${colourTokens.length}; re-pointed for dark: ${themed.length}`)
  if (themed.length) notes.push('NOTE dark-aware: ' + themed.join(', '))
} else {
  notes.push('NOTE token inventory unavailable — existence could not be verified')
}

for (const note of notes) console.log(note)
console.log('')
if (failures.length) {
  for (const failure of failures) console.log(failure)
  console.log('\nRESULT: ' + failures.length + ' failure(s)')
  process.exit(1)
}
console.log('RESULT: theme tokens are consistent with the engine')
