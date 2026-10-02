// Shell text for the WSL side. Every piece here is plain bash fed to
// `bash -s` over stdin (see wsl.js), so nothing has to survive argv quoting.
//
// Output contract: ASCII markers around `key=value` or `P\t<fields>` lines.
// No JSON is built in bash and no shell parser is needed on this side.
//
// The WSL dsh is normally a systemd *user* unit (Restart=always), so killing
// its process only makes systemd start it again — every lifecycle operation
// therefore goes through `systemctl --user` when a unit exists, and only falls
// back to spawning directly when there is no unit at all.

export const SH = {
  lib: `
# The launcher is usually an fnm/nvm symlink whose shebang is
# '#!/usr/bin/env node'. A non-interactive shell has no fnm/nvm in PATH, so
# running it directly fails with "env: 'node': No such file or directory".
dsh_node() {
  local c
  for c in "$HOME/.local/share/fnm/aliases/default/bin/node" "$HOME/.nvm/current/bin/node" "$HOME/.nvm/versions/node"/*/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -x "$c" ]; then printf '%s' "$c"; return 0; fi
  done
  printf '%s' ''
}
dsh_entry() {
  local c real
  for c in "$HOME/.local/share/fnm/aliases/default/bin/dsh" "$HOME/.local/state/fnm_multishells"/*/bin/dsh "$HOME/.nvm/versions/node"/*/bin/dsh /usr/local/bin/dsh /usr/bin/dsh; do
    if [ -x "$c" ]; then
      real="$(readlink -f "$c" 2>/dev/null || printf '%s' "$c")"
      printf '%s' "$real"
      return 0
    fi
  done
  c="$(command -v dsh 2>/dev/null | grep -v '^/mnt/' || true)"
  if [ -n "$c" ]; then readlink -f "$c" 2>/dev/null || printf '%s' "$c"; fi
  printf '%s' ''
}
# Empty when no runnable command line can be built.
dsh_cmd() {
  local entry node
  entry="$(dsh_entry)"
  [ -z "$entry" ] && return 0
  case "$entry" in
    *.js|*.cjs|*.mjs)
      node="$(dsh_node)"
      if [ -n "$node" ]; then printf '%s %s' "$node" "$entry"; fi
      ;;
    *) printf '%s' "$entry" ;;
  esac
}
# ---------------------------------------------------------------- systemd ---
# systemctl needs the user bus, which is present in WSL when systemd is enabled.
sysd() {
  command -v systemctl >/dev/null 2>&1 || return 1
  [ -S "\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/bus" ] || return 1
  systemctl --user "$@" 2>/dev/null
}
# The unit that owns the port, searched among all user units running dsh.
dsh_unit() {
  local want name
  want="$STATE/unit"
  if [ -r "$want" ]; then
    name="$(head -1 "$want" 2>/dev/null | tr -d '\\r\\n')"
    if [ -n "$name" ] && sysd cat "$name" >/dev/null 2>&1; then printf '%s' "$name"; return 0; fi
  fi
  name="$(sysd list-units --type=service --all --no-legend --plain 2>/dev/null | awk '{print $1}' | grep -i dsh | head -1)"
  if [ -z "$name" ]; then
    for name in dsh-web.service dsh.service; do
      if sysd cat "$name" >/dev/null 2>&1; then printf '%s' "$name"; return 0; fi
    done
  fi
  printf '%s' "$name"
}
# The port this plugin asked for last time (may have no listener right now).
dsh_stored_port() {
  local pr u
  pr="$(cat "$STATE/port" 2>/dev/null || true)"
  if [ -z "$pr" ]; then pr="$(url_port)"; fi
  if [ -z "$pr" ]; then
    u="$(dsh_unit)"
    if [ -n "$u" ]; then
      pr="$(sysd show "$u" -p ExecStart 2>/dev/null | grep -oE 'port[ =][0-9]+' | grep -oE '[0-9]+' | head -1)"
    fi
  fi
  printf '%s' "$pr"
}
# PID listening on a TCP port: fuser first, lsof as a fallback.
port_pid() {
  local pr p
  pr="$1"
  [ -z "$pr" ] && { printf '%s' ''; return 0; }
  p="$(fuser "$pr/tcp" 2>/dev/null | tr -s ' ' '\\n' | grep -E '^[0-9]+$' | head -1 || true)"
  if [ -z "$p" ]; then
    p="$(lsof -nP -iTCP:"$pr" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  fi
  printf '%s' "$p"
}
# The port that actually has a listener, so an instance started by hand
# (plain dsh web on the default 19800 or the shipped 3080) is still found.
dsh_live_port() {
  local pr cand
  pr="$(dsh_stored_port)"
  if [ -n "$pr" ] && [ -n "$(port_pid "$pr")" ]; then printf '%s' "$pr"; return 0; fi
  for cand in 19800 3080 3081 20000; do
    if [ -n "$(port_pid "$cand")" ]; then printf '%s' "$cand"; return 0; fi
  done
  printf '%s' "$pr"
}
# The published UI URL, e.g. http://127.0.0.1:19800/?token=...
# The file is the primary source; when it is gone (a stop removes it) the unit
# journal still carries the line dsh printed at startup, so the one-shot token
# stays reachable.
published_url() {
  local u
  if [ -r "$HOME/.dsh/web-url.txt" ]; then
    u="$(head -1 "$HOME/.dsh/web-url.txt" 2>/dev/null | tr -d '\\r\\n')"
    if [ -n "$u" ]; then printf '%s' "$u"; return 0; fi
  fi
  local unit
  unit="$(dsh_unit)"
  if [ -n "$unit" ] && command -v journalctl >/dev/null 2>&1; then
    u="$(journalctl --user -u "$unit" --no-pager -n 200 2>/dev/null \
      | grep -oE 'https?://127\\.0\\.0\\.1:[0-9]+/\\?token=[A-Za-z0-9_-]+' | tail -1)"
    if [ -n "$u" ]; then printf '%s' "$u"; return 0; fi
  fi
  if [ -n "$unit" ]; then
    u="$(sysd status "$unit" --no-pager -n 40 2>/dev/null | grep -oE 'https?://127\\.0\\.0\\.1:[0-9]+/\\?token=[A-Za-z0-9_-]+' | tail -1)"
  fi
  printf '%s' "$u"
}
# Port taken out of that URL. grep -oE rather than sed, whose backreferences
# inside a JS template literal fail silently when escaped wrongly.
url_port() {
  local u p
  u="$(published_url)"
  [ -z "$u" ] && return 0
  p="$(printf '%s' "$u" | grep -oE '127\\.0\\.0\\.1:[0-9]+' | head -1 | cut -d: -f2)"
  printf '%s' "$p"
}
# Asking dsh for its version costs seconds, so the answer is cached and
# revalidated only when the launcher itself changes.
dsh_version() {
  local entry stamp cached at cmd v
  entry="$(dsh_entry)"
  if [ -z "$entry" ]; then printf '%s' 'not-installed'; return 0; fi
  stamp="$(date -r "$entry" +%s 2>/dev/null || echo 0)"
  if [ -r "$STATE/version" ]; then
    cached="$(head -1 "$STATE/version" 2>/dev/null || true)"
    at="$(sed -n 2p "$STATE/version" 2>/dev/null || true)"
    if [ "$cached" = "$stamp" ] && [ -n "$at" ]; then printf '%s' "$at"; return 0; fi
  fi
  cmd="$(dsh_cmd)"
  v=""
  [ -n "$cmd" ] && v="$(timeout 90 $cmd --version 2>/dev/null | head -1 | tr -d '\\r')"
  v="\${v:-unknown}"
  printf '%s\\n%s\\n' "$stamp" "$v" > "$STATE/version" 2>/dev/null
  printf '%s' "$v"
}
`,
}

