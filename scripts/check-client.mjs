// Regression harness for the client half plus the host's origin policy. Loads
// the real bundle with the same globals the shell provides, then drives its
// plugin through a stubbed Cordis context. It cannot judge pixels, but it does
// catch a broken bundle, a missing export, a wrong slot id, a crash inside
// apply(), and a broken address fallback.
//
//   node scripts/check-client.mjs

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const bundlePath = join(root, 'lib', 'client.js')

const failures = []
const notes = []

function check(label, condition, detail = '') {
  if (condition) notes.push('PASS ' + label)
  else failures.push('FAIL ' + label + (detail ? ' — ' + detail : ''))
}

// --- react stub -------------------------------------------------------------

const hookCalls = []
function makeReact() {
  const state = []
  let cursor = 0
  return {
    __reset() { cursor = 0 },
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useRef: (initial) => ({ current: initial }),
    useState: (initial) => {
      const slot = cursor++
      if (state[slot] === undefined) state[slot] = typeof initial === 'function' ? initial() : initial
      return [state[slot], (next) => { state[slot] = typeof next === 'function' ? next(state[slot]) : next }]
    },
    useEffect: (fn) => { hookCalls.push('useEffect'); fn() },
    useCallback: (fn) => fn,
  }
}

const React = makeReact()
const requireStub = (id) => {
  if (id === 'react') return React
  throw new Error('unexpected require("' + id + '") — the bundle must stay on the baseline modules')
}

function collectText(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) collectText(child, out); return out }
  if (typeof node === 'object') {
    for (const child of node.children || []) collectText(child, out)
  }
  return out
}

const payload = JSON.stringify({
  ok: true,
  distro: 'Ubuntu',
  distros: [{ name: 'Ubuntu', state: 'Running', version: 2, isDefault: true }],
  status: {
    running: true,
    pid: '4242',
    port: '19800',
    unit: 'dsh-web.service',
    managed: true,
    active: 'active',
    restarts: 3,
    version: '0.2.0-rc.2',
    url: 'http://127.0.0.1:19800/?token=abc',
  },
  projects: [{ name: 'radio', path: '/home/me/projects/radio', kind: 'node', git: true, modifiedAt: Math.floor(Date.now() / 1000) - 3600 }],
  aliases: { '/home/me/projects/radio': 'Radio Station' },
  configFiles: ['~/.dsh/settings.yaml'],
  defaultPort: 19800,
  apiOrigin: 'http://127.0.0.1:19387',
})

/**
 * Loads the bundle with fresh globals and returns what the panel produced.
 * `fetchImpl` receives the URL and must resolve like fetch; `pageOrigin` is the
 * document origin the shell would provide; `surface` picks which host slot the
 * plugin registers into.
 */
async function drivePanel(fetchImpl, pageOrigin = 'dsh-app://app', surface = null) {
  const loaded = []
  const fetchCalls = []
  const storage = new Map()

  globalThis.window = { __ModuleLoader__: { load: (spec) => loaded.push(spec) }, innerWidth: 1920, innerHeight: 1080 }
  if (surface) globalThis.window.__DSH_WSL_PROJECTS_SURFACE__ = surface
  globalThis.localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  }
  globalThis.location = { origin: pageOrigin, protocol: pageOrigin.split(':')[0] + ':' }
  globalThis.fetch = async (url, options) => {
    fetchCalls.push(String(url))
    return fetchImpl(String(url), options)
  }

  const source = await readFile(bundlePath, 'utf8')
  new Function(source)()

  const spec = loaded[0]
  if (!spec) throw new Error('the bundle did not register with the module loader')
  const plugin = spec.factory(requireStub)

  // --- drive apply()
  const registrations = []
  let overlayFactory = null
  const ctx = {
    logger: { warn: (...args) => notes.push('WARN ' + args.join(' ')), info: () => {} },
    get: (name) => (name === 'slots' ? {
      inject: (key, callback) => { registrations.push(['inject', key]); overlayFactory = callback },
      register: (declaration, component) => { registrations.push(['register', declaration, component]) },
    } : undefined),
    effect: (fn) => fn(),
  }

  let applyError = null
  try {
    plugin.apply(ctx)
  } catch (error) {
    applyError = error
  }
  if (typeof overlayFactory === 'function') overlayFactory()
  const registration = registrations.find((r) => r[0] === 'register')

  // --- render twice: empty, then with whatever the host answered
  const render = () => {
    React.__reset()
    return registration ? registration[2]({}) : null
  }
  let renderError = null
  let tree = null
  try {
    tree = render()
  } catch (error) {
    renderError = error
  }
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
  let secondError = null
  try {
    tree = render()
  } catch (error) {
    secondError = error
  }

  return {
    spec,
    plugin,
    registration,
    registrations,
    applyError,
    renderError,
    secondError,
    fetchCalls,
    text: collectText(tree).join(' | '),
  }
}

// --- default host: answers on the relative route ----------------------------

const okResponse = () => ({ ok: true, status: 200, text: async () => payload, json: async () => JSON.parse(payload) })

const healthy = await drivePanel(async () => okResponse())

