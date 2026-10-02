# dsh-wsl-projects

The plugin runs one DeepSeek Harness web server for each project inside WSL2. The
panel in the Windows app starts, stops and opens them.

## What the plugin does

The panel has two sections.

**Services** shows every service. Each row gives the project, the state, the port
and these controls:

- **Open** opens the user interface of that service in your browser.
- **Stop** stops that service.
- **Start** starts that service again.
- **Restart** restarts that service.
- **Remove** deletes a stopped service.

The panel reads the state again every five seconds while it is open, and when the
window comes back. A service can stop on its own, and a link can go dead. The
panel shows what is true now, not what was true when it opened.

**Start a project** starts one project. The section holds a filter box, the
project picker, a name, a port and one button.

Each project gets its own service, its own port and its own dsh home. The
projects do not touch each other. You can run two projects at the same time.

## Requirements

- Windows with the DeepSeek Harness app.
- WSL2 with a Linux distribution.
- `dsh` in that distribution. The command must be in `PATH`.
- systemd in that distribution. The plugin uses `systemctl --user`.
- `bash` in that distribution.
- `~/projects` with your project folders. You can change this path. Refer to
  Configuration.

The plugin has one tested platform: WSL2 with Ubuntu. Other distributions are not
tested.

## Install

1. Run this command in a terminal on Windows:

   ```powershell
   dsh plugin --profile desktop add <path-or-github-spec>
   ```

   Use `--profile web` for a plain `dsh web` profile.

2. Quit the DeepSeek Harness app. Start it again.

A page reload is not sufficient. The app reads the two halves of the plugin at
different times. The panel arrives with the client half, and the client half is
part of the start sequence.

## Use

1. Open the panel. The panel is at the bottom right of the window. For the other
   positions, refer to Where the panel lives.
2. Select a project in **Start a project**.
3. Push **Start a service for this project**.
4. Push **Open** in the new row.

## Configuration

Add the settings to a profile patch:

```yaml
- id: wsl-projects
  name: dsh-wsl-projects
  config:
    distro: Ubuntu
    projectsRoot: ~/projects
    unit: dsh-web.service
    defaultPort: 19800
    configFiles:
      - ~/.dsh/settings.yaml
      - ~/.dsh/profiles/web/cordis.patch.yml
```

| Key | Meaning |
| --- | --- |
| `distro` | The distribution. An empty value uses the WSL default. |
| `projectsRoot` | The folder with your projects. |
| `unit` | The systemd user unit that owns the WSL dsh. |
| `defaultPort` | The first port for a new service. |
| `configFiles` | The files that the panel can edit. |

## Where the panel lives

The panel is in the sidebar foot. Two other positions are available. Set a global
before the bundle starts:

```js
window.__DSH_WSL_PROJECTS_SURFACE__ = 'settings'  // a page in Settings
window.__DSH_WSL_PROJECTS_SURFACE__ = 'floating'  // a movable panel
```

## The model

A project is the unit of control.

The plugin gives each project its own dsh home at
`~/.dsh/dsh-wsl-projects/homes/<folder>-<tag>/`. The tag comes from the path, so
two projects with the same folder name get separate homes. The launcher makes the
home at the first start. It copies the account from `~/.dsh` one time, so no
project asks for a login again. It writes the project into the workspace storage
of that home.

The separate homes are necessary. `dsh` opens the workspace that
`$DSH_HOME/storages/workspace.json` names. `dsh` does not compare that workspace
with the folder that started it. One home for all projects therefore makes every
service open the last project that you used.

Two more rules follow from the same cause:

- The plugin does not give one port to two projects. `dsh` identifies a browser
  by host and port. A session that belongs to one project answers on that port
  after another project takes the port.
- The plugin shows a link only after the server answers it. A token belongs to
  one process. A token from an earlier start is dead.

Sessions belong to a project. A conversation in one project does not appear in
another.

## Tests

Five checks need only Node:

```sh
node scripts/check-manifest.mjs      # manifest, exports, package contents
node scripts/check-client.mjs        # the client half
node scripts/check-theme-tokens.mjs  # the theme tokens
node scripts/check-bash.mjs          # the generated shell scripts
node scripts/check-pack.mjs          # the tarball installs and starts
```

`check-pack.mjs` packs the plugin, installs that tarball into a profile it makes
from a copy of yours, starts a server on it, and asks that server for the
plugin's route. A file left out of `files`, an export that does not resolve, or a
manifest that installs but does not load are all invisible from the checkout and
visible here. Without a profile it checks the tarball contents and says so.

The other checks need WSL or Linux:

```sh
node scripts/check-projects.mjs     # two projects, one port each
node scripts/check-urls.mjs         # every link answers
node scripts/check-legacy.mjs       # a unit from an older version
node scripts/check-shared-home.mjs  # the home decides the project
node scripts/check-alias.mjs        # the name store
node scripts/smoke.mjs              # the host half
```

These checks need a browser:

```sh
node scripts/check-ui.mjs      # a browser shows the correct project
node scripts/check-readme.mjs  # every claim in this file, one at a time
```

`check-readme.mjs` is the proof of this document. It holds one entry for each
claim, finds the evidence, and prints it. A claim with no evidence fails. Run it
after a change to the readme or to the plugin:

```sh
node scripts/check-readme.mjs
```

`check-shared-home.mjs` is an experiment. It starts two processes on one home
with two different folders, and it shows that both open the project the home
names. That is the reason for a home per project.

`npm run check` runs the four checks that need only Node. The CI workflow runs
the same four checks on Node 20, 22 and 24.

You can set `SMOKE_DISTRO`, `SMOKE_PROJECT`, `SMOKE_PROJECT_A`,
`SMOKE_PROJECT_B`, `DSH_ASAR` and `UI_BROWSER` for your machine.

## Troubleshooting

**The panel does nothing, and it says the host half is older.** The app runs the
host half from the moment it starts. Quit the app and start it again. A page
reload is not sufficient.

**Open shows the wrong project.** Look at the address. One port serves one
project, and each project has its own home. Start the project again, then push
Open in its own row.

**Open shows an error about authentication.** The link is old. Push Stop, then
Start. The panel checks a link before it shows it.

**A project asks for a login again.** The home of that project holds a copy of
the account, and the copy does not follow a later change in `~/.dsh`. Remove the
copy, then start the project:

```sh
rm ~/.dsh/dsh-wsl-projects/homes/<folder>-<tag>/.credentials.yaml
```

**A service does not start.** Look at its log:

```sh
journalctl --user -u dsh-web-<folder>-<tag>.service -n 40
```

## Security

The plugin uses your rights. It runs `systemctl --user`. It reads and writes
files in the distribution. It accepts a request from the panel only. A request
with a different origin gets an error.

## License

MIT. Refer to LICENSE.