/** One shared preamble so every command sees the same helpers and paths. */
export function preamble() {
  return `
set -u
STATE="$HOME/.dsh/dsh-wsl-projects"
mkdir -p "$STATE" 2>/dev/null
${SH.lib}`
}

export function statusScript() {
  return `${preamble()}
unit="$(dsh_unit)"
port="$(dsh_live_port)"
pid=""
active=""
substate=""
restarts=""
managed=no
if [ -n "$unit" ]; then
  managed=yes
  active="$(sysd is-active "$unit" 2>/dev/null | head -1)"
  substate="$(sysd show "$unit" -p SubState --value 2>/dev/null | head -1)"
  restarts="$(sysd show "$unit" -p NRestarts --value 2>/dev/null | head -1)"
  pid="$(sysd show "$unit" -p MainPID --value 2>/dev/null | head -1)"
fi
if [ -z "$pid" ] || [ "$pid" = "0" ]; then
  pid=""
  if [ -n "$port" ]; then pid="$(port_pid "$port")"; fi
fi
project="$(cat "$STATE/project" 2>/dev/null || true)"
if [ -z "$project" ] && [ -n "$unit" ]; then
  project="$(sysd show "$unit" -p WorkingDirectory --value 2>/dev/null | sed 's|^%h|'"$HOME"'|' | head -1)"
fi
if [ -n "$pid" ]; then running=yes; else running=no; fi
echo STATUS
echo "running=$running"
echo "pid=$pid"
echo "port=$port"
echo "project=$project"
echo "version=$(dsh_version)"
echo "unit=$unit"
echo "managed=$managed"
echo "active=$active"
echo "substate=$substate"
echo "restarts=$restarts"
echo "url=$(published_url)"
echo END
`
}

