# Changelog

## 0.1.0

First release. Manages a DeepSeek Harness instance running inside WSL2 from the
Windows dsh app.

### Added

- Floating panel (`shell.overlay`) with a project list from `~/projects`
  (configurable), newest first, annotated with project kind and git presence.
- Start / Stop / Restart that go through `systemctl --user` when the WSL dsh is
  a systemd unit, so a `Restart=always` unit really stays stopped. Falls back to
  killing the port listener, then to a detached spawn, without systemd.
- Project switching and port selection written as a systemd drop-in
  (`<unit>.d/override.conf`). A project-only change preserves the port.
- Token URL surfaced in the panel, recovered from the unit journal when
  `~/.dsh/web-url.txt` is absent (a stop removes it).
- Config editor for `~/.dsh/settings.yaml` and the profile's
  `cordis.patch.yml`.
- Service creation: writes a user unit and enables it when none exists.
- `wsl_dsh` agent tool exposing the same operations
  (`state`, `projects`, `distros`, `start`, `stop`, `restart`, `read_config`,
  `write_config`).
- REST surface under `/wsl-projects/api/` with an origin policy: a request is
  accepted only with no `Origin` header, or with the Desktop shell's
  `dsh-app://app` origin, or with this server's own origin; anything else is
  refused with `403` before an operation runs.
- Two offline harnesses: `scripts/check-client.mjs` (client half, 29 checks) and
  `scripts/smoke.mjs` (host half against a real distribution).

### Verified against

- dsh engine `0.2.0-rc.2`, Windows Desktop build (`dsh-client-modules` boot
  graph, `dsh-app://app/` request forwarding).
- WSL2 Ubuntu, `dsh-web.service` user unit, `Restart=always`.

### Known limits

- The panel's appearance has been verified only through the served boot graph
  and the client harness, not visually in a running Desktop window.
- `systemctl --user` requires systemd in the distribution and a live user bus;
  distributions without it take the spawn fallback, which cannot survive a
  distribution restart.
- The origin policy is not authentication: a local process running as the same
  user can reach the loopback port directly.
