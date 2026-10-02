// Manifest and packaging gate: the checks `dsh plugin add` performs are only
// available when a profile installs the package, so the same invariants are
// asserted here, offline, before a release.
//
//   node scripts/check-manifest.mjs

import { readFile, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const failures = []
const notes = []

function check(label, condition, detail = '') {
  if (condition) notes.push('PASS ' + label)
  else failures.push('FAIL ' + label + (detail ? ' — ' + detail : ''))
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

// --- identity ---------------------------------------------------------------

check('name is a valid npm name', /^[a-z0-9][a-z0-9._-]*$/.test(manifest.name || ''), String(manifest.name))
check('version is semver', /^\d+\.\d+\.\d+/.test(manifest.version || ''), String(manifest.version))
check('license is declared', Boolean(manifest.license), String(manifest.license))
check('description is present', Boolean(manifest.description))

// --- the dsh manifest, which the installer validates ------------------------

const dsh = manifest.dsh || {}
check('dsh.manifestVersion is 1', dsh.manifestVersion === 1, String(dsh.manifestVersion))

const isPath = (value) => typeof value === 'string' && value.trim().length > 0
const patches = dsh.bundle?.patch
check('dsh.bundle.patch is a path or a list of paths',
  isPath(patches) || (Array.isArray(patches) && patches.length > 0 && patches.every(isPath)),
  JSON.stringify(patches))

for (const patch of Array.isArray(patches) ? patches : [patches]) {
  if (!isPath(patch)) continue
  check('patch file exists: ' + patch, await exists(join(root, patch)), 'missing on disk')
}

check('dsh.client.platform is web', dsh.client?.platform === 'web', String(dsh.client?.platform))
check('dsh.client declares no bogus externals',
  dsh.client?.external === undefined || Array.isArray(dsh.client.external),
  JSON.stringify(dsh.client?.external))

// --- exports ----------------------------------------------------------------

const clientExport = manifest.exports?.['./client']
const clientPath = typeof clientExport === 'string' ? clientExport : clientExport?.default
check('exports["./client"] resolves to a file', isPath(clientPath) && await exists(join(root, clientPath)), String(clientPath))

const mainExport = manifest.exports?.['.']
const mainPath = typeof mainExport === 'string' ? mainExport : mainExport?.default
check('exports["."] resolves to a file', isPath(mainPath) && await exists(join(root, mainPath)), String(mainPath))
check('exports["./package.json"] is exposed', Boolean(manifest.exports?.['./package.json']))

// The client bundle is served verbatim, so it must be a plain browser script:
// no bare import statement, and it registers through the shell's loader.
if (isPath(clientPath)) {
  const bundle = await readFile(join(root, clientPath), 'utf8')
  check('client bundle has no import statement', !/^\s*import\s/m.test(bundle))
  check('client bundle registers with __ModuleLoader__', bundle.includes('window.__ModuleLoader__.load'))
  check('client bundle requires no non-baseline module',
    !/require\(\s*['"](?!react['"])/.test(bundle),
    'only react may be required')
}

// --- no peer ranges that the installer would refuse -------------------------

const peers = manifest.peerDependencies || {}
const dshPeers = Object.entries(peers).filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
check('no @deepseek-ai/dsh-* peer declarations', dshPeers.length === 0,
  'a peer range outside the running line makes the installer reject the package: ' + JSON.stringify(dshPeers))

// --- packaging --------------------------------------------------------------

check('files list is present', Array.isArray(manifest.files) && manifest.files.length > 0)
for (const entry of manifest.files || []) {
  check('files entry exists: ' + entry, await exists(join(root, entry)), 'listed but missing on disk')
}
check('scripts stay out of the package', !(manifest.files || []).some((f) => f.startsWith('scripts')))
check('lib is packaged', (manifest.files || []).includes('lib'))
check('the patch file is packaged', (manifest.files || []).some((f) => 'cordis.patch.yml'.endsWith(f) || f === 'cordis.patch.yml'))

for (const required of ['README.md', 'LICENSE']) {
  check(required + ' is packaged', (manifest.files || []).includes(required))
}

// --- report -----------------------------------------------------------------

for (const note of notes) console.log(note)
console.log('')
if (failures.length) {
  for (const failure of failures) console.log(failure)
  console.log('\nRESULT: ' + failures.length + ' failure(s)')
  process.exit(1)
}
console.log('RESULT: manifest and packaging checks passed')
