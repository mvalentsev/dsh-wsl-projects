// Do the readme's images keep the promises their markup makes?
//
//   node scripts/check-assets.mjs
//
// The readme presents every image as a <picture> with three shapes: a light
// variant, a dark variant, and a narrow one for small screens. This check
// reads those blocks out of the readme and loads each file in a real browser:
//
//   every file the readme names exists and loads;
//   each group has all three shapes, in the reference order — narrow first,
//     then dark, then the light <img>;
//   the dark variant of a group renders darker than the light one, so a
//     reader in either theme gets an image meant for that theme;
//   a narrow SVG follows the colour scheme itself, from the media query in
//     its own <style>, so the one narrow file serves both themes.
//
// A Chromium-based browser is looked up the way check-ui.mjs looks for one:
// UI_BROWSER, the usual install locations, then PATH.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

let failures = 0
const check = (ok, msg) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + msg)
  if (!ok) failures += 1
}

// ------------------------------------------------------- what the readme says

const readme = await readFile(join(root, 'README.md'), 'utf8')
const blocks = [...readme.matchAll(/<picture>[\s\S]*?<\/picture>/g)].map((m) => m[0])
check(blocks.length === 3, 'the readme presents three pictures (found ' + blocks.length + ')')

const groups = []
for (const block of blocks) {
  const sources = [...block.matchAll(/<source\s+media="([^"]+)"\s+srcset="([^"]+)">/g)]
    .map((m) => ({ media: m[1], srcset: m[2] }))
  const img = block.match(/<img\s+[^>]*>/)?.[0] || ''
  const src = img.match(/src="([^"]+)"/)?.[1] || ''
  const alt = img.match(/alt="([^"]*)"/)?.[1] || ''
  groups.push({ sources, src, alt })
}

for (const [index, group] of groups.entries()) {
  const label = 'picture ' + (index + 1) + ' (' + (group.src || 'no image') + ')'
  const narrow = group.sources.find((s) => /max-width:\s*600px/.test(s.media))
  const dark = group.sources.find((s) => /prefers-color-scheme:\s*dark/.test(s.media))
  check(Boolean(narrow), label + ' offers a narrow source for small screens')
  check(Boolean(dark), label + ' offers a dark source')
  check(Boolean(group.src), label + ' falls back to a light image')
  check(group.alt.trim().length > 0, label + ' says what it shows (alt text)')
  check(group.sources.length === 2, label + ' carries exactly the two sources (found ' + group.sources.length + ')')
  for (const file of [narrow?.srcset, dark?.srcset, group.src]) {
    if (file) check(existsSync(join(root, file)), 'the file exists: ' + file)
  }
  group.files = { narrow: narrow?.srcset, dark: dark?.srcset, light: group.src }
}

if (failures) {
  console.log(failures === 0 ? '' : `\nRESULT: ${failures} failure(s) — the markup is wrong, no point rendering`)
  process.exit(1)
}

// ------------------------------------------------------------- what it shows

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

// A page that loads one image and reports the luminance it renders as. The
// image is addressed by an absolute file URL, so the harness can live in a
// temporary directory while the images stay in docs/. The load races a timer:
// a browser that holds the load back neither succeeds nor fails, and an
// answer that never comes is worth more than a hang.
const HARNESS = `<!doctype html><meta charset="utf-8"><canvas id="c"></canvas><script>
window.__done = Promise.race([
  new Promise((resolve) => {
    const src = new URLSearchParams(location.search).get('img')
    const img = new Image()
    img.onload = () => {
      const c = document.getElementById('c')
      c.width = img.naturalWidth; c.height = img.naturalHeight
      const ctx = c.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(img, 0, 0)
      const d = ctx.getImageData(0, 0, c.width, c.height).data
      let sum = 0, count = 0
      for (let i = 0; i < d.length; i += 4) {
        sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; count += 1
      }
      resolve({ ok: true, width: c.width, height: c.height, mean: sum / count })
    }
    img.onerror = () => resolve({ ok: false, error: 'the image did not load' })
    img.src = src
  }),
  new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: 'the image never answered' }), 10000)),
])
</script>`

const profile = mkdtempSync(join(tmpdir(), 'dsh-assets-'))
const harnessPath = join(profile, 'harness.html')
writeFileSync(harnessPath, HARNESS)
const harnessUrl = pathToFileURL(harnessPath).href

const CHROME = findBrowser()
const port = 9700 + Math.floor(Math.random() * 200)
const child = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
  // The harness page is a file: URL that shows images from docs/, also as
  // file: URLs — a load the browser holds back without this flag.
  '--allow-file-access-from-files',
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

try {
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
  await send('Runtime.enable')
  await send('Page.enable')

  /**
   * The mean luminance a file renders with, under one colour scheme. SVGs
   * with a media query of their own follow the emulated scheme; raster files
   * render the same either way, which is why the light and dark variants are
   * separate files.
   */
  async function measure(file, scheme) {
    await send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: scheme }],
    })
    const image = pathToFileURL(join(root, file)).href
    // The cache-buster keeps the two readings of one file independent: a
    // decoded image reused from cache would freeze the first scheme's answer.
    const url = harnessUrl + '?img=' + encodeURIComponent(image + '?scheme=' + scheme)
    await send('Page.navigate', { url })
    for (let i = 0; i < 30; i += 1) {
      const ready = await send('Runtime.evaluate', {
        expression: 'typeof window.__done', returnByValue: true,
      })
      if (ready?.result?.value !== 'undefined') break
      await sleep(300)
    }
    const result = await send('Runtime.evaluate', {
      expression: 'window.__done', returnByValue: true, awaitPromise: true,
    })
    return result?.result?.value
  }

  const CONTRAST = 15 // luminance points between the themes
  for (const [index, group] of groups.entries()) {
    const label = 'picture ' + (index + 1) + ' (' + group.files.light + ')'
    const light = await measure(group.files.light, 'light')
    const dark = await measure(group.files.dark, 'dark')
    check(light?.ok, label + ' renders its light variant (' + (light?.error || light?.width + 'x' + light?.height) + ')')
    check(dark?.ok, label + ' renders its dark variant (' + (dark?.error || dark?.width + 'x' + dark?.height) + ')')
    if (light?.ok && dark?.ok) {
      check(dark.mean + CONTRAST <= light.mean,
        label + ' is darker in the dark than in the light (means ' +
        dark.mean.toFixed(0) + ' vs ' + light.mean.toFixed(0) + ')')
    }
    const narrowLight = await measure(group.files.narrow, 'light')
    const narrowDark = await measure(group.files.narrow, 'dark')
    check(narrowLight?.ok, label + ' renders its narrow variant (' + (narrowLight?.error || narrowLight?.width + 'x' + narrowLight?.height) + ')')
    // A narrow PNG cannot follow the scheme, so it is shown as it is; a
    // narrow SVG can, and must, because it is the one file for both themes.
    if (narrowLight?.ok && narrowDark?.ok && group.files.narrow.endsWith('.svg')) {
      check(narrowDark.mean + CONTRAST <= narrowLight.mean,
        label + ' narrow SVG follows the scheme itself (means ' +
        narrowDark.mean.toFixed(0) + ' vs ' + narrowLight.mean.toFixed(0) + ')')
    }
  }

  ws.close()
  child.kill()
} catch (error) {
  console.log('FAIL ' + (error && error.message ? error.message : error))
  failures += 1
} finally {
  await sleep(1000)
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* browser still holds it */ }
}

console.log('')
console.log(failures === 0 ? 'RESULT: every image renders, and follows the viewer' : `RESULT: ${failures} failure(s)`)
process.exit(failures ? 1 : 0)