export function listProjectsScript(root) {
  return `${preamble()}
ROOT=${JSON.stringify(root)}
if [ ! -d "$ROOT" ]; then echo STATUS; echo missing=1; echo END; exit 0; fi
echo STATUS
for d in "$ROOT"/*/; do
  [ -d "$d" ] || continue
  name="$(basename "$d")"
  case "$name" in .*) continue;; esac
  mtime="$(date -r "$d" +%s 2>/dev/null || echo 0)"
  git=no; [ -d "$d/.git" ] && git=yes
  kind=dir
  if [ -f "$d/package.json" ]; then kind=node
  elif [ -f "$d/pyproject.toml" ] || [ -f "$d/requirements.txt" ]; then kind=python
  elif [ -f "$d/Cargo.toml" ]; then kind=rust
  elif [ -f "$d/go.mod" ]; then kind=go
  elif [ -f "$d/composer.json" ]; then kind=php
  fi
  printf 'P\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$name" "$d" "$mtime" "$git" "$kind"
done
echo END
`
}

/** Writes the drop-in that carries project and port, then restarts the unit. */
export function unitApplyScript({ unit, project, port }) {
  return `${preamble()}
U=${JSON.stringify(unit)}
D="$HOME/.config/systemd/user/$U.d"
if ! sysd cat "$U" >/dev/null 2>&1; then echo STATUS; echo result=no-unit; echo END; exit 0; fi
mkdir -p "$D" 2>/dev/null
CMD="$(dsh_cmd)"
if [ -z "$CMD" ]; then echo STATUS; echo result=no-dsh; echo END; exit 0; fi
if [ -n ${JSON.stringify(project)} ] && [ ! -d ${JSON.stringify(project)} ]; then
  echo STATUS; echo result=no-project; echo END; exit 0
fi
# A project-only change must not silently move the service to another port, so
# the port falls back to the one the unit is already running on, then to the
# plugin's stored port, then to the default. Anything that is not a number
# (a JS undefined/null slipping through as text) is treated as absent.
PORT=${JSON.stringify(String(port))}
case "$PORT" in ''|null|undefined|NaN) PORT="" ;; esac
if [ -z "$PORT" ]; then
  PORT="$(sysd show "$U" -p ExecStart 2>/dev/null | grep -oE 'port[ =][0-9]+' | grep -oE '[0-9]+' | head -1)"
fi
if [ -z "$PORT" ]; then PORT="$(cat "$STATE/port" 2>/dev/null | tr -dc '0-9' | head -c 5)"; fi
if [ -z "$PORT" ]; then PORT="$(url_port)"; fi
if [ -z "$PORT" ]; then PORT="\${DSH_WSL_WEB_PORT:-19800}"; fi
{
  echo "# Managed by dsh-wsl-projects. Edit through the plugin or systemctl."
  echo "[Service]"
  if [ -n ${JSON.stringify(project)} ]; then
    echo "WorkingDirectory=${JSON.stringify(project)}"
  fi
  echo "ExecStart="
  echo "ExecStart=$CMD --profile web --no-open --port $PORT"
} > "$D/override.conf" 2>/dev/null
printf '%s' "$U" > "$STATE/unit"
printf '%s' "$PORT" > "$STATE/port"
printf '%s' ${JSON.stringify(project)} > "$STATE/project"
sysd daemon-reload
sysd restart "$U" >/dev/null 2>&1
i=0
while [ "$i" -lt 160 ] && [ "$(sysd is-active "$U" 2>/dev/null | head -1)" != "active" ]; do sleep 0.25; i=$((i + 1)); done
i=0
while [ "$i" -lt 80 ] && [ -z "$(published_url)" ]; do sleep 0.25; i=$((i + 1)); done
active="$(sysd is-active "$U" 2>/dev/null | head -1)"
pid="$(sysd show "$U" -p MainPID --value 2>/dev/null | head -1)"
if [ "$active" != "active" ]; then
  echo STATUS
  echo result=failed
  echo "log=$(sysd status "$U" --no-pager -n 8 2>/dev/null | tail -8 | tr '\\n' ' ')"
  echo END
  exit 0
fi
echo STATUS
echo result=started
echo "pid=$pid"
echo "port=$PORT"
echo "url=$(published_url)"
echo END
`
}

