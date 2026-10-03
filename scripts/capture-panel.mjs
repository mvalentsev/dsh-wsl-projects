// What the readme's panel images are: screenshots of the real panel, not a
// drawing of it.
//
//   node scripts/capture-panel.mjs <url> [output-dir]
//
// <url> is a dsh web app URL a browser can open — for example the printed URL
// of a throwaway server:
//
//   dsh --profile web --no-open --port 19444
//   node scripts/capture-panel.mjs 'http://127.0.0.1:19444/?token=…'
//
// The script opens the app in headless Chrome, walks the app's first-run
// dialogs away the way a user would — clicking the button that acknowledges
// each one — opens the WSL projects panel from its seat in the sidebar foot,
// waits until the panel reports the state of the real services, checks that
// nothing is sitting on top of the panel, hides everything that is not the
// panel or the seat it opened from, and captures the popover the way the
// readme presents it: a dark shot, a light shot, and a narrow one for small
// screens. The images land in docs/ (or the given directory) as panel-dark.png,
// panel-light.png and panel-narrow.png, overwriting what is there.
//
// A Chromium-based browser is looked up the way check-ui.mjs looks for one:
// UI_BROWSER, the usual install locations, then PATH.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const url = process.argv[2]
const outDir = process.argv[3] ? resolve(process.argv[3]) : join(root, 'docs')

if (!url || !/^https?:\/\//.test(url)) {
  console.error('usage: node scripts/capture-panel.mjs <url-of-a-dsh-web-app> [output-dir]')
  process.exit(1)
}

// The debugging protocol is spoken over a WebSocket, which became a Node
// global in Node 22; an older Node cannot drive the browser at all.
if (typeof WebSocket === 'undefined') {
  console.error('this Node has no WebSocket global to speak the debugging protocol on (Node 22+)')
  process.exit(1)
}

/** A Chromium-based browser, looked for rather than assumed. */
function findBrowser() {
  const candidates = [
    process.env.UI_BROWSER,
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean)
  return candidates.find((candidate) => existsSync(candidate)) || 'chrome'
}

const CHROME = findBrowser()
const port = 9600 + Math.floor(Math.random() * 300)
const profile = mkdtempSync(join(tmpdir(), 'dsh-shot-'))
const child = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank',
], { stdio: 'ignore', detached: false })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findTarget() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      const target = list.find((t) => t.type === 'page')
      if (target) return target
    } catch { /* chrome not up yet */ }
    await sleep(500)
  }
  throw new Error('no browser came up on the debugging port')
}

const target = await findTarget()
const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const send = (method, params = {}) => new Promise((resolve) => {
  const messageId = ++id
  pending.set(messageId, resolve)
  ws.send(JSON.stringify({ id: messageId, method, params }))
})
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) { pending.get(message.id)(message.result); pending.delete(message.id) }
})
await new Promise((resolve) => ws.addEventListener('open', resolve))
await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: 1280, height: 800, deviceScaleFactor: 2, mobile: false,
})

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true })
  return result?.result?.value
}

// The trigger in the sidebar foot, and the popover it opens.
const TRIGGER = "document.querySelector('button[title^=\"WSL projects\"]')"
const DIALOG = "document.querySelector('[role=dialog][aria-label=\"WSL projects\"]')"

/**
 * The button text that only acknowledges a dialog and nothing else. A first
 * capture shipped with a preview notice sitting over the panel because the
 * dialogs of a fresh profile never looked dismissable; this lists the words
 * a button may say for the capture to click it. Buttons that could sign in,
 * save or navigate are deliberately left unclicked.
 */
const ACKNOWLEDGE = /continue|later|skip|got it|close|dismiss|understand|^ok$|^done$|begin|start|продолжить|позже|пропустить|закрыть|понятно/i

