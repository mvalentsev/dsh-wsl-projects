# dsh-wsl-projects

Run DeepSeek Harness (dsh) inside WSL2 and drive it from the Windows dsh app:
pick the project folder, start, stop and restart the WSL instance, choose its
port, and edit its config files — without opening a WSL terminal.

The panel opens from a **button in the sidebar foot**: one click, in place, no
window to move around. Two other homes remain selectable; see
[Where the panel lives](#where-the-panel-lives).

> Verified against dsh `0.2.0-rc.2` (engine line `0.2.0`). Not affiliated with
> DeepSeek.

## Why

The usual setup is: `dsh web` runs inside a WSL distribution as a **systemd user
unit** (`dsh-web.service`, `Restart=always`), and you use it from a Windows
browser. Day-to-day that means remembering `systemctl --user restart`, editing
`WorkingDirectory=` in a unit file, and hand-editing `~/.dsh/**` over SSH — from
a different OS than the one you are looking at.

This plugin removes that hop. It is a control panel for exactly that instance.

## Where the panel lives

By default the plugin takes a seat in **`sidebar.footer.action`**: a button in
the sidebar foot that opens the panel next to itself, anchored above the button.
A cell of that slot is a whole component — the host's own occupant of it works
the same way — so the trigger and the popover it opens are both owned here, and
nothing floats over the conversation until you ask for it.

Two other homes are selectable through a global the shell can set before the
bundle materialises:

```js
window.__DSH_WSL_PROJECTS_SURFACE__ = 'settings'  // a page under Settings
window.__DSH_WSL_PROJECTS_SURFACE__ = 'floating'  // a draggable overlay
```

All three render the same component and call the same routes; only the slot and
the chrome differ.

## The model

**A project is the unit of control.** Each project has at most one service, and
that service has its own port. Nothing is global, so there is no mode to switch
and no single "current project" to lose track of.

The panel is two sections, in the order the questions get asked.

**Services** — what exists right now, one row per service: a state dot, the
project, `running` or `stopped`, its port, and the controls that act on *that
service* — `Open` while it runs, `Stop` or `Start`, and `Restart`. A stopped
service stays in the list, and the panel reads unit files as well as loaded
units, because systemd unloads a disabled unit and `list-units` alone would drop
exactly the services you wanted to see.

**Start a project** — the one thing the panel can add: a filter box, the project
picker, an optional short name, an optional port, and a single button reading
**Start a service for this project**. Starting a project creates its service on
a free port and never touches another, so running several at once is that same
action repeated on another project.

Two rules keep this readable, both learned from a screenshot where two buttons
read "Start" with different meanings:

1. **Every control names its scope.** A button inside a service row acts on that
   row; the button in the lower section acts on the picked project. No label is
   reused between the two.
2. **Nothing is offered that cannot work.** While the picked project already
   runs, its start button is disabled and says why, instead of starting a
   duplicate or silently re-pointing the running service.

`Stop` also disables the service, so a `Restart=always` unit stays down instead
of coming back at the next boot. `Restart` re-enables it.

## Features

- **Project list** — every directory under `~/projects` (configurable), listed
  alphabetically by the name you see and annotated with kind (`node` / `python`
  / `rust` / `go` / `php`), git presence and recency, with a filter box beside
  the picker so a long list stays navigable. Alphabetical rather than by
  modification time, because a list that reorders whenever a file is touched is
  hard to navigate.
- **Project names** — give a project a short label ("Radio Station") and the
  panel shows that everywhere instead of the folder name. Labels live in
  `~/.dsh/dsh-wsl-projects/aliases.json` inside the distribution, keyed by
  absolute path, so a project outside the projects root can be pinned too.
  Clearing the field restores the folder name.
- **Start / Stop / Restart** — through `systemctl --user` when the WSL dsh is a
  unit, so a `Restart=always` unit really stays stopped. Falls back to killing
  the port listener on distributions without systemd. One button per project,
  deciding from that project's own state; see [The model](#the-model).
- **Several projects at once** — an ordinary consequence of the model above,
  verified on a real machine: `dsh-web.service` on 19800 for `dev` and
  `dsh-web-llm.service` on 19801 for `llm` ran side by side, stopping one left
  the other running, and the stopped one came back on the port it had. The
  shared `~/.dsh` state directory did not clash.
- **Switch project** — rewrites `WorkingDirectory` as a systemd drop-in
  (`dsh-web.service.d/override.conf`) and restarts the unit. **The port is
  preserved** when you only change the project.
- **Choose the port** — same drop-in, `ExecStart` rewritten with the new
  `--port`.
- **Open the WSL UI** — the panel shows the launch URL *including* the one-shot
  `?token=`. Because a stop deletes `~/.dsh/web-url.txt`, the token is recovered
  from the unit journal so the link keeps working.
- **Config editor** — read and write `~/.dsh/settings.yaml` and the profile's
  `cordis.patch.yml` in place.
- **Create service** — when no unit exists yet, writes one and enables it.
- **Agent tool** — the same operations are exposed to the model as `wsl_dsh`
  (`state`, `units`, `projects`, `distros`, `start`, `stop`, `restart`,
  `stop_unit`, `restart_unit`, `read_config`, `write_config`, `set_alias`), all
  built on the same project model.

## Install

```powershell
dsh plugin --profile desktop add <path-or-github-spec>
```

For the Windows Desktop app use `--profile desktop`; for a plain `dsh web`
profile use `--profile web`. Then **restart that profile** — bundle membership
is a startup boundary. Open a new session and the panel appears bottom-right.

A running profile does hot-reload its `cordis.patch.yml`, so inserting the row
yourself activates the **host half** immediately — verified against a live
Desktop app, whose routes answered with real WSL data right after the edit:

```yaml
# ~/.dsh/profiles/desktop/cordis.patch.yml
- insert:
    - id: wsl-projects
      name: "dsh-wsl-projects"
```

That shortcut does **not** deliver the panel. A Desktop window does not serve
client bundles over the `/plugins` HTTP route at all — the route answers 404 for
the shipped plugins too — so the client half travels through the shell's own
bundle carrier, which is composed at startup. **Restart the app** to get the
panel; the patch row above is only useful for exercising the host half during
development, and it is safe to remove once the bundle is in
`dsh.profile.bundles`.

Three sources work, and none of them needs a build step or a `prepare` script:
the client bundle is committed to `lib/`, so pnpm never has to allowlist a
build.

```powershell
# a local checkout
dsh plugin --profile desktop add C:\path\to\dsh-wsl-projects

# a git repository, pinned to a commit for safety
dsh plugin --profile desktop add github:OWNER/dsh-wsl-projects#<sha>

# an npm release, once published
dsh plugin --profile desktop add dsh-wsl-projects
```

`node scripts/check-client.mjs` is worth running before installing a checkout:
it fails loudly on a broken client bundle.

## Publishing

`npm pack --dry-run` shows the nine files that ship; the tarball carries
`package.json`, the patch file, the host and client halves, the license, the
readme and the changelog. The two harnesses stay out of the package on purpose.

```sh
npm pack --dry-run     # inspect contents
npm publish            # requires an npm account with rights to the name
git push origin main   # for the github: source
```

Community catalogues such as
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
accept a pull request adding one entry per plugin.

## Configuration

Settings may be passed as the plugin row's `config` in a profile patch:

```yaml
- id: wsl-projects
  name: dsh-wsl-projects
  config:
    distro: Ubuntu                 # empty = WSL default distribution
    projectsRoot: ~/projects       # where your project folders live
    unit: dsh-web.service          # systemd user unit that owns the WSL dsh
    defaultPort: 19800             # used when the panel's port field is empty
    configFiles:
      - ~/.dsh/settings.yaml
      - ~/.dsh/profiles/web/cordis.patch.yml
```

## How it works

```
Windows dsh process                        WSL distribution
┌───────────────────────────┐              ┌──────────────────────────────┐
│ panel (lib/client.js)     │              │ dsh-web.service              │
│   fetch /wsl-projects/api │              │   dsh --profile web --port … │
│ host (lib/index.js)       │  wsl.exe     │                              │
│   controller.js ──────────┼─────────────▶│ systemctl --user …           │
│     scripts.js (bash)     │   stdin      │ ~/projects, ~/.dsh/**        │
└───────────────────────────┘              └──────────────────────────────┘
```

Three details are load-bearing, each learned the hard way:

1. **Bash travels over stdin, not argv.** A command line has to survive Node's
   quoting, `wsl.exe`'s argument rewriter and bash; measured on Windows 11 that
   mangles `$VAR` and `case` patterns. `bash -s` with the script on stdin has
   none of those layers.
2. **`wsl.exe` is inconsistent about encoding.** Management verbs (`-l -v`,
   `--status`) write UTF-16LE to a pipe; a Linux command writes UTF-8. stdout is
   captured as bytes and sniffed.
3. **systemd owns the process.** A `Restart=always` unit restarts a killed dsh
   within seconds. Every lifecycle operation therefore goes through
   `systemctl --user`; killing a PID only works when no unit exists.

The panel reaches the host half by a **relative** `fetch` on purpose. The
Windows Desktop shell does not serve the UI from the HTTP server: it serves the
page over the privileged `dsh-app://app/` scheme and forwards every non-asset
path to the loopback server, replacing the `cookie` header with the shell's own
session cookie (Electron's `forwardWebRequest`). A relative call therefore works
in the Desktop app and in a plain browser with no CORS involvement. The host
half also reports the loopback origin it is bound to in `GET …/api/state`, and
the panel stores it, so a direct absolute call remains available as a fallback.

## Theming

The panel owns no colour of its own. Every value comes from the host's
`--dsw-alias-*` tokens, read bare — with no literal fallback — so the light and
dark schemes are whatever the host says they are, and switching the OS scheme
re-renders the panel with it.

The app themes itself by following `prefers-color-scheme` (there is no in-app
toggle): the light values sit on `body` and a
`@media (prefers-color-scheme: dark) { body { … } }` block re-points them. The
tokens this panel uses are among those re-pointed, which is why it follows:

| Token | Light | Dark |
| --- | --- | --- |
| `--dsw-alias-label-primary` | `#0f1115` | `#f9fafb` |
| `--dsw-alias-label-secondary` | `#61666b` | `#cfd3d6` |
| `--dsw-alias-border-l2` | `#0000001a` | `#ffffff1f` |
| `--dsw-alias-button-elevated-fill` | `#fff` | `#43454a` |
| `--dsw-alias-label-primary-inverted` | `#fff` | `#353638` |

Two rules follow from a bug this project actually shipped, where the panel
rendered a white card with near-black text on a dark theme:

1. **Never invent a token name.** The panel had asked for
   `--dsw-alias-bg-elevated`, `--dsw-alias-success`, `--dsw-label-error`,
   `--dsw-bg-error`, `--dsw-border-error` and `--dsw-shadow-lg`; none exist.
2. **Never pair a token with a colour literal.** `var(--dsw-alias-label-primary, #1f2329)`
   renders near-black text in dark mode, because the fallback only applies when
   the token is missing — and the missing token is exactly the case that hides
   the mistake.

`scripts/check-theme-tokens.mjs` enforces both: it reads the installed engine's
token inventory (423 tokens), fails on any token the panel invents, and fails on
any colour literal used as a `var()` fallback. It is part of `npm run check` and
of CI.

## Tests

Three harnesses run without a browser and without the plugin being installed:

```sh
node scripts/check-manifest.mjs    # manifest, exports, packaging invariants
node scripts/check-client.mjs      # client half: factory, slot, render, decisions
node scripts/check-theme-tokens.mjs # theme token existence and no colour literals
node scripts/check-projects.mjs    # the project model against a real distribution
node scripts/smoke.mjs             # host half: distros, projects, live status (needs WSL)
```

`npm run check` runs the first three, which is also what
[`.github/workflows/checks.yml`](.github/workflows/checks.yml) runs on Node 20,
22 and 24 for every push and pull request.

`check-projects.mjs` starts a second project beside the one it finds, checks
that both run, that stopping one leaves the other alone, that a stopped project
returns on the port it had, and then removes the service it created — so a
machine ends the way it started.

`check-manifest.mjs` is the gate that keeps a release installable. It asserts
the `dsh` manifest shape (`manifestVersion`, `bundle.patch` as a path or list,
`client.platform`), that every declared path resolves on disk, that the packaged
`files` list covers `lib` and the patch file, and — the invariant learned the
hard way — that the package declares **no** `@deepseek-ai/dsh-*` peer range,
because a range outside the running line makes `dsh plugin add` reject the
package outright. It also reads the client bundle to confirm it is a plain
browser script: no `import` statement, registers through
`window.__ModuleLoader__`, requires nothing beyond `react`.

`check-client.mjs` loads the real `lib/client.js` with the globals the shell
provides (`window.__ModuleLoader__`, `localStorage`, `location`, `fetch`) and a
stub `react`, then drives the plugin through a stubbed Cordis context: it
asserts the factory shape, that `apply()` registers into `shell.overlay`, that
the panel renders, and — after letting the host answer — that the fetched state
reaches the panel (project list, unit name, port, version, token link). It
cannot judge pixels; it catches a broken bundle, a wrong slot, a bad export and
a crash inside `apply()` or the render pass.

`smoke.mjs` exercises the host half against a real distribution.

## Security

The plugin runs with your permissions. It executes `systemctl --user`, reads and
writes files under `~/.dsh/` inside your distribution, and serves its routes on
the loopback bind of the profile's own web server.

Because a stopped service and a rewritten config file are real consequences, the
routes carry an origin policy. An allowed request is one with no `Origin` header
(a loopback probe, the server-side agent tool) or one whose `Origin` is the
Desktop shell's `dsh-app://app` or this server's own origin. Anything else is
refused with `403` before an operation runs, so an arbitrary page open in a
browser cannot drive the plugin:

| Request | Result |
| --- | --- |
| no `Origin` | allowed |
| `Origin: dsh-app://app` | allowed (this is how the Desktop panel calls in) |
| the plugin's own origin | allowed, echoed in `access-control-allow-origin` |
| any other origin, including a mutation | `403` |

This is not authentication: a process running as you on this machine can still
reach the loopback port directly. Do not bind the profile to a non-loopback host
while relying on it.

## License

MIT
