// Low-level WSL interop for dsh-wsl-projects.
//
// Two facts drive this file:
//   * The script travels to Linux over stdin (`bash -s`), never through argv.
//     A command line has to survive Node's quoting, `wsl.exe`'s argument
//     rewriter and bash — measured on Windows 11 that mangles `$VAR` and
//     `case` patterns. stdin has none of those layers.
//   * `wsl.exe` writes UTF-16LE to a pipe for its own management verbs
//     (`-l -v`, `--status`), while a Linux command writes plain UTF-8. stdout
//     is therefore captured as a Buffer and sniffed.

import { spawn } from 'node:child_process'

const WSL_EXE = process.env.DSH_WSL_EXE || 'wsl.exe'

const homeCache = new Map()
// Distributions already proven reachable in this process, so the boot probe is
// paid once per distribution rather than on every panel refresh.
const woken = new Set()
const waking = new Map()

function decode(buffer) {
  if (!buffer || buffer.length === 0) return ''

  // UTF-16LE text is full of NUL bytes in the high half of every code unit.
  const limit = Math.min(buffer.length, 400)
  let zeros = 0
  for (let i = 1; i < limit; i += 2) if (buffer[i] === 0) zeros += 1
  const pairs = Math.max(1, Math.floor(limit / 2))
  const isUtf16 = zeros / pairs > 0.3

  return (isUtf16 ? buffer.toString('utf16le') : buffer.toString('utf8')).replace(/^\uFEFF/, '')
}

function run(args, { timeoutMs = 120000, stdin } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(WSL_EXE, args, { windowsHide: true })
    } catch (error) {
      resolve({ ok: false, code: -1, stdout: '', stderr: String(error?.message || error) })
      return
    }

    const out = []
    const err = []
    let settled = false
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill() } catch {}
    }, timeoutMs)

    child.stdout?.on('data', (chunk) => out.push(chunk))
    child.stderr?.on('data', (chunk) => err.push(chunk))
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, code: -1, stdout: '', stderr: String(error?.message || error) })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const stdout = decode(Buffer.concat(out))
      const stderr = decode(Buffer.concat(err))
      if (timedOut) {
        resolve({ ok: false, code: code ?? -1, stdout, stderr: `${stderr}\n[timeout after ${timeoutMs} ms]`.trim() })
        return
      }
      resolve({ ok: code === 0, code: code ?? -1, stdout, stderr })
    })

    if (stdin !== undefined) {
      try { child.stdin.end(stdin) } catch {}
    } else {
      try { child.stdin.end() } catch {}
    }
  })
}

/** Run a bash script inside a distribution, fed over stdin. */
export async function bash(distro, script, options = {}) {
  const args = []
  if (distro) args.push('-d', distro)
  args.push('--', 'bash', '-s')

  const result = await run(args, { ...options, stdin: script })
  return {
    ...result,
    stdout: result.stdout.replace(/\r\n/g, '\n'),
    stderr: result.stderr.replace(/\r\n/g, '\n'),
  }
}

/** Parse `wsl.exe -l -v` into distro records. */
export async function listDistros() {
  const result = await run(['-l', '-v'], { timeoutMs: 30000 })
  if (!result.ok) {
    return { ok: false, error: result.stderr || `wsl.exe -l -v exited with ${result.code}`, distros: [] }
  }

  const distros = []
  for (const rawLine of result.stdout.split(/\r?\n/)) {
    const line = rawLine.replace(/\u0000/g, '').trimEnd()
    if (!line.trim()) continue
    const match = /^(\*)?\s*(\S+)\s+(Running|Stopped|Installing|Uninstalling|Converting|Installed)?\s*(\d+)?\s*$/.exec(line)
    if (!match) continue
    const [, star, name, state, version] = match
    if (/^NAME$/i.test(name)) continue
    distros.push({
      name,
      state: state || 'Unknown',
      version: version ? Number(version) : null,
      isDefault: Boolean(star),
    })
  }

  return { ok: true, distros }
}

/** The Linux home directory of the default user in one distribution. */
export async function homeOf(distro) {
  const key = distro || ''
  if (homeCache.has(key)) return homeCache.get(key)
  const result = await bash(distro, 'printf %s "$HOME"\n', { timeoutMs: 30000 })
  const home = result.stdout.trim() || '/root'
  homeCache.set(key, home)
  return home
}

/**
 * Starting a stopped distribution means booting the Linux VM, which can take
 * longer than a normal call and can answer with a transient error. Two
 * overlapping probes are fired instead of one so the boot cost is paid once,
 * and each is retried once with a generous timeout.
 */
export async function wake(distro) {
  const key = distro || ''
  if (woken.has(key)) return true
  const inFlight = waking.get(key)
  if (inFlight) return inFlight

  const probe = async (attempt) => {
    const result = await bash(distro, 'printf %s wsl-ready\n', { timeoutMs: attempt === 0 ? 30000 : 120000 })
    if (result.stdout.trim() === 'wsl-ready') return true
    if (attempt === 0) return probe(1)
    return false
  }

  const promise = (async () => {
    const results = await Promise.all([probe(0), probe(0)])
    const ready = results.some(Boolean)
    if (ready) woken.add(key)
    waking.delete(key)
    return ready
  })()

  waking.set(key, promise)
  return promise
}

export function resetHomeCache() {
  homeCache.clear()
  woken.clear()
}

export const _internals = { decode }
