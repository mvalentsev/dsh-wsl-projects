// Проверка того, что видит пользователь: открывает UI каждого сервиса в
// headless Chrome через CDP и читает видимый текст. Это единственная проверка,
// которая отвечает на вопрос «какой проект открылся», а не «какая ссылка».
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

async function cdp(port, url) {
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
  if (!target) { child.kill(); rmSync(profile, { recursive: true, force: true }); return null }

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