/** Visible modals other than the WSL projects panel itself. */
async function foreignModals() {
  return (await evaluate(`(() => {
    const out = []
    for (const m of document.querySelectorAll('[role=dialog], [aria-modal="true"]')) {
      if (m.getAttribute('aria-label') === 'WSL projects') continue
      const rect = m.getBoundingClientRect()
      const style = getComputedStyle(m)
      if (rect.width < 4 || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue
      const buttons = [...m.querySelectorAll('button')].filter((b) => b.getClientRects().length > 0)
      out.push({
        label: String(m.getAttribute('aria-label') || m.innerText || '').replace(/\s+/g, ' ').slice(0, 90),
        buttons: buttons.map((b) => String(b.innerText || '').replace(/\s+/g, ' ').slice(0, 30)),
      })
    }
    return out
  })()`)) || []
}

/**
 * Walks the app's first-run dialogs away: the versioned preview notice every
 * fresh profile starts with, and whatever step follows it. Each is closed by
 * the button that acknowledges it; a dialog without such a button stops the
 * capture, because clicking blind through an unknown dialog is how a
 * screenshot ends up somewhere else entirely.
 */
async function dismissDialogs() {
  let closed = 0
  for (let round = 0; round < 10; round += 1) {
    const modals = await foreignModals()
    if (modals.length === 0) return closed
    const modal = modals[0]
    const pick = modal.buttons.find((label) => ACKNOWLEDGE.test(label))
    if (!pick) {
      throw new Error(`a dialog is open that no button safely closes: "${modal.label}" (buttons: ${modal.buttons.join(', ') || 'none'})`)
    }
    console.log(`closing a first-run dialog: ${modal.label.slice(0, 60)} [${pick}]`)
    await evaluate(`(() => {
      const modal = [...document.querySelectorAll('[role=dialog], [aria-modal="true"]')]
        .find((x) => x.getAttribute('aria-label') !== 'WSL projects' && x.getBoundingClientRect().width > 4)
      if (!modal) return false
      const button = [...modal.querySelectorAll('button')]
        .find((b) => new RegExp(${JSON.stringify(ACKNOWLEDGE.source)}, 'i').test(String(b.innerText || '')))
      if (!button) return false
      button.click()
      return true
    })()`)
    closed += 1
    await sleep(900)
  }
  throw new Error('first-run dialogs kept coming back')
}

/**
 * What the browser itself says is on top of the panel: the topmost element
 * at a grid of points over the popover. The first capture shipped a notice
 * overlaying the panel, and the pixels of the shot were the last place that
 * should have been the first to notice.
 */
async function coveredPoints() {
  return (await evaluate(`(() => {
    const d = ${DIALOG}
    if (!d) return [{ where: 'no panel' }]
    const r = d.getBoundingClientRect()
    const covered = []
    for (let fx = 0.1; fx <= 0.901; fx += 0.1) {
      for (let fy = 0.1; fy <= 0.901; fy += 0.1) {
        const x = r.left + r.width * fx
        const y = r.top + r.height * fy
        const hit = document.elementFromPoint(x, y)
        if (!hit || d === hit || d.contains(hit)) continue
        covered.push({ where: [Math.round(x), Math.round(y)], tag: hit.tagName, text: String(hit.innerText || '').replace(/\s+/g, ' ').slice(0, 60) })
      }
    }
    return covered.slice(0, 6)
  })()`)) || []
}

/**
 * Boots the app in one colour scheme and opens the panel. The scheme is
 * emulated before navigation, so the app resolves its `system` theme to the
 * one asked for from the first paint.
 */
async function bootAndOpenPanel(scheme) {
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: scheme }],
  })
  await send('Page.navigate', { url })
  for (let i = 0; i < 90; i += 1) {
    if (await evaluate(`Boolean(${TRIGGER})`)) break
    await sleep(1000)
  }
  if (!(await evaluate(`Boolean(${TRIGGER})`))) throw new Error('the sidebar seat never appeared')
  await dismissDialogs()
  await evaluate(`${TRIGGER}.click()`)
  // The panel's first reading takes seconds: it asks the distribution. Until
  // the answer lands, the footer says "dsh ?" and the lists are the
  // pre-reading empties — "No service yet" included, which once made this
  // wait stop on the empty panel and capture it. So the wait is for a
  // version the host actually answered with.
  for (let i = 0; i < 90; i += 1) {
    const text = (await evaluate(`${DIALOG} ? ${DIALOG}.innerText : ''`)) || ''
    if (!/dsh \?/.test(text)) break
    await sleep(1000)
  }
  const text = (await evaluate(`${DIALOG} ? ${DIALOG}.innerText : ''`)) || ''
  if (/dsh \?/.test(text)) throw new Error('the panel never finished its first reading: ' + text.slice(0, 200))
  if (!/Services/.test(text)) throw new Error('the panel never reported its services: ' + text.slice(0, 200))
  await sleep(1500) // let the reading settle and the layout still
  await assertUncovered()
  return text
}