export function unitActionScript({ unit, verb }) {
  return `${preamble()}
U=${JSON.stringify(unit)}
if [ -z "$U" ]; then echo STATUS; echo result=no-unit; echo END; exit 0; fi
if ! sysd cat "$U" >/dev/null 2>&1; then echo STATUS; echo result=no-unit; echo END; exit 0; fi
case ${JSON.stringify(verb)} in
  stop)
    sysd stop "$U" >/dev/null 2>&1
    echo STATUS
    echo "result=$(sysd is-active "$U" 2>/dev/null | head -1)"
    echo END
    ;;
  start)
    sysd start "$U" >/dev/null 2>&1
    i=0
    while [ "$i" -lt 120 ] && [ ! -s "$HOME/.dsh/web-url.txt" ]; do sleep 0.25; i=$((i + 1)); done
    echo STATUS
    echo "result=$(sysd is-active "$U" 2>/dev/null | head -1)"
    echo "pid=$(sysd show "$U" -p MainPID --value 2>/dev/null | head -1)"
    echo "port=$(dsh_live_port)"
    echo "url=$(published_url)"
    echo END
    ;;
  restart)
    rm -f "$HOME/.dsh/web-url.txt" 2>/dev/null
    sysd restart "$U" >/dev/null 2>&1
    i=0
    while [ "$i" -lt 120 ] && [ ! -s "$HOME/.dsh/web-url.txt" ]; do sleep 0.25; i=$((i + 1)); done
    echo STATUS
    echo "result=$(sysd is-active "$U" 2>/dev/null | head -1)"
    echo "pid=$(sysd show "$U" -p MainPID --value 2>/dev/null | head -1)"
    echo "port=$(dsh_live_port)"
    echo "url=$(published_url)"
    echo END
    ;;
esac
`
}

/** Creates or replaces the user unit. Used when no unit exists yet. */
export function unitCreateScript({ unit, project, port, description }) {
  return `${preamble()}
U=${JSON.stringify(unit)}
P=${JSON.stringify(project)}
PORT=${JSON.stringify(String(port))}
CMD="$(dsh_cmd)"
if [ -z "$CMD" ]; then echo STATUS; echo result=no-dsh; echo END; exit 0; fi
if [ ! -d "$P" ]; then echo STATUS; echo result=no-project; echo END; exit 0; fi
if ! sysd >/dev/null 2>&1; then echo STATUS; echo result=no-systemd; echo END; exit 0; fi
mkdir -p "$HOME/.config/systemd/user" 2>/dev/null
cat > "$HOME/.config/systemd/user/$U" <<UNIT
[Unit]
Description=${description}
After=default.target

[Service]
Type=simple
WorkingDirectory=$P
Environment=DSH_HOME=$HOME/.dsh
ExecStart=$CMD --profile web --no-open --port $PORT
Restart=always
RestartSec=3
KillMode=mixed

[Install]
WantedBy=default.target
UNIT
printf '%s' "$U" > "$STATE/unit"
printf '%s' "$PORT" > "$STATE/port"
printf '%s' "$P" > "$STATE/project"
sysd daemon-reload
sysd enable --now "$U" >/dev/null 2>&1
i=0
while [ "$i" -lt 120 ] && [ ! -s "$HOME/.dsh/web-url.txt" ]; do sleep 0.25; i=$((i + 1)); done
echo STATUS
echo "result=$(sysd is-active "$U" 2>/dev/null | head -1)"
echo "pid=$(sysd show "$U" -p MainPID --value 2>/dev/null | head -1)"
echo "port=$(dsh_live_port)"
echo "url=$(published_url)"
echo END
`
}

