'use strict';
// A notice on the user's phone when sessions have been waiting for them too long and they're away
// from the PC. It's sent by running a command the user sets in Settings (for instance ssh to a
// machine that forwards it to a chat), with the text as its last argument and never through a
// shell. The text says how many sessions wait, which ones and for how long: never what they ask,
// which may quote paths or data that shouldn't leave the PC.

const { spawn } = require('child_process');

const CHECK_EVERY = 30 * 1000;
const MIN_GAP = 10 * 60 * 1000; // at most one notice every 10 minutes
const RUN_TIMEOUT = 30 * 1000;
const AWAY_AFTER = 120; // seconds without keyboard or mouse (or a locked screen): the user isn't there
const MAX_TEXT = 400;

/** What a session waits for that's worth a notice, and since when (finished turns aren't). */
function pressingWait(v) {
  if (v.status === 'exited' || v.parked) return null;
  if (v.guard) return { kind: 'guard', since: v.guard.since };
  if (v.status === 'permission' || v.status === 'input') return { kind: v.status, since: v.statusSince };
  if (v.asks && v.asks.length) return { kind: 'decision', since: Math.min(...v.asks.map((a) => a.since)) };
  return null;
}

/**
 * The command line from Settings as program + arguments: split at spaces, "double quotes" keep
 * spaces together, %VAR% is expanded. Backslashes are plain characters (Windows paths).
 */
function parseCommand(line) {
  const out = [];
  let cur = null;
  let quoted = false;
  for (const ch of String(line || '')) {
    if (ch === '"') { quoted = !quoted; cur = cur === null ? '' : cur; continue; }
    if (!quoted && /\s/.test(ch)) {
      if (cur !== null) { out.push(cur); cur = null; }
      continue;
    }
    cur = (cur === null ? '' : cur) + ch;
  }
  if (cur !== null) out.push(cur);
  return out.map((a) => a.replace(/%([A-Za-z0-9_()]+)%/g, (m, name) => (process.env[name] !== undefined ? process.env[name] : m)));
}

/** One line, no quote marks or control characters, short: whatever carries it gets plain data. */
function cleanLine(text) {
  return String(text).replace(/["'`\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

function cleanName(name) {
  return String(name || '').replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 40) || '?';
}

function noticeText(t, waits, now) {
  const names = waits.map((w) => cleanName(w.name));
  let list = names.slice(0, 8).join(', ');
  if (names.length > 8) list += ' ' + t('alert.more', { n: names.length - 8 });
  const minutes = Math.max(1, Math.round((now - Math.min(...waits.map((w) => w.since))) / 60000));
  return cleanLine(t(waits.length === 1 ? 'alert.one' : 'alert.many', { n: waits.length, list, minutes }));
}

class PhoneAlert {
  /** `settings`: the Settings store (alerts: { afterMinutes, command }); `idleState`: powerMonitor.getSystemIdleState. */
  constructor({ manager, settings, t, idleState }) {
    this.manager = manager;
    this.settings = settings;
    this.t = t;
    this.idleState = idleState;
    this.told = new Set(); // waits already in a notice: "<session>|<kind>|<since>"
    this.lastSent = 0;
    this.running = false;
    this.timer = null;
  }

  start() {
    this.timer = setInterval(() => this.check(), CHECK_EVERY);
  }

  stop() {
    clearInterval(this.timer);
  }

  away() {
    try { return this.idleState(AWAY_AFTER) !== 'active'; } catch { return true; }
  }

  /**
   * Each wait gets into at most one notice. One that comes up while the last notice is less than
   * 10 minutes old, or while the user is at the PC, waits for the next chance; the notice then
   * counts every session waiting longer than the limit.
   */
  check(now = Date.now()) {
    const { afterMinutes, command } = this.settings.get().alerts;
    const live = new Set();
    const waits = [];
    for (const v of this.manager.list()) {
      const w = pressingWait(v);
      if (!w) continue;
      const key = `${v.id}|${w.kind}|${w.since}`;
      live.add(key);
      if (afterMinutes && now - w.since >= afterMinutes * 60000) waits.push({ key, name: v.name, since: w.since });
    }
    for (const k of this.told) if (!live.has(k)) this.told.delete(k);
    if (!afterMinutes || !command || this.running) return;
    const fresh = waits.filter((w) => !this.told.has(w.key));
    if (!fresh.length || now - this.lastSent < MIN_GAP || !this.away()) return;
    for (const w of fresh) this.told.add(w.key);
    this.lastSent = now;
    this.send(noticeText(this.t, waits, now));
  }

  /** From Settings: a notice right now, to see that it arrives. */
  test() {
    if (this.running) return Promise.resolve({ ok: false, error: this.t('alert.busy') });
    return this.send(cleanLine(this.t('alert.test')));
  }

  /** Runs the command with `text` as its last argument. Resolves { ok, error }; never retries. */
  send(text) {
    const argv = parseCommand(this.settings.get().alerts.command);
    if (!argv.length) return Promise.resolve({ ok: false, error: this.t('alert.noCommand') });
    this.running = true;
    return new Promise((resolve) => {
      let out = '';
      let timer = null;
      let done = false;
      const finish = (r) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.running = false;
        if (!r.ok) console.error('[alert] not sent:', r.error);
        resolve(r);
      };
      let child;
      try {
        child = spawn(argv[0], [...argv.slice(1), text], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        finish({ ok: false, error: err.message });
        return;
      }
      timer = setTimeout(() => {
        try { child.kill(); } catch { /* gone */ }
        finish({ ok: false, error: this.t('alert.timeout') });
      }, RUN_TIMEOUT);
      const keep = (d) => { if (out.length < 4000) out += d; };
      child.stdout.on('data', keep);
      child.stderr.on('data', keep);
      child.on('error', (err) => finish({ ok: false, error: err.message }));
      child.on('close', (code) => {
        const last = out.trim().split(/\r?\n/).pop() || '';
        finish(code === 0 ? { ok: true } : { ok: false, error: (last || this.t('alert.exitCode', { code })).slice(0, 200) });
      });
    });
  }
}

module.exports = { PhoneAlert, parseCommand, noticeText, pressingWait };
