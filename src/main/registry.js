'use strict';
// Watches ~/.claude/sessions/<pid>.json, the registry where every running Claude Code
// session publishes its sessionId and busy/idle status. It's an internal format, so it's
// only used as a secondary signal (to correct missed hooks and to spot sessions running
// outside the app); every read is defensive.

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const REGISTRY_DIR = path.join(os.homedir(), '.claude', 'sessions');

class Registry extends EventEmitter {
  constructor() {
    super();
    this.entries = [];
    this.timer = null;
    this.poller = null;
    this.watcher = null;
  }

  start() {
    this.refresh();
    try {
      this.watcher = fs.watch(REGISTRY_DIR, () => this.scheduleRefresh());
      this.watcher.on('error', () => {});
    } catch { /* dir may not exist yet; polling covers it */ }
    this.poller = setInterval(() => this.refresh(), 5000);
  }

  stop() {
    clearInterval(this.poller);
    clearTimeout(this.timer);
    if (this.watcher) this.watcher.close();
  }

  scheduleRefresh() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), 250);
  }

  async refresh() {
    let names;
    try { names = await fsp.readdir(REGISTRY_DIR); } catch { names = []; }
    const entries = [];
    for (const name of names) {
      if (!/^\d+\.json$/.test(name)) continue;
      try {
        const e = JSON.parse(await fsp.readFile(path.join(REGISTRY_DIR, name), 'utf8'));
        if (typeof e.pid !== 'number' || !isAlive(e.pid)) continue;
        entries.push({
          pid: e.pid,
          sessionId: e.sessionId || null,
          cwd: e.cwd || null,
          name: e.name || null,
          nameSource: e.nameSource || null, // 'user' after /rename
          nameSince: e.nameSince || 0,
          socket: e.messagingSocketPath || null,
          kind: e.kind || null,
          status: e.status || null,
          statusUpdatedAt: e.statusUpdatedAt || e.updatedAt || 0,
        });
      } catch { /* being rewritten */ }
    }
    this.entries = entries;
    this.emit('change', entries);
  }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

module.exports = { Registry };
