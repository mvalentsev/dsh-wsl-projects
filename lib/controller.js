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
    const aliases = await this.readAliases()
    const services = await this.units({ awaitUrls: true })

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
      aliases: aliases.aliases || {},
      services: services.units || [],
      projectsRoot: this.config.projectsRoot,
      configFiles: this.config.configFiles,
      defaultPort: this.config.defaultPort,
      suggestedUnit: this.config.unit,
    }
  }

  /** The path -> label map the panel shows instead of raw folder names. */
  async readAliases() {
    const result = await this.#bash(S.readAliasesScript(), { timeoutMs: 60000 })
    if (!result.ok && !result.stdout) return { ok: true, aliases: {} }
    const body = between(result.stdout, 'STATUS\n', '\nEND')
    if (body.startsWith('result=missing')) return { ok: true, aliases: {} }
    const firstBreak = body.indexOf('\n')
    const encoded = (firstBreak < 0 ? '' : body.slice(firstBreak + 1)).trim()
    try {
      const parsed = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8') || '{}')
      return { ok: true, aliases: parsed && typeof parsed === 'object' ? parsed : {} }
    } catch {
      // A hand-edited file that no longer parses must not break the panel.
      return { ok: true, aliases: {}, broken: true }
    }
  }

  /** Sets or clears one label. An empty label removes the entry. */
  async setAlias(path, label) {
    if (typeof path !== 'string' || !path.startsWith('/')) {
      return fail('alias needs an absolute Linux path, got: ' + String(path))
    }
    const current = await this.readAliases()
    const next = { ...(current.aliases || {}) }
    const text = String(label ?? '').trim()
    if (text) next[path] = text.slice(0, 60)
    else delete next[path]

    const encoded = Buffer.from(JSON.stringify(next, null, 2) + '\n', 'utf8').toString('base64')
    const result = await this.#bash(S.writeAliasesScript(encoded), { timeoutMs: 60000 })
    if (!result.ok && !result.stdout) return fail(result.stderr)
    const values = payload(result.stdout)
    if (values.result !== 'ok') return fail('could not write the alias file inside WSL')
    return { ok: true, path, label: text, aliases: next }
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

  /**
   * Every dsh web service this user has. One unit serves one project on one
   * port, so running two projects at once means two units — proven on a real
   * machine, where two instances ran side by side and `~/.dsh` did not clash.
   */
  async units({ awaitUrls = false } = {}) {
    const result = await this.#bash(S.unitsScript({ awaitUrls }), { timeoutMs: awaitUrls ? 120000 : 90000 })
    if (!result.ok && !result.stdout) return fail(result.stderr)
    const body = between(result.stdout, 'STATUS\n', '\nEND')
    const list = []
    for (const line of body.split('\n')) {
      if (!line.startsWith('U\t')) continue
      const [, unit, active, workdir, port, pid, url] = line.split('\t')
      if (!unit) continue
      list.push({
        unit,
        active: active || 'unknown',
        // A unit with Restart=always counts as active while it is still coming
        // up, so the script reports `starting` when its own URL does not answer.
        // Treating that as running would claim a service is up with nothing
        // listening, and two projects cannot share one port.
        running: active === 'active',
        starting: active === 'starting',
        project: workdir || null,
        port: port ? Number(port) : null,
        pid: pid && pid !== '0' ? pid : null,
        url: url || null,
      })
    }
    return { ok: true, units: list }
  }

  /** The unit name that serves a project, derived from its folder name. */
  unitForProject(project, index) {
    const tail = String(project).replace(/\/+$/, '').split('/').pop() || 'project'
    const slug = tail.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'project'
    return index === undefined ? `dsh-web-${slug}.service` : `dsh-web-${slug}-${index}.service`
  }

  #checkPort(port) {
    const wanted = port === undefined || port === null || port === '' ? this.config.defaultPort : Number(port)
    if (!PORT_RE.test(String(wanted)) || wanted < 1 || wanted > 65535) return null
    return wanted
  }

  /**
   * Brings a project up, and only that project.
   *
   * The unit of control is the project: if it already has a service, that
   * service is reconfigured and restarted; if it has none, one is created. Any
   * other project's service is left alone, which is what makes running two
   * projects at once an ordinary consequence rather than a separate command.
   *
   * The port follows the same rule: an existing service keeps the port it had,
   * a new one takes the first free port, and an explicit port that is already
   * taken by something else steps aside instead of failing.
   */
  async start({ project, port } = {}) {
    const known = await this.projects()
    const target = project || known.projects?.[0]?.path
    if (!target) return fail('no project selected and none found under ' + this.config.projectsRoot)
    if (!target.startsWith('/')) return fail('project must be an absolute Linux path: ' + target)

    const services = await this.units({ awaitUrls: true })
    const existing = (services.units || []).find((service) => service.project === target)
    const unit = existing?.unit || this.unitForProject(target)

    const explicit = this.#requestedPort(port)
    if (explicit === null) return fail('invalid port: ' + port)

    let chosen
    if (explicit !== '') {
      // An explicit port wins unless another service already owns it.
      const taken = (services.units || []).some((service) => service.unit !== unit && service.port === explicit)
      chosen = taken ? await this.#freePort() : explicit
    } else if (existing?.port) {
      chosen = existing.port
    } else {
      chosen = await this.#freePort()
    }

    // The unit runs the launcher, and the launcher is what records this
    // service's own UI URL, so it has to exist before the unit does.
    const launcher = await this.#kv(S.writeLaunchScript(), { timeoutMs: 60000 })
    if (launcher.failed) return launcher.failed
    if (launcher.values?.result !== 'ok') return fail('could not write the service launcher inside WSL')

    const { values, failed } = await this.#kv(
      S.unitCreateForProjectScript({
        unit,
        project: target,
        port: chosen,
        description: `DeepSeek Harness web profile (${target})`,
      }),
      { timeoutMs: 200000 },
    )
    if (failed) return failed
    if (values.result !== 'active') {
      return fail(REASONS[values.result] || values.result || 'the unit did not come up')
    }
    return {
      ok: true,
      unit,
      project: target,
      port: values.port,
      pid: values.pid,
      url: values.url,
      created: !existing,
      movedPort: Boolean(explicit !== '' && chosen !== explicit),
    }
  }

  /**
   * Stops a project's service without touching any other, and disables it so a
   * `Restart=always` unit does not come back on the next boot.
   */
  async stopProject({ project, unit } = {}) {
    const services = await this.units({ awaitUrls: true })
    const list = services.units || []
    let target = unit
    if (!target) {
      const wanted = project || (await this.state()).status?.project
      target = list.find((service) => service.project === wanted)?.unit
    }
    if (!target) {
      // Nothing matches: fall back to whatever the panel's own unit is.
      target = (await this.#unit()) || undefined
    }
    if (!target) return fail('no service matches that project')
    return this.stopUnit(target)
  }

  /** Restarts a project's service, or starts it when it is not running yet. */
  async restartProject({ project, port } = {}) {
    const services = await this.units({ awaitUrls: true })
    const wanted = project || (await this.state()).status?.project
    const existing = (services.units || []).find((service) => service.project === wanted)
    if (!existing) return this.start({ project: wanted, port })
    if (!existing.running) return this.start({ project: wanted, port: port ?? existing.port })
    const result = await this.restartUnit(existing.unit)
    return result.ok ? { ...result, project: existing.project, port: existing.port } : result
  }

  /** Removes a service for good: stop, disable, delete the unit file. */
  async removeUnit(unit) {
    if (!unit || !/^[A-Za-z0-9@._-]+\.service$/.test(unit)) return fail('invalid unit name: ' + String(unit))
    const { failed } = await this.#kv(S.unitRemoveScript(unit), { timeoutMs: 120000 })
    if (failed) return failed
    return { ok: true, unit, removed: true }
  }

  /** First port at or above the configured one that nothing is listening on. */
  async #freePort() {
    const { values } = await this.#kv(S.firstFreePortScript(this.config.defaultPort), { timeoutMs: 60000 })
    const port = Number(values.port)
    return Number.isFinite(port) && port > 0 ? port : this.config.defaultPort
  }

  async stopUnit(unit) {
    if (!unit || !/^[A-Za-z0-9@._-]+\.service$/.test(unit)) return fail('invalid unit name: ' + String(unit))
    const { values, failed } = await this.#kv(S.unitActionScript({ unit, verb: 'stop' }), { timeoutMs: 120000 })
    if (failed) return failed
    return { ok: true, unit, result: values.result || 'stopped' }
  }

  async restartUnit(unit) {
    if (!unit || !/^[A-Za-z0-9@._-]+\.service$/.test(unit)) return fail('invalid unit name: ' + String(unit))
    const { values, failed } = await this.#kv(S.unitActionScript({ unit, verb: 'restart' }), { timeoutMs: 200000 })
    if (failed) return failed
    if (values.result !== 'active') {
      return fail('the unit did not return to active (state: ' + (values.result || 'unknown') + ')')
    }
    return { ok: true, unit, pid: values.pid, port: values.port, url: values.url }
  }

  async #unit() {
    const { values } = await this.#kv(S.statusScript(), { timeoutMs: 120000 })
    return values?.unit || this.config.unit
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

  /**
   * Fallback for a distribution without systemd: stop whatever owns the port.
   * With systemd, stopping always goes through the project's own unit.
   */
  async stopByPort() {
    const { values, failed } = await this.#kv(S.stopScript(), { timeoutMs: 120000 })
    if (failed) return failed
    return { ok: true, result: values.result || 'stopped' }
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
