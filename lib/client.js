// Client half of dsh-wsl-projects.
//
// Format: a lazy-CJS factory registered with the shell's module loader. React
// comes from the host's baseline module table, so it is never bundled. The
// panel follows the host's own row patterns and only uses --dsw-alias-* theme
// tokens, so a renamed token degrades the look but never breaks rendering.

window.__ModuleLoader__.load({
  id: 'dsh-wsl-projects',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/wsl-projects/api'
    const STORE_KEY = 'dsh-wsl-projects:selection'

    // ---------------------------------------------------------------- styling

    // Only tokens the host actually defines are used, and every one of them is
    // read without a literal fallback: a missing token then leaves the property
    // unset and the host's own colour shows through, instead of a hard-coded
    // light value landing on a dark theme.
    const SURFACE_BG = 'var(--dsw-alias-bg-overlay)'
    const HAIRLINE = '.5px solid var(--dsw-alias-border-l2)'

    const S = {
      panel: {
        position: 'fixed',
        right: '16px',
        bottom: '16px',
        width: '420px',
        maxWidth: 'calc(100vw - 32px)',
        maxHeight: 'min(620px, calc(100vh - 32px))',
        display: 'flex',
        flexDirection: 'column',
        background: SURFACE_BG,
        color: 'var(--dsw-alias-label-primary)',
        border: HAIRLINE,
        borderRadius: 'var(--dsw-radius-xl, 10px)',
        font: 'inherit',
        fontSize: '13px',
        overflow: 'hidden',
        zIndex: 60,
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '8px 10px',
        borderBottom: HAIRLINE,
        cursor: 'move',
        userSelect: 'none',
      },
      title: { flex: 1, fontWeight: 600, fontSize: '13px' },
      body: { padding: '10px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px' },
      // Docked in Settings: plain document flow, sized by the host's own page.
      docked: {
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        padding: '4px 0 12px',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '13px',
        maxWidth: '720px',
      },
      row: { display: 'flex', alignItems: 'center', gap: '8px' },
      label: { width: '78px', color: 'var(--dsw-alias-label-secondary)', flexShrink: 0 },
      select: {
        flex: 1, minWidth: 0, padding: '4px 6px', fontSize: '13px',
        color: 'inherit', background: 'var(--dsw-alias-bg-base)',
        border: HAIRLINE, borderRadius: 'var(--dsw-radius-sm, 6px)',
      },
      input: {
        width: '84px', padding: '4px 6px', fontSize: '13px',
        color: 'inherit', background: 'var(--dsw-alias-bg-base)',
        border: HAIRLINE, borderRadius: 'var(--dsw-radius-sm, 6px)',
      },
      // Borderless fills, matching the host's own buttons in this set: it draws
      // separation with a background rather than an outline.
      button: {
        padding: '4px 10px', fontSize: '13px', cursor: 'pointer',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-button-elevated-fill)',
        border: 'none', borderRadius: 'var(--dsw-radius-sm, 6px)',
      },
      primary: {
        padding: '4px 10px', fontSize: '13px', cursor: 'pointer',
        color: 'var(--dsw-alias-label-primary-inverted)',
        background: 'var(--dsw-alias-button-primary-fill)',
        border: 'none', borderRadius: 'var(--dsw-radius-sm, 6px)',
      },
      dot: (color) => ({
        width: '8px', height: '8px', borderRadius: '50%', background: color, flexShrink: 0,
      }),
      meta: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: '1.5' },
      link: { color: 'var(--dsw-alias-link)', wordBreak: 'break-all', fontSize: '12px' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px' },
      error: {
        color: 'var(--dsw-alias-state-error-primary)',
        background: 'var(--dsw-alias-interactive-bg-hover-danger)',
        border: HAIRLINE,
        borderRadius: 'var(--dsw-radius-sm, 6px)', padding: '6px 8px', fontSize: '12px', whiteSpace: 'pre-wrap',
      },
      textarea: {
        width: '100%', minHeight: '150px', resize: 'vertical', padding: '6px',
        color: 'inherit', background: 'var(--dsw-alias-bg-base)', fontFamily: 'ui-monospace, monospace',
        fontSize: '12px', lineHeight: '1.45',
        border: HAIRLINE, borderRadius: 'var(--dsw-radius-sm, 6px)',
      },
      divider: { height: '1px', background: 'var(--dsw-alias-border-l2)' },
      serviceRow: { display: 'flex', alignItems: 'center', gap: '8px', padding: '2px 0' },
      serviceName: { flexShrink: 0, maxWidth: '150px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      servicePort: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', whiteSpace: 'nowrap' },
      sectionTitle: { fontWeight: 600, marginBottom: '4px' },
      empty: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
      // The sidebar seat owns both halves: its trigger, and the popover the
      // trigger opens. That is how the host's own occupant of this slot works.
      // The seat's own styling follows the host's: a bare row that lights up on
      // hover, not a boxed button.
      seat: { position: 'relative', width: '100%' },
      trigger: {
        display: 'flex', alignItems: 'center', gap: '6px', width: '100%',
        minHeight: '28px', padding: '0 8px', cursor: 'pointer', font: 'inherit', fontSize: '13px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'none', border: 'none',
        borderRadius: 'var(--dsw-radius-sm, 6px)',
        textAlign: 'left', whiteSpace: 'nowrap',
      },
      triggerLabel: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      popover: {
        position: 'fixed',
        width: '460px',
        maxWidth: 'calc(100vw - 24px)',
        maxHeight: 'min(640px, calc(100vh - 96px))',
        overflowY: 'auto',
        padding: '12px',
        background: SURFACE_BG,
        color: 'var(--dsw-alias-label-primary)',
        border: HAIRLINE,
        borderRadius: 'var(--dsw-radius-xl, 10px)',
        zIndex: 70,
      },
    }

    // ------------------------------------------------------------------- api

    // The Desktop shell serves this page from the privileged `dsh-app://app/`
    // scheme and forwards every non-asset path to the real HTTP server together
    // with the shell's cookie, so a relative fetch works there and on a plain
    // browser alike. The absolute candidates exist for a host that serves the
    // page from an opaque origin instead, and every answer is shape-checked so
    // that another local server answering on a guessed port is not mistaken
    // for this one.
    const FALLBACK_ORIGINS = ['http://127.0.0.1:19387', 'http://127.0.0.1:3080']
    const API_BASE_KEY = STORE_KEY + ':apiBase'
    // Must match HOST_CONTRACT in lib/index.js. A mismatch means the app is
    // still running the previous host half, which has to be reported plainly.
    const CLIENT_CONTRACT = 2

    function rememberOrigin(origin) {
      if (!origin || !String(origin).startsWith('http')) return
      try { localStorage.setItem(API_BASE_KEY, String(origin).replace(/\/+$/, '')) } catch { /* ignore */ }
    }

    function apiBases() {
      const list = []
      const pageOrigin = typeof location !== 'undefined' ? String(location.origin) : ''
      // Relative first: it is what the Desktop shell's scheme handler forwards.
      list.push(API)
      if (pageOrigin.startsWith('http')) list.push(pageOrigin + API)
      let stored = null
      try { stored = localStorage.getItem(API_BASE_KEY) } catch { /* ignore */ }
      if (stored) list.push(String(stored).replace(/\/+$/, '') + API)
      for (const origin of FALLBACK_ORIGINS) list.push(origin + API)
      return list.filter((value, index) => list.indexOf(value) === index)
    }

    function looksLikeOurAnswer(payload) {
      return Boolean(payload) && typeof payload === 'object' && typeof payload.ok === 'boolean'
    }

    async function call(path, options) {
      let lastError = null
      let lastPayload = null
      const bases = apiBases()

      for (let index = 0; index < bases.length; index += 1) {
        let payload = null
        try {
          const response = await fetch(bases[index] + path, { cache: 'no-store', ...options })
          const text = await response.text()
          try { payload = JSON.parse(text) } catch { payload = null }
          if (!payload) throw new Error('HTTP ' + response.status + ' with a non-JSON body')
          if (!response.ok && payload.ok !== false) {
            payload = { ok: false, error: 'HTTP ' + response.status }
          }
        } catch (error) {
          lastError = error
          continue
        }
        if (looksLikeOurAnswer(payload)) return payload
        // Some other server answered on this address — try the next one.
        lastPayload = payload
      }

      if (lastPayload) return lastPayload
      throw lastError || new Error('no reachable host route')
    }

    function post(path, body) {
      return call(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
    }

    // --------------------------------------------------------------- helpers

    function readStore() {
      try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') } catch { return {} }
    }

    function writeStore(value) {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(value)) } catch { /* ignore */ }
    }

    function ago(seconds) {
      if (!seconds) return 'unknown'
      const days = Math.floor((Date.now() / 1000 - seconds) / 86400)
      if (days <= 0) return 'today'
      if (days === 1) return 'yesterday'
      if (days < 30) return days + 'd ago'
      return Math.floor(days / 30) + 'mo ago'
    }

    function distroName(distro) {
      return distro.replace(/\u0000/g, '').trim()
    }

    /**
     * Which project the panel acts on.
     *
     * What you picked in the list wins — otherwise choosing a project would do
     * nothing, because a running service always reports one of its own and that
     * report used to take priority. When a service moves to a project on its
     * own (a restart from a terminal, say), the report differs from the one we
     * last saw and becomes the new starting point, so the panel cannot sit on a
     * stale choice.
     */
    function resolveActiveProject({ selected, reportedProject, lastReported, projects }) {
      if (selected && (!reportedProject || reportedProject === lastReported)) return selected
      if (reportedProject) return reportedProject
      if (selected) return selected
      return projects?.[0]?.path || ''
    }

    /**
     * The single decision the panel offers about a project.
     *
     * `stop` when that project has a running service, `start` otherwise —
     * starting is also what creates a service and what brings a stopped one
     * back, so neither needs a command of its own. `restart` is offered only
     * while something runs, since restarting nothing is meaningless.
     */
    function primaryAction(service) {
      if (service && service.running) return { kind: 'stop', label: 'Stop', offersRestart: true }
      return { kind: 'start', label: 'Start', offersRestart: false }
    }

    /**
     * The dropdown entries, ordered so a long list stays workable: alphabetically
     * by the name you see, with a natural comparison so `app-2` precedes
     * `app-10`. Ordering by modification time was more informative but worse to
     * navigate — the position of a project changed whenever anything touched it.
     */
    function projectViews(projects, aliases) {
      return (projects || []).map((project) => {
        const alias = (aliases || {})[project.path] || ''
        return {
          path: project.path,
          name: project.name,
          alias,
          label: alias || project.name,
          meta: [project.kind, project.git ? 'git' : null, ago(project.modifiedAt)].filter(Boolean).join(' · '),
        }
      }).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }))
    }

    /** Keeps the picker usable with many projects: matches the label or the folder. */
    function filterViews(views, query) {
      const needle = String(query || '').trim().toLowerCase()
      if (!needle) return views
      return views.filter((view) =>
        view.label.toLowerCase().includes(needle) || view.name.toLowerCase().includes(needle))
    }

    // ----------------------------------------------------------------- panel

    /**
     * The one panel, rendered in whichever home the plugin was configured for.
     * `docked` is a plain page inside Settings — ordinary document flow, no
     * window chrome. `floating` keeps the draggable overlay for anyone who
     * prefers it always visible.
     */
    function Panel(props) {
      const docked = props?.surface !== 'floating'
      const store = readStore()
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [selected, setSelected] = React.useState(store.project || '')
      const [collapsed, setCollapsed] = React.useState(Boolean(store.collapsed))
      const [pos, setPos] = React.useState(store.pos || null)
      const [configPath, setConfigPath] = React.useState('')
      const [configText, setConfigText] = React.useState('')
      const [configOpen, setConfigOpen] = React.useState(false)
      const [configDirty, setConfigDirty] = React.useState(false)
      const [aliasDraft, setAliasDraft] = React.useState(null)
      const [filter, setFilter] = React.useState('')
      const [portDraft, setPortDraft] = React.useState({})
      // The project the service reported last time we looked, so a change made
      // outside the panel is noticed and a stale pick does not win over it.
      const lastReportedRef = React.useRef(null)
      const dragRef = React.useRef(null)

      const refresh = React.useCallback(async () => {
        try {
          const next = await call('/state?contract=' + CLIENT_CONTRACT)
          if (!next || next.ok === false) {
            setError(next && next.error ? next.error : 'no answer from the host half')
            return
          }
          const reported = next.status?.project || null
          if (reported && reported !== lastReportedRef.current) {
            // The service moved; follow it unless this is the first reading.
            if (lastReportedRef.current !== null) setSelected(reported)
            lastReportedRef.current = reported
          }
          setState(next)
          // An outdated host answers with what it has, so the panel can still
          // show that, but the mismatch is stated rather than left to guess. A
          // host that predates the marker sends no contract at all.
          const hostContract = Number(next.contract)
          const outdated = next.outdated === true || !Number.isFinite(hostContract) || hostContract !== CLIENT_CONTRACT
          setError(outdated
            ? (next.error || 'the plugin host half is older than this panel — restart DeepSeek Harness to load the current code')
            : null)
          rememberOrigin(next.apiOrigin)
          if (!configPath && next.configFiles && next.configFiles.length) setConfigPath(next.configFiles[0])
        } catch (problem) {
          setError('cannot reach the plugin host half. Tried: ' + apiBases().join(', ') +
            '. Underlying error: ' + String(problem && problem.message ? problem.message : problem))
        }
      }, [configPath])

      React.useEffect(() => { refresh() }, []) // eslint-disable-line react-hooks/exhaustive-deps

      React.useEffect(() => { writeStore({ project: selected, collapsed, pos }) }, [selected, collapsed, pos])

      const run = React.useCallback(async (fn) => {
        setBusy(true)
        try {
          const result = await fn()
          if (result && result.ok === false) setError(result.error || 'operation failed')
          else setError(null)
          await refresh()
        } catch (problem) {
          setError(String(problem && problem.message ? problem.message : problem))
        } finally {
          setBusy(false)
        }
      }, [refresh])

      const status = (state && state.status) || {}
      const projects = (state && state.projects) || []
      const aliases = (state && state.aliases) || {}
      const services = (state && state.services) || []
      const activeProject = resolveActiveProject({
        selected,
        reportedProject: status.project || null,
        lastReported: lastReportedRef.current,
        projects,
      })
      // Actions aim at the project in the picker; the Services list is the
      // record of what is actually up.
      const views = projectViews(projects, aliases)
      const shownViews = filterViews(views, filter)
      const labelOf = (project) => aliases[project.path] || project.name
      /** A service row names its project the same way the picker does. */
      const aliasFor = (path) => (aliases[path] || (path ? path.replace(/\/+$/, '').split('/').pop() : ''))
      // Which projects already have a service, so the picker itself says what
      // is up instead of only the list further down.
      const runningProjects = new Map((services || [])
        .filter((service) => service.running && service.project)
        .map((service) => [service.project, service.port]))
      // The service belonging to the project in the picker — that pair decides
      // what the primary button offers.
      const selectedService = (services || []).find((service) => service.project === activeProject) || null
      const runningCount = (services || []).filter((service) => service.running).length
      const action = primaryAction(selectedService)
      const activeAlias = activeProject ? (aliases[activeProject] || '') : ''

      const loadConfig = React.useCallback(async (path) => {
        if (!path) return
        setBusy(true)
        try {
          const result = await call('/config?path=' + encodeURIComponent(path))
          if (result && result.ok) {
            setConfigText(result.content || '')
            setConfigDirty(false)
            setError(result.missing ? 'file does not exist yet — saving will create it' : null)
          } else {
            setError(result && result.error ? result.error : 'could not read the file')
          }
        } catch (problem) {
          setError(String(problem && problem.message ? problem.message : problem))
        } finally {
          setBusy(false)
        }
      }, [])

      React.useEffect(() => { if (configOpen && configPath && !configDirty) loadConfig(configPath) }, [configOpen, configPath]) // eslint-disable-line react-hooks/exhaustive-deps

      // A pending rename belongs to the project it was typed for.
      React.useEffect(() => { setAliasDraft(null) }, [activeAlias, activeProject])

      // Drag by the title bar; the stored position is clamped on render.
      const onPointerDown = (event) => {
        if (event.target.closest('button')) return
        const rect = event.currentTarget.parentElement.getBoundingClientRect()
        dragRef.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top }
        event.currentTarget.setPointerCapture(event.pointerId)
      }
      const onPointerMove = (event) => {
        if (!dragRef.current) return
        setPos({
          x: Math.max(0, Math.min(window.innerWidth - 120, event.clientX - dragRef.current.dx)),
          y: Math.max(0, Math.min(window.innerHeight - 40, event.clientY - dragRef.current.dy)),
        })
      }
      const onPointerUp = () => { dragRef.current = null }

      const anchored = pos
        ? { left: pos.x + 'px', top: pos.y + 'px', right: 'auto', bottom: 'auto' }
        : {}

      const header = h('div', {
        style: S.header,
        ...(docked ? {} : { onPointerDown, onPointerMove, onPointerUp, title: 'Drag to move' }),
      },
        h('span', { style: S.dot(status.running ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-idle-primary)') }),
        h('span', { style: S.title }, 'WSL · dsh projects'),
        docked
          ? null
          : h('button', {
              style: S.button,
              disabled: busy,
              onClick: () => setCollapsed((value) => !value),
            }, collapsed ? 'Expand' : 'Collapse'),
      )

      if (!docked && collapsed) return h('div', { style: { ...S.panel, ...anchored } }, header)

      const statusLine = status.running
        ? 'running · pid ' + (status.pid || '?') + ' · port ' + (status.port || '?')
        : status.managed
          ? 'stopped · unit ' + status.unit
          : 'stopped'

      const projectOptions = projects.map((project) =>
        h('option', { key: project.path, value: project.path },
          project.name + ' · ' + project.kind + (project.git ? ' · git' : '') + ' · ' + ago(project.modifiedAt)))

      // A port is remembered per project: the service's own once one exists,
      // otherwise whatever you typed last for that project.
      const portForProject = (path) => {
        const service = (services || []).find((entry) => entry.project === path)
        if (service?.port) return String(service.port)
        return portDraft[path] || ''
      }
      const displayedPort = portDraft[activeProject] ?? (selectedService?.port ? String(selectedService.port) : '')
      // `auto` and an empty field mean the same thing, so the panel reads a
      // typed "auto" as "no preference" rather than as an invalid number.
      const requestedPort = (() => {
        const raw = String(displayedPort ?? '').trim().toLowerCase()
        if (raw === '' || raw === 'auto') return undefined
        return /^[0-9]+$/.test(raw) ? Number(raw) : undefined
      })()

      const body = h('div', { style: S.body },
        error ? h('div', { style: S.error }, error) : null,

        // Services first: this is what is true right now, and the panel is
        // opened to find it out. Every control here acts on one named service.
        h('div', null,
          h('div', { style: S.sectionTitle }, 'Services'),
          services.length === 0
            ? h('div', { style: S.empty }, 'No service yet. Starting a project below creates one.')
            : null,
          ...services.map((service) => h('div', { key: service.unit, style: S.serviceRow },
            h('span', {
              style: S.dot(service.running ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-idle-primary)'),
              title: service.running ? 'running' : 'stopped',
            }),
            h('span', { style: S.serviceName }, aliasFor(service.project) || service.unit),
            h('span', { style: S.meta }, service.running ? 'running' : 'stopped'),
            h('span', { style: S.servicePort }, service.port ? 'port ' + service.port : ''),
            h('span', { style: { flex: 1 } }),
            service.running && service.url
              ? h('a', { style: S.link, href: service.url, target: '_blank', rel: 'noreferrer' }, 'Open')
              : null,
            service.running
              ? h('button', {
                  style: S.button,
                  disabled: busy,
                  title: 'Stop ' + service.unit + ' and disable it, so it stays stopped across restarts.',
                  onClick: () => run(() => post('/stop', { project: service.project, unit: service.unit })),
                }, 'Stop')
              : h('button', {
                  style: S.button,
                  disabled: busy,
                  title: 'Bring ' + service.unit + ' back up, on its own port.',
                  onClick: () => run(() => post('/restart', { project: service.project, unit: service.unit })),
                }, 'Start'),
            service.running
              ? h('button', {
                  style: S.button,
                  disabled: busy,
                  title: 'Restart ' + service.unit + ' in place — use it after editing a config.',
                  onClick: () => run(() => post('/restart-unit', { unit: service.unit })),
                }, 'Restart')
              : null,
            // A stopped service is only clutter unless you can take it away.
            service.running
              ? null
              : h('button', {
                  style: S.button,
                  disabled: busy,
                  title: 'Delete ' + service.unit + ' — stops it, disables it and removes the unit file.',
                  onClick: () => run(() => post('/remove-unit', { unit: service.unit })),
                }, 'Remove'),
          )),
        ),

        h('div', { style: S.divider }),

        // Then the one thing this panel can add: another project. The heading
        // and the button wording keep it apart from the controls above, because
        // two buttons both reading "Start" is what made this unreadable.
        h('div', { style: S.sectionTitle }, 'Start a project'),
        h('div', { style: S.row },
          h('input', {
            style: { ...S.input, width: '96px', flexShrink: 0 },
            value: filter,
            placeholder: 'filter',
            disabled: busy || projects.length === 0,
            title: 'Type to narrow the list — matches the name you gave a project or its folder.',
            onChange: (event) => setFilter(event.target.value),
          }),
          h('select', {
            style: S.select,
            value: activeProject,
            disabled: busy || projects.length === 0,
            onChange: (event) => {
              const path = event.target.value
              setSelected(path)
            },
          },
            projects.length === 0 ? h('option', { value: '' }, 'no projects found') : null,
            shownViews.length === 0 ? h('option', { value: '' }, 'nothing matches “' + filter + '”') : null,
            // The picked project stays selectable while filtered out, so typing
            // never silently changes what Start would act on.
            shownViews.every((view) => view.path !== activeProject) && activeProject
              ? h('option', { key: activeProject, value: activeProject },
                  (runningProjects.has(activeProject) ? '● ' : '') + aliasFor(activeProject) + ' · selected')
              : null,
            shownViews.map((view) => h('option', { key: view.path, value: view.path },
              (runningProjects.has(view.path) ? '● ' : '') + view.label +
              (runningProjects.has(view.path) ? ' — already running' : ' · ' + view.meta) +
              (view.alias ? ' (' + view.name + ')' : ''))),
          ),
        ),

        h('div', { style: S.row },
          h('span', { style: S.label }, 'Port'),
          h('input', {
            style: S.input,
            value: displayedPort,
            placeholder: 'auto',
            disabled: busy,
            title: 'Leave it as auto to take the first free port. A project that already has a service shows that port here.',
            onChange: (event) => {
              const value = event.target.value.replace(/[^0-9]/g, '')
              setPortDraft((draft) => ({ ...draft, [activeProject]: value }))
            },
          }),
          h('span', { style: S.meta }, status.version ? 'dsh ' + status.version : ''),
        ),

        h('div', { style: S.row },
          h('span', { style: S.label }, 'Name'),
          h('input', {
            style: { ...S.input, width: 'auto', flex: 1, minWidth: 0 },
            value: aliasDraft === null ? activeAlias : aliasDraft,
            placeholder: activeProject ? aliasFor(activeProject) : 'pick a project',
            disabled: busy || !activeProject,
            title: 'A short label for this project, used everywhere in the panel. Clear it to go back to the folder name.',
            onChange: (event) => setAliasDraft(event.target.value),
          }),
          h('button', {
            style: S.button,
            disabled: busy || !activeProject || aliasDraft === null,
            onClick: () => run(async () => {
              const result = await post('/alias', { path: activeProject, label: aliasDraft })
              if (result && result.ok) setAliasDraft(null)
              return result
            }),
          }, 'Save name'),
        ),

        h('div', { style: S.row },
          h('button', {
            style: S.primary,
            disabled: busy || !activeProject || selectedService?.running === true,
            title: selectedService?.running
              ? 'This project is already running. Stop it above first.'
              : 'Start this project as its own service on a free port. Other projects keep running.',
            onClick: () => run(async () => {
              const result = await post('/start', { project: activeProject, port: requestedPort })
              if (result && result.ok) {
                setPortDraft((draft) => ({ ...draft, [activeProject]: '' }))
              }
              return result
            }),
          }, busy ? '…' : 'Start a service for this project'),
        ),
        selectedService?.running
          ? h('div', { style: S.empty },
              aliasFor(activeProject) + ' is already running on port ' + selectedService.port + ' — use its row above.')
          : null,

        h('div', { style: S.divider }),
        // What is left is a summary of the machine, not a log: the distro, the
        // dsh version, and how many services are up. The per-service URLs live
        // in their own rows above, where the Open link needs them, so a single
        // stale "URL not published" line has no place here.
        h('div', { style: S.meta },
          (state?.distro ? state.distro + ' · ' : '') +
          'dsh ' + (status.version || '?') +
          ' · ' + runningCount + ' of ' + services.length + ' services running'),

        h('div', { style: S.divider }),
        h('div', { style: S.row },
          h('button', { style: S.button, onClick: () => setConfigOpen((value) => !value) }, configOpen ? 'Hide config' : 'Edit config'),
          h('select', {
            style: S.select,
            value: configPath,
            disabled: !configOpen,
            onChange: (event) => { setConfigPath(event.target.value); setConfigDirty(false) },
          },
            ((state && state.configFiles) || []).map((file) => h('option', { key: file, value: file }, file)),
          ),
        ),
        configOpen
          ? h('div', null,
              h('textarea', {
                style: S.textarea,
                value: configText,
                spellCheck: false,
                onChange: (event) => { setConfigText(event.target.value); setConfigDirty(true) },
              }),
              h('div', { style: { ...S.row, marginTop: '6px' } },
                h('button', {
                  style: S.primary,
                  disabled: busy || !configDirty,
                  onClick: () => run(async () => {
                    const result = await post('/config', { path: configPath, content: configText })
                    if (result && result.ok) setConfigDirty(false)
                    return result
                  }),
                }, 'Save'),
                h('button', { style: S.button, disabled: busy, onClick: () => loadConfig(configPath) }, 'Reload'),
                h('span', { style: S.meta }, configDirty ? 'unsaved changes' : 'in sync'),
              ),
            )
          : null,
      )

      if (docked) return h('div', { style: S.docked }, body)
      return h('div', { style: { ...S.panel, ...anchored } }, header, body)
    }

    /**
     * The sidebar seat: a trigger in the sidebar foot plus the panel it opens.
     * A cell of `sidebar.footer.action` is a whole component, exactly as the
     * host's own occupant of that slot is, so the trigger and its popover are
     * both owned here.
     */
    function FooterAction(props) {
      const [open, setOpen] = React.useState(false)
      const [hover, setHover] = React.useState(false)
      const [anchor, setAnchor] = React.useState(null)
      const rootRef = React.useRef(null)
      const placedRef = React.useRef(false)

      const place = () => {
        const rect = rootRef.current?.getBoundingClientRect?.()
        // The seat sits in the sidebar foot, so the popover opens upward from
        // that edge. Without a measurable rect the popover still opens, pinned
        // to the bottom-left corner, rather than failing to appear.
        setAnchor({
          left: rect ? Math.max(8, Math.min(rect.left, window.innerWidth - 480)) : 8,
          bottom: rect ? Math.max(8, window.innerHeight - rect.top + 8) : 8,
        })
      }

      // Anchor before paint, so the popover never renders unpositioned.
      if (open && !placedRef.current) {
        placedRef.current = true
        place()
      }

      React.useEffect(() => {
        if (!open) return undefined
        window.addEventListener('resize', place)
        return () => window.removeEventListener('resize', place)
      }, [open])

      const trigger = h('button', {
        type: 'button',
        style: hover || open
          ? { ...S.trigger, background: 'var(--dsw-alias-interactive-bg-hover)' }
          : S.trigger,
        title: 'WSL projects — pick a project, start or stop the WSL dsh',
        'aria-expanded': open ? 'true' : 'false',
        onClick: () => setOpen((value) => !value),
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
      },
        h('span', { style: S.dot('var(--dsw-alias-state-idle-primary)') }),
        h('span', { style: S.triggerLabel }, props?.wide === false ? 'WSL' : 'WSL projects'),
      )

      return h('div', { ref: rootRef, style: S.seat },
        trigger,
        open
          ? h('div', {
              style: { ...S.popover, left: (anchor?.left ?? 8) + 'px', bottom: (anchor?.bottom ?? 8) + 'px' },
              role: 'dialog',
              'aria-label': 'WSL projects',
              onKeyDown: (event) => { if (event.key === 'Escape') setOpen(false) },
            },
            h('div', { style: { ...S.row, marginBottom: '8px' } },
              h('span', { style: S.title }, 'WSL · dsh projects'),
              h('span', { style: { flex: 1 } }),
              h('button', { style: S.button, onClick: () => setOpen(false) }, 'Close'),
            ),
            h(Panel, { surface: 'settings' }),
          )
          : null,
      )
    }

    // ------------------------------------------------------------------ boot

    // The panel lives behind a button in the sidebar foot by default: the
    // control surface stays one click away without occupying the conversation
    // or a settings page. `settings` and `floating` remain available.
    const SURFACE = typeof window.__DSH_WSL_PROJECTS_SURFACE__ === 'string'
      ? window.__DSH_WSL_PROJECTS_SURFACE__
      : 'sidebar'

    // `inject` makes Cordis wait for the slots service before apply() runs, so
    // the registration below is a plain call rather than a poll. The retry loop
    // stays as a fallback for a host whose slot service appears late anyway.
    function apply(ctx) {
      ctx.effect(() => {
        let cancelled = false
        let attempts = 0
        const register = () => {
          const slots = ctx.get('slots')
          if (!slots || typeof slots.inject !== 'function') return false

          if (SURFACE === 'floating') {
            slots.inject('shell.overlay', () => slots.register(
              { name: 'shell.overlay', id: 'dsh-wsl-projects', order: 40 },
              (props) => Panel({ ...props, surface: 'floating' }),
            ))
            return true
          }

          if (SURFACE === 'settings') {
            slots.inject('settings.section', () => slots.register(
              {
                name: 'settings.section',
                id: 'wsl-projects',
                order: 30,
                label: () => 'WSL projects',
              },
              (props) => Panel({ ...props, surface: 'settings' }),
            ))
            return true
          }

          slots.inject('sidebar.footer.action', () => slots.register(
            { name: 'sidebar.footer.action', id: 'wsl-projects', order: 60 },
            FooterAction,
          ))
          return true
        }

        if (register()) return () => { cancelled = true }

        const timer = setInterval(() => {
          if (cancelled) return
          attempts += 1
          try {
            if (register()) { clearInterval(timer); return }
          } catch (error) {
            ctx.logger?.warn?.('dsh-wsl-projects: slot registration failed — %s', error?.message || error)
            clearInterval(timer)
            return
          }
          if (attempts > 200) clearInterval(timer)
        }, 150)

        return () => { cancelled = true; clearInterval(timer) }
      }, 'dsh-wsl-projects: panel')
    }

    return {
      apply,
      inject: ['slots'],
      // Exposed so the offline harness can assert the pure derivations without
      // standing in for a whole renderer.
      __testing: { resolveActiveProject, primaryAction, projectViews, filterViews, ago, apiBases, looksLikeOurAnswer },
    }
  },
})
