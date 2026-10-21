/** Minimal structured logger: one JSON object per line on stdout/stderr. */
export function log(level, msg, fields = {}) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}
