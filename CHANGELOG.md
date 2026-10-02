# Changelog

## 0.2.0

The project becomes the unit of control, and each project gets its own dsh home.
The version is bumped because both change behaviour in ways a user will notice:
services are created and removed per project, the panel is laid out differently,
and sessions now belong to a project rather than to the machine.

### Added

- **A dsh home per project.** Each service runs with `DSH_HOME` set to
  `~/.dsh/dsh-wsl-projects/homes/<folder>/`, seeded once from the shared
  `~/.dsh` (account, settings, profile configuration) with the workspace storage
  written to name that service's project. Sessions are therefore per project.
- **`Remove`** for a stopped service: stops it, disables it, and deletes the unit
  along with its URL, port and log records.
- **A filter box** beside the project picker, matching a label or a folder name.
- **URLs per service.** Each service records its own token URL, and a URL is
  offered only after the server has answered it.
- **`starting…`** as a state distinct from `running`: systemd reports a unit with
  `Restart=always` as active while it is still coming up, which is not the same
  as serving.
- **Checks that read the result, not the intention**: `scripts/check-ui.mjs`
  opens each service in a real browser over the debugging protocol and reads the
  project it shows; `scripts/check-urls.mjs` requests every offered URL over
  HTTP; `scripts/check-legacy.mjs` builds a unit exactly as an older version
  wrote it and asserts it still opens its own project; `scripts/check-bash.mjs`
  runs `bash -n` over every generated script.

### Changed

- The panel is two named sections: **Services** (what exists, one row per
  service, every control scoped to that row) and **Start a project** (filter,
  picker, name, port, and one button reading *Start a service for this project*).
- `Start` acts on the picked project only. There is no separate command for
  running several projects, because starting one never touches another.
- `Stop` also disables the unit, so a `Restart=always` service stays down.
- Ports are never reused between projects, including a stopped one's. dsh
  authenticates a browser by host and port, so a session opened for one project
  would otherwise keep answering on that port for the next one.
- Projects are listed alphabetically by the name you see, with a natural order,
  rather than by modification time.
- `Run also` and the ambiguous `Restart` label are gone.

### Fixed

- **Opening one project served another.** The cause was never the port or the
  token: dsh opens the workspace recorded in `$DSH_HOME/storages/workspace.json`
  and does not compare it with its working directory, so one shared home meant
  every service served whichever project was opened last. Recorded here because
  the symptom invites fixing the wrong thing.
- A unit written by an older version carries no project argument and may set
  `DSH_HOME` to the shared home. The launcher now reads the project from the
  unit's own `WorkingDirectory`, found through the `INVOCATION_ID` systemd sets,
  so such a unit is repaired on its next start.
- A home with an empty workspace storage makes dsh render *"choose a workspace"*
  rather than opening its working directory; the project is now recorded
  explicitly.
- `Start` on an already-running service cleared its URL before noticing the
  service was up.
- Dead tokens were offered as working links. A token belongs to one process.
- A disabled unit is unloaded, so `list-units` alone dropped exactly the stopped
  services the panel promises to show.
- The panel used theme tokens that do not exist and carried colour literals as
  fallbacks, which is what made it unreadable in a dark theme. Only tokens that
  exist in the engine are used, without fallbacks, and a gate enforces it.
- `--port null` could be written into `ExecStart`; an empty field now means
  "choose a free port" and anything else is rejected before a unit is written.

### Known limits

- `systemctl --user` requires systemd in the distribution and a live user bus.
- The origin policy is not authentication: a local process running as the same
  user can reach the loopback port directly.
- A service created while an older host half is loaded in the app is repaired on
  its next start, but only after the app is restarted does the panel itself run
  the current code. The panel detects a host that is a generation behind, says
  so, and withholds its actions rather than attempting them.

## 0.1.0

First release. Manages a DeepSeek Harness instance running inside WSL2 from the
Windows dsh app.

### Added

- Project list from `~/projects` (configurable), annotated with project kind and
  git presence.
- Project labels: a short name per project, kept in
  `~/.dsh/dsh-wsl-projects/aliases.json` inside the distribution and used by the
  panel wherever the folder name would appear.
- Start / Stop / Restart through `systemctl --user` when the WSL dsh is a systemd
  unit, so a `Restart=always` unit really stays stopped. Falls back to killing
  the port listener, then to a detached spawn, without systemd.
- Token URL surfaced in the panel, recovered from the unit journal when
  `~/.dsh/web-url.txt` is absent (a stop removes it).
- Config editor for `~/.dsh/settings.yaml` and the profile's
  `cordis.patch.yml`.
- Service creation: writes a user unit and enables it when none exists.
- `wsl_dsh` agent tool exposing the same operations.
- REST surface under `/wsl-projects/api/` with an origin policy: a request is
  accepted only with no `Origin` header, or with the Desktop shell's
  `dsh-app://app` origin, or with this server's own origin; anything else is
  refused with `403` before an operation runs.

### Verified against

- dsh engine `0.2.0-rc.2`, Windows Desktop build (`dsh-client-modules` boot
  graph, `dsh-app://app/` request forwarding).
- WSL2 Ubuntu, `dsh-web.service` user unit, `Restart=always`.
