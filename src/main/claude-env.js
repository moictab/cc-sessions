'use strict';
// Locating the `claude` executable and preparing a clean environment for each session.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Variables that a running Claude Code session injects into its children. If the app
// is launched from inside a session (e.g. `npm start` from Claude), these would leak
// into new sessions and confuse them (nested-session detection, wrong session ID...).
const SESSION_SCOPED_VARS = [
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
];

function resolveClaude() {
  const candidates = [path.join(os.homedir(), '.local', 'bin', 'claude.exe')];
  // An explicit choice wins (a custom install, or a wrapper in tests).
  if (process.env.CC_SESSIONS_CLAUDE) candidates.unshift(process.env.CC_SESSIONS_CLAUDE);
  const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of ['.exe', '.cmd']) candidates.push(path.join(dir, 'claude' + ext));
  }
  return candidates.find((c) => {
    try { return fs.statSync(c).isFile(); } catch { return false; }
  }) || null;
}

function sessionEnv() {
  const env = { ...process.env };
  const drop = new Set(SESSION_SCOPED_VARS.map((v) => v.toUpperCase()));
  for (const key of Object.keys(env)) {
    if (drop.has(key.toUpperCase())) delete env[key];
  }
  env.COLORTERM = 'truecolor';
  return env;
}

/** Claude stores each project's transcripts in ~/.claude/projects/<cwd with non-alphanumerics as '-'>. */
function projectDirFor(cwd) {
  return path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

function transcriptExists(cwd, sessionId) {
  if (!sessionId) return false;
  try { return fs.statSync(path.join(projectDirFor(cwd), sessionId + '.jsonl')).isFile(); } catch { return false; }
}

module.exports = { resolveClaude, sessionEnv, projectDirFor, transcriptExists };
