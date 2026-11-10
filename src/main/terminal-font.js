'use strict';
// Reads the font of the default Windows Terminal profile, so sessions here look like the
// terminal the user already works in. Returns null when there is nothing to read.

const fs = require('fs');
const path = require('path');

function settingsFiles() {
  const local = process.env.LOCALAPPDATA;
  if (!local) return [];
  const out = [];
  try {
    for (const dir of fs.readdirSync(path.join(local, 'Packages'))) {
      if (dir.startsWith('Microsoft.WindowsTerminal')) out.push(path.join(local, 'Packages', dir, 'LocalState', 'settings.json'));
    }
  } catch { /* no packages dir */ }
  out.push(path.join(local, 'Microsoft', 'Windows Terminal', 'settings.json')); // unpackaged install
  return out.filter((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
}

/** settings.json allows comments and trailing commas. */
function parseLenient(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') { out += text[++i] || ''; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

function fontOf(profile) {
  if (!profile || typeof profile !== 'object') return {};
  const f = profile.font && typeof profile.font === 'object' ? profile.font : {};
  return {
    face: f.face || profile.fontFace,
    size: Number(f.size || profile.fontSize) || undefined,
    weight: f.weight || profile.fontWeight,
  };
}

function readTerminalFont() {
  for (const file of settingsFiles()) {
    try {
      const s = parseLenient(fs.readFileSync(file, 'utf8'));
      const profiles = s.profiles || {};
      const list = Array.isArray(profiles) ? profiles : profiles.list || [];
      const defaults = fontOf(profiles.defaults);
      const own = fontOf(list.find((p) => p && p.guid === s.defaultProfile));
      const face = own.face || defaults.face;
      const sizePt = own.size || defaults.size || 12; // Windows Terminal's default
      if (!face) continue;
      return { family: face, sizePx: Math.round((sizePt * 96) / 72) };
    } catch { /* unreadable; try the next one */ }
  }
  return null;
}

module.exports = { readTerminalFont };
