// Host half of dsh-wsl-projects.
//
// One operation layer (controller.js) serves two callers, as the Harness
// plugin practices ask: the REST routes the panel uses, and the agent tool.
// The routes are registered on the profile's own web server, so nothing here
// needs a build step and the panel can be plain JavaScript.

import { WslProjects } from './controller.js'

export const name = 'dsh-wsl-projects'

// Cordis refuses to expose a service property that has not been declared, so
// the web server must be named here (the `inject` list also delays apply()
// until that service exists).
export const inject = ['webServer']

const PREFIX = '/wsl-projects'
const MAX_BODY = 512 * 1024

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        resolve({ ok: false, error: 'request body too large' })
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) return resolve({ ok: true, value: {} })
      try {
        resolve({ ok: true, value: JSON.parse(text) })
      } catch (error) {
        resolve({ ok: false, error: 'invalid JSON body: ' + error.message })
      }
    })
    req.on('error', (error) => resolve({ ok: false, error: String(error?.message || error) }))
  })
}

// The Desktop shell serves the page from dsh-app://app and forwards our routes
// with the shell's own session cookie, so the browser sends a foreign Origin.
// These two values are the only sources this plugin accepts; everything else is
// refused before an operation can stop a service or rewrite a config file.
const SHELL_ORIGIN = 'dsh-app://app'

/**
 * Which origin a request must be allowed to come from. A request with no Origin
 * header (a curl probe, the agent tool's own server-side path) carries no
 * browser credentials and is left to the loopback bind.
 */
function originDecision(req, ownOrigin) {
  const raw = req.headers?.origin
  if (!raw) return { allowed: true, crossOrigin: false }
  if (raw === SHELL_ORIGIN) return { allowed: true, crossOrigin: true }
  if (ownOrigin && raw === ownOrigin) return { allowed: true, crossOrigin: true }
  return { allowed: false, crossOrigin: true }
}

/** `POST /wsl-projects/api/start` -> ['start'] */
function tail(prefix, pathname) {
  return pathname.slice(prefix.length).replace(/^\/+/, '').replace(/\/+$/, '')
}

export function apply(ctx, config = {}) {
  const controller = new WslProjects(config)
  const logger = ctx.logger ?? console

  // The Desktop shell serves the UI over the privileged `dsh-app://app/` scheme
  // and forwards every other path to this HTTP server, so a relative fetch from
  // a panel already reaches us with the shell's cookie. Reporting our own
  // origin lets the panel fall back to a direct loopback call if a host ever
  // serves the page from an opaque origin instead.
  const origin = (() => {
    try {
      const port = ctx.webServer?.port
      if (port) return `http://127.0.0.1:${port}`
    } catch { /* the port getter is not essential */ }
    return null
  })()

  const handle = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname
    const action = tail(PREFIX + '/api', pathname)
    const method = (req.method ?? 'GET').toUpperCase()

    try {
      const decision = originDecision(req, origin)
      if (!decision.allowed) {
        logger.warn?.('dsh-wsl-projects: refused a request from Origin %s', req.headers?.origin)
        sendJson(res, 403, { ok: false, error: 'origin not allowed: ' + req.headers?.origin })
        return true
      }
      // A forwarded cross-origin request is answered by the shell, so the
      // response needs no CORS grant; these headers only keep a direct
      // loopback call readable when it came from an allowed page.
      if (decision.crossOrigin && origin) res.setHeader('access-control-allow-origin', origin)
      res.setHeader('vary', 'origin')

      if (method === 'GET' && (action === '' || action === 'state')) {
        const state = await controller.state()
        sendJson(res, 200, origin ? { ...state, apiOrigin: origin } : state)
        return true
      }
      if (method === 'GET' && action === 'distros') {
        sendJson(res, 200, await controller.distros())
        return true
      }
      if (method === 'GET' && action === 'projects') {
        sendJson(res, 200, await controller.projects())
        return true
      }
      if (method === 'GET' && action.startsWith('config')) {
        const which = url.searchParams.get('path') || undefined
        sendJson(res, 200, await controller.readConfig(which))
        return true
      }
      if (method !== 'POST') return false

      if (action === 'start' || action === 'stop' || action === 'restart') {
        const body = await readBody(req)
        if (!body.ok) {
          sendJson(res, 400, { ok: false, error: body.error })
          return true
        }
        const result = await controller[action](body.value)
        sendJson(res, result.ok ? 200 : 400, result)
        return true
      }
      if (action === 'config') {
        const body = await readBody(req)
        if (!body.ok) {
          sendJson(res, 400, { ok: false, error: body.error })
          return true
        }
        const result = await controller.writeConfig(body.value?.path, body.value?.content)
        sendJson(res, result.ok ? 200 : 400, result)
        return true
      }
      return false
    } catch (error) {
      logger.warn?.('dsh-wsl-projects: route failed — %s', error?.stack || error)
      sendJson(res, 500, { ok: false, error: String(error?.message || error) })
      return true
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: async (req, res) => {
      const handled = await handle(req, res)
      if (!handled) sendJson(res, 404, { ok: false, error: 'unknown route: ' + req.url })
    },
  }), 'dsh-wsl-projects: REST routes')

  ctx.inject?.(['tools'], (tctx) => {
    tctx.effect(() => tctx.tools.register({
      name: 'wsl_dsh',
      description: [
        'Manage the DeepSeek Harness (dsh) instance that runs inside WSL2, from Windows.',
        'Actions: "state" (instances, projects, running dsh), "projects" (list ~/projects),',
        '"distros" (WSL distributions), "start" (launch dsh web inside a project folder),',
        '"stop", "restart", "read_config", "write_config".',
        'Starting dsh takes a few seconds while the WSL distribution boots.',
      ].join(' '),
      parameters: {
        action: {
          type: 'string',
          required: true,
          description: 'state | projects | distros | start | stop | restart | read_config | write_config',
          enum: ['state', 'projects', 'distros', 'start', 'stop', 'restart', 'read_config', 'write_config'],
        },
        project: {
          type: 'string',
          description: 'Absolute Linux path of the project folder, e.g. /home/user/projects/radio. Used by start/restart; defaults to the most recently modified project.',
        },
        port: {
          type: 'number',
          description: 'TCP port for the WSL dsh web UI. Defaults to the plugin setting (19800).',
        },
        path: {
          type: 'string',
          description: 'Config file path inside WSL for read_config/write_config, e.g. ~/.dsh/settings.yaml.',
        },
        content: {
          type: 'string',
          description: 'Full file content for write_config.',
        },
      },
      async execute(args = {}) {
        switch (args.action) {
          case 'state': return await controller.state()
          case 'projects': return await controller.projects()
          case 'distros': return await controller.distros()
          case 'start': return await controller.start({ project: args.project, port: args.port })
          case 'stop': return await controller.stop()
          case 'restart': return await controller.restart({ project: args.project, port: args.port })
          case 'read_config': return await controller.readConfig(args.path)
          case 'write_config': return await controller.writeConfig(args.path, args.content ?? '')
          default: return { ok: false, error: 'unknown action: ' + String(args.action) }
        }
      },
    }), 'dsh-wsl-projects: wsl_dsh tool')
  })

  logger.info?.('dsh-wsl-projects: ready on %s', PREFIX)
}
