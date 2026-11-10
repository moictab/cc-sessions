'use strict';
// Claude Code plugins that a single session can switch on or off just for itself.
// The override goes into the session's own --settings file, which takes precedence over the
// user's and the project's settings, so nothing in ~/.claude or in the project changes.

const fs = require('fs');
const os = require('os');
const path = require('path');

const TOGGLABLE = [
  {
    key: 'playwright',
    id: 'playwright@claude-plugins-official',
    label: 'Playwright',
    aboutKey: 'plugins.about.playwright', // what it is, in shared/i18n.js
  },
];

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Plugins from TOGGLABLE that are installed (all of them if we can't tell). */
function available() {
  const data = readJson(path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json'));
  if (!data || !data.plugins || typeof data.plugins !== 'object') return TOGGLABLE;
  return TOGGLABLE.filter((p) => p.id in data.plugins);
}

/** Whether a plugin is on for a session in `cwd` when we don't override it (local > project > user). */
function configured(cwd, id) {
  const files = [
    path.join(cwd, '.claude', 'settings.local.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(os.homedir(), '.claude', 'settings.json'),
  ];
  for (const file of files) {
    const v = readJson(file)?.enabledPlugins?.[id];
    if (typeof v === 'boolean') return v;
  }
  return false;
}

function byKey(key) {
  return TOGGLABLE.find((p) => p.key === key || p.id === key) || null;
}

/** Only known plugins, only booleans. */
function sanitizeOverrides(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const p of TOGGLABLE) if (typeof obj[p.id] === 'boolean') out[p.id] = obj[p.id];
  return out;
}

module.exports = { TOGGLABLE, available, configured, byKey, sanitizeOverrides };
