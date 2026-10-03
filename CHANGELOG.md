# Changelog

## Unreleased

- The readme images follow the viewer: the banner and the architecture diagram
  gained a light and a dark variant, and every image gained a narrow variant
  for small screens.
- The panel illustration is gone. The readme now shows screenshots of the real
  panel, and `scripts/capture-panel.mjs` takes them again from a running app.
- `check-assets.mjs` renders the readme's images in a browser and fails when a
  dark variant is not darker, or a narrow SVG does not follow the scheme.
- The browser checks speak Chrome's debugging protocol over a WebSocket, which
  Node 20 does not have: they report that and are skipped there, instead of
  failing CI on the Node 20 leg of the matrix.

## 0.2.2

- The package ships the images the readme references, so the npm page shows the
  banner, the panel and the architecture diagram instead of broken links.

## 0.2.1

- The package names its repository, its home page and its issue tracker, so the
  npm page links to the source.
- The readme is written for the reader who wants to use the plugin. The check
  suite and the development notes moved to CONTRIBUTING.md. The repository
  gained a banner, a panel illustration, an architecture diagram and a social
  preview.

## 0.2.0

First release.

### What it does

- The plugin runs one DeepSeek Harness web server for each project inside WSL2.
  The panel in the Windows app starts, stops and opens them.
- Each project has its own systemd user service, its own port and its own dsh
  home. The projects do not touch each other.

### The panel

- **Services** lists every service. Each row shows the project, the state, the
  port, and the controls for that row: Open, Stop, Start, Restart, Remove.
- **Start a project** holds a filter box, the project picker, a name, a port,
  and one button. The button starts the picked project.
- The picker lists projects in alphabetical order.
- A name is a short label for a project. The panel uses the label in place of the
  folder name.
- The panel edits `~/.dsh/settings.yaml` and the profile's `cordis.patch.yml`.

### The service

- A service runs under `systemctl --user`. Stop also disables the service, so a
  service with `Restart=always` stays down.
- `~/.dsh/dsh-wsl-projects/homes/<folder>-<tag>/` is the dsh home of one
  project. The tag comes from the path, so two projects with the same folder name
  in different places get separate homes. The launcher makes the home on the
  first start and copies the account from `~/.dsh`, so no project asks for a
  login again.
- A service records the URL of its own user interface, token included. The panel
  shows the link after the server answers it.
- The plugin writes shell scripts and starts them inside the distribution. It
  needs `bash`, and it needs systemd for the service control.

### For other programs

- The REST surface is at `/wsl-projects/api/`.
- The agent tool `wsl_dsh` gives the model the same operations.

### Known limits

- The plugin uses `systemctl --user`. A distribution without systemd uses a
  fallback that kills the port listener, and that fallback does not survive a
  restart of the distribution.
- The origin check is not authentication. A local process with the same user
  rights can reach the loopback port.
- Sessions belong to a project. A conversation in one project does not appear in
  another.
