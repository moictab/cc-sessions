'use strict';
// The record of the decisions raised with ask_user, kept by the app so that a session can check
// what the user answered in another session's inbox (get_decision in mcp.js) without asking again,
// and without having to take the word of the session that tells it.
//
// What it guarantees, and how:
// - Only the app writes it. Each entry is signed (HMAC-SHA256) with a key that only the app holds,
//   and carries the hash of the entry before it, so an edited, removed or reordered entry shows.
//   head.json, also signed, says how far the record goes, so cutting entries off its end shows too,
//   and which start of the app wrote it last (boot); a copy of it in the registry (HKCU), checked on
//   starting, means that putting back an older copy of the folder also takes rewinding the registry.
//   A record that fails any of these checks is kept aside and everything in it is "unverifiable".
// - An answer goes in only from the inbox (a button, or typed in the card's box), never from a tool.
//   One typed in the session's own terminal is noted, as "terminal", and counts for nothing.
// - The card is bound to its answer: its SHA-256 (cardHash), as shown, goes in when it's raised, and
//   the inbox only takes an answer to the card the user was looking at.
// - An answer covers what the card names (actions), each so many times (uses), for 7 days.
//
// The key sits next to the record, encrypted for the Windows user (DPAPI, through Electron's
// safeStorage); `protect` and `unprotect` are those two calls, passed in so this runs without Electron.
// Kept in memory once loaded: what the file says while the app runs is never read back.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VALID_FOR_MS = 7 * 24 * 60 * 60 * 1000;
const ZERO = '0'.repeat(64);
// agent: a session's name or a project folder (Windows paths go up to 260 characters).
const LIMITS = { actions: 10, agent: 300, action: 300, ref: 200, uses: 20, answer: 500 };

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/** A project folder, the way two of them are compared: absolute, no trailing separator, any case. */
function normFolder(p) {
  if (typeof p !== 'string' || !p.trim()) return '';
  return path.win32.resolve(p.trim()).replace(/[\\/]+$/, '').toLowerCase();
}

/**
 * The SHA-256 of a card as the inbox shows it: who raised it (its folder) and every field the card
 * displays, in a fixed order. Hex.
 */
function cardHash(folder, card) {
  return sha256(JSON.stringify([
    normFolder(folder),
    card.label || '',
    card.question || '',
    card.summary || '',
    (card.options || []).map((o) => [o.label, !!o.recommended]),
    card.fallback || '',
    card.context || '',
    (card.actions || []).map((a) => [a.agent, normFolder(a.folder), a.action, a.ref || '']),
    card.uses || 1,
  ]));
}

class DecisionLog {
  /**
   * `registry`: { read(): string | null, write(value) } for the copy of the head (see readRegHead());
   * write may be slow, and is never waited for.
   */
  constructor({ dir, protect, unprotect, registry, now = Date.now }) {
    this.dir = dir;
    this.registry = registry;
    this.file = path.join(dir, 'log.jsonl');
    this.headFile = path.join(dir, 'head.json');
    this.keyFile = path.join(dir, 'key.bin');
    this.protect = protect;
    this.unprotect = unprotect;
    this.now = now;
    this.decisions = new Map(); // id -> decision (see apply())
    this.n = 0; // entries in the current record
    this.last = ZERO; // hash of its last line
    this.boot = 0; // this start of the app, counted (in head.json and the registry)
    this.problem = ''; // why an earlier record was set aside ('' if it wasn't)
    this.load();
    this.writeHead();
  }

  // ---- the record on disk ---------------------------------------------------------------

