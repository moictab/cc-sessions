'use strict';
// Owns every Claude Code process (one PTY per session), tracks its status from hook
// events and produces the snapshot that gets persisted.
//
// Status machine:
//   starting   process launched, no hook received yet
//   ready      SessionStart: waiting for the first prompt
//   busy       UserPromptSubmit / PostToolUse: working
//   permission Notification(permission): blocked on a permission prompt
//   input      AskUserQuestion / ExitPlanMode / other notification: waiting for an answer
//   done       Stop: turn finished, your move
//   exited     the process ended

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const pty = require('node-pty');
const { sessionEnv, transcriptExists } = require('./claude-env');
const { parseEnvelopes } = require('./messages');
const plugins = require('./plugins');
const { restartNote } = require('./restart-note');
const { adminContext } = require('./admin');
const i18n = require('../shared/i18n');

const ATTENTION = new Set(['permission', 'input', 'done']);
const IDLE = new Set(['ready', 'done']);
// Badge colors (the renderer draws them), in the order new sessions get them: each pick is the
// least used one, so up to 12 sessions all look different.
const COLORS = ['blue', 'orange', 'green', 'pink', 'cyan', 'amber', 'violet', 'lime', 'red', 'teal', 'indigo', 'slate'];
const cleanGroup = (g) => (typeof g === 'string' && g ? g.slice(0, 64) : null);
const MAX_BUFFER = 512 * 1024;
const termSize = (n, min, max, fallback) => (Number.isInteger(n) && n >= min && n <= max ? n : fallback);
// A session may ask for a restart itself (to load a plugin); this keeps a confused one from looping.
const SELF_RESTARTS_PER_HOUR = 6;

class SessionManager extends EventEmitter {
  /** `t(key, vars)` translates into the interface language of the moment (see shared/i18n.js). */
  /** `admin`: an AdminHost (admin.js), for the sessions that run as administrator. */
  constructor({ claudePath, hooks, settingsDir, t, admin = null }) {
    super();
    this.admin = admin;
    this.t = typeof t === 'function' ? t : i18n.create(i18n.DEFAULT_LANGUAGE);
    this.claudePath = claudePath;
    this.hooks = hooks;
    this.settingsDir = settingsDir;
    this.sessions = new Map();
    this.quitting = false;
    // Settings files from a previous run point at a port that no longer exists.
    try { fs.rmSync(settingsDir, { recursive: true, force: true }); } catch { /* ignore */ }
    fs.mkdirSync(settingsDir, { recursive: true });
  }

  // ---- lifecycle -------------------------------------------------------------------

  restore(records) {
    let delay = 0;
    for (const rec of records) {
      if (!rec || !rec.cwd) continue;
      const s = this.add(rec);
      // Administrator sessions wait for you to start them: a Windows prompt shouldn't pop up
      // on its own every time the app opens.
      if (s.admin) {
        s.parked = true;
        s.status = 'exited';
        this.emit('update', this.view(s));
        continue;
      }
      if (rec.exited) continue;
      // Stagger launches so a dozen sessions don't all boot in the same instant.
      setTimeout(() => this.spawn(s), delay);
      delay += 350;
    }
    this.emit('persist'); // badge colors given to sessions saved before there were any
  }

  /** `cols`/`rows`: the size of the pane it will show in, so Claude starts at the right size. */
  create({ cwd, name, resumeId, cols, rows }) {
    if (typeof cwd !== 'string' || !cwd) throw new Error(this.t('session.invalidFolder'));
    if (resumeId) {
      const open = [...this.sessions.values()].find((s) => s.claudeSessionId === resumeId);
      if (open) return this.view(open);
    }
    const s = this.add({ cwd, name: name || path.basename(cwd), claudeSessionId: resumeId || null, nameSince: Date.now(), cols, rows });
    this.spawn(s);
    this.emit('persist');
    return this.view(s);
  }

