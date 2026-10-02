# dsh-wsl-projects

Run DeepSeek Harness (dsh) inside WSL2 and drive it from the Windows dsh app:
pick the project folder, start, stop and restart the WSL instance, choose its
port, and edit its config files — without opening a WSL terminal.

A floating panel appears in the dsh web UI. It talks to a host half that runs
inside the Windows dsh process and reaches WSL through `wsl.exe`.

> Verified against dsh `0.2.0-rc.2` (engine line `0.2.0`). Not affiliated with
> DeepSeek.

## Why

The usual setup is: `dsh web` runs inside a WSL distribution as a **systemd user
unit** (`dsh-web.service`, `Restart=always`), and you use it from a Windows
browser. Day-to-day that means remembering `systemctl --user restart`, editing
`WorkingDirectory=` in a unit file, and hand-editing `~/.dsh/**` over SSH — from
a different OS than the one you are looking at.

This plugin removes that hop. It is a control panel for exactly that instance.

## Features

- **Project list** — every directory under `~/projects` (configurable), newest
  first, annotated with kind (`node` / `python` / `rust` / `go` / `php`) and
  whether it is a git repository.
- **Start / Stop / Restart** — through `systemctl --user` when the WSL dsh is a
  unit, so a `Restart=always` unit really stays stopped. Falls back to killing
  the port listener, then to a detached spawn, on distributions without systemd.
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
  (`state`, `projects`, `distros`, `start`, `stop`, `restart`, `read_config`,
  `write_config`).

## Install

```powershell
dsh plugin --profile desktop add <path-or-github-spec>
```

For the Windows Desktop app use `--profile desktop`; for a plain `dsh web`
profile use `--profile web`. Then **restart that profile** — bundle membership
is a startup boundary. Open a new session and the panel appears bottom-right.

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

## Tests

Two harnesses run without a browser and without the plugin being installed:

```sh
node scripts/check-client.mjs   # client half: factory, slot, render, fetched state
node scripts/smoke.mjs          # host half: distros, projects, live status (needs WSL)
```

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
writes files under `~/.dsh/` inside your distribution, and its HTTP routes are
served on the loopback bind of the profile's own web server. Those routes carry
no origin check of their own — the same posture as a plugin route on a loopback
host, and the Desktop shell only forwards them for its own pages. Do not bind
the profile to a non-loopback host while relying on that.

## License

MIT