  load() {
    fs.mkdirSync(this.dir, { recursive: true });
    const hasLog = fs.existsSync(this.file) && fs.statSync(this.file).size > 0;
    this.key = this.readKey();
    if (!this.key) {
      if (hasLog) this.setAside('its key could not be read');
      this.key = crypto.randomBytes(32);
      fs.writeFileSync(this.keyFile, this.protect(this.key.toString('hex')));
      this.boot = 1;
      return;
    }
    const reg = this.readRegHead();
    if (!hasLog) {
      if (reg && reg.n > 0) this.problem = 'the record was missing';
      this.boot = (reg ? reg.boot : 0) + 1;
      return;
    }
    const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter((l) => l);
    const entries = [];
    const hashes = [ZERO]; // hashes[k]: of line k (1…)
    let bad = '';
    for (let i = 0; i < lines.length; i++) {
      let e = null;
      try { e = JSON.parse(lines[i]); } catch { /* bad below */ }
      if (!e || e.n !== i + 1 || e.prev !== hashes[i] || !this.macOk(e)) { bad = `entry ${i + 1} does not check`; break; }
      entries.push(e);
      hashes.push(sha256(lines[i]));
    }
    const head = this.readHead();
    const count = entries.length;
    if (!bad) {
      // The heads can lag behind the record by what was being written when the app stopped, never the other way.
      if (!head) bad = 'head.json is missing or does not check';
      else if (head.n > count) bad = `${head.n - count} entries are missing from its end`;
      else if (hashes[head.n] !== head.hash) bad = 'it does not match head.json';
      else if (!reg) bad = 'its copy in the registry is missing or does not check';
      else if (reg.n > count) bad = `${reg.n - count} entries are missing from its end (by the registry)`;
      else if (hashes[reg.n] !== reg.hash) bad = 'it does not match its copy in the registry';
      else if (reg.boot > head.boot) bad = 'it is older than its copy in the registry: it was put back';
    }
    if (bad) {
      // Kept, so it can be looked at, but nothing in it counts.
      for (const e of entries) this.apply(e, false);
      this.setAside(bad);
      this.boot = Math.max(head ? head.boot : 0, reg ? reg.boot : 0) + 1;
      return;
    }
    for (const e of entries) this.apply(e, true);
    this.n = count;
    this.last = hashes[count];
    this.boot = Math.max(head.boot, reg.boot) + 1;
  }

