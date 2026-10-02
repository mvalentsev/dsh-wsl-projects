// What the user actually sees: opens a service's UI in headless Chrome over the
// debugging protocol and reads the visible text. This is the only check that
// answers "which project opened" rather than "which link was offered", and it is
// the one that would have caught the reported bug immediately.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A Chromium-based browser, looked for rather than assumed: `UI_BROWSER`, the
 * usual install locations per platform, then whatever is on PATH. A missing
 * browser is reported by `cdp` as a failure instead of a mystery timeout.
 */
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

async function cdp(port, url) {
  if (!url) return ''
  const profile = mkdtempSync(join(tmpdir(), 'dsh-ui-'))
  const child = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, url,
  ], { stdio: 'ignore', detached: false })

  let target = null
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      target = list.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1'))
      if (target) break
    } catch { /* chrome not up yet */ }
  }
  if (!target) {
    child.kill()
    await new Promise((r) => setTimeout(r, 500))
    try { rmSync(profile, { recursive: true, force: true }) } catch { /* still held */ }
    return null
  }

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

  // The UI boots, asks the host for its workspace and only then renders the
  // project, so the text is polled until it settles rather than read once.
  let text = ''
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 1000))
    const result = await send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true })
    text = result?.result?.value || ''
    if (text && !/Choose a workspace/i.test(text) && text.length > 20) break
  }
  ws.close()
  child.kill()
  await new Promise((r) => setTimeout(r, 1000))
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* chrome still holds it */ }
  return text
}

export { cdp }

if (process.argv[1] && process.argv[1].endsWith('ui-probe.mjs')) {
  const [, , url] = process.argv
  const text = await cdp(9300 + Math.floor(Math.random() * 500), url)
  console.log(text ? text.split('\n').slice(0, 12).join(' | ') : '(не удалось открыть)')
}