  add(rec) {
    const s = {
      id: rec.id || crypto.randomUUID(),
      name: rec.name || path.basename(rec.cwd),
      // When the name was last set, here or with /rename in Claude (0: saved by an older version).
      nameSince: Number(rec.nameSince) || 0,
      color: COLORS.includes(rec.color) ? rec.color : this.pickColor(), // the badge in the sidebar
      group: cleanGroup(rec.group), // id of a sidebar group (the groups themselves live in the store)
      cwd: rec.cwd,
      claudeSessionId: rec.claudeSessionId || null,
      status: rec.exited ? 'exited' : 'starting',
      detail: '',
      lastPrompt: rec.lastPrompt || '',
      lastReply: rec.lastReply || '',
      interrupted: !!rec.interrupted,
      createdAt: rec.createdAt || Date.now(),
      statusSince: Date.now(),
      exitCode: null,
      pendingTool: '',
      peerName: null,
      socket: null,
      pid: null,
      pty: null,
      // The PTY's size. Kept between runs, so a restored session starts at the size it had.
      cols: termSize(rec.cols, 2, 1000, 120),
      rows: termSize(rec.rows, 2, 500, 32),
      spawnSize: null, // the size the running process started at
      sizeTimer: null,
      buffer: '',
      pending: '',
      flushTimer: null,
      plugins: plugins.sanitizeOverrides(rec.plugins), // per-session plugin overrides (persisted)
      admin: !!rec.admin, // runs as administrator, through the helper in admin.js (persisted)
      adminDropped: !!rec.adminDropped, // was administrator until now: tell it on its next start
      parked: false, // an administrator session restored but not started yet
      elevated: null, // whether the running process really has administrator rights
      loadedPlugins: {}, // the overrides the running process was started with
      restartWhenIdle: null, // { change, note }: restart as soon as the current turn ends
      // Typed into the session once it's back after a restart (kept between runs: the note after
      // restarting the app is delivered by the next run).
      resumeNote: typeof rec.resumeNote === 'string' ? rec.resumeNote.slice(0, 4000) : '',
      wind: null, // { kind: 'stop' | 'cancel', state, text, timer }: see windDownAll()
      idleTimer: null,
      noteTimer: null,
      selfRestarts: [],
    };
    this.sessions.set(s.id, s);
    this.emit('update', this.view(s));
    return s;
  }

  spawn(s) {
    if (this.quitting || !this.sessions.has(s.id)) return;
    if (!this.claudePath) return this.setStatus(s, 'exited', own('session.noClaude'));
    if (!fs.existsSync(s.cwd)) return this.setStatus(s, 'exited', own('session.noFolder'));

    const settingsPath = path.join(this.settingsDir, s.id + '.json');
    const settings = { ...this.hooks.settingsFor(s.id) };
    if (Object.keys(s.plugins).length) settings.enabledPlugins = { ...s.plugins };
    fs.writeFileSync(settingsPath, JSON.stringify(settings));
    s.loadedPlugins = { ...s.plugins };
    s.spawnSize = { cols: s.cols, rows: s.rows };

    let args;
    if (s.claudeSessionId && transcriptExists(s.cwd, s.claudeSessionId)) {
      args = ['--resume', s.claudeSessionId];
      // So a rename made in the app reaches Claude. Not for sessions saved by older versions,
      // which never recorded when their name was set: Claude keeps its own (perhaps changed
      // with /rename) and applyRegistry picks it up.
      if (s.nameSince) args.push('--name', s.name);
    } else {
      // Brand-new conversation (or one that never got a first message): we pick the ID
      // so we can resume it later without guessing.
      s.claudeSessionId = s.claudeSessionId || crypto.randomUUID();
      args = ['--session-id', s.claudeSessionId, '--name', s.name];
    }
    args.push('--settings', settingsPath);
    if (this.hooks.mcpConfigFor) {
      // Our own MCP server (tools such as "turn a plugin on in this session").
      const mcpPath = path.join(this.settingsDir, s.id + '.mcp.json');
      fs.writeFileSync(mcpPath, JSON.stringify(this.hooks.mcpConfigFor(s.id)));
      args.push('--mcp-config', mcpPath);
    }

    let file = this.claudePath;
    if (/\.(cmd|bat)$/i.test(file)) {
      args = ['/d', '/c', file, ...args];
      file = process.env.ComSpec || 'cmd.exe';
    }

    const remote = s.admin && !!this.admin;
    let proc;
    try {
      const opts = { name: 'xterm-256color', cols: s.cols, rows: s.rows, cwd: s.cwd, env: sessionEnv(), useConpty: true };
      proc = remote ? this.admin.spawn(file, args, opts) : pty.spawn(file, args, opts);
    } catch (err) {
      return this.setStatus(s, 'exited', own('session.spawnFailed', { error: err.message }));
    }

    s.pty = proc;
    s.pid = proc.pid || null; // an administrator session gets it once the helper has started it
    s.parked = false;
    s.elevated = remote ? null : false;
    s.exitCode = null;
    if (remote) {
      proc.onSpawn(({ pid, elevated }) => {
        if (s.pty !== proc) return;
        s.pid = pid;
        s.elevated = elevated;
        if (s.status === 'starting') this.setStatus(s, 'starting'); // drops "waiting for approval"
        else this.emit('update', this.view(s));
      });
    }
    // A process being replaced by a restart can still print as it dies (cmd's "^C", for one):
    // that would land in the new process's terminal, whose buffer was just cleared.
    proc.onData((data) => { if (s.pty === proc) this.onData(s, data); });
    proc.onExit(({ exitCode, error }) => {
      if (s.pty !== proc) return; // replaced by a restart
      s.pty = null;
      s.pid = null;
      this.flush(s);
      if (this.quitting) return;
      // A restart that was waiting for the turn to end: the new plugins apply when it's
      // resumed, and the note still tells the session what happened.
      if (s.restartWhenIdle) { s.resumeNote = s.restartWhenIdle.note; s.restartWhenIdle = null; }
      clearTimeout(s.idleTimer); s.idleTimer = null;
      s.exitCode = exitCode;
      this.setStatus(s, 'exited', error ? own(error.key, error.vars) : exitCode ? own('session.exitCode', { code: exitCode }) : '');
      this.emit('persist');
    });
    this.setStatus(s, 'starting', remote && !proc.pid ? own('admin.waiting') : '');
  }