  readKey() {
    try {
      const hex = this.unprotect(fs.readFileSync(this.keyFile));
      return /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, 'hex') : null;
    } catch {
      return null;
    }
  }

  readHead() {
    try {
      const h = JSON.parse(fs.readFileSync(this.headFile, 'utf8'));
      if (!Number.isInteger(h.n) || !Number.isInteger(h.boot) || typeof h.hash !== 'string') return null;
      return this.equal(h.mac, this.mac(`head|${h.n}|${h.hash}|${h.boot}`)) ? h : null;
    } catch {
      return null;
    }
  }

  /** The registry's copy: "<n>|<hash>|<boot>|<mac>". */
  readRegHead() {
    let v = null;
    try { v = this.registry ? this.registry.read() : null; } catch { v = null; }
    const m = /^(\d{1,9})\|([0-9a-f]{64})\|(\d{1,9})\|([0-9a-f]{64})$/.exec(String(v || '').trim());
    if (!m) return null;
    const h = { n: Number(m[1]), hash: m[2], boot: Number(m[3]) };
    return this.equal(m[4], this.mac(`reg|${h.n}|${h.hash}|${h.boot}`)) ? h : null;
  }

  /** head.json now, and the registry's copy as soon as it can be written. */
  writeHead() {
    const head = { n: this.n, hash: this.last, boot: this.boot };
    head.mac = this.mac(`head|${head.n}|${head.hash}|${head.boot}`);
    const tmp = this.headFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(head));
    fs.renameSync(tmp, this.headFile);
    if (this.registry) {
      const mac = this.mac(`reg|${head.n}|${head.hash}|${head.boot}`);
      try { this.registry.write(`${head.n}|${head.hash}|${head.boot}|${mac}`); } catch { /* checked on the next start */ }
    }
  }

  /** The record doesn't check: moved aside, and a new one starts (with a new key if it had to). */
  setAside(why) {
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
    for (const f of [this.file, this.headFile]) {
      try { if (fs.existsSync(f)) fs.renameSync(f, `${f}.${stamp}.unverifiable`); } catch { /* left in place: overwritten below */ }
    }
    try { fs.rmSync(this.file, { force: true }); fs.rmSync(this.headFile, { force: true }); } catch { /* ignore */ }
    this.problem = why;
    this.n = 0;
    this.last = ZERO;
    console.error(`[decisions] the record was set aside: ${why}`);
  }

  mac(text) {
    return crypto.createHmac('sha256', this.key).update(text, 'utf8').digest('hex');
  }

  macOk(e) {
    return typeof e.mac === 'string' && this.equal(e.mac, this.mac(JSON.stringify([e.n, e.prev, e.at, e.type, e.d])));
  }

  equal(a, b) {
    return typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  }

  append(type, d) {
    const e = { n: this.n + 1, prev: this.last, at: this.now(), type, d };
    e.mac = this.mac(JSON.stringify([e.n, e.prev, e.at, e.type, e.d]));
    const line = JSON.stringify(e);
    fs.appendFileSync(this.file, line + '\n');
    this.n = e.n;
    this.last = sha256(line);
    this.writeHead();
    this.apply(e, true);
    return e;
  }

  /** One entry into the decisions in memory. `trusted`: it came from a record that checks. */
  apply(e, trusted) {
    const d = e.d || {};
    if (e.type === 'raised') {
      this.decisions.set(d.id, {
        id: d.id,
        terminal: d.terminal,
        folder: d.folder,
        name: d.name,
        label: d.label,
        question: d.question,
        options: d.options || [],
        actions: d.actions || [],
        uses: d.uses || 1,
        cardHash: d.cardHash,
        raisedAt: e.at,
        status: 'open',
        answer: null,
        closed: null,
        used: [],
        trusted,
      });
      return;
    }
    const x = this.decisions.get(d.id);
    if (!x) return;
    if (!trusted) x.trusted = false;
    if (e.type === 'answered' && x.status === 'open') {
      x.status = 'answered';
      x.answer = { text: d.text, via: d.via, option: d.option, cardOk: d.cardOk !== false, at: e.at };
    } else if (e.type === 'closed' && x.status === 'open') {
      x.status = d.reason === 'dismissed' ? 'dismissed' : 'withdrawn';
      x.closed = { reason: d.reason, at: e.at };
    } else if (e.type === 'used') {
      x.used.push({ action: d.action, folder: d.folder, terminal: d.terminal, at: e.at });
    }
  }

  // ---- what the app records -------------------------------------------------------------

  /**
   * A decision raised with ask_user. `by`: the session ({ id, cwd, name }); `card`: what the inbox
   * shows (label, question, summary, options, fallback, context, actions with their folders, uses).
   * Returns its id and the card's hash.
   */
  raise(by, card) {
    const id = `${card.label}-${crypto.randomBytes(6).toString('hex')}`;
    const hash = cardHash(by.cwd, card);
    this.append('raised', {
      id,
      terminal: by.id,
      folder: by.cwd,
      name: by.name,
      label: card.label,
      question: card.question,
      options: card.options.map((o) => o.label),
      actions: (card.actions || []).map((a) => ({ agent: a.agent, folder: a.folder, action: a.action, ref: a.ref || '' })),
      uses: card.uses || 1,
      cardHash: hash,
    });
    return { id, cardHash: hash };
  }

  /**
   * The user's answer. `via`: 'button' or 'inbox' (typed in the card), from the app's own window;
   * 'terminal' when it was typed in the session (noted, with no text: it proves nothing). `card`:
   * the card as it is now, which must hash to what was raised. False if it wasn't open.
   */
  answer(id, { text, via, card, folder }) {
    const x = this.decisions.get(id);
    if (!x || x.status !== 'open' || !x.trusted) return false;
    const fromInbox = via === 'button' || via === 'inbox';
    const said = fromInbox ? String(text || '').trim().slice(0, LIMITS.answer) : null;
    const option = fromInbox ? x.options.find((o) => o === said) || null : null;
    const cardOk = !card || cardHash(folder, card) === x.cardHash;
    this.append('answered', { id, text: said, via: fromInbox ? via : 'terminal', option, cardOk });
    return true;
  }

  /** Off the inbox without an answer: 'resolved', 'replaced', 'cleared', 'closed', 'dropped' or 'dismissed'. */
  close(id, reason) {
    const x = this.decisions.get(id);
    if (!x || x.status !== 'open' || !x.trusted) return false;
    this.append('closed', { id, reason });
    return true;
  }

  // ---- what sessions read ---------------------------------------------------------------

  get(id) {
    return this.decisions.get(id) || null;
  }

  /** Whether an answer can be acted on, and if not, why (in English: read by the model). */
  validity(x) {
    if (!x.trusted) return { ok: false, why: 'unverifiable: the record it is in does not check' };
    if (x.status !== 'answered') return { ok: false, why: `not answered (${x.status})` };
    const a = x.answer;
    if (a.via === 'terminal') return { ok: false, why: 'answered in the session\'s terminal, which cannot be checked' };
    if (!a.cardOk) return { ok: false, why: 'the card answered does not match the one raised' };
    if (a.option === null) return { ok: false, why: 'the answer is not exactly one of the options' };
    if (this.now() > a.at + VALID_FOR_MS) return { ok: false, why: 'expired (answers are valid for 7 days)' };
    return { ok: true, why: '' };
  }

  /** The slot an action takes in `used`: its number (1…), or 0 when the card names no actions. */
  usesLeft(x, slot) {
    return Math.max(0, x.uses - x.used.filter((u) => u.action === slot).length);
  }

  /** Who may read it: the auditors, everything; anyone else, answered ones they raised or are named in. */
  visibleTo(x, folder, auditor) {
    if (auditor) return true;
    if (x.status !== 'answered') return false;
    const me = normFolder(folder);
    return normFolder(x.folder) === me || x.actions.some((a) => normFolder(a.folder) === me);
  }

  /** The decisions raised from `folder` with `label`, newest first. */
  find(folder, label) {
    const f = normFolder(folder);
    const l = String(label || '').trim().toUpperCase();
    return [...this.decisions.values()].filter((x) => normFolder(x.folder) === f && x.label === l).sort((a, b) => b.raisedAt - a.raisedAt);
  }

  /**
   * A session (`by`: { id, cwd }) is about to do action `slot` of decision `id` (0: the card names
   * none, and it raised it). Recorded if the answer is valid, it's the one named, and uses are left.
   * Returns { ok, left } or { ok: false, why }.
   */
  use(id, slot, by) {
    const x = this.decisions.get(id);
    if (!x) return { ok: false, why: 'there is no such decision' };
    const v = this.validity(x);
    if (!v.ok) return { ok: false, why: v.why };
    const me = normFolder(by.cwd);
    if (x.actions.length) {
      const a = x.actions[slot - 1];
      if (!a) return { ok: false, why: `the decision names actions 1 to ${x.actions.length}` };
      if (normFolder(a.folder) !== me) return { ok: false, why: `action ${slot} is for ${a.folder}, not for this session's folder` };
    } else {
      if (slot !== 0) return { ok: false, why: 'the decision names no actions: leave action out' };
      if (normFolder(x.folder) !== me) return { ok: false, why: 'the decision names no actions, so only the session that raised it can use it' };
    }
    if (!this.usesLeft(x, slot)) return { ok: false, why: 'already used as many times as the card allows' };
    this.append('used', { id, action: slot, folder: by.cwd, terminal: by.id });
    return { ok: true, left: this.usesLeft(x, slot) };
  }
}

