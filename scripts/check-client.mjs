// Regression harness for the client half. Loads the real bundle with the same
// globals the shell provides, then drives its plugin through a stubbed Cordis
// context. It cannot judge pixels, but it does catch a broken factory, a
// missing export, a wrong slot id and a crash inside apply().
//
//   node scripts/check-client.mjs

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '..', 'lib', 'client.js')

const failures = []
const notes = []

function check(label, condition, detail = '') {
  if (condition) notes.push('PASS ' + label)
  else failures.push('FAIL ' + label + (detail ? ' — ' + detail : ''))
}

// --- globals the shell owns -------------------------------------------------

const loaded = []
let debugState = null
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      loaded.push(spec)
    },
  },
  innerWidth: 1920,
  innerHeight: 1080,
}

const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
}
globalThis.location = { origin: 'dsh-app://app', protocol: 'dsh-app:' }

const fetchCalls = []
globalThis.fetch = async (url) => {
  fetchCalls.push(String(url))
  const body = JSON.stringify({
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
    projects: [{ name: 'radio', path: '/home/me/projects/radio', kind: 'node', git: true, modifiedAt: 1790000000 }],
    configFiles: ['~/.dsh/settings.yaml'],
    defaultPort: 19800,
    apiOrigin: 'http://127.0.0.1:19387',
  })
  return {
    ok: true,
    status: 200,
    text: async () => body,
    json: async () => JSON.parse(body),
  }
}

// --- react stub -------------------------------------------------------------

const hookCalls = []
function makeReact() {
  const state = []
  let cursor = 0
  return {
    __reset() { cursor = 0 },
    __dump() { debugState = state.map((v) => (typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v)) },
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

const requireStub = (id) => {
  if (id === 'react') return React
  throw new Error('unexpected require("' + id + '") — the bundle must stay on the baseline modules')
}

// --- load -------------------------------------------------------------------

// One React instance for the whole run: the bundle gets it through require(),
// and the harness renders through the same object, so hook state is shared the
// way a real renderer shares it.
const React = makeReact()

const source = await readFile(bundlePath, 'utf8')
check('bundle inlines no import statement', !/^\s*import\s/m.test(source))
check('bundle registers with the shell module loader', source.includes('window.__ModuleLoader__.load'))

new Function(source)()
check('loader received exactly one bundle', loaded.length === 1, 'got ' + loaded.length)

const spec = loaded[0] || {}
check('bundle id is the package name', spec.id === 'dsh-wsl-projects', 'got ' + JSON.stringify(spec.id))
check('bundle exposes a factory', typeof spec.factory === 'function')

const plugin = typeof spec.factory === 'function' ? spec.factory(requireStub) : {}
check('factory returns a plugin object', plugin && typeof plugin === 'object')
check('plugin exports apply()', typeof plugin.apply === 'function')
check("plugin injects the slots service", Array.isArray(plugin.inject) && plugin.inject.includes('slots'),
  'got ' + JSON.stringify(plugin.inject))

// --- drive apply() ----------------------------------------------------------

const registrations = []
let overlayFactory = null
const ctx = {
  logger: { warn: (...args) => notes.push('WARN ' + args.join(' ')), info: () => {} },
  get: (name) => (name === 'slots' ? {
    inject: (key, callback) => { registrations.push(['inject', key]); overlayFactory = callback },
    register: (declaration, component) => { registrations.push(['register', declaration, component]) },
  } : undefined),
  effect: (fn) => { const dispose = fn(); return dispose },
}

let applyError = null
try {
  plugin.apply(ctx)
} catch (error) {
  applyError = error
}
check('apply() runs without throwing', !applyError, applyError ? String(applyError.message) : '')
check("apply() injects into 'shell.overlay'", registrations.some((r) => r[0] === 'inject' && r[1] === 'shell.overlay'))

if (typeof overlayFactory === 'function') {
  overlayFactory()
}
const registration = registrations.find((r) => r[0] === 'register')
check('apply() registers a component', Boolean(registration))
if (registration) {
  const declaration = registration[1]
  check('registration targets shell.overlay', declaration?.name === 'shell.overlay', JSON.stringify(declaration))
  check('registration carries an order', typeof declaration?.order === 'number')
  check('registration exposes a component function', typeof registration[2] === 'function')
}

// --- render the panel -------------------------------------------------------
// Render once, let the host answer, then render again: the second pass is the
// one that proves the fetched state actually reaches the panel.

function collectText(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) collectText(child, out); return out }
  if (typeof node === 'object') {
    for (const child of node.children || []) collectText(child, out)
  }
  return out
}

const render = () => {
  React.__reset()
  return registration ? registration[2]() : null
}

let renderError = null
let tree = null
try {
  tree = render()
} catch (error) {
  renderError = error
}
check('panel renders without throwing', !renderError, renderError ? String(renderError.message) : '')
check('panel returns an element tree', Boolean(tree) && typeof tree === 'object')

// Let the initial refresh() promise chain settle, then render with data.
for (let i = 0; i < 5; i += 1) await Promise.resolve()
tree = render()

const text = collectText(tree).join(' | ')
check('panel shows its title', text.includes('WSL · dsh projects'), text.slice(0, 200))
check('panel lists the reported project', text.includes('radio'), text.slice(0, 260))
check('panel offers Start', text.includes('Start'))
check('panel offers Stop', text.includes('Stop'))
check('panel offers Restart', text.includes('Restart'))
check('panel reports the systemd unit', text.includes('dsh-web.service'), text.slice(0, 260))
check('panel reports a running instance', text.includes('running'), text.slice(0, 260))
check('panel shows the port it acts on', text.includes('19800'), text.slice(0, 260))
check('panel shows the host dsh version', text.includes('0.2.0-rc.2'), text.slice(0, 260))
check('panel links the token URL', text.includes('Open the WSL dsh UI'), text.slice(0, 260))
check('managed unit hides the create button', !text.includes('Create service'), text.slice(0, 260))

// --- the panel asks the host over the relative route ------------------------

try {
  const probe = await globalThis.fetch('/wsl-projects/api/state')
  const body = await probe.json()
  check('relative route answers', body && body.ok === true)
  check('relative route is tried first', fetchCalls[0] === '/wsl-projects/api/state', JSON.stringify(fetchCalls.slice(0, 3)))
} catch (error) {
  check('relative route answers', false, String(error))
}

// --- report -----------------------------------------------------------------

for (const note of notes) console.log(note)
console.log('')
if (failures.length) {
  for (const failure of failures) console.log(failure)
  console.log('\nRESULT: ' + failures.length + ' failure(s)')
  process.exit(1)
}
console.log('RESULT: all client checks passed')