  /**
   * Kills the process and starts it again on the same conversation (--resume), with the
   * session's current plugin overrides. `note` is typed into the session once it's back.
   */
  restart(id, { note = '' } = {}) {
    const s = this.sessions.get(id);
    if (!s) return null;
    const old = s.pty;
    s.pty = null;
    if (old) { try { old.kill(); } catch { /* already gone */ } }
    s.restartWhenIdle = null;
    clearTimeout(s.idleTimer); s.idleTimer = null;
    clearTimeout(s.noteTimer); s.noteTimer = null;
    clearTimeout(s.sizeTimer); s.sizeTimer = null;
    s.resumeNote = typeof note === 'string' ? note : '';
    s.buffer = '';
    s.pending = '';
    this.emit('reset', s.id);
    this.spawn(s);
    this.emit('persist');
    return this.view(s);
  }

  remove(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    const proc = s.pty;
    s.pty = null;
    if (proc) { try { proc.kill(); } catch { /* already gone */ } }
    clearTimeout(s.flushTimer);
    clearTimeout(s.idleTimer);
    clearTimeout(s.noteTimer);
    clearTimeout(s.sizeTimer);
    this.clearWind(s);
    this.sessions.delete(id);
    for (const ext of ['.json', '.mcp.json']) {
      try { fs.rmSync(path.join(this.settingsDir, id + ext), { force: true }); } catch { /* ignore */ }
    }
    this.emit('removed', id);
    this.emit('persist');
  }

  /** Before quitting: remember which sessions were cut off mid-task. */
  markInterrupted() {
    for (const s of this.sessions.values()) {
      if (s.status === 'busy') s.interrupted = true;
    }
  }