/**
 * A text value under HKCU, through reg.exe: read at once; written in the background, in order, the
 * newest value winning; flushSync() writes what is still pending before the app quits.
 */
function registryValue(key, name) {
  const { execFileSync, execFile } = require('child_process');
  const args = (v) => ['add', key, '/v', name, '/t', 'REG_SZ', '/d', v, '/f'];
  let writing = false;
  let next = null;
  let last = null;
  const flush = () => {
    if (writing || next === null) return;
    const v = next;
    next = null;
    writing = true;
    execFile('reg.exe', args(v), { windowsHide: true }, (err) => {
      writing = false;
      if (err) console.error('[decisions] could not write the registry copy of the head', err.message);
      flush();
    });
  };
  return {
    read() {
      try {
        const out = execFileSync('reg.exe', ['query', key, '/v', name], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const m = new RegExp(`^\\s*${name}\\s+REG_SZ\\s+(.*)$`, 'm').exec(out);
        return m ? m[1].trim() : null;
      } catch {
        return null;
      }
    },
    write(v) {
      last = v;
      next = v;
      flush();
    },
    flushSync() {
      if (!writing && next === null) return;
      next = null;
      try { execFileSync('reg.exe', args(last), { windowsHide: true, stdio: 'ignore' }); } catch { /* checked on the next start */ }
    },
  };
}

module.exports = { DecisionLog, cardHash, normFolder, registryValue, VALID_FOR_MS, LIMITS };