/**
 * Aliases are the name you give a project in the panel. They are kept as a
 * JSON object (absolute Linux path -> label) so a project can be recognised by
 * a short word instead of its folder name, and so a path outside the projects
 * root can be pinned too.
 */
export function readAliasesScript() {
  return `${preamble()}
if [ -r "$STATE/aliases.json" ]; then
  echo STATUS
  echo result=ok
  base64 -w0 "$STATE/aliases.json" 2>/dev/null || base64 "$STATE/aliases.json" 2>/dev/null | tr -d '\\n'
  echo
  echo END
else
  echo STATUS
  echo result=missing
  echo END
fi
`
}

export function writeAliasesScript(base64Body) {
  return `${preamble()}
if printf '%s' '${base64Body}' | base64 -d > "$STATE/aliases.json"; then
  echo STATUS
  echo result=ok
  echo END
else
  echo STATUS
  echo result=failed
  echo END
fi
`
}

/** Every dsh web unit this user has, with its state and the project it serves. */
export function unitsScript() {
  return `${preamble()}
echo STATUS
for u in $(sysd list-units --type=service --all --no-legend --plain 2>/dev/null | awk '{print $1}' | grep -i dsh); do
  case "$u" in *.service) ;; *) continue;; esac
  echo "U\t$u\t$(sysd is-active "$u" 2>/dev/null | head -1)\t$(sysd show "$u" -p WorkingDirectory --value 2>/dev/null | head -1)\t$(sysd show "$u" -p ExecStart 2>/dev/null | grep -oE 'port[ =][0-9]+' | grep -oE '[0-9]+' | head -1)\t$(sysd show "$u" -p MainPID --value 2>/dev/null | head -1)"
done
echo END
`
}

/** Creates (or rewrites) one unit per project, so several can run at once. */
export function unitCreateForProjectScript({ unit, project, port, description }) {
  return `${preamble()}
U=${JSON.stringify(unit)}
P=${JSON.stringify(project)}
PORT=${JSON.stringify(String(port))}
CMD="$(dsh_cmd)"
if [ -z "$CMD" ]; then echo STATUS; echo result=no-dsh; echo END; exit 0; fi
if [ ! -d "$P" ]; then echo STATUS; echo result=no-project; echo END; exit 0; fi
if ! sysd >/dev/null 2>&1; then echo STATUS; echo result=no-systemd; echo END; exit 0; fi
mkdir -p "$HOME/.config/systemd/user" 2>/dev/null
cat > "$HOME/.config/systemd/user/$U" <<UNIT
[Unit]
Description=${description}
After=default.target

[Service]
Type=simple
WorkingDirectory=$P
Environment=DSH_HOME=$HOME/.dsh
ExecStart=$CMD --profile web --no-open --port $PORT
Restart=always
RestartSec=3
KillMode=mixed

[Install]
WantedBy=default.target
UNIT
sysd daemon-reload
sysd enable --now "$U" >/dev/null 2>&1
printf '%s' "$U" > "$STATE/unit"
printf '%s' "$PORT" > "$STATE/port"
printf '%s' "$P" > "$STATE/project"
i=0
while [ "$i" -lt 160 ] && [ "$(sysd is-active "$U" 2>/dev/null | head -1)" != "active" ]; do sleep 0.25; i=$((i + 1)); done
echo STATUS
echo "result=$(sysd is-active "$U" 2>/dev/null | head -1)"
echo "pid=$(sysd show "$U" -p MainPID --value 2>/dev/null | head -1)"
echo "port=$PORT"
echo "url=$(published_url)"
echo "unit=$U"
echo END
`
}

