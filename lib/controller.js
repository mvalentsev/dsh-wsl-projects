// The operation layer: one place that owns every WSL interaction, so the REST
// API and the agent tool call exactly the same code (no duplicated logic).
//
// Lifecycle rule, learned on a real machine: when the WSL dsh runs as a
// systemd user unit (the common setup, usually with Restart=always), killing
// its process is pointless — systemd starts it again within seconds. Every
// start/stop/restart therefore goes through `systemctl --user`, and a project
// or port change is written as a drop-in override. Spawning directly is kept
// only as a fallback for a distribution without systemd.

import { bash, listDistros, homeOf, wake, resetHomeCache } from './wsl.js'
import * as S from './scripts.js'

const PORT_RE = /^[0-9]{1,5}$/

function parseKV(stdout) {
  const out = {}
  for (const line of String(stdout).split('\n')) {
    const index = line.indexOf('=')
    if (index > 0) out[line.slice(0, index)] = line.slice(index + 1)
  }
  return out
}

function between(stdout, start, end) {
  const from = stdout.indexOf(start)
  if (from < 0) return ''
  const rest = stdout.slice(from + start.length)
  const to = rest.indexOf(end)
  return (to < 0 ? rest : rest.slice(0, to)).replace(/^\n/, '').replace(/\n$/, '')
}

function payload(stdout) {
  return parseKV(between(stdout, 'STATUS\n', '\nEND'))
}

function fail(error) {
  return { ok: false, error: String(error || 'unknown error') }
}

const REASONS = {
  'no-unit': 'the systemd unit disappeared while working — refresh and try again',
  'no-dsh': 'dsh is not installed for this WSL user (nothing runnable on the Linux PATH)',
  'no-project': 'no such directory inside WSL',
  'no-systemd': 'this distribution has no systemd user session, so no unit can be created',
  failed: 'dsh did not come up — see the unit status in the error field',
  crashed: 'dsh exited right after start',
}

export class WslProjects {
  constructor(config = {}) {
    this.config = {
      distro: config.distro || '',
      projectsRoot: config.projectsRoot || '~/projects',
      unit: config.unit || 'dsh-web.service',
      defaultPort: Number(config.defaultPort) || 19800,
      configFiles: Array.isArray(config.configFiles) && config.configFiles.length
        ? config.configFiles
        : ['~/.dsh/settings.yaml', '~/.dsh/profiles/web/cordis.patch.yml'],
    }
  }

  distro() {
    return this.config.distro || ''
  }

