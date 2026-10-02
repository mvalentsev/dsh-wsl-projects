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
//
// One unit serves one project on one port, so running several projects means
// several units. Anything that reads state takes the unit as the source of
// truth and treats the plugin's own files as a fallback, because a stale file
// once made the panel name a project the service was not running.

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
# A UI URL pulled out of a line of text. The last one wins: a restarted service
# prints a new token, and only the newest line still works.
url_from() {
  printf '%s' "$1" | grep -oE 'https?://127\\.0\\.0\\.1:[0-9]+/\\?token=[A-Za-z0-9_-]+' | tail -1
}
# The port a URL points at, so a remembered URL can be checked against the
# service it is supposed to belong to.
url_port_of() {
  printf '%s' "$1" | grep -oE '127\\.0\\.0\\.1:[0-9]+' | head -1 | cut -d: -f2
}
# Whether a token URL is accepted by the server listening right now.
#
# A token belongs to the process that printed it, so a URL kept from an earlier
# start is worthless: it opens an expired session, or somebody else's. Nothing
# short of asking the server settles it, and a rejected link is worse than no
# link at all, because the panel would look like it worked.
url_alive() {
  local code
  [ -n "$1" ] || return 1
  command -v curl >/dev/null 2>&1 || return 1
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$1" 2>/dev/null)"
  case "$code" in
    200|301|302|303|307|308) return 0 ;;
    *) return 1 ;;
  esac
}
# The live UI URL of one service, e.g. http://127.0.0.1:19800/?token=...
#
# Candidates are tried newest-first — the log the launcher wrote on this start,
# then the unit journal, then a remembered file — and each one is accepted only
# if it carries this service's port and the server actually answers it.
service_url() {
  local unit log cand want
  unit="$1"
  want=""
  if [ -n "$unit" ]; then
    log="$STATE/logs/\${unit%.service}.log"
    want="$(cat "$STATE/ports/$unit" 2>/dev/null | tr -dc '0-9' | head -c 5)"
    for cand in \\
      "$(url_from "$(cat "$log" 2>/dev/null)")" \\
      "$(url_from "$(journalctl --user -u "$unit" --no-pager -n 300 2>/dev/null)")" \\
      "$(head -1 "$STATE/urls/\${unit%.service}" 2>/dev/null | tr -d '\\r\\n')"; do
      [ -n "$cand" ] || continue
      if [ -n "$want" ] && [ "$(url_port_of "$cand")" != "$want" ]; then continue; fi
      if url_alive "$cand"; then printf '%s' "$cand"; return 0; fi
    done
  else
    unit="$(dsh_unit)"
  fi
  if [ -n "$unit" ]; then
    cand="$(url_from "$(sysd status "$unit" --no-pager -n 60 2>/dev/null)")"
    if [ -n "$cand" ] && url_alive "$cand"; then printf '%s' "$cand"; return 0; fi
  fi
  # Last resort: the shared file, and only when it names this service's port.
  if [ -r "$HOME/.dsh/web-url.txt" ]; then
    cand="$(head -1 "$HOME/.dsh/web-url.txt" 2>/dev/null | tr -d '\\r\\n')"
    if [ -n "$want" ] && [ "$(url_port_of "$cand")" = "$want" ] && url_alive "$cand"; then
      printf '%s' "$cand"
    fi
  fi
}
# The URL of the service this plugin controls, for the older callers.
published_url() {
  service_url "$(dsh_unit)"
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
if [ -n "$unit" ]; then
  managed=yes
  active="$(sysd is-active "$unit" 2>/dev/null | head -1)"
  substate="$(sysd show "$unit" -p SubState --value 2>/dev/null | head -1)"
  restarts="$(sysd show "$unit" -p NRestarts --value 2>/dev/null | head -1)"
  pid="$(sysd show "$unit" -p MainPID --value 2>/dev/null | head -1)"
fi
# The unit is the source of truth for both the project and the port. The state
# files only describe what this plugin last did, so trusting them first reports
# a project the service is no longer running.
if [ -n "$unit" ]; then
  project="$(sysd show "$unit" -p WorkingDirectory --value 2>/dev/null | sed 's|^%h|'"$HOME"'|' | head -1)"
  port="$(sysd show "$unit" -p ExecStart 2>/dev/null | grep -oE 'port[ =][0-9]+' | grep -oE '[0-9]+' | head -1)"
fi
if [ -z "\${project:-}" ]; then project="$(cat "$STATE/project" 2>/dev/null || true)"; fi
if [ -z "\${port:-}" ]; then port="$(cat "$STATE/port" 2>/dev/null || true)"; fi
if [ -z "\${port:-}" ]; then port="$(url_port)"; fi
if [ -z "\${pid:-}" ] || [ "\${pid:-}" = "0" ]; then
  pid=""
  if [ -n "\${port:-}" ]; then pid="$(port_pid "$port")"; fi
fi
if [ -n "\${pid:-}" ]; then running=yes; else running=no; fi
echo STATUS
echo "running=$running"
echo "pid=\${pid:-}"
echo "port=\${port:-}"
echo "project=\${project:-}"
echo "version=$(dsh_version)"
echo "unit=\${unit:-}"
echo "managed=\${managed:-no}"
echo "active=\${active:-}"
echo "substate=\${substate:-}"
echo "restarts=\${restarts:-}"
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

/** Removes a unit for good: stop it, disable it, delete the file. */
export function unitRemoveScript(unit) {
  return `${preamble()}
U=${JSON.stringify(unit)}
if [ -z "$U" ]; then echo STATUS; echo result=no-unit; echo END; exit 0; fi
sysd disable "$U" >/dev/null 2>&1
sysd stop "$U" >/dev/null 2>&1
rm -f "$HOME/.config/systemd/user/$U" 2>/dev/null
rm -rf "$HOME/.config/systemd/user/$U.d" 2>/dev/null
rm -f "$STATE/urls/\${U%.service}" "$STATE/ports/$U" "$STATE/logs/\${U%.service}.log" 2>/dev/null
sysd daemon-reload
if [ -r "$STATE/unit" ] && [ "$(head -1 "$STATE/unit" 2>/dev/null | tr -d '\\r\\n')" = "$U" ]; then
  rm -f "$STATE/unit" "$STATE/port" "$STATE/project" 2>/dev/null
fi
echo STATUS
echo result=removed
echo END
`
}

/** Every dsh web unit this user has, with its state and the project it serves. */
export function unitsScript({ awaitUrls = false } = {}) {
  // A service that has just started is listed before its launcher has had the
  // time to record the URL dsh prints, so a caller that expects URLs can ask
  // for a short wait instead of reading a hole.
  const awaitBlock = awaitUrls
    ? `
i=0
while [ "$i" -lt 20 ]; do
  missing=0
  for u in $UNITS; do
    case "$u" in *.service) ;; *) continue;; esac
    if [ "$(sysd is-active "$u" 2>/dev/null | head -1)" = "active" ] && [ ! -s "$STATE/urls/\${u%.service}" ]; then
      missing=1
    fi
  done
  [ "$missing" = "0" ] && break
  sleep 0.25
  i=$((i + 1))
done
`
    : ''

  return `${preamble()}
echo STATUS
# A disabled unit is unloaded, so list-units alone loses exactly the stopped
# services the panel must still show. Unit files are listed as well, and the
# two lists are merged by unit name.
UNITS="$( {
  sysd list-units --type=service --all --no-legend --plain 2>/dev/null | awk '{print $1}'
  sysd list-unit-files --type=service --no-legend --plain 2>/dev/null | awk '{print $1}'
  ls "$HOME/.config/systemd/user" 2>/dev/null
} | grep -E '^dsh[-.].*\\.service$' | sort -u | tr '\\n' ' ')"
${awaitBlock}
for u in $UNITS; do
  [ -n "$u" ] || continue
  active="$(sysd is-active "$u" 2>/dev/null | head -1)"
  [ -n "$active" ] || active="$(sysd show "$u" -p ActiveState --value 2>/dev/null | head -1)"
  [ -n "$active" ] || active=inactive
  port="$(cat "$STATE/ports/$u" 2>/dev/null | tr -dc '0-9' | head -c 5)"
  if [ -z "$port" ]; then
    port="$(sysd show "$u" -p ExecStart 2>/dev/null | grep -oE 'port [0-9]+|--port[ =][0-9]+' | grep -oE '[0-9]+' | head -1)"
  fi
  if [ -z "$port" ]; then
    port="$(sysd show "$u" -p ExecStart 2>/dev/null | grep -oE '[0-9]{4,5}' | head -1)"
  fi
  # A unit with Restart=always counts as active while it is still trying to come
  # up, so "active" alone would report a service as running when it never took
  # its port — two projects cannot share one. Its own URL answering is the
  # honest test, and service_url already checks exactly that.
  url="$(service_url "$u")"
  if [ "$active" = "active" ] && [ -z "$url" ]; then active=starting; fi
  echo "U\t$u\t$active\t$(sysd show "$u" -p WorkingDirectory --value 2>/dev/null | head -1)\t$port\t$(sysd show "$u" -p MainPID --value 2>/dev/null | head -1)\t$url"
done
echo END
`
}

/**
 * The per-service launcher body, without the shared preamble.
 *
 * It exists for one reason: `~/.dsh/web-url.txt` is a single file holding the
 * URL of whichever service started last, so with one service per project every
 * other running service has no reachable token URL. This records each service's
 * own URL under `$STATE/urls/` by following that service's journal, where dsh
 * prints the line at startup.
 *
 * `${'$'}{STATE} is resolved by the preamble prepended at install time.
 */
const LAUNCH_BODY = [
  'PORT="${1:-19800}"',
  'UNIT="${2:-}"',
  'mkdir -p "$STATE/urls" "$STATE/logs" 2>/dev/null',
  'LOG="$STATE/logs/${UNIT%.service}.log"',
  'URLFILE="$STATE/urls/${UNIT%.service}"',
  '# Both records are cleared here, not merely truncated. A token belongs to one',
  '# process, so a stale line left behind would be offered as a working link.',
  'rm -f "$LOG" "$URLFILE" 2>/dev/null',
  'CMD="$(dsh_cmd)"',
  'if [ -z "$CMD" ]; then echo "dsh not found in this distribution" >&2; exit 127; fi',
  '# Every line is mirrored to the log and scanned for the URL dsh prints. A',
  '# plain echo is used on purpose: printf format escapes in this file have',
  '# already produced a literal backslash-n once.',
  '{ $CMD --profile web --no-open --port "$PORT" 2>&1 & } | while IFS= read -r line; do',
  '  echo "$line" >> "$LOG"',
  '  case "$line" in',
  '    *"token="*)',
  "      url=\"$(echo \"$line\" | grep -oE 'https?://127\\.0\\.0\\.1:[0-9]+/\\?token=[A-Za-z0-9_-]+' | head -1)\"",
  '      if [ -n "$url" ]; then echo "$url" > "$URLFILE"; fi',
  '      ;;',
  '  esac',
  'done',
].join('\n')

/**
 * Writes the launcher to `$STATE/launch.sh` and makes it executable. The unit's
 * ExecStart points at that file, so a unit can start a service on its own.
 */
export function writeLaunchScript() {
  return `${installLaunchScript()}
if [ -x "$STATE/launch.sh" ]; then
  echo STATUS
  echo result=ok
  echo "path=$STATE/launch.sh"
  echo END
else
  echo STATUS
  echo result=failed
  echo END
fi
`
}

/**
 * The same installation without any report, for use inside another script whose
 * stdout is already a protocol. Rewriting the launcher is part of starting or
 * restarting a service, because a copy left on disk from an older revision of
 * this plugin would keep recording URLs the way it used to.
 */
export function installLaunchScript() {
  return `${preamble()}
mkdir -p "$STATE/urls" "$STATE/logs" 2>/dev/null
cat > "$STATE/launch.sh" <<'LAUNCH'
#!/usr/bin/env bash
set -u
STATE="$HOME/.dsh/dsh-wsl-projects"
${SH.lib}
${LAUNCH_BODY}
LAUNCH
chmod 755 "$STATE/launch.sh" 2>/dev/null
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
# An earlier version of this plugin wrote project and port into a drop-in. That
# override outranks the unit file, so leaving one behind would keep the old
# ExecStart and the service would never run through the launcher.
rm -rf "$HOME/.config/systemd/user/$U.d" 2>/dev/null
# The unit runs the launcher rather than dsh, because the launcher is what
# records this service's own UI URL.
LAUNCHER="$STATE/launch.sh"
if [ ! -x "$LAUNCHER" ]; then echo STATUS; echo result=no-launcher; echo END; exit 0; fi
cat > "$HOME/.config/systemd/user/$U" <<UNIT
[Unit]
Description=${description}
After=default.target

[Service]
Type=simple
WorkingDirectory=$P
Environment=DSH_HOME=$HOME/.dsh
ExecStart=$LAUNCHER $PORT $U
Restart=always
RestartSec=3
KillMode=mixed

[Install]
WantedBy=default.target
UNIT
# The port is recorded here as well: with the launcher in ExecStart it can no
# longer be read off the command line.
mkdir -p "$STATE/ports" 2>/dev/null
printf '%s' "$PORT" > "$STATE/ports/$U" 2>/dev/null
sysd daemon-reload
# Starting a service that is already up must change nothing: restarting it
# would drop the URL its launcher already recorded, and the panel would lose the
# Open link for a project nobody touched.
ACTIVE="$(sysd is-active "$U" 2>/dev/null | head -1)"
if [ "$ACTIVE" = "active" ]; then
  echo STATUS
  echo result=active
  echo "pid=$(sysd show "$U" -p MainPID --value 2>/dev/null | head -1)"
  echo "port=$PORT"
  echo "url=$(service_url "$U")"
  echo "unit=$U"
  echo END
  exit 0
fi
sysd enable "$U" >/dev/null 2>&1
${installLaunchScript()}
rm -f "$STATE/urls/\${U%.service}" "$STATE/logs/\${U%.service}.log" 2>/dev/null
sysd restart "$U" >/dev/null 2>&1
printf '%s' "$U" > "$STATE/unit"
printf '%s' "$PORT" > "$STATE/port"
printf '%s' "$P" > "$STATE/project"
i=0
while [ "$i" -lt 160 ] && [ "$(sysd is-active "$U" 2>/dev/null | head -1)" != "active" ]; do sleep 0.25; i=$((i + 1)); done
# Bounded wait for this service's launcher to record its URL, so a caller that
# reports the URL does not race the launcher.
j=0
while [ "$j" -lt 60 ] && [ ! -s "$STATE/urls/\${U%.service}" ]; do sleep 0.25; j=$((j + 1)); done
echo STATUS
echo "result=$(sysd is-active "$U" 2>/dev/null | head -1)"
echo "pid=$(sysd show "$U" -p MainPID --value 2>/dev/null | head -1)"
echo "port=$PORT"
echo "url=$(service_url "$U")"
echo "unit=$U"
echo END
`
}

/** The first port at or above `from` that no service and no listener owns. */
export function firstFreePortScript(from) {
  return `${preamble()}
p=${JSON.stringify(String(from))}
case "$p" in ''|*[!0-9]*) p=19800;; esac
i=0
while [ "$i" -lt 50 ]; do
  if [ -z "$(port_pid "$p")" ]; then
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

/** Stops or restarts one named unit; stopping also disables autostart. */
export function unitActionScript({ unit, verb }) {
  return `${preamble()}
U=${JSON.stringify(unit)}
if [ -z "$U" ]; then echo STATUS; echo result=no-unit; echo END; exit 0; fi
if ! sysd cat "$U" >/dev/null 2>&1; then echo STATUS; echo result=no-unit; echo END; exit 0; fi
case ${JSON.stringify(verb)} in
  stop)
    # Disabled as well, so a Restart=always unit does not come back on boot.
    sysd disable "$U" >/dev/null 2>&1
    sysd stop "$U" >/dev/null 2>&1
    echo STATUS
    echo "result=$(sysd is-active "$U" 2>/dev/null | head -1)"
    echo END
    ;;
  restart)
    sysd enable "$U" >/dev/null 2>&1
    # The launcher is rewritten on every action. It records the URL, so a stale
    # copy on disk is exactly how a dead token kept being offered: the source
    # was fixed while the file inside WSL stayed at an older revision.
    ${installLaunchScript()}
    rm -f "$STATE/urls/\${U%.service}" "$STATE/logs/\${U%.service}.log" 2>/dev/null
    sysd restart "$U" >/dev/null 2>&1
    i=0
    while [ "$i" -lt 160 ] && [ "$(sysd is-active "$U" 2>/dev/null | head -1)" != "active" ]; do sleep 0.25; i=$((i + 1)); done
    # The launcher writes this service's URL once dsh prints it.
    j=0
    while [ "$j" -lt 80 ] && [ ! -s "$STATE/urls/\${U%.service}" ]; do sleep 0.25; j=$((j + 1)); done
    echo STATUS
    echo "result=$(sysd is-active "$U" 2>/dev/null | head -1)"
    echo "pid=$(sysd show "$U" -p MainPID --value 2>/dev/null | head -1)"
    port="$(cat "$STATE/ports/$U" 2>/dev/null | tr -dc '0-9' | head -c 5)"
    echo "port=$port"
    echo "url=$(service_url "$U")"
    echo END
    ;;
esac
`
}

/** Fallback for a distribution without systemd: kill whatever owns the port. */
export function stopScript() {
  return `${preamble()}
port="$(url_port)"
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
rm -f "$STATE/pid" "$STATE/port" "$HOME/.dsh/web-url.txt" 2>/dev/null
echo STATUS
echo result=stopped
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