  /**
   * Kills every session and resolves once all of them have exited, or after `timeoutMs`.
   * On Windows node-pty closes the console asynchronously (it first lists and kills the
   * console's processes); quitting before that finishes can leave the app hanging on exit.
   */
  killAll(timeoutMs = 3000) {
    this.quitting = true;
    const exits = [];
    for (const s of this.sessions.values()) {
      const proc = s.pty;
      s.pty = null;
      if (!proc) continue;
      exits.push(new Promise((resolve) => {
        const sub = proc.onExit(() => { sub.dispose(); resolve(); });
      }));
      try { proc.kill(); } catch { /* already gone */ }
    }
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); });
    return Promise.race([Promise.all(exits), timeout]).finally(() => clearTimeout(timer));
  }

  // ---- terminal I/O ----------------------------------------------------------------

  onData(s, data) {
    s.buffer += data;
    if (s.buffer.length > MAX_BUFFER) s.buffer = s.buffer.slice(-MAX_BUFFER);
    s.pending += data;
    if (!s.flushTimer) s.flushTimer = setTimeout(() => this.flush(s), 8);
  }

  flush(s) {
    clearTimeout(s.flushTimer);
    s.flushTimer = null;
    if (!s.pending) return;
    const chunk = s.pending;
    s.pending = '';
    this.emit('data', s.id, chunk);
  }

  write(id, data) {
    const s = this.sessions.get(id);
    if (!s || !s.pty || typeof data !== 'string') return;
    s.pty.write(data);
    // Answering a permission prompt or a question doesn't fire any hook until the tool
    // finishes; assume Enter means "answered". The registry corrects it if it was a "no".
    if ((s.status === 'permission' || s.status === 'input') && data.includes('\r')) {
      this.setStatus(s, 'busy');
    }
  }

  resize(id, cols, rows) {
    const s = this.sessions.get(id);
    if (!s || !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2) return;
    if (s.cols === cols && s.rows === rows) return;
    s.cols = cols;
    s.rows = rows;
    if (s.pty) { try { s.pty.resize(cols, rows); } catch { /* exiting */ } }
  }

  /**
   * The pane's size can reach the PTY while Claude is still starting up, and Claude sometimes
   * misses that change and keeps drawing at the size it was launched with (120x32, in a corner of
   * the pane). If the size changed since the launch, send it again once Claude is up: one row
   * less and back, since the same size again wouldn't tell it anything.
   */
  resendSizeIfChanged(s) {
    const proc = s.pty;
    if (!proc || !s.spawnSize || (s.spawnSize.cols === s.cols && s.spawnSize.rows === s.rows)) return;
    s.spawnSize = { cols: s.cols, rows: s.rows };
    clearTimeout(s.sizeTimer);
    s.sizeTimer = setTimeout(() => {
      s.sizeTimer = null;
      if (s.pty !== proc || s.rows < 3) return;
      try { proc.resize(s.cols, s.rows - 1); } catch { return; }
      setTimeout(() => { if (s.pty === proc) { try { proc.resize(s.cols, s.rows); } catch { /* exiting */ } } }, 80);
    }, 1500); // SessionStart comes a little before Claude's screen is up
  }

  // ---- status ----------------------------------------------------------------------

  handleHook(terminalId, p) {
    const s = this.sessions.get(terminalId);
    if (!s || !p || typeof p !== 'object') return null;

    if (p.session_id && p.session_id !== s.claudeSessionId) {
      s.claudeSessionId = p.session_id; // e.g. after /clear
      this.emit('persist');
    }

    switch (p.hook_event_name) {
      case 'SessionStart': {
        if (p.source === 'startup' || p.source === 'resume') this.resendSizeIfChanged(s);
        // Auto-compaction restarts the session mid-turn; keep whatever we had.
        if (p.source !== 'compact') this.setStatus(s, 'ready');
        // On every start, resume, /clear and compaction, so it's never forgotten.
        const context = this.startContext(s);
        return context ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } } : null;
      }
      case 'UserPromptSubmit': {
        const envelopes = parseEnvelopes(p.prompt);
        if (envelopes.length) {
          // Turn started by another session's message, not by the user.
          const e = envelopes[envelopes.length - 1];
          // Stored as text (and persisted): it stays in the language it was written in.
          s.lastPrompt = this.t('session.messageFrom', { name: e.fromName || this.t('session.anotherSession'), body: e.body }).slice(0, 2000);
        } else if (typeof p.prompt === 'string') {
          s.lastPrompt = p.prompt.slice(0, 2000);
        }
        if (s.interrupted) { s.interrupted = false; this.emit('persist'); }
        this.setStatus(s, 'busy');
        break;
      }
      case 'PreToolUse':
        s.pendingTool = describeTool(p.tool_name, p.tool_input);
        if (p.tool_name === 'AskUserQuestion') this.setStatus(s, 'input', firstQuestion(p.tool_input) || own('session.asking'));
        else if (p.tool_name === 'ExitPlanMode') this.setStatus(s, 'input', own('session.plan'));
        break;
      case 'PostToolUse': {
        if (s.status !== 'busy') this.setStatus(s, 'busy');
        // A request for a session that's working: it reads it along with this step's result,
        // without anything being typed over what it's doing.
        const w = s.wind;
        if (w && w.state === 'queued') {
          w.state = 'delivered';
          this.emit('update', this.view(s));
          return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: w.text } };
        }
        break;
      }
      case 'Notification': {
        const kind = classifyNotification(p);
        if (kind === 'permission') this.setStatus(s, 'permission', s.pendingTool || p.message || '');
        else if (kind === 'idle') {
          if (!['done', 'ready', 'permission', 'input'].includes(s.status)) this.setStatus(s, 'done', p.message || '');
        } else if (kind === 'input') this.setStatus(s, 'input', p.message || own('session.waiting'));
        break;
      }
      case 'Stop':
        if (typeof p.last_assistant_message === 'string') s.lastReply = p.last_assistant_message.slice(0, 2000);
        // Before setStatus: for a request still queued, the end of this turn is when it gets typed.
        if (s.wind && s.wind.state === 'delivered') this.windAnswered(s);
        this.setStatus(s, 'done');
        this.onIdle(s); // also when we already thought it was idle (setStatus didn't change)
        this.emit('persist');
        break;
      default:
        break;
    }
    return null;
  }

  /** What a session should know as it starts: that it runs as administrator, or no longer does. */
  startContext(s) {
    if (s.admin) return adminContext({ elevated: !!s.elevated });
    if (s.adminDropped) {
      s.adminDropped = false;
      this.emit('persist');
      return adminContext({ dropped: true });
    }
    return '';
  }

  /** Cross-check with ~/.claude/sessions: fixes missed hooks and tracks /clear. */
  applyRegistry(entries) {
    for (const s of this.sessions.values()) {
      if (!s.pty) continue;
      const e = entries.find((x) => (s.pid && x.pid === s.pid) || (s.claudeSessionId && x.sessionId === s.claudeSessionId));
      if (!e) continue;
      if (e.pid === s.pid && e.sessionId && e.sessionId !== s.claudeSessionId) {
        s.claudeSessionId = e.sessionId;
        this.emit('persist');
      }
      // The name other sessions use to address this one (SendMessage), and its socket.
      if (e.name && e.name !== s.peerName) s.peerName = e.name;
      // Renamed inside Claude (/rename) after the app last named it: the app follows.
      if (e.name && e.nameSource === 'user' && e.nameSince > s.nameSince && e.name !== s.name) {
        s.name = e.name.slice(0, 80);
        s.nameSince = e.nameSince;
        this.emit('update', this.view(s));
        this.emit('persist');
      }
      if (e.socket) s.socket = e.socket;
      if (!(e.statusUpdatedAt > s.statusSince)) continue;
      if (e.status === 'idle' && s.status === 'busy') this.setStatus(s, 'done');
      else if (e.status === 'busy' && ['starting', 'ready', 'done'].includes(s.status)) this.setStatus(s, 'busy');
    }
  }

  /** `detail`: text from Claude, or own(key, vars) for text of ours (translated in view()). */
  setStatus(s, status, detail = '') {
    const prev = s.status;
    if (prev === status && sameDetail(s.detail, detail)) return;
    s.status = status;
    s.detail = detail;
    s.statusSince = Date.now();
    this.emit('update', this.view(s));
    if (ATTENTION.has(status) && prev !== status && (status !== 'done' || prev === 'busy')) {
      this.emit('attention', this.view(s));
    }
    if (s.wind) this.windStep(s);
    if (IDLE.has(status)) this.onIdle(s);
  }

  // ---- winding down before the app restarts ------------------------------------------------

  /**
   * Asks every running session to stop its background work (commands, monitors, reminders,
   * subagents) and not start more, since restarting the app closes them all. How it reaches each:
   *   idle (ready, done)        typed in, like a prompt
   *   working                   with the result of its next step (PostToolUse additionalContext)
   *   permission, question,     not touched until that's over: typing would answer it
   *   starting
   * It counts as answered when the turn that read it ends. The UI shows how each one is doing.
   */
  windDownAll(text) {
    for (const s of this.sessions.values()) {
      this.clearWind(s);
      s.wind = { kind: 'stop', state: s.pty && s.status !== 'exited' ? 'waiting' : 'closed', text, timer: null };
      this.windStep(s);
      this.emit('update', this.view(s));
    }
  }

  /** Never mind: the sessions that were asked are told they can carry on. */
  cancelWindDown(text) {
    for (const s of this.sessions.values()) {
      const told = s.wind && s.wind.kind === 'stop' && (s.wind.state === 'delivered' || s.wind.state === 'done');
      this.clearWind(s);
      if (told && s.pty) {
        s.wind = { kind: 'cancel', state: 'waiting', text, timer: null };
        this.windStep(s);
      }
      this.emit('update', this.view(s));
    }
  }

  /** On restarting the app: a note for each session that was asked to stop, for when it's back. */
  noteAfterRestart(text) {
    for (const s of this.sessions.values()) {
      if (s.wind && s.wind.kind === 'stop' && (s.wind.state === 'delivered' || s.wind.state === 'done')) s.resumeNote = text;
    }
    this.emit('persist');
  }

  clearWind(s) {
    if (s.wind) clearTimeout(s.wind.timer);
    s.wind = null;
  }

  windStep(s) {
    const w = s.wind;
    if (!w || w.state === 'done' || w.state === 'closed' || w.state === 'delivered') return;
    if (!s.pty || s.status === 'exited') {
      clearTimeout(w.timer);
      if (w.kind === 'cancel') s.wind = null;
      else w.state = 'closed';
      return;
    }
    if (s.status === 'busy') { w.state = 'queued'; return; }
    if (!IDLE.has(s.status)) { w.state = 'waiting'; return; } // permission, question, starting
    if (w.timer) return;
    // A moment after the turn ends, so the prompt takes input again.
    w.timer = setTimeout(() => {
      w.timer = null;
      if (s.wind !== w || (w.state !== 'waiting' && w.state !== 'queued')) return;
      if (!s.pty || !IDLE.has(s.status)) { this.windStep(s); return; }
      w.state = 'delivered';
      this.typeNote(s, w.text);
      this.emit('update', this.view(s));
    }, 600);
  }

  /** The turn that read the request ended. */
  windAnswered(s) {
    if (s.wind.kind === 'cancel') this.clearWind(s);
    else s.wind.state = 'done';
  }

  /**
   * Types `text` as a prompt and sends it. Claude takes a long burst of input as a paste, and an
   * Enter that arrives too soon after it becomes a line break. So wait, and press it again if the
   * prompt wasn't sent (any status change means it was, or that something else is going on).
   */
  typeNote(s, text) {
    const proc = s.pty;
    if (!proc) return;
    proc.write(text);
    const since = s.statusSince;
    const submit = (retries) => {
      if (s.pty !== proc || s.statusSince !== since) return;
      proc.write('\r');
      if (retries > 0) setTimeout(() => submit(retries - 1), 2000);
    };
    setTimeout(() => submit(2), 800);
  }

  // ---- restarts that wait for the turn to end, and notes for after a restart ------------

  /** The session just finished a turn (or started): do whatever was waiting for that. */
  onIdle(s) {
    if (!s.pty) return;
    if (s.restartWhenIdle) {
      // A moment for Claude to finish writing the turn to the transcript before we kill it.
      if (!s.idleTimer) {
        s.idleTimer = setTimeout(() => {
          s.idleTimer = null;
          if (s.restartWhenIdle && s.pty && IDLE.has(s.status)) this.restart(s.id, { note: s.restartWhenIdle.note });
        }, 1500);
      }
      return;
    }
    if (s.resumeNote && !s.noteTimer) {
      // SessionStart arrives a little before the prompt accepts input.
      s.noteTimer = setTimeout(() => {
        s.noteTimer = null;
        const proc = s.pty;
        if (!s.resumeNote || !proc || !IDLE.has(s.status)) return;
        const text = s.resumeNote;
        s.resumeNote = '';
        this.emit('persist');
        this.typeNote(s, text);
      }, 1500);
    }
  }

  /** Plugins this session can switch on or off, and their state. */
  pluginState(id) {
    const s = this.sessions.get(id);
    if (!s) return null;
    const eff = (overrides, p) => (typeof overrides[p.id] === 'boolean' ? overrides[p.id] : plugins.configured(s.cwd, p.id));
    return {
      running: !!s.pty,
      pending: s.restartWhenIdle ? this.changeText(s.restartWhenIdle.changes) : '',
      plugins: plugins.available().map((p) => ({
        key: p.key,
        label: p.label,
        about: this.t(p.aboutKey),
        configured: plugins.configured(s.cwd, p.id),
        on: eff(s.plugins, p), // what the session will have (now, or after the pending restart)
        loaded: s.pty ? eff(s.loadedPlugins, p) : null, // what the running process has
      })),
    };
  }

  /**
   * Turns plugins on or off for this session only. `changes` maps a plugin key to a boolean.
   * The running process only picks it up on a restart: right away if the session is idle and
   * the user asked, otherwise when the current turn ends (a session asking for itself is always
   * mid-turn: its tool call must get its answer first).
   */
  setPlugins(id, changes, { by = 'user', notify = true, sessionNote = '' } = {}) {
    // The errors only reach a session's model, through the MCP tool (the UI ignores them),
    // so they are in English like the rest of mcp.js.
    const s = this.sessions.get(id);
    if (!s) return { ok: false, error: 'Unknown session' };
    const next = { ...s.plugins };
    for (const [key, on] of Object.entries(changes || {})) {
      const p = plugins.byKey(key);
      if (!p || typeof on !== 'boolean') return { ok: false, error: `Plugin not allowed: ${key}` };
      next[p.id] = on;
    }
    const eff = (overrides, p) => (typeof overrides[p.id] === 'boolean' ? overrides[p.id] : plugins.configured(s.cwd, p.id));
    const diffs = plugins.TOGGLABLE.filter((p) => eff(next, p) !== eff(s.loadedPlugins, p));
    const pending = diffs.map((p) => ({ label: p.label, on: eff(next, p) }));
    const change = this.changeText(pending);

    if (by === 'session' && diffs.length) {
      const now = Date.now();
      s.selfRestarts = s.selfRestarts.filter((t) => now - t < 3600e3);
      if (s.selfRestarts.length >= SELF_RESTARTS_PER_HOUR) {
        return { ok: false, error: 'Too many restarts requested by this session in the last hour. Ask the user for it.' };
      }
      s.selfRestarts.push(now);
    }

    s.plugins = next;
    this.emit('persist');
    if (!s.pty) {
      s.restartWhenIdle = null;
      this.emit('update', this.view(s));
      return { ok: true, result: 'saved' }; // closed: applies when it's resumed
    }
    if (!diffs.length) {
      const had = !!s.restartWhenIdle;
      s.restartWhenIdle = null;
      clearTimeout(s.idleTimer); s.idleTimer = null;
      this.emit('update', this.view(s));
      return { ok: true, result: had ? 'cancelled' : 'unchanged' };
    }
    const note = notify ? restartNote(this.t, { bySession: by === 'session', change, sessionNote }) : '';
    s.restartWhenIdle = { changes: pending, note };
    this.emit('update', this.view(s));
    if (by !== 'session' && IDLE.has(s.status)) {
      this.restart(s.id, { note });
      return { ok: true, result: 'restarted', change };
    }
    return { ok: true, result: 'scheduled', change };
  }

  /** "turn on Playwright and turn off X", in the interface language of the moment. */
  changeText(changes) {
    return changes.map((c) => this.t(c.on ? 'plugins.turnOn' : 'plugins.turnOff', { label: c.label })).join(this.t('plugins.and'));
  }

  /** Called from the UI: forget a restart that was waiting for the turn to end. */
  cancelPendingRestart(id) {
    const s = this.sessions.get(id);
    if (!s || !s.restartWhenIdle) return;
    s.plugins = { ...s.loadedPlugins };
    s.restartWhenIdle = null;
    clearTimeout(s.idleTimer); s.idleTimer = null;
    this.emit('update', this.view(s));
    this.emit('persist');
  }

  /**
   * Runs the session as administrator, or stops doing so. A running session restarts on the
   * same conversation (and, to become administrator, goes through the Windows prompt); a closed
   * one just keeps the choice for when it's started.
   */
  setAdmin(id, on, { note = '' } = {}) {
    const s = this.sessions.get(id);
    if (!s || typeof on !== 'boolean') return null;
    if (s.admin === on) return this.view(s);
    s.admin = on;
    s.adminDropped = !on; // so the session hears it no longer has those rights
    this.emit('persist');
    if (s.pty) return this.restart(id, { note });
    s.parked = on;
    this.emit('update', this.view(s));
    return this.view(s);
  }

  // ---- queries ---------------------------------------------------------------------

  /** The least used badge color (ties: the earlier one in COLORS). */
  pickColor() {
    const used = new Map(COLORS.map((c) => [c, 0]));
    for (const s of this.sessions.values()) if (used.has(s.color)) used.set(s.color, used.get(s.color) + 1);
    let best = COLORS[0];
    for (const c of COLORS) if (used.get(c) < used.get(best)) best = c;
    return best;
  }

  /** Sidebar look: { color } and/or { group } (null: no group). */
  setMeta(id, patch) {
    const s = this.sessions.get(id);
    if (!s || !patch || typeof patch !== 'object') return null;
    if (COLORS.includes(patch.color)) s.color = patch.color;
    if ('group' in patch) s.group = cleanGroup(patch.group);
    this.emit('update', this.view(s));
    this.emit('persist');
    return this.view(s);
  }

  rename(id, name) {
    const s = this.sessions.get(id);
    if (!s || typeof name !== 'string' || !name.trim()) return null;
    s.name = name.trim().slice(0, 80);
    s.nameSince = Date.now(); // Claude gets it with --name on the next start
    this.emit('update', this.view(s));
    this.emit('persist');
    return this.view(s);
  }

  clearInterrupted(id) {
    const s = this.sessions.get(id);
    if (!s || !s.interrupted) return;
    s.interrupted = false;
    this.emit('update', this.view(s));
    this.emit('persist');
  }

  reorder(ids) {
    if (!Array.isArray(ids)) return;
    const next = new Map();
    for (const id of ids) if (this.sessions.has(id)) next.set(id, this.sessions.get(id));
    for (const [id, s] of this.sessions) if (!next.has(id)) next.set(id, s);
    this.sessions = next;
    this.emit('persist');
  }

  get(id) {
    const s = this.sessions.get(id);
    return s ? this.view(s) : null;
  }

  list() {
    return [...this.sessions.values()].map((s) => this.view(s));
  }

  /** A session of ours addressed by its peer name (or, failing that, its display name). */
  findByName(name) {
    const n = String(name || '').toLowerCase();
    if (!n) return null;
    const all = [...this.sessions.values()];
    const s = all.find((x) => x.peerName && x.peerName.toLowerCase() === n) || all.find((x) => x.name.toLowerCase() === n);
    return s ? this.view(s) : null;
  }

  /** Name under which a session of ours appears to other sessions. */
  peerNameOf(id) {
    const s = this.sessions.get(id);
    return s ? { name: s.peerName || s.name } : null;
  }

  ownsRegistryEntry(e) {
    for (const s of this.sessions.values()) {
      if ((s.pid && e.pid === s.pid) || (s.claudeSessionId && e.sessionId === s.claudeSessionId)) return s;
    }
    return null;
  }

  /** Terminal contents for a renderer that (re)connects. Flushes first so nothing is sent twice. */
  buffers() {
    const out = {};
    for (const s of this.sessions.values()) {
      this.flush(s);
      out[s.id] = s.buffer;
    }
    return out;
  }

  snapshot() {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      name: s.name,
      nameSince: s.nameSince,
      color: s.color,
      group: s.group,
      cwd: s.cwd,
      claudeSessionId: s.claudeSessionId,
      // Processes we kill on quit don't go through setStatus('exited'), so this only
      // captures sessions that had already ended on their own.
      exited: s.status === 'exited',
      interrupted: s.interrupted,
      lastPrompt: s.lastPrompt,
      lastReply: s.lastReply,
      createdAt: s.createdAt,
      plugins: s.plugins,
      admin: s.admin,
      adminDropped: s.adminDropped,
      cols: s.cols,
      rows: s.rows,
      resumeNote: s.resumeNote,
    }));
  }

  view(s) {
    return {
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      claudeSessionId: s.claudeSessionId,
      status: s.status,
      detail: typeof s.detail === 'string' ? s.detail : this.t(s.detail.key, s.detail.vars),
      lastPrompt: s.lastPrompt,
      lastReply: s.lastReply,
      interrupted: s.interrupted,
      statusSince: s.statusSince,
      exitCode: s.exitCode,
      pendingRestart: s.restartWhenIdle ? this.changeText(s.restartWhenIdle.changes) : '',
      cols: s.cols, // the PTY's size: a page that reconnects replays the output at it
      rows: s.rows,
      color: s.color,
      group: s.group,
      admin: s.admin,
      wind: s.wind && s.wind.kind === 'stop' ? s.wind.state : null, // winding down before a restart
      parked: s.parked, // administrator session restored, waiting for you to start it
      elevated: s.elevated,
    };
  }
}

