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
      button: {
        padding: '4px 10px', fontSize: '13px', cursor: 'pointer',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-button-elevated-fill)',
        border: HAIRLINE, borderRadius: 'var(--dsw-radius-sm, 6px)',
      },
      primary: {
        padding: '4px 10px', fontSize: '13px', cursor: 'pointer',
        color: 'var(--dsw-alias-label-primary-inverted)',
        background: 'var(--dsw-alias-button-primary-fill)',
        border: HAIRLINE, borderRadius: 'var(--dsw-radius-sm, 6px)',
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

    /** Which project the panel acts on: what runs, else what you picked, else the newest. */
    function resolveActiveProject(status, projects, selected) {
      return status?.project || selected || projects?.[0]?.path || ''
    }

    /** The dropdown entries: alias first, then kind, git flag and recency. */
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
      })
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
      const [port, setPort] = React.useState(store.port || '')
      const [collapsed, setCollapsed] = React.useState(Boolean(store.collapsed))
      const [pos, setPos] = React.useState(store.pos || null)
      const [configPath, setConfigPath] = React.useState('')
      const [configText, setConfigText] = React.useState('')
      const [configOpen, setConfigOpen] = React.useState(false)
      const [configDirty, setConfigDirty] = React.useState(false)
      const [aliasDraft, setAliasDraft] = React.useState(null)
      const dragRef = React.useRef(null)

      const refresh = React.useCallback(async () => {
        try {
          const next = await call('/state')
          if (!next || next.ok === false) {
            setError(next && next.error ? next.error : 'no answer from the host half')
            return
          }
          setState(next)
          setError(null)
          rememberOrigin(next.apiOrigin)
          if (!configPath && next.configFiles && next.configFiles.length) setConfigPath(next.configFiles[0])
          if (!port && next.defaultPort) setPort(String(next.defaultPort))
        } catch (problem) {
          setError('cannot reach the plugin host half. Tried: ' + apiBases().join(', ') +
            '. Underlying error: ' + String(problem && problem.message ? problem.message : problem))
        }
      }, [configPath, port])

      React.useEffect(() => { refresh() }, []) // eslint-disable-line react-hooks/exhaustive-deps

      React.useEffect(() => { writeStore({ project: selected, port, collapsed, pos }) }, [selected, port, collapsed, pos])

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
      const distros = (state && state.distros) || []
      const aliases = (state && state.aliases) || {}
      const activeProject = resolveActiveProject(status, projects, selected)
      const views = projectViews(projects, aliases)
      const labelOf = (project) => aliases[project.path] || project.name
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

      const body = h('div', { style: S.body },
        error ? h('div', { style: S.error }, error) : null,

        h('div', { style: S.row },
          h('span', { style: S.label }, 'Distro'),
          h('select', {
            style: S.select,
            value: (state && state.distro) || '',
            disabled: true,
            title: 'Distributions found by wsl.exe. The plugin acts on the one its own config names (config.distro), or the WSL default.',
          },
            h('option', { value: '' },
              state && state.distro
                ? state.distro
                : 'WSL default · ' + distros.filter((d) => d.name && !d.name.includes('docker-desktop')).length + ' available'),
          ),
        ),

        h('div', { style: S.row },
          h('span', { style: S.label }, 'Project'),
          h('select', {
            style: S.select,
            value: activeProject,
            disabled: busy || projects.length === 0,
            onChange: (event) => setSelected(event.target.value),
          },
            projects.length === 0 ? h('option', { value: '' }, 'no projects found') : null,
            views.map((view) => h('option', { key: view.path, value: view.path },
              view.label + ' · ' + view.meta + (view.alias ? ' (' + view.name + ')' : ''))),
          ),
        ),

        h('div', { style: S.row },
          h('span', { style: S.label }, 'Name'),
          h('input', {
            style: { ...S.input, width: 'auto', flex: 1, minWidth: 0 },
            value: aliasDraft === null ? activeAlias : aliasDraft,
            placeholder: activeProject ? (activeProject.split('/').pop() || 'project') : 'pick a project',
            disabled: busy || !activeProject,
            title: 'Short label for the selected project, kept in ~/.dsh/dsh-wsl-projects/aliases.json inside WSL. Clear it to go back to the folder name.',
            onChange: (event) => setAliasDraft(event.target.value),
          }),
          h('button', {
            style: S.primary,
            disabled: busy || !activeProject || aliasDraft === null,
            onClick: () => run(async () => {
              const result = await post('/alias', { path: activeProject, label: aliasDraft })
              if (result && result.ok) setAliasDraft(null)
              return result
            }),
          }, 'Save name'),
        ),

        h('div', { style: S.row },
          h('span', { style: S.label }, 'Port'),
          h('input', {
            style: S.input,
            value: port,
            inputMode: 'numeric',
            disabled: busy,
            onChange: (event) => setPort(event.target.value.replace(/[^0-9]/g, '')),
          }),
          h('span', { style: S.meta }, status.version ? 'dsh ' + status.version : ''),
        ),

        h('div', { style: S.row },
          h('button', {
            style: S.primary,
            disabled: busy || status.running,
            onClick: () => run(() => post('/start', { project: activeProject, port: Number(port) || undefined })),
          }, busy ? '…' : 'Start'),
          h('button', {
            style: S.button,
            disabled: busy || !status.running,
            onClick: () => run(() => post('/stop', {})),
          }, 'Stop'),
          h('button', {
            style: S.button,
            disabled: busy,
            title: 'Restart the WSL dsh. The current project and the port field are written as a systemd drop-in first.',
            onClick: () => run(() => post('/restart', { project: activeProject, port: Number(port) || undefined })),
          }, 'Restart'),
          h('button', { style: S.button, disabled: busy, onClick: () => refresh() }, 'Refresh'),
          status.managed
            ? null
            : h('button', {
                style: S.button,
                disabled: busy || !activeProject,
                title: 'Create a systemd user unit so dsh starts with the distribution and survives a restart',
                onClick: () => run(() => post('/start', { project: activeProject, port: Number(port) || undefined, createUnit: true })),
              }, 'Create service'),
        ),

        h('div', { style: S.divider }),
        h('div', { style: S.meta }, statusLine),
        status.managed
          ? h('div', { style: S.meta },
              'systemd unit ' + status.unit + ' · ' + (status.active || '?') +
              (status.restarts ? ' · ' + status.restarts + ' restarts' : ''))
          : h('div', { style: S.meta }, 'no systemd unit found for dsh in this distribution'),
        status.url
          ? h('div', null,
              h('a', {
                style: S.link,
                href: status.url,
                target: '_blank',
                rel: 'noreferrer',
              }, 'Open the WSL dsh UI ↗'))
          : (status.running ? h('div', { style: S.meta }, 'URL not published yet — press Refresh in a moment.') : null),

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
      __testing: { resolveActiveProject, projectViews, ago, apiBases, looksLikeOurAnswer },
    }
  },
})
