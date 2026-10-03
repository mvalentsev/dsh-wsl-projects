# Contributing

The plugin is plain JavaScript on both halves: no build step, no transpiler.
The host half (`lib/`) runs in Node, the client half (`lib/client.js`) runs in
the app's web shell, and the shell scripts it drives inside the distribution are
generated from templates in `lib/scripts.js`.

## The checks

One command runs everything:

```sh
npm run check            # every check, in one sequence
npm run check:offline    # only the checks that need no distribution
```

It prints one line per check, and a check that cannot run on this machine is
reported as skipped with the reason. Nothing passes silently.

The checks, and what each one needs:

```sh
node scripts/check-manifest.mjs      # manifest, exports, package contents   (Node)
node scripts/check-client.mjs        # the client half                       (Node)
node scripts/check-theme-tokens.mjs  # the theme tokens                      (Node)
node scripts/check-assets.mjs        # the readme images render, per theme   (browser)
node scripts/check-bash.mjs          # the generated shell scripts           (Node, bash when reachable)
node scripts/check-pack.mjs          # the tarball installs and starts       (Node, a profile)
node scripts/check-projects.mjs      # two projects, one port each           (distribution)
node scripts/check-urls.mjs          # every link answers                    (distribution)
node scripts/check-legacy.mjs        # a unit from an older version          (distribution)
node scripts/check-shared-home.mjs   # the home decides the project          (distribution)
node scripts/check-alias.mjs         # the name store                        (distribution)
node scripts/check-ui.mjs            # a browser shows the correct project   (browser)
node scripts/check-readme.mjs        # every claim in the readme             (distribution)
node scripts/check-all.mjs           # all of the above in one sequence      (whatever is present)
```

`check-pack.mjs` packs the plugin, installs that tarball into a profile it
makes from a copy of yours, starts a server on it, and asks that server for the
plugin's route. A file left out of `files`, an export that does not resolve, or
a manifest that installs but does not load are all invisible from the checkout
and visible here. Without a profile it checks the tarball contents and says so.

`check-assets.mjs` keeps the readme's images honest: it reads the `<picture>`
blocks out of the readme, loads every file they name in a real browser, and
measures what each renders as. The dark variant has to be darker than the
light one, and a narrow SVG has to follow the colour scheme from inside its
own `<style>`, so an image that only works in one theme fails here.

`check-readme.mjs` is the proof of the readme. It holds one entry for each
claim, finds the evidence, and prints it. A claim with no evidence fails. Run it
after a change to the readme or to the plugin:

```sh
node scripts/check-readme.mjs
```

`check-shared-home.mjs` is an experiment. It starts two processes on one home
with two different folders, and it shows that both open the project the home
names. That is the reason for a home per project.

## The environment

You can point the checks at your machine:

- `SMOKE_DISTRO` — the distribution to drive (default `Ubuntu`).
- `SMOKE_PROJECT`, `SMOKE_PROJECT_A`, `SMOKE_PROJECT_B` — the projects to use.
- `DSH_ASAR` — where the app's asar lives, for checks that read the app.
- `UI_BROWSER` — the browser for `check-ui.mjs` and `capture-panel.mjs`
  (Chromium-based).

## CI

The [checks workflow](.github/workflows/checks.yml) runs the offline checks on
Node 20, 22 and 24, packs the tarball and checks its contents. The checks that
drive a real distribution or a real browser run by hand: CI would have to fake
the very thing those checks exist to observe.

## Assets

The images in `docs/` come in three shapes, and the readme picks between them
with `<picture>`: a light variant, a dark variant, and a narrow one for small
screens (the narrow SVG follows the viewer's colour scheme from inside, with a
`prefers-color-scheme` media query in its own `<style>`).

The banner and the architecture diagram are hand-written SVG — change the
colors of `*-light.svg` and `*-dark.svg` together, and keep
`*-narrow.svg`'s two palettes beside them.

The panel images are screenshots of the real panel, not drawings of it:
`capture-panel.mjs` opens the app, opens the panel from its sidebar seat, and
captures what is there. Point it at a dsh web app URL — a throwaway server
prints one, and its token is part of the URL:

```sh
dsh --profile web --no-open --port 19444
node scripts/capture-panel.mjs 'http://127.0.0.1:19444/?token=…'
```

The social preview PNG is rendered from the banner design with GDI+:

```powershell
pwsh -NoProfile -File scripts/render-social-preview.ps1
```

Upload the result as the repository's social preview (Settings → Social
preview).
