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
// The script opens the app in headless Chrome, opens the WSL projects panel
// from its seat in the sidebar foot, waits until the panel reports the state
// of the real services, and captures the popover the way the readme presents
// it: a dark shot, a light shot, and a narrow one for small screens. The
// images land in docs/ (or the given directory) as panel-dark.png,
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
  // A first-run surface may sit on top; one Escape dismisses it.
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(600)
  await evaluate(`${TRIGGER}.click()`)
  // The panel reads the state of the services when it opens, and the state
  // asks the distribution, so the wait is for a reading that came back.
  for (let i = 0; i < 90; i += 1) {
    const text = (await evaluate(`${DIALOG} ? ${DIALOG}.innerText : ''`)) || ''
    if (/running|No service yet/.test(text)) break
    await sleep(1000)
  }
  const text = (await evaluate(`${DIALOG} ? ${DIALOG}.innerText : ''`)) || ''
  if (!/Services/.test(text)) throw new Error('the panel never reported its services: ' + text.slice(0, 200))
  await sleep(1500) // let the reading settle and the layout still
  return text
}

/** Captures the popover, with the seat it opened from just below it. */
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
  const shot = await send('Page.captureScreenshot', { format: 'png', clip })
  writeFileSync(join(outDir, name), Buffer.from(shot.data, 'base64'))
  console.log('saved ' + join('docs', name))
}

const darkText = await bootAndOpenPanel('dark')
console.log('panel (dark) reports: ' + darkText.split('\n').slice(0, 8).join(' | ').slice(0, 200))
await captureClip('panel-dark.png')

const lightText = await bootAndOpenPanel('light')
console.log('panel (light) reports: ' + lightText.split('\n').slice(0, 8).join(' | ').slice(0, 200))
await captureClip('panel-light.png')

// A narrow viewport, as a phone would show it; the popover re-anchors on the
// resize and fills the width it is given.
await send('Emulation.setDeviceMetricsOverride', {
  width: 410, height: 900, deviceScaleFactor: 2, mobile: false,
})
await sleep(1500)
await captureClip('panel-narrow.png')

ws.close()
child.kill()
await sleep(1000)
try { rmSync(profile, { recursive: true, force: true }) } catch { /* browser still holds it */ }
console.log('done: panel-dark.png, panel-light.png, panel-narrow.png in ' + outDir)