/** Captures the popover, with the seat it opened from just below it. */
/**
 * Nothing but the panel and the seat it opened from is left to paint. Hiding
 * rather than removing keeps every measurement taken before it valid, and the
 * shot then depends on the panel alone: no sliver of the app around the frame,
 * no icon of a neighbour in the sidebar foot, no backdrop of a surface that
 * was there at the time.
 */
async function isolatePanel() {
  const hidden = await evaluate(`(() => {
    const keep = [${DIALOG}, ${TRIGGER}].filter(Boolean)
    if (keep.length === 0) return 0
    let hidden = 0
    for (const el of document.querySelectorAll('body *')) {
      if (keep.some((node) => node === el || node.contains(el) || el.contains(node))) continue
      if (el.style.visibility === 'hidden') continue
      el.style.visibility = 'hidden'
      hidden += 1
    }
    return hidden
  })()`)
  console.log('hid ' + hidden + ' elements outside the panel')
  await sleep(400) // let the styles land before the shutter opens
}

async function captureClip(name) {
  const rect = await evaluate(`(() => { const d = ${DIALOG}; if (!d) return null; const r = d.getBoundingClientRect();
    const t = ${TRIGGER}; const tr = t ? t.getBoundingClientRect() : null;
    return { x: r.x, y: r.y, w: r.width, h: tr ? (tr.bottom - r.y) : r.height, vh: window.innerHeight, vw: window.innerWidth } })()`)
  if (!rect) throw new Error('no panel to capture')
  const clip = {
    x: Math.max(0, rect.x - 8),
    y: Math.max(0, rect.y - 8),
    width: Math.min(rect.w + 16, rect.vw - Math.max(0, rect.x - 8)),
    height: Math.min(rect.h + 16, rect.vh - Math.max(0, rect.y - 8)),
    scale: 1,
  }
  await isolatePanel()
  const shot = await send('Page.captureScreenshot', { format: 'png', clip })
  writeFileSync(join(outDir, name), Buffer.from(shot.data, 'base64'))
  console.log('saved ' + join('docs', name))
}

/**
 * The panel must be the topmost thing where it is, at the moment of the shot.
 * A dialog that arrived late gets one chance to be walked away, and then the
 * capture fails with what it saw instead of shipping it.
 */
async function assertUncovered() {
  let covered = await coveredPoints()
  if (covered.length) {
    await dismissDialogs()
    await sleep(800)
    covered = await coveredPoints()
  }
  if (covered.length) {
    throw new Error('the panel is covered at capture time: ' + covered.map((c) => `${c.tag} "${c.text}" at ${c.where}`).join('; '))
  }
}

const darkText = await bootAndOpenPanel('dark')
console.log('panel (dark) reports: ' + darkText.split('\n').slice(0, 8).join(' | ').slice(0, 200))
await captureClip('panel-dark.png')

const lightText = await bootAndOpenPanel('light')
console.log('panel (light) reports: ' + lightText.split('\n').slice(0, 8).join(' | ').slice(0, 200))
await captureClip('panel-light.png')

// A narrow viewport, as a phone would show it; the popover re-anchors on the
// resize and fills the width it is given. The resize re-checks the coverage
// too: the anchor moves, and something could have arrived since the light
// shot.
await send('Emulation.setDeviceMetricsOverride', {
  width: 410, height: 900, deviceScaleFactor: 2, mobile: false,
})
await sleep(1500)
await assertUncovered()
await captureClip('panel-narrow.png')

ws.close()
child.kill()
await sleep(1000)
try { rmSync(profile, { recursive: true, force: true }) } catch { /* browser still holds it */ }
console.log('done: panel-dark.png, panel-light.png, panel-narrow.png in ' + outDir)
