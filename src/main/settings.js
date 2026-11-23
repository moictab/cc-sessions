'use strict';
// User settings, in settings.json in the app's data folder. Kept apart from state.json, which
// the app rewrites all the time, so this file stays small and can be edited by hand.
// A null value means "not set": use the default (for the terminal font, Windows Terminal's).

const fs = require('fs');
const path = require('path');
const i18n = require('../shared/i18n');

const LIMITS = { fontSize: { min: 8, max: 32 }, alertMinutes: { min: 1, max: 1440 } };

const section = (data, name) => (data && typeof data === 'object' && data[name] && typeof data[name] === 'object' ? data[name] : {});

function normalize(data) {
  const t = section(data, 'terminal');
  const u = section(data, 'ui');
  const a = section(data, 'alerts');
  const box = section(data, 'inbox');
  const dec = section(data, 'decisions');
  const folder = typeof box.folder === 'string' ? box.folder.trim().replace(/\\+$/, '') : '';
  const minutes = Math.round(Number(a.afterMinutes));
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
    // A notice on the phone when sessions wait too long (see phone-alert.js): after how many
    // minutes (null: off), and the command that sends it, with the text added as its last argument.
    alerts: {
      afterMinutes: a.afterMinutes != null && minutes >= LIMITS.alertMinutes.min && minutes <= LIMITS.alertMinutes.max ? minutes : null,
      command: typeof a.command === 'string' && a.command.trim() ? a.command.trim().slice(0, 1000) : null,
    },
    // The alert inbox (see alert-inbox.js): the folder system tasks leave notices in, the session
    // that gets them, and the kinds of notice it accepts. Off until all three are set.
    // The record of decisions (decision-log.js): the project folders of the sessions that may read
    // every decision with get_decision, whoever raised it and whatever its state (the security one).
    decisions: {
      auditors: Array.isArray(dec.auditors)
        ? [...new Set(dec.auditors.filter((f) => typeof f === 'string' && /^[A-Za-z]:\\[^<>"|?*\x00-\x1f]*$/.test(f.trim()) && f.trim().length <= 240)
          .map((f) => f.trim().replace(/\\+$/, '')))].slice(0, 5)
        : [],
    },
    inbox: {
      folder: /^[A-Za-z]:\\[^<>"|?*\x00-\x1f]*$/.test(folder) && folder.length <= 240 ? folder : null,
      session: typeof box.session === 'string' && box.session.trim() ? box.session.trim().slice(0, 64) : null,
      kinds: Array.isArray(box.kinds)
        ? [...new Set(box.kinds.filter((k) => typeof k === 'string' && /^[a-z][a-z0-9]{0,23}$/.test(k)))].slice(0, 10)
        : [],
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
      alerts: { ...this.data.alerts, ...section(patch, 'alerts') },
      inbox: { ...this.data.inbox, ...section(patch, 'inbox') },
      decisions: { ...this.data.decisions, ...section(patch, 'decisions') },
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