/**
 * A status detail written by the app rather than by Claude: kept as a key and translated each
 * time the view is built, so it follows a change of language.
 */
function own(key, vars) {
  return { key, vars };
}

function sameDetail(a, b) {
  if (a === b) return true;
  return !!a && !!b && typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b);
}

function describeTool(name, input) {
  if (!name) return '';
  const i = input && typeof input === 'object' ? input : {};
  const base = (f) => String(f || '').split(/[\\/]/).pop();
  let text = name;
  if ((name === 'Bash' || name === 'PowerShell') && i.command) text = `${name}: ${i.command}`;
  else if (i.file_path || i.notebook_path) text = `${name}: ${base(i.file_path || i.notebook_path)}`;
  else if (name === 'WebFetch' && i.url) text = `WebFetch: ${i.url}`;
  else if (name === 'WebSearch' && i.query) text = `WebSearch: ${i.query}`;
  else if (name.startsWith('mcp__')) {
    const [, server, ...tool] = name.split('__');
    text = `MCP ${server}: ${tool.join('__')}`;
  }
  return text.replace(/\s+/g, ' ').slice(0, 240);
}

function firstQuestion(input) {
  const q = input && Array.isArray(input.questions) && input.questions[0];
  return q && typeof q.question === 'string' ? q.question.slice(0, 240) : '';
}

function classifyNotification(p) {
  const type = p.notification_type || p.type || '';
  if (type === 'permission_prompt') return 'permission';
  if (type === 'idle_prompt') return 'idle';
  if (type === 'auth_success') return 'ignore';
  if (type) return 'input';
  const msg = String(p.message || '');
  if (/permission|permiso/i.test(msg)) return 'permission';
  if (/waiting for your input|esperando/i.test(msg)) return 'idle';
  return 'input';
}

module.exports = { SessionManager };
