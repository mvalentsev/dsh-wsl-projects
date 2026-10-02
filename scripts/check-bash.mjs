import { writeLaunchScript, unitActionScript } from '../lib/scripts.js'
import { bash } from '../lib/wsl.js'

const cases = {
  'launch.sh': writeLaunchScript(),
  'restart.sh': unitActionScript({ unit: 'dsh-web-dev.service', verb: 'restart' }),
  'stop.sh': unitActionScript({ unit: 'dsh-web-dev.service', verb: 'stop' }),
}

for (const [name, source] of Object.entries(cases)) {
  // Strip the report protocol from the launcher installer, keep the rest.
  const r = await bash('Ubuntu', `cat > /tmp/${name} <<'XEOF'\n${source}\nXEOF\nbash -n /tmp/${name} && echo "SYNTAX OK ${name}"`, { timeoutMs: 60000 })
  console.log((r.stdout.trim() || '(no output)') + (r.stderr ? ' | ' + r.stderr.trim().slice(0, 200) : ''))
}