check('bundle inlines no import statement', !/^\s*import\s/m.test(await readFile(bundlePath, 'utf8')))
check('loader received exactly one bundle', Boolean(healthy.spec))
check('bundle id is the package name', healthy.spec?.id === 'dsh-wsl-projects', String(healthy.spec?.id))
check('bundle exposes a factory', typeof healthy.spec?.factory === 'function')
check('factory returns a plugin object', healthy.plugin && typeof healthy.plugin === 'object')
check('plugin exports apply()', typeof healthy.plugin?.apply === 'function')
check("plugin injects the slots service", Array.isArray(healthy.plugin?.inject) && healthy.plugin.inject.includes('slots'),
  JSON.stringify(healthy.plugin?.inject))
check('apply() runs without throwing', !healthy.applyError, healthy.applyError ? String(healthy.applyError.message) : '')
check("apply() injects into the settings page", healthy.registrations.some((r) => r[0] === 'inject' && r[1] === 'settings.section'))
check('apply() registers a component', Boolean(healthy.registration))
check('registration targets settings.section', healthy.registration?.[1]?.name === 'settings.section', JSON.stringify(healthy.registration?.[1]))
check('registration carries an order', typeof healthy.registration?.[1]?.order === 'number')
check('registration labels the section', typeof healthy.registration?.[1]?.label === 'function' && healthy.registration[1].label() === 'WSL projects',
  JSON.stringify(healthy.registration?.[1]?.label?.()))
check('registration exposes a component function', typeof healthy.registration?.[2] === 'function')
check('panel renders without throwing', !healthy.renderError && !healthy.secondError,
  String(healthy.renderError?.message || healthy.secondError?.message || ''))
check('relative route is tried first', healthy.fetchCalls[0] === '/wsl-projects/api/state', JSON.stringify(healthy.fetchCalls.slice(0, 3)))

const text = healthy.text
check('docked panel renders its controls', text.includes('Distro') && text.includes('Project') && text.includes('Port'),
  text.slice(0, 220))
check('panel lists the reported project', text.includes('Radio Station'), text.slice(0, 260))
check('panel offers Start', text.includes('Start'))
check('panel offers Stop', text.includes('Stop'))
check('panel offers Restart', text.includes('Restart'))
check('panel reports the systemd unit', text.includes('dsh-web.service'), text.slice(0, 260))
check('panel reports a running instance', text.includes('running'), text.slice(0, 260))
check('panel shows the port it acts on', text.includes('19800'), text.slice(0, 260))
check('panel shows the host dsh version', text.includes('0.2.0-rc.2'), text.slice(0, 260))
check('panel links the token URL', text.includes('Open the WSL dsh UI'), text.slice(0, 260))
check('managed unit hides the create button', !text.includes('Create service'), text.slice(0, 260))
check('panel offers renaming a project', text.includes('Save name'), text.slice(0, 300))
check('docked panel has no overlay chrome', !text.includes('Collapse'), text.slice(0, 200))

// --- the floating variant is still available on request ---------------------

const floating = await drivePanel(async () => okResponse(), 'dsh-app://app', 'floating')
check('floating surface injects into shell.overlay',
  floating.registrations.some((r) => r[0] === 'inject' && r[1] === 'shell.overlay'))
check('floating surface targets shell.overlay', floating.registration?.[1]?.name === 'shell.overlay',
  JSON.stringify(floating.registration?.[1]))
check('floating surface keeps its window chrome', floating.text.includes('Collapse'), floating.text.slice(0, 200))
check('floating surface keeps its title bar', floating.text.includes('WSL · dsh projects'), floating.text.slice(0, 200))
check('floating surface shows the same data', floating.text.includes('dsh-web.service') && floating.text.includes('Radio Station'),
  floating.text.slice(0, 220))

// --- degraded host: the relative route fails, an absolute one answers -------

const degraded = await drivePanel(async (url) => {
  if (!url.startsWith('http')) throw new Error('Failed to fetch')
  if (url.includes(':3080')) return okResponse()
  return { ok: false, status: 404, text: async () => '<html>not here</html>', json: async () => { throw new Error('not json') } }
}, 'file://')

check('absolute fallback recovers the panel', degraded.text.includes('dsh-web.service') && degraded.text.includes('Radio Station'),
  degraded.text.slice(0, 220))
check('fallback walks the candidate addresses',
  degraded.fetchCalls.some((u) => u.startsWith('http://127.0.0.1:19387')) && degraded.fetchCalls.some((u) => u.startsWith('http://127.0.0.1:3080')),
  JSON.stringify(degraded.fetchCalls))
check('a non-JSON answer is not mistaken for the plugin', !degraded.text.includes('not here'), degraded.text.slice(0, 200))

// --- origin policy on the host routes ---------------------------------------

const hostSource = await readFile(join(root, 'lib', 'index.js'), 'utf8')
check('host refuses a foreign Origin', hostSource.includes('origin not allowed'))
check('host accepts the Desktop shell origin', hostSource.includes("'dsh-app://app'"))
check('host echoes the allowed origin', hostSource.includes('access-control-allow-origin'))

// --- report -----------------------------------------------------------------

for (const note of notes) console.log(note)
console.log('')
if (failures.length) {
  for (const failure of failures) console.log(failure)
  console.log('\nRESULT: ' + failures.length + ' failure(s)')
  process.exit(1)
}
console.log('RESULT: all client checks passed')
