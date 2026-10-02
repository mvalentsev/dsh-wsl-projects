// Guards against the class of bug that shipped once: the panel styled itself
// with tokens the engine does not define, so the literal fallbacks (a light
// #ffffff card, near-black text) landed on a dark theme.
//
//   node scripts/check-theme-tokens.mjs [path-to-app.asar]
//
// The token inventory is read from the installed engine. Without a readable
// archive the check reports that it could not run rather than passing quietly.

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

// Every token the panel asks for.
const used = [...new Set([...bundle.matchAll(/--dsw-[a-z0-9-]+/g)].map((m) => m[0]))].sort()

check('the bundle uses theme tokens at all', used.length > 0)

// Tokens must be referenced bare. A literal fallback inside var() is how a
// light-theme colour survives into a dark theme.
const withFallback = [...bundle.matchAll(/var\((--dsw-[a-z0-9-]+)\s*,\s*([^)]+)\)/g)]
  .filter((m) => /#|rgb|rgba|hsl/i.test(m[2]))
check('no colour literal is used as a token fallback', withFallback.length === 0,
  withFallback.map((m) => `${m[1]} -> ${m[2].trim()}`).join('; '))

let inventory = null
try {
  const archiveText = await readFile(archive, 'utf8')
  inventory = new Set([...archiveText.matchAll(/--dsw-[a-z0-9-]+/g)].map((m) => m[0]))
} catch (error) {
  notes.push('NOTE could not read the engine archive (' + String(error.message).slice(0, 80) + ')')
}

if (inventory) {
  const missing = used.filter((token) => !inventory.has(token))
  check('every token the panel uses exists in the engine', missing.length === 0, missing.join(', '))
  notes.push(`NOTE engine defines ${inventory.size} dsh tokens; the panel uses ${used.length}`)
} else {
  notes.push('NOTE token inventory unavailable — existence could not be verified')
}

// A radius or shadow token is optional, so a plain fallback is acceptable
// there; only colours are constrained.
const radiusFallbacks = [...bundle.matchAll(/var\((--dsw-(?:radius|shadow)[a-z0-9-]*)\s*,\s*([^)]+)\)/g)]
notes.push('NOTE radius/shadow fallbacks: ' + (radiusFallbacks.length || 'none'))

for (const note of notes) console.log(note)
console.log('')
if (failures.length) {
  for (const failure of failures) console.log(failure)
  console.log('\nRESULT: ' + failures.length + ' failure(s)')
  process.exit(1)
}
console.log('RESULT: theme tokens are consistent with the engine')
