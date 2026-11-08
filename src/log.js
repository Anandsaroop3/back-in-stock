'use strict';

let silent = false;
const setSilent = (v) => {
  silent = v;
};

/** Structured JSON logs. Never pass secrets or full email addresses in `fields`. */
function log(level, msg, fields = {}) {
  if (silent && level !== 'error') return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
  (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
}

module.exports = {
  log,
  setSilent,
  info: (m, f) => log('info', m, f),
  warn: (m, f) => log('warn', m, f),
  error: (m, f) => log('error', m, f),
};
