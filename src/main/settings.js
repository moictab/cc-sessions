'use strict';
// User settings, in settings.json in the app's data folder. Kept apart from state.json, which
// the app rewrites all the time, so this file stays small and can be edited by hand.
// A null value means "not set": use the default (for the terminal font, Windows Terminal's).

const fs = require('fs');
const path = require('path');
const i18n = require('../shared/i18n');

const LIMITS = { fontSize: { min: 8, max: 32 } };

const section = (data, name) => (data && typeof data === 'object' && data[name] && typeof data[name] === 'object' ? data[name] : {});

function normalize(data) {
  const t = section(data, 'terminal');
  const u = section(data, 'ui');
  // The family ends up inside a CSS font list: keep it to a plain name.
  const family = typeof t.fontFamily === 'string' ? t.fontFamily.replace(/["'\\;{}<>]/g, '').trim().slice(0, 100) : '';
  const size = Math.round(Number(t.fontSize));
  const { min, max } = LIMITS.fontSize;
  return {
    terminal: {
      fontFamily: family || null,
      fontSize: t.fontSize != null && size >= min && size <= max ? size : null,
    },
    ui: {
      animations: u.animations !== false, // status indicators; on unless turned off here
      language: i18n.normalize(u.language), // 'en' unless a supported one was chosen
      listMode: u.listMode === 'status' ? 'status' : 'groups', // how the sidebar organizes sessions
    },
  };
}

class Settings {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.data = this.load();
  }

  load() {
    try {
      return normalize(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      return normalize({});
    }
  }

  get() {
    return this.data;
  }

  /** Merges `patch` section by section ({ terminal: { fontSize: 14 } }) and saves. */
  update(patch) {
    this.data = normalize({
      terminal: { ...this.data.terminal, ...section(patch, 'terminal') },
      ui: { ...this.data.ui, ...section(patch, 'ui') },
    });
    this.save();
    return this.data;
  }

  save() {
    const tmp = this.file + '.tmp';
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[settings] could not save', err);
    }
  }
}

module.exports = { Settings, LIMITS };