  async #resolve(p) {
    if (!p.startsWith('~')) return p
    return p.replace(/^~/, await homeOf(this.distro()))
  }

  async #bash(script, options) {
    // A stopped distribution boots on the first call; paying for that once
    // keeps a cold distro from looking like a plugin failure.
    await wake(this.distro())
    return bash(this.distro(), script, options)
  }

  async #kv(script, options) {
    const result = await this.#bash(script, options)
    if (!result.ok && !result.stdout) return { failed: fail(result.stderr) }
    return { values: payload(result.stdout) }
  }

  async distros() {
    const result = await listDistros()
    if (!result.ok) return fail(result.error)
    return { ok: true, distros: result.distros, selected: this.distro() || null }
  }

  async state() {
    const { values, failed } = await this.#kv(S.statusScript(), { timeoutMs: 120000 })
    if (failed) return failed
    const projects = await this.projects()

    return {
      ok: true,
      distro: this.distro() || null,
      distros: (await listDistros()).distros || [],
      status: {
        running: values.running === 'yes',
        pid: values.pid || null,
        port: values.port || null,
        project: values.project || null,
        version: values.version || null,
        url: values.url || null,
        unit: values.unit || null,
        managed: values.managed === 'yes',
        active: values.active || null,
        substate: values.substate || null,
        restarts: values.restarts ? Number(values.restarts) : null,
      },
      projects: projects.projects || [],
      projectsRoot: this.config.projectsRoot,
      configFiles: this.config.configFiles,
      defaultPort: this.config.defaultPort,
      suggestedUnit: this.config.unit,
    }
  }

  async projects() {
    const root = await this.#resolve(this.config.projectsRoot)
    const result = await this.#bash(S.listProjectsScript(root), { timeoutMs: 60000 })
    if (!result.ok && !result.stdout) return fail(result.stderr)

    const body = between(result.stdout, 'STATUS\n', '\nEND')
    if (/^missing=1$/m.test(body)) return { ok: true, projects: [], missing: true, root }

    const projects = []
    for (const line of body.split('\n')) {
      if (!line.startsWith('P\t')) continue
      const [, name, path, mtime, git, kind] = line.split('\t')
      if (!name || !path) continue
      projects.push({
        name,
        path: path.replace(/\/$/, ''),
        modifiedAt: Number(mtime) || 0,
        git: git === 'yes',
        kind: kind || 'dir',
      })
    }
    projects.sort((a, b) => b.modifiedAt - a.modifiedAt)
    return { ok: true, projects, root }
  }

  /** Reads the unit name from WSL: a stored override, else the discovered one. */
  async #unit() {
    const { values } = await this.#kv(S.statusScript(), { timeoutMs: 120000 })
    return values?.unit || this.config.unit
  }

  #checkPort(port) {
    const wanted = port === undefined || port === null || port === '' ? this.config.defaultPort : Number(port)
    if (!PORT_RE.test(String(wanted)) || wanted < 1 || wanted > 65535) return null
    return wanted
  }

  /**
   * A port is only carried through when the caller actually supplied one.
   * `null`/`undefined` must stay empty — stringifying them puts the literal
   * "null" into a systemd ExecStart line, which dsh rejects at startup.
   */
  #requestedPort(port) {
    if (port === undefined || port === null || port === '') return ''
    const wanted = Number(port)
    if (!PORT_RE.test(String(wanted)) || wanted < 1 || wanted > 65535) return null
    return wanted
  }

  async start({ project, port, createUnit = false } = {}) {
    const wanted = this.#requestedPort(port)
    if (wanted === null) return fail('invalid port: ' + port)
    const effectivePort = wanted === '' ? this.config.defaultPort : wanted

    const root = await this.#resolve(this.config.projectsRoot)
    const known = await this.projects()
    let target = project || known.projects?.[0]?.path
    if (!target) return fail('no project selected and none found under ' + root)
    if (!target.startsWith('/')) return fail('project must be an absolute Linux path: ' + target)

    const unit = await this.#unit()
    const canUseUnit = Boolean(unit) && !createUnit

    if (canUseUnit) {
      const { values, failed } = await this.#kv(
        S.unitApplyScript({ unit, project: target, port: wanted }),
        { timeoutMs: 180000 },
      )
      if (failed) return failed
      return this.#outcome(values, target)
    }

    if (createUnit) {
      const { values, failed } = await this.#kv(S.unitCreateScript({
        unit: unit || this.config.unit,
        project: target,
        port: effectivePort,
        description: 'DeepSeek Harness web profile',
      }), { timeoutMs: 180000 })
      if (failed) return failed
      return this.#outcome(values, target)
    }

    const { values, failed } = await this.#kv(
      S.spawnScript({ port: effectivePort, project: target }),
      { timeoutMs: 180000 },
    )
    if (failed) return failed
    return this.#outcome(values, target)
  }

  #outcome(values, project) {
    if (values.result === 'already-running' || values.result === 'active') {
      return { ok: true, alreadyRunning: true, pid: values.pid, port: values.port, url: values.url, project }
    }
    if (values.result === 'started') {
      return { ok: true, pid: values.pid, port: values.port, url: values.url, project }
    }
    const reason = REASONS[values.result] || values.result || 'start failed'
    return fail(values.log ? reason + ' — ' + values.log : reason)
  }

  async stop() {
    const unit = await this.#unit()
    if (unit) {
      const { values, failed } = await this.#kv(
        S.unitActionScript({ unit, verb: 'stop' }),
        { timeoutMs: 120000 },
      )
      if (failed) return failed
      if (values.result === 'inactive' || values.result === 'failed' || values.result === 'deactivating') {
        return { ok: true, result: 'stopped', unit }
      }
      return { ok: true, result: values.result || 'stopped', unit }
    }

    // No unit: kill whatever owns the port, then confirm it is really gone.
    const { values, failed } = await this.#kv(S.stopScript(), { timeoutMs: 120000 })
    if (failed) return failed
    return { ok: true, result: values.result || 'stopped' }
  }

  async restart(options = {}) {
    const unit = await this.#unit()
    if (unit) {
      const requested = this.#requestedPort(options.port)
      if (requested === null) return fail('invalid port: ' + options.port)
      const project = options.project || null

      if (project || requested !== '') {
        const { values, failed } = await this.#kv(
          S.unitApplyScript({ unit, project, port: requested }),
          { timeoutMs: 200000 },
        )
        if (failed) return failed
        return this.#outcome(values, project)
      }

      const { values, failed } = await this.#kv(
        S.unitActionScript({ unit, verb: 'restart' }),
        { timeoutMs: 200000 },
      )
      if (failed) return failed
      if (values.result !== 'active') {
        return fail('the unit did not return to active (state: ' + (values.result || 'unknown') + ')')
      }
      return { ok: true, pid: values.pid, port: values.port, url: values.url, restarted: true }
    }

    const stopped = await this.stop()
    if (stopped.ok === false) return stopped
    resetHomeCache()
    return this.start(options)
  }

  async readConfig(which) {
    const path = await this.#resolve(which || this.config.configFiles[0])
    const result = await this.#bash(S.readFileScript(path), { timeoutMs: 60000 })
    if (!result.ok && !result.stdout) return fail(result.stderr)

    const body = between(result.stdout, 'STATUS\n', '\nEND')
    if (body.startsWith('result=missing')) return { ok: true, path, missing: true, content: '' }
    const firstBreak = body.indexOf('\n')
    const encoded = (firstBreak < 0 ? '' : body.slice(firstBreak + 1)).trim()
    let content = ''
    try {
      content = Buffer.from(encoded, 'base64').toString('utf8')
    } catch (error) {
      return fail('could not decode the file body: ' + error)
    }
    return { ok: true, path, missing: false, content }
  }

  async writeConfig(which, content) {
    const path = await this.#resolve(which || this.config.configFiles[0])
    const encoded = Buffer.from(String(content ?? ''), 'utf8').toString('base64')
    const result = await this.#bash(S.writeFileScript(path, encoded), { timeoutMs: 60000 })
    if (!result.ok && !result.stdout) return fail(result.stderr)
    const values = payload(result.stdout)
    if (values.result !== 'ok') return fail('write rejected by WSL')
    return { ok: true, path }
  }
}