/** The first port at or above `from` with no listener, so projects never collide. */
export function firstFreePortScript(from) {
  return `${preamble()}
p=${JSON.stringify(String(from))}
case "$p" in ''|*[!0-9]*) p=19800;; esac
i=0
while [ "$i" -lt 50 ]; do
  if [ -z "$(port_pid "$p")" ]; then
    # Also make sure a unit is not configured for it.
    if ! sysd list-units --type=service --all --no-legend --plain 2>/dev/null | grep -q "port $p\\b"; then
      echo STATUS; echo "port=$p"; echo END; exit 0
    fi
  fi
  p=$((p + 1))
  i=$((i + 1))
done
echo STATUS
echo "port=$p"
echo END
`
}

/** Fallback for a distribution without systemd: kill whatever owns the port. */export function stopScript() {
  return `${preamble()}
port="$(dsh_live_port)"
p="$(cat "$STATE/pid" 2>/dev/null || true)"
if [ -n "$port" ]; then
  lpid="$(port_pid "$port")"
  if [ -n "$lpid" ]; then p="$lpid"; fi
fi
if [ -z "$p" ]; then
  rm -f "$HOME/.dsh/web-url.txt" 2>/dev/null
  echo STATUS
  echo result=not-running
  echo END
  exit 0
fi
kill -TERM "$p" 2>/dev/null
i=0
while [ "$i" -lt 60 ] && kill -0 "$p" 2>/dev/null; do sleep 0.25; i=$((i + 1)); done
if kill -0 "$p" 2>/dev/null; then kill -KILL "$p" 2>/dev/null; fi
i=0
while [ "$i" -lt 20 ] && [ -n "$(port_pid "$port")" ]; do sleep 0.25; i=$((i + 1)); done
rm -f "$STATE/pid" "$STATE/port" "$HOME/.dsh/web-url.txt" 2>/dev/null
echo STATUS
echo result=stopped
echo END
`
}

/** Fallback for a distribution without systemd: spawn detached by hand. */
export function spawnScript({ port, project }) {
  return `${preamble()}
CMD="$(dsh_cmd)"
if [ -z "$CMD" ]; then echo STATUS; echo result=no-dsh; echo END; exit 0; fi
if [ ! -d ${JSON.stringify(project)} ]; then echo STATUS; echo result=no-project; echo END; exit 0; fi
PORT=${JSON.stringify(String(port))}
[ -z "$PORT" ] && PORT="\${DSH_WSL_WEB_PORT:-19800}"
rm -f "$HOME/.dsh/web-url.txt" 2>/dev/null
cd ${JSON.stringify(project)} || { echo STATUS; echo result=no-project; echo END; exit 0; }
setsid nohup $CMD --profile web --no-open --port "$PORT" >> "$STATE/dsh-web.log" 2>&1 &
PID=$!
echo "$PID" > "$STATE/pid"
echo "$PORT" > "$STATE/port"
printf '%s' ${JSON.stringify(project)} > "$STATE/project"
i=0
while [ "$i" -lt 120 ] && [ ! -s "$HOME/.dsh/web-url.txt" ]; do
  sleep 0.25
  kill -0 "$PID" 2>/dev/null || break
  i=$((i + 1))
done
if ! kill -0 "$PID" 2>/dev/null; then
  echo STATUS
  echo result=crashed
  echo "log=$(tail -8 "$STATE/dsh-web.log" 2>/dev/null | tr '\\n' ' ')"
  echo END
  rm -f "$STATE/pid" "$STATE/port"
  exit 0
fi
echo STATUS
echo result=started
echo "pid=$PID"
echo "port=$PORT"
echo "url=$(published_url)"
echo END
`
}

export function readFileScript(path) {
  return `${preamble()}
if [ -r ${JSON.stringify(path)} ]; then
  echo STATUS
  echo result=ok
  base64 -w0 ${JSON.stringify(path)} 2>/dev/null || base64 ${JSON.stringify(path)} 2>/dev/null | tr -d '\\n'
  echo
  echo END
else
  echo STATUS
  echo result=missing
  echo END
fi
`
}

export function writeFileScript(path, base64Body) {
  return `${preamble()}
mkdir -p "$(dirname ${JSON.stringify(path)})" 2>/dev/null
if printf '%s' '${base64Body}' | base64 -d > ${JSON.stringify(path)}; then
  echo STATUS
  echo result=ok
  echo END
else
  echo STATUS
  echo result=failed
  echo END
fi
`
}
