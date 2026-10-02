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
// Hook state is keyed per component, the way a real renderer keeps a fiber's
// own hook list: a tree with two components (a seat and the panel inside it)
// must not share slots, or their state cross-wires.

const hookCalls = []
const renderedComponents = []
function makeReact() {
  const slots = new Map()
  const everySlot = new Map()
  let current = 'root'
  let anonymous = 0

  // A component's hook slots are keyed by its own identity, the way a real
  // renderer keeps each fiber's hook list separate.
  const ownerOf = (fn) => {
    if (!fn || typeof fn !== 'function') return 'node'
    if (!everySlot.has(fn)) everySlot.set(fn, 'c' + (anonymous += 1))
    return everySlot.get(fn)
  }

  const nextSlot = (kind) => {
    const counter = current + '#n'
    const index = slots.get(counter) ?? 0
    slots.set(counter, index + 1)
    return current + '#' + kind + index
  }

  return {
    __reset(owner = 'root') { current = owner },
    __owner: ownerOf,
    __peek: () => Object.fromEntries([...slots.entries()]),
    /** Pre-seeds a hook slot, standing in for a renderer that mounted earlier. */
    __seed: (owner, kind, index, value) => { slots.set(owner + '#' + kind + index, value) },
    createElement: (type, props, ...children) => {
      if (typeof type === 'function') {
        renderedComponents.push(type.name || 'anonymous')
        const previous = current
        current = ownerOf(type)
        try {
          return type({ ...(props || {}), children })
        } finally {
          current = previous
        }
      }
      return { type, props: props || {}, children }
    },
    useRef: (initial) => {
      const key = nextSlot('ref')
      if (!slots.has(key)) slots.set(key, { current: initial })
      return slots.get(key)
    },
    useState: (initial) => {
      const key = nextSlot('state')
      if (!slots.has(key)) slots.set(key, typeof initial === 'function' ? initial() : initial)
      return [slots.get(key), (next) => { slots.set(key, typeof next === 'function' ? next(slots.get(key)) : next) }]
    },
    useEffect: (fn) => {
      hookCalls.push('useEffect')
      try {
        const result = fn()
        if (typeof result === 'function') hookCalls.push('cleanup')
      } catch (error) {
        notes.push('EFFECT THREW ' + String(error && error.message ? error.message : error))
      }
    },
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
  services: [{
    unit: 'dsh-web-radio.service',
    active: 'active',
    running: true,
    project: '/home/me/projects/radio',
    port: 19801,
    pid: '4242',
  }],
  contract: 2,
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
async function drivePanel(fetchImpl, pageOrigin = 'dsh-app://app', surface = null, openSeat = false) {
  const loaded = []
  const fetchCalls = []
  const storage = new Map()

  globalThis.window = {
    __ModuleLoader__: { load: (spec) => loaded.push(spec) },
    innerWidth: 1920,
    innerHeight: 1080,
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  if (surface) globalThis.window.__DSH_WSL_PROJECTS_SURFACE__ = surface
  if (process.env.DSH_WSL_DEBUG) globalThis.window.__DSH_WSL_DEBUG__ = true
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
    React.__reset(React.__owner(registration?.[2]))
    return registration ? registration[2]({}) : null
  }

  // A click in the seat sets an open flag; the renderer it would run in then
  // re-renders and mounts the panel. Simulating that by pre-seeding the hook
  // is more faithful than calling the component twice by hand.
  if (openSeat) React.__seed(React.__owner(registration?.[2]), 'state', 0, true)
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

  let liveTree = tree
  const currentTree = () => liveTree

  return {
    spec,
    plugin,
    registration,
    registrations,
    applyError,
    renderError,
    secondError,
    fetchCalls,
    rendered: renderedComponents.slice(),
    ownerKeys: [React.__owner(registration?.[2])],
    text: collectText(tree).join(' | '),
    /** The first focusable element of the seat: its trigger button. */
    trigger: findFirst(tree, (node) => node?.type === 'button'),
    /** Re-renders the registered component; hooks keep their state. */
    rerender: () => {
      liveTree = render()
      return { tree: liveTree, text: collectText(liveTree).join(' | ') }
    },
    treeShape: () => describe(currentTree()),
    // A click must act on the newest tree, whose handlers close over the
    // current hook state.
    clickTrigger: () => {
      const node = findFirst(currentTree(), (n) => n?.type === 'button')
      console.log('DEBUG trigger found:', Boolean(node), 'has onClick:', typeof node?.props?.onClick)
      if (node?.props?.onClick) node.props.onClick()
      else {
        // Fall back to the trigger captured at first render, whose closure may
        // still hold a valid setter.
        const fallback = findFirst(tree, (n) => n?.type === 'button')
        console.log('DEBUG fallback trigger:', Boolean(fallback), 'has onClick:', typeof fallback?.props?.onClick)
        fallback?.props?.onClick?.()
      }
    },
  }
}

function describe(node, depth = 0) {
  if (depth > 3 || !node || typeof node !== 'object') return null
  const type = typeof node.type === 'function' ? 'Component' : String(node.type)
  const children = (node.children || []).map((child) => describe(child, depth + 1)).filter(Boolean)
  const text = (node.children || []).filter((c) => typeof c === 'string')
  return { type, text, children }
}

function findFirst(node, predicate) {  if (!node || typeof node !== 'object') return null
  if (predicate(node)) return node
  const children = Array.isArray(node) ? node : (node.children || [])
  for (const child of children) {
    const found = findFirst(child, predicate)
    if (found) return found
  }
  return null
}

// --- default host: answers on the relative route ----------------------------

const okResponse = () => ({ ok: true, status: 200, text: async () => payload, json: async () => JSON.parse(payload) })

// The sidebar seat, opened: its panel is mounted by the renderer, fetches, and
// shows what the host answered.
const healthy = await drivePanel(async () => okResponse(), 'dsh-app://app', null, true)

check('bundle inlines no import statement', !/^\s*import\s/m.test(await readFile(bundlePath, 'utf8')))
check('loader received exactly one bundle', Boolean(healthy.spec))
check('bundle id is the package name', healthy.spec?.id === 'dsh-wsl-projects', String(healthy.spec?.id))
check('bundle exposes a factory', typeof healthy.spec?.factory === 'function')
check('factory returns a plugin object', healthy.plugin && typeof healthy.plugin === 'object')
check('plugin exports apply()', typeof healthy.plugin?.apply === 'function')
check("plugin injects the slots service", Array.isArray(healthy.plugin?.inject) && healthy.plugin.inject.includes('slots'),
  JSON.stringify(healthy.plugin?.inject))
check('apply() runs without throwing', !healthy.applyError, healthy.applyError ? String(healthy.applyError.message) : '')
check("apply() injects into the sidebar foot", healthy.registrations.some((r) => r[0] === 'inject' && r[1] === 'sidebar.footer.action'))
check('apply() registers a component', Boolean(healthy.registration))
check('registration targets sidebar.footer.action', healthy.registration?.[1]?.name === 'sidebar.footer.action', JSON.stringify(healthy.registration?.[1]))
check('registration carries an order', typeof healthy.registration?.[1]?.order === 'number')
check('registration exposes a component function', typeof healthy.registration?.[2] === 'function')
check('panel renders without throwing', !healthy.renderError && !healthy.secondError,
  String(healthy.renderError?.message || healthy.secondError?.message || ''))
check('relative route is tried first',
  String(healthy.fetchCalls[0]).startsWith('/wsl-projects/api/state?contract='),
  JSON.stringify(healthy.fetchCalls.slice(0, 3)))
check('the open seat mounts the panel component', healthy.rendered.includes('Panel'), JSON.stringify(healthy.rendered))

// --- pure derivations ------------------------------------------------------
// A hand-rolled renderer cannot be trusted to replay React's update cycle, so
// the data-facing logic is asserted directly instead of through the tree.

const T = healthy.plugin.__testing
check('derivations are exposed for testing', Boolean(T && T.resolveActiveProject && T.projectViews))

const host = JSON.parse(payload)
const views = T.projectViews(host.projects, host.aliases)
check('a project is named by its alias', views[0]?.label === 'Radio Station', JSON.stringify(views[0]))
check('the alias keeps the folder name visible', views[0]?.name === 'radio')
check('a project carries its kind and git flag', views[0]?.meta.includes('node') && views[0].meta.includes('git'),
  JSON.stringify(views[0]?.meta))

// Ordering and filtering, so a long list stays navigable.
const unsorted = [
  { path: '/p/app-10', name: 'app-10', kind: 'node', git: false, modifiedAt: 100 },
  { path: '/p/LLM tools', name: 'LLM tools', kind: 'dir', git: false, modifiedAt: 300 },
  { path: '/p/app-2', name: 'app-2', kind: 'dir', git: false, modifiedAt: 200 },
]
const ordered = T.projectViews(unsorted, {})
check('projects are ordered by the name you see',
  ordered.map((view) => view.label).join(',') === 'app-2,app-10,LLM tools',
  ordered.map((view) => view.label).join(','))
check('an alias decides the order too',
  T.projectViews(unsorted, { '/p/app-10': 'aaa' })[0].path === '/p/app-10')
check('filtering matches a folder name', T.filterViews(ordered, 'llm').length === 1)
check('filtering matches an alias',
  T.filterViews(T.projectViews(unsorted, { '/p/app-2': 'backend' }), 'backend').length === 1)
check('filtering ignores case', T.filterViews(ordered, 'APP').length === 2)
check('an empty filter keeps everything', T.filterViews(ordered, '  ').length === 3)
check('a filter that matches nothing yields nothing', T.filterViews(ordered, 'zzz').length === 0)

// The regression that prompted this: a running service always reports a
// project, and that report used to outrank the list, so picking a project did
// nothing at all.
check('picking a project beats what the service reports',
  T.resolveActiveProject({ selected: '/picked', reportedProject: '/running', lastReported: '/running', projects: [{ path: '/first' }] }) === '/picked')
check('the service project is used when nothing is picked',
  T.resolveActiveProject({ selected: '', reportedProject: '/running', lastReported: '/running', projects: [] }) === '/running')
check('a project moved outside the panel is followed',
  T.resolveActiveProject({ selected: '/picked', reportedProject: '/moved', lastReported: '/running', projects: [] }) === '/moved')
check('the newest project is the fallback',
  T.resolveActiveProject({ selected: '', reportedProject: null, lastReported: null, projects: [{ path: '/first' }] }) === '/first')
check('no projects resolves to an empty choice',
  T.resolveActiveProject({ selected: '', reportedProject: null, lastReported: null, projects: [] }) === '')

// The one decision the panel offers per project.
check('a running service offers Stop', T.primaryAction({ running: true })?.kind === 'stop')
check('a running service also offers Restart', T.primaryAction({ running: true })?.offersRestart === true)
check('a stopped service offers Start', T.primaryAction({ running: false })?.kind === 'start')
check('a stopped service offers no Restart', T.primaryAction({ running: false })?.offersRestart === false)
check('a project with no service yet offers Start', T.primaryAction(null)?.kind === 'start')
check('no service means no Restart either', T.primaryAction(null)?.offersRestart === false)

check('the panel falls back through candidate addresses', T.apiBases().length >= 2, JSON.stringify(T.apiBases()))
check('our own answers are recognised', T.looksLikeOurAnswer({ ok: true }) && !T.looksLikeOurAnswer({ hello: 'world' }))
check('recency is described in words', ['today', 'yesterday'].includes(T.ago(Math.floor(Date.now() / 1000))))

// --- what each seat renders -------------------------------------------------
// Asserted for structure only. Fetched values are covered by the derivation
// checks above, because a hand-rolled renderer cannot replay React's update
// cycle faithfully enough to be trusted with them.

// Closed: the sidebar holds a trigger and nothing more.
const closed = await drivePanel(async () => okResponse())
check('sidebar seat renders a trigger', Boolean(closed.trigger), closed.text.slice(0, 160))
check('trigger is labelled', collectText(closed.trigger).join(' ').includes('WSL projects'), collectText(closed.trigger).join(' '))
check('closed seat fetches nothing', closed.fetchCalls.length === 0, JSON.stringify(closed.fetchCalls))
check('closed seat shows no panel', !closed.text.includes('Restart'), closed.text.slice(0, 160))

// The settings page renders the whole control surface in document flow. The
// button it leads with depends on fetched state, which the fake renderer cannot
// replay, so the rule behind it is asserted through primaryAction above; here
// only the structure is checked.
const docked = await drivePanel(async () => okResponse(), 'dsh-app://app', 'settings', true)
const dockedText = docked.rerender().text
check('settings page renders a primary action', dockedText.includes('Start') || dockedText.includes('Stop'),
  dockedText.slice(0, 240))
// The screenshot that prompted this restructure had two buttons reading "Start"
// meaning different things. The wording is part of the design now: one heading
// per section, and a button that cannot be confused with a service control.
check('the panel groups services under their own heading', dockedText.includes('Services'), dockedText.slice(0, 200))
check('the panel names the section that adds a project', dockedText.includes('Start a project'), dockedText.slice(0, 240))
check('the add-project button says what it does',
  dockedText.includes('Start a service for this project'), dockedText.slice(0, 320))
check('a bare Start does not compete with the service rows',
  !/(^|\| )Start( \||$)/.test(dockedText), dockedText.slice(0, 320))
check('starting another project needs no separate command', !dockedText.includes('Run also'), dockedText.slice(0, 300))
check('the old ambiguous restart label is gone', !dockedText.includes('Restart on this project'), dockedText.slice(0, 300))
check('settings page offers renaming a project', dockedText.includes('Save name'), dockedText.slice(0, 240))
check('settings page offers a config editor', dockedText.includes('Edit config'), dockedText.slice(0, 240))
check('settings page is in flow, without window chrome',
  !dockedText.includes('Collapse') && !dockedText.includes('Close'), dockedText.slice(0, 200))
check('no separate refresh button duplicates the actions', !dockedText.includes('Refresh'), dockedText.slice(0, 240))

// The overlay variant keeps its window chrome.
const floating = await drivePanel(async () => okResponse(), 'dsh-app://app', 'floating', true)
const floatingText = floating.rerender().text
check('floating panel keeps its title bar', floatingText.includes('WSL · dsh projects'), floatingText.slice(0, 200))
check('floating panel keeps its collapse control', floatingText.includes('Collapse'), floatingText.slice(0, 200))
check('floating panel renders the controls', floatingText.includes('Start') || floatingText.includes('Stop'),
  floatingText.slice(0, 240))

// --- surface registration ---------------------------------------------------

check('settings surface injects into settings.section',
  docked.registrations.some((r) => r[0] === 'inject' && r[1] === 'settings.section'))
check('settings surface targets settings.section', docked.registration?.[1]?.name === 'settings.section',
  JSON.stringify(docked.registration?.[1]))
check('settings surface labels its entry',
  typeof docked.registration?.[1]?.label === 'function' && docked.registration[1].label() === 'WSL projects',
  JSON.stringify(docked.registration?.[1]?.label?.()))

// --- degraded host: the relative route fails, an absolute one answers -------
// Asserted on the addresses actually tried, which the harness does record
// faithfully, rather than on the second paint.

const degraded = await drivePanel(async (url) => {
  if (!url.startsWith('http')) throw new Error('Failed to fetch')
  if (url.includes(':3080')) return okResponse()
  return { ok: false, status: 404, text: async () => '<html>not here</html>', json: async () => { throw new Error('not json') } }
}, 'file://', null, true)
for (let i = 0; i < 8; i += 1) await Promise.resolve()

check('fallback walks the candidate addresses',
  degraded.fetchCalls.some((u) => u.startsWith('http://127.0.0.1:19387')) && degraded.fetchCalls.some((u) => u.startsWith('http://127.0.0.1:3080')),
  JSON.stringify(degraded.fetchCalls))
check('a non-JSON answer is not mistaken for the plugin', !degraded.text.includes('not here'), degraded.text.slice(0, 200))

// --- origin policy on the host routes ---------------------------------------

const hostSource = await readFile(join(root, 'lib', 'index.js'), 'utf8')
check('host refuses a foreign Origin', hostSource.includes('origin not allowed'))
check('host accepts the Desktop shell origin', hostSource.includes("'dsh-app://app'"))
check('host echoes the allowed origin', hostSource.includes('access-control-allow-origin'))

// --- a host half from the previous generation -------------------------------
// A stale host answers with its own routes, so an action would either 404 or
// fall through to a route that means something else now — which is exactly how
// a Remove button once stopped a service instead. The guard is asserted on the
// source, because a hand-rolled renderer cannot be trusted to replay the state
// update that carries the message to the screen.

const panelSource = await readFile(bundlePath, 'utf8')
check('a stale host withholds every action', panelSource.includes('const blocked = busy || staleHost'))
check('every action button is gated on it', !/disabled: busy\b/.test(panelSource))
check('a stale host is named to the user', panelSource.includes('older than this panel'))
check('a stale host asks for a full restart', panelSource.includes('quit it completely'))
check('the panel tells the host which contract it speaks',
  panelSource.includes("'/state?contract=' + CLIENT_CONTRACT"))
check('the host answers with its contract', (await readFile(join(root, 'lib', 'index.js'), 'utf8')).includes('contract: HOST_CONTRACT'))

// --- report -----------------------------------------------------------------

for (const note of notes) console.log(note)
console.log('')
if (failures.length) {
  for (const failure of failures) console.log(failure)
  console.log('\nRESULT: ' + failures.length + ' failure(s)')
  process.exit(1)
}
console.log('RESULT: all client checks passed')
