'use strict';
// Persists the app state (open sessions, active one, layout, window bounds) as JSON.

const fs = require('fs');
const path = require('path');

const DEFAULT_STATE = { version: 1, sessions: [], activeId: null, view: 'single', bounds: null };

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'state.json');
    this.timer = null;
    this.state = this.load();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { ...DEFAULT_STATE, ...data, sessions: Array.isArray(data.sessions) ? data.sessions : [] };
    } catch {
      return { ...DEFAULT_STATE };
    }
  }

  update(patch) {
    Object.assign(this.state, patch);
    this.scheduleSave();
  }

  scheduleSave() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.saveNow(), 400);
  }

  saveNow() {
    clearTimeout(this.timer);
    this.timer = null;
    const tmp = this.file + '.tmp';
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[store] could not save state', err);
    }
  }
}

module.exports = { Store };
